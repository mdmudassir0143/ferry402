// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract EscrowTest is Test {
    Escrow escrow;
    MockUSDC usdc;
    address merchant = address(0xBEEF);
    uint256 payerKey = 0xA11CE;
    address payer;

    // secp256k1 curve order / 2. vm.sign does not canonicalize its output, so
    // roughly half of all signed digests come back high-s; a real wallet SDK
    // (ethers, viem, ...) normalizes to low-s (EIP-2) before returning a
    // signature, so the test helper must do the same to produce signatures
    // MockUSDC (which rejects high-s, like real USDC) will actually accept.
    uint256 constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 constant SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

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

    function test_withdraw_transfersToMerchant() public {
        _payMerchant(10e6);
        vm.prank(merchant);
        escrow.withdraw(4e6, merchant);
        assertEq(escrow.balanceOf(merchant), 6e6);
        assertEq(usdc.balanceOf(merchant), 4e6);
    }

    function test_withdraw_revertsWhenOverBalance() public {
        _payMerchant(10e6);
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

    function _toLowS(uint8 v, bytes32 r, bytes32 s) internal pure returns (uint8, bytes32, bytes32) {
        if (uint256(s) > SECP256K1N_HALF) {
            return (v == 27 ? 28 : 27, r, bytes32(SECP256K1N - uint256(s)));
        }
        return (v, r, s);
    }
}
