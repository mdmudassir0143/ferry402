// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {LossyMockUSDC} from "./mocks/EscrowSecurityDoubles.t.sol";
import {Secp256k1TestHelper} from "./helpers/Secp256k1TestHelper.sol";

/// @notice Invariant handler that hammers Escrow with a mix of legitimate and
/// deliberately bad operations across several actors: over-withdrawals,
/// merchant-mismatched settlements, and nonce replays. The handler must be
/// able to ATTEMPT every one of these -- it is Escrow's own checks, not any
/// guard rail in here, that must reject them. Settled against a
/// fee-skimming token (LossyMockUSDC) so the pool never receives the full
/// `auth.value`, forcing the ghost accounting below to be built from the
/// merchant's own ledger row (escrow.balanceOf) rather than requested
/// amounts -- or, just as importantly, rather than the pool's own token
/// balance (see the note in settle() below on why that distinction matters).
contract EscrowHandler is Test, Secp256k1TestHelper {
    Escrow public immutable escrow;
    LossyMockUSDC public immutable usdc;

    uint256 private constant PAYER_KEY = 0xA11CE;
    address public immutable payer;

    address[] public actors;

    // Ghost accounting, updated only from OBSERVED deltas on each merchant's
    // own ledger row (escrow.balanceOf) -- never from the requested
    // `auth.value` (which LossyMockUSDC never delivers in full) and never
    // from the pool's own token balance (which would make this a tautology;
    // see settle() below).
    uint256 public totalCredited;
    uint256 public totalWithdrawn;

    uint256 public settleAttempts;
    uint256 public settleSuccesses;
    uint256 public withdrawAttempts;
    uint256 public withdrawSuccesses;
    uint256 public mismatchAttempts;
    uint256 public replayAttempts;
    uint256 public overWithdrawAttempts;

    // Second line of defense: if either critical property is ever violated
    // during the campaign, latch it here so the invariant can catch it even
    // if the pool still happens to look solvent afterwards.
    bool public merchantBindingBroken;
    bool public replayProtectionBroken;
    // Same idea for over-withdrawal: a successful over-withdraw is not
    // reliably visible through the solvency invariant alone (see the note in
    // withdraw() below), so it gets its own explicit latch and invariant.
    bool public overWithdrawSucceeded;

    mapping(address => bool) public everCredited;
    uint256 public distinctCreditedActors;

    uint256 private _nextPaymentId = 1;
    mapping(address => bytes32) public lastPaymentId;
    mapping(address => bool) private _hasLastPaymentId;

    constructor(Escrow escrow_, LossyMockUSDC usdc_) {
        escrow = escrow_;
        usdc = usdc_;
        payer = vm.addr(PAYER_KEY);

        actors.push(address(0xA1));
        actors.push(address(0xA2));
        actors.push(address(0xA3));
        actors.push(address(0xA4));

        // Fund the payer generously up front so no run is starved for
        // balance regardless of how many settle attempts the fuzzer makes.
        usdc.mint(payer, 1_000_000_000e6);
    }

    function actorsCount() external view returns (uint256) {
        return actors.length;
    }

    /// @dev Randomly settles a payment. `wrongMerchant` deliberately submits
    /// a different merchant than the one the authorization was signed for
    /// (must revert MerchantNotBound); `reuseNonce` deliberately resubmits an
    /// already-used (merchant, paymentId) pair, re-signed over a fresh value
    /// (must revert on the token's nonce-used check regardless of value).
    function settle(uint256 actorSeed, uint256 valueSeed, bool wrongMerchant, bool reuseNonce) external {
        settleAttempts++;
        (uint256 idx, address signedMerchant) = _actor(actorSeed);
        uint256 value = bound(valueSeed, 1, 1_000e6);

        bool mismatched = wrongMerchant && actors.length > 1;
        address submittedMerchant = mismatched ? actors[(idx + 1) % actors.length] : signedMerchant;
        if (mismatched) mismatchAttempts++;

        bool attemptedReplay = reuseNonce && _hasLastPaymentId[signedMerchant];
        bytes32 paymentId = attemptedReplay ? lastPaymentId[signedMerchant] : bytes32(_nextPaymentId++);
        // Only count this as an attempt on the TOKEN's nonce-used check when
        // the call isn't already doomed to revert earlier at
        // MerchantNotBound: when both booleans are true, the mismatch fires
        // first and the token's replay guard is never reached, so counting
        // it here would overstate what the campaign actually exercised
        // (assertGt(replayAttempts, 0) in afterInvariant would then prove
        // less than it claims to).
        if (attemptedReplay && !mismatched) replayAttempts++;

        Escrow.Authorization memory auth = Escrow.Authorization({
            from: payer,
            to: address(escrow),
            value: value,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(signedMerchant, paymentId))
        });
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        uint256 ledgerBefore = escrow.balanceOf(submittedMerchant);
        try escrow.settleAuthorization(submittedMerchant, paymentId, auth, v, r, s) {
            settleSuccesses++;

            // Latch the safety-property flags BEFORE any arithmetic below.
            // These two branches should be unreachable; if either fires, a
            // core safety property has broken during the campaign.
            if (mismatched) merchantBindingBroken = true;
            if (attemptedReplay) replayProtectionBroken = true;

            // NOTE: the delta is measured on the MERCHANT'S OWN LEDGER ROW
            // (escrow.balanceOf), not on the pool's token balance. Measuring
            // the pool's token balance instead would make totalCredited a
            // restatement of the pool's own conservation of tokens -- it
            // would then equal usdc.balanceOf(escrow) by construction, and
            // the solvency invariant below would compare a quantity to
            // itself and could never fail. The whole point of this
            // invariant is to compare the contract's *ledger* (this delta)
            // against its *actual token holdings*, which are two
            // independently-tracked quantities inside Escrow.
            //
            // Clamped rather than a bare subtraction: a ghost update must
            // never be able to revert, or it silently vetoes the very class
            // of bug it exists to measure (a Solidity 0.8 underflow panic
            // here would unwind this whole try body, including the
            // settleSuccesses++ and the latches above, discarding the
            // observation instead of recording it).
            uint256 ledgerAfter = escrow.balanceOf(submittedMerchant);
            totalCredited += ledgerAfter >= ledgerBefore ? ledgerAfter - ledgerBefore : 0;

            if (!everCredited[submittedMerchant]) {
                everCredited[submittedMerchant] = true;
                distinctCreditedActors++;
            }
            lastPaymentId[signedMerchant] = paymentId;
            _hasLastPaymentId[signedMerchant] = true;
        } catch {
            // Expected outcome for mismatched merchants, reused nonces, and
            // occasionally a value too small to survive LossyMockUSDC's fee
            // (amount < fee underflows in _transfer) -- rejection is exactly
            // what these attempts exist to prove.
        }
    }

    /// @dev Randomly withdraws. `overWithdraw` deliberately requests more
    /// than the actor's own ledger balance (must revert InsufficientBalance).
    /// `toSeed` picks the payout destination from the actor set OR the
    /// escrow contract itself -- withdrawing to the escrow is the documented
    /// slack case in Escrow.withdraw's own dev comment (ledger debited, but
    /// the token physically stays in the pool), which is exactly why the
    /// solvency invariant below is `>=` rather than `==`; without fuzzing it
    /// that slack path was never exercised.
    function withdraw(uint256 actorSeed, uint256 amountSeed, bool overWithdraw, uint256 toSeed) external {
        withdrawAttempts++;
        (, address actor) = _actor(actorSeed);
        uint256 ledgerBalance = escrow.balanceOf(actor);

        uint256 amount = overWithdraw
            ? bound(amountSeed, ledgerBalance + 1, ledgerBalance + 1_000_000e6 + 1)
            : bound(amountSeed, 0, ledgerBalance);
        if (overWithdraw) overWithdrawAttempts++;

        uint256 toIdx = bound(toSeed, 0, actors.length);
        address to = toIdx == actors.length ? address(escrow) : actors[toIdx];

        vm.prank(actor);
        try escrow.withdraw(amount, to) {
            withdrawSuccesses++;

            // Latch BEFORE the ghost arithmetic below, for the same reason
            // as in settle(): a successful over-withdrawal here is the exact
            // bug class this handler exists to attempt, and it must be
            // recorded as having happened even if something downstream in
            // this function were ever to revert.
            if (overWithdraw) overWithdrawSucceeded = true;

            // Same reasoning as in settle(): measured against the actor's
            // own ledger row, not the pool's token balance, so this is a
            // quantity independent of usdc.balanceOf(escrow) rather than a
            // restatement of it -- and clamped rather than a bare
            // subtraction, because an unclamped `ledgerBalance -
            // escrow.balanceOf(actor)` UNDERFLOWS AND PANICS whenever a
            // withdrawal succeeds for more than `ledgerBalance` (exactly
            // what `overWithdraw` is designed to attempt): `_balances`
            // becomes ~2**256 under a broken guard, so
            // `escrow.balanceOf(actor)` ends up far ABOVE `ledgerBalance`,
            // not below it. That panic would unwind this entire try body --
            // including the `overWithdrawSucceeded` latch above -- silently
            // discarding the very observation this handler exists to make,
            // deterministically, on every successful over-withdrawal.
            uint256 ledgerAfter = escrow.balanceOf(actor);
            totalWithdrawn += ledgerAfter <= ledgerBalance ? ledgerBalance - ledgerAfter : 0;
        } catch {
            // Expected outcome for over-withdrawal attempts.
        }
    }

    function _actor(uint256 seed) internal view returns (uint256 idx, address a) {
        idx = bound(seed, 0, actors.length - 1);
        a = actors[idx];
    }

    function _sign(Escrow.Authorization memory a) internal view returns (uint8, bytes32, bytes32) {
        bytes32 digest = usdc.receiveAuthorizationDigest(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);
        return _toLowS(v, r, s);
    }
}

/// @notice Fuzzes long random sequences of settlements and withdrawals
/// (including deliberately bad ones -- see EscrowHandler) against a single
/// pooled Escrow, and asserts the pool's accounting can never go negative:
/// pooled custody means one token balance backs many merchants' ledger rows,
/// so any desync here is other merchants' money.
contract EscrowInvariantTest is Test {
    Escrow escrow;
    LossyMockUSDC usdc;
    EscrowHandler handler;

    // Nonzero fee, so settles never deliver the full requested `auth.value`
    // -- the scenario the solvency accounting must be robust to.
    uint256 constant FEE = 1e3;

    function setUp() public {
        usdc = new LossyMockUSDC(FEE);
        escrow = new Escrow(address(usdc));
        handler = new EscrowHandler(escrow, usdc);

        targetContract(address(handler));
    }

    /// @notice Core solvency property: the pool's actual token balance must
    /// always be enough to cover every merchant's ledger credits net of what
    /// has already been withdrawn. `totalCredited`/`totalWithdrawn` are
    /// tallied from OBSERVED deltas on each merchant's own ledger row
    /// (escrow.balanceOf), not from requested amounts and not from the
    /// pool's own token balance -- so this genuinely compares two
    /// independently-tracked quantities (the private per-merchant ledger vs.
    /// the pool's real token holdings) rather than comparing a value to
    /// itself, and it still holds even though LossyMockUSDC delivers less
    /// than `auth.value` on every settle.
    function invariant_escrowHoldsAtLeastSumOfBalances() public view {
        uint256 credited = handler.totalCredited();
        uint256 withdrawn = handler.totalWithdrawn();
        assertGe(credited, withdrawn);
        assertGe(usdc.balanceOf(address(escrow)), credited - withdrawn);
    }

    /// @notice Second line of defense alongside
    /// testFuzz_settleAuthorization_merchantBindingRejectsMismatch in
    /// Escrow.t.sol: even under a long random campaign that deliberately
    /// submits merchant-mismatched settlements every so often, none may ever
    /// succeed.
    function invariant_merchantBindingNeverBroken() public view {
        assertFalse(handler.merchantBindingBroken());
    }

    /// @notice Second line of defense alongside
    /// testFuzz_authorizationCannotBeReplayed in Escrow.t.sol: a reused
    /// (merchant, paymentId) nonce, even re-signed over a different value,
    /// must never settle twice.
    function invariant_replayProtectionNeverBroken() public view {
        assertFalse(handler.replayProtectionBroken());
    }

    /// @notice Third line of defense, and load-bearing on its own: a
    /// successful over-withdrawal is not reliably visible through
    /// invariant_escrowHoldsAtLeastSumOfBalances alone. Pooled custody means
    /// the pool's physical token balance is the SUM of every actor's row, so
    /// a single actor over-withdrawing by a small margin can still be
    /// covered by other actors' pooled funds without the aggregate solvency
    /// check ever dipping below zero -- it is still theft from those other
    /// actors, just not visible in the aggregate. This invariant is what
    /// actually proves InsufficientBalance is enforced, independent of
    /// whatever the aggregate happens to look like.
    function invariant_overWithdrawNeverSucceeds() public view {
        assertFalse(handler.overWithdrawSucceeded());
    }

    /// @notice Guards against a vacuous pass: if the handler never actually
    /// credited, withdrew, or attacked anything, these would hold trivially
    /// forever (e.g. 0 >= 0, or an attempt counter that never got exercised).
    /// Foundry calls this once PER RUN (not once for the whole campaign), so
    /// every one of the 256 runs configured in foundry.toml must
    /// independently reach non-trivial state before the suite passes.
    function afterInvariant() public view {
        assertGt(handler.settleSuccesses(), 0);
        assertGt(handler.withdrawSuccesses(), 0);
        assertGt(handler.totalCredited(), 0);
        assertGt(handler.totalWithdrawn(), 0);
        assertGt(handler.mismatchAttempts(), 0);
        assertGt(handler.replayAttempts(), 0);
        assertGt(handler.overWithdrawAttempts(), 0);
        assertGt(handler.distinctCreditedActors(), 1);
    }
}
