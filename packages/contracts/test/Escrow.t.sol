// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Secp256k1TestHelper} from "./helpers/Secp256k1TestHelper.sol";

contract EscrowTest is Test, Secp256k1TestHelper {
    Escrow escrow;
    MockUSDC usdc;
    address merchant = address(0xBEEF);
    uint256 payerKey = 0xA11CE;
    address payer;

    // Counter used only to derive unique paymentIds for _payMerchant calls
    // within a single test; it is NOT the nonce itself. The nonce is
    // cryptographically bound on-chain to (merchant, paymentId) via
    // keccak256(abi.encode(merchant, paymentId)) — see _auth().
    uint256 private _nextPaymentId = 1000;

    function setUp() public {
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        escrow = new Escrow(address(usdc));
        usdc.mint(payer, 1_000e6);
    }

    /// @notice Settles a fresh authorization crediting `merchant` with
    /// `amount`, using a unique paymentId each call so the merchant-bound
    /// nonce (see Escrow.settleAuthorization) never collides.
    function _payMerchant(uint256 amount) internal {
        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(merchant, paymentId, amount);
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);
        escrow.settleAuthorization(merchant, paymentId, auth, v, r, s);
    }

    function test_settleAuthorization_creditsMerchant() public {
        bytes32 paymentId = bytes32(uint256(1));
        Escrow.Authorization memory auth = _auth(merchant, paymentId, 10e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.PaymentSettled(merchant, payer, 10e6, auth.nonce);

        escrow.settleAuthorization(merchant, paymentId, auth, v, r, s);

        assertEq(escrow.balanceOf(merchant), 10e6);
        assertEq(usdc.balanceOf(address(escrow)), 10e6);
        assertEq(usdc.balanceOf(payer), 1_000e6 - 10e6);
    }

    /// @notice Fuzzed replay proof: no matter the settled amount, resubmitting
    /// the exact same (auth, v, r, s) pair a second time must never credit
    /// the merchant again. Replay protection lives in the token's per-nonce
    /// `_authorizationStates` (see MockUSDC.receiveWithAuthorization), so the
    /// expected revert selector belongs to MockUSDC, not Escrow.
    function testFuzz_authorizationCannotBeReplayed(uint96 amountSeed) public {
        uint256 value = bound(uint256(amountSeed), 1, 1_000e6);
        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(merchant, paymentId, value);
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        escrow.settleAuthorization(merchant, paymentId, auth, v, r, s);
        assertEq(escrow.balanceOf(merchant), value);

        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        escrow.settleAuthorization(merchant, paymentId, auth, v, r, s);

        assertEq(escrow.balanceOf(merchant), value);
        assertEq(usdc.balanceOf(address(escrow)), value);
    }

    /// @notice C1 regression: the payer's signature binds `merchant` into the
    /// nonce (nonce == keccak256(abi.encode(merchant, paymentId))). Replaying
    /// the exact same (auth, v, r, s) against a different `merchant` argument
    /// must fail — otherwise anyone who observes the signed payload in transit
    /// (e.g. through an x402 resource server or facilitator) could redirect
    /// the payer's funds to themselves.
    function test_settleAuthorization_revertsWhenMerchantNotBoundToSignature() public {
        bytes32 paymentId = bytes32(uint256(2));
        Escrow.Authorization memory auth = _auth(merchant, paymentId, 10e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        address attacker = address(0xA77AC4);
        vm.expectRevert(Escrow.MerchantNotBound.selector);
        escrow.settleAuthorization(attacker, paymentId, auth, v, r, s);
    }

    /// @notice C1 regression, fuzzed: the single hand-picked `attacker` above
    /// proves the property once. This proves it for the whole address space
    /// (minus the trivial signedMerchant == submittedMerchant case) and every
    /// (paymentId, amount) combination -- an authorization signed for
    /// `signedMerchant` must never settle to any other address. This is the
    /// regression barrier for the critical flaw found in Task 2: without the
    /// on-chain nonce binding, anyone holding a signed payload could redirect
    /// the credit to themselves.
    function testFuzz_settleAuthorization_merchantBindingRejectsMismatch(
        address signedMerchant,
        address submittedMerchant,
        uint256 paymentIdSeed,
        uint96 amountSeed
    ) public {
        vm.assume(signedMerchant != address(0));
        vm.assume(submittedMerchant != address(0));
        vm.assume(signedMerchant != submittedMerchant);

        uint256 value = bound(uint256(amountSeed), 1, 1_000e6);
        bytes32 paymentId = bytes32(paymentIdSeed);

        Escrow.Authorization memory auth = _auth(signedMerchant, paymentId, value);
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        vm.expectRevert(Escrow.MerchantNotBound.selector);
        escrow.settleAuthorization(submittedMerchant, paymentId, auth, v, r, s);

        assertEq(escrow.balanceOf(signedMerchant), 0);
        assertEq(escrow.balanceOf(submittedMerchant), 0);

        // MerchantNotBound fires before signature recovery, the balance
        // check, and the token call, so the mismatch revert above alone
        // would still pass even against a broken `_sign` or an unfunded
        // payer -- it proves nothing about whether the payload was
        // otherwise valid. Settle the exact same (auth, v, r, s) to the
        // merchant it was actually signed for and require it to succeed,
        // so a mutation that broke the fuzzed inputs themselves (rather
        // than the binding check) can't hide behind this test.
        escrow.settleAuthorization(signedMerchant, paymentId, auth, v, r, s);
        assertEq(escrow.balanceOf(signedMerchant), value);
    }

    function test_settleAuthorization_revertsOnRecipientMismatch() public {
        bytes32 paymentId = bytes32(uint256(3));
        Escrow.Authorization memory auth = Escrow.Authorization({
            from: payer,
            to: address(0xDEAD),
            value: 10e6,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(merchant, paymentId))
        });
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        vm.expectRevert(Escrow.RecipientMismatch.selector);
        escrow.settleAuthorization(merchant, paymentId, auth, v, r, s);
    }

    function test_settleAuthorization_revertsOnZeroMerchant() public {
        bytes32 paymentId = bytes32(uint256(4));
        Escrow.Authorization memory auth = _auth(address(0), paymentId, 10e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        vm.expectRevert(Escrow.ZeroMerchant.selector);
        escrow.settleAuthorization(address(0), paymentId, auth, v, r, s);
    }

    /// @notice R5: withdraws to a `to` distinct from `merchant`, so a
    /// mutation swapping the Withdrawn event's (merchant, to) argument
    /// positions would produce a mismatched log and fail this test. Sending
    /// to `merchant` itself would leave both indexed topics holding the same
    /// value, masking exactly that kind of bug.
    function test_withdraw_transfersToMerchant() public {
        _payMerchant(10e6);
        address payoutAddress = address(0xFEED);

        vm.prank(merchant);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.Withdrawn(merchant, payoutAddress, 4e6);
        escrow.withdraw(4e6, payoutAddress);

        assertEq(escrow.balanceOf(merchant), 6e6);
        assertEq(usdc.balanceOf(payoutAddress), 4e6);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    /// @notice I1 regression: MockUSDC's own insufficient-balance error and
    /// Escrow.InsufficientBalance() are both zero-argument errors, so they
    /// compile to the identical 4-byte selector (selectors are derived from
    /// the signature string alone, not the declaring contract). If the pool
    /// held exactly the merchant's own row, a broken ledger guard could
    /// "accidentally" revert via the token's own balance check instead of
    /// Escrow's, with the same selector, and this test would never notice.
    /// Funding the pool with another merchant's deposit first (so the pool
    /// holds more than `merchant`'s row) makes the two checks genuinely
    /// distinguishable: only Escrow's ledger check can fire here, since the
    /// token has plenty of balance to physically satisfy the request.
    function test_withdraw_revertsWhenOverBalance() public {
        _payMerchant(10e6);

        address other = address(0xCAFE);
        bytes32 otherPaymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory otherAuth = _auth(other, otherPaymentId, 5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(otherAuth);
        escrow.settleAuthorization(other, otherPaymentId, otherAuth, v, r, s);
        // Pool now holds 15e6 total token balance; merchant's own row is 10e6.

        vm.prank(merchant);
        vm.expectRevert(Escrow.InsufficientBalance.selector);
        escrow.withdraw(11e6, merchant);
    }

    /// @notice There is no owner/admin path in Escrow at all — withdraw only
    /// ever debits `_balances[msg.sender]`. An unrelated caller with no
    /// ledger balance of their own can't withdraw anything, merchant funds
    /// included, because `amount > bal` (0) always trips InsufficientBalance.
    function test_noAdminCanMoveMerchantFunds() public {
        _payMerchant(10e6);
        vm.prank(address(0xDEAD));
        vm.expectRevert(Escrow.InsufficientBalance.selector);
        escrow.withdraw(10e6, address(0xDEAD));
    }

    /// @notice Security proof: pooled custody means one token balance backs
    /// many merchants' ledger rows. A merchant withdrawing their own balance
    /// must not move or zero out another merchant's `_balances` entry.
    function test_withdraw_doesNotTouchOtherMerchantBalance() public {
        _payMerchant(10e6);

        address other = address(0xCAFE);
        bytes32 otherPaymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory otherAuth = _auth(other, otherPaymentId, 5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(otherAuth);
        escrow.settleAuthorization(other, otherPaymentId, otherAuth, v, r, s);

        vm.prank(merchant);
        escrow.withdraw(10e6, merchant);

        assertEq(escrow.balanceOf(merchant), 0);
        assertEq(escrow.balanceOf(other), 5e6);
        assertEq(usdc.balanceOf(other), 0);
        assertEq(usdc.balanceOf(address(escrow)), 5e6);
    }

    /// @notice I2 regression: test_withdraw_doesNotTouchOtherMerchantBalance
    /// (above) only proves a *well-behaved* withdrawal is well-behaved — it
    /// never attempts an over-withdrawal, so it doesn't prove the headline
    /// claim of this task: that a merchant cannot reach into another
    /// merchant's row. This test actually attacks: `merchant` tries to pull
    /// the entire pool (15e6), which is more than their own row (10e6) but
    /// no more than the token's physical balance in the escrow (which also
    /// holds `other`'s 5e6). The request must be rejected by the ledger
    /// check, and `other`'s row plus the escrow's token holdings must be
    /// completely untouched afterward.
    function test_withdraw_attackerCannotDrainOtherMerchantsRow() public {
        _payMerchant(10e6); // credits `merchant`

        address other = address(0xCAFE);
        bytes32 otherPaymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory otherAuth = _auth(other, otherPaymentId, 5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(otherAuth);
        escrow.settleAuthorization(other, otherPaymentId, otherAuth, v, r, s);
        // Pool: 15e6 total token balance, 10e6 attributable to merchant, 5e6 to other.

        vm.prank(merchant);
        vm.expectRevert(Escrow.InsufficientBalance.selector);
        escrow.withdraw(15e6, merchant); // the whole pool, including `other`'s row

        assertEq(escrow.balanceOf(merchant), 10e6);
        assertEq(escrow.balanceOf(other), 5e6);
        assertEq(usdc.balanceOf(address(escrow)), 15e6);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function _auth(address merchant_, bytes32 paymentId, uint256 value)
        internal
        view
        returns (Escrow.Authorization memory)
    {
        return Escrow.Authorization({
            from: payer,
            to: address(escrow),
            value: value,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(merchant_, paymentId))
        });
    }

    function _sign(Escrow.Authorization memory a) internal view returns (uint8, bytes32, bytes32) {
        bytes32 digest = usdc.receiveAuthorizationDigest(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return _toLowS(v, r, s);
    }
}
