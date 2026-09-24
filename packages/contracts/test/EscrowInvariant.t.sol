// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {LossyMockUSDC} from "./mocks/EscrowSecurityDoubles.t.sol";

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
contract EscrowHandler is Test {
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

    // Second line of defense: if either critical property is ever violated
    // during the campaign, latch it here so the invariant can catch it even
    // if the pool still happens to look solvent afterwards.
    bool public merchantBindingBroken;
    bool public replayProtectionBroken;

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

        bool attemptedReplay = reuseNonce && _hasLastPaymentId[signedMerchant];
        bytes32 paymentId = attemptedReplay ? lastPaymentId[signedMerchant] : bytes32(_nextPaymentId++);
        if (attemptedReplay) replayAttempts++;

        Escrow.Authorization memory auth = Escrow.Authorization({
            from: payer,
            to: address(escrow),
            value: value,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(signedMerchant, paymentId))
        });
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        bool mismatched = wrongMerchant && actors.length > 1;
        address submittedMerchant = mismatched ? actors[(idx + 1) % actors.length] : signedMerchant;
        if (mismatched) mismatchAttempts++;

        // NOTE: the delta is measured on the MERCHANT'S OWN LEDGER ROW
        // (escrow.balanceOf), not on the pool's token balance. Measuring the
        // pool's token balance instead would make totalCredited a restatement
        // of the pool's own conservation of tokens -- it would then equal
        // usdc.balanceOf(escrow) by construction, and the solvency invariant
        // below would compare a quantity to itself and could never fail. The
        // whole point of this invariant is to compare the contract's
        // *ledger* (this delta) against its *actual token holdings*, which
        // are two independently-tracked quantities inside Escrow.
        uint256 ledgerBefore = escrow.balanceOf(submittedMerchant);
        try escrow.settleAuthorization(submittedMerchant, paymentId, auth, v, r, s) {
            settleSuccesses++;
            totalCredited += escrow.balanceOf(submittedMerchant) - ledgerBefore;

            // These two branches should be unreachable. If either fires, a
            // core safety property has broken during the campaign.
            if (mismatched) merchantBindingBroken = true;
            if (attemptedReplay) replayProtectionBroken = true;

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
    function withdraw(uint256 actorSeed, uint256 amountSeed, bool overWithdraw) external {
        withdrawAttempts++;
        (, address actor) = _actor(actorSeed);
        uint256 ledgerBalance = escrow.balanceOf(actor);

        uint256 amount = overWithdraw
            ? bound(amountSeed, ledgerBalance + 1, ledgerBalance + 1_000_000e6 + 1)
            : bound(amountSeed, 0, ledgerBalance);

        // Same reasoning as in settle(): measured against the merchant's own
        // ledger row, not the pool's token balance, so this is an
        // independent quantity from usdc.balanceOf(escrow) rather than a
        // restatement of it.
        vm.prank(actor);
        try escrow.withdraw(amount, actor) {
            withdrawSuccesses++;
            totalWithdrawn += ledgerBalance - escrow.balanceOf(actor);
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

    uint256 private constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function _toLowS(uint8 v, bytes32 r, bytes32 s) internal pure returns (uint8, bytes32, bytes32) {
        if (uint256(s) > SECP256K1N_HALF) {
            return (v == 27 ? 28 : 27, r, bytes32(SECP256K1N - uint256(s)));
        }
        return (v, r, s);
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

    /// @notice Guards against a vacuous pass: if the handler never actually
    /// credited or withdrew anything, `0 >= 0` would hold trivially forever.
    /// Runs once after the fuzzing campaign and asserts genuinely non-trivial
    /// state was reached: real successes, real attempted attacks, and
    /// multiple distinct merchants credited.
    function afterInvariant() public view {
        assertGt(handler.settleSuccesses(), 0);
        assertGt(handler.withdrawSuccesses(), 0);
        assertGt(handler.totalCredited(), 0);
        assertGt(handler.mismatchAttempts(), 0);
        assertGt(handler.replayAttempts(), 0);
        assertGt(handler.distinctCreditedActors(), 1);
    }
}
