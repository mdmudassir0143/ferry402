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

    function setUp() public {
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        escrow = new Escrow(address(usdc));
        usdc.mint(payer, 1_000e6);
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

    function _sign(Escrow.Authorization memory a)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 digest = usdc.receiveAuthorizationDigest(
            a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce
        );
        return vm.sign(payerKey, digest);
    }
}
