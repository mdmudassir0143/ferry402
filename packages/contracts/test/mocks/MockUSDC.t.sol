// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Guardrail tests for MockUSDC itself. These exist so that, if
/// MockUSDC's checks are ever weakened (e.g. to make an Escrow test pass more
/// easily), CI catches it here rather than silently shipping a permissive
/// mock that hides real signature-verification or replay bugs.
contract MockUSDCTest is Test {
    MockUSDC usdc;
    uint256 payerKey = 0xA11CE;
    address payer;
    address to = address(0xCAFE);

    // secp256k1 curve order, used to construct the malleable "other" valid
    // signature (r, n - s, flipped v) for the low-s rejection test.
    uint256 constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 constant SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function setUp() public {
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        usdc.mint(payer, 1_000e6);
    }

    // vm.sign does not canonicalize its output, so roughly half of all signed
    // digests come back high-s; a real wallet SDK normalizes to low-s (EIP-2)
    // before returning a signature, so test helpers must do the same to
    // produce signatures MockUSDC (which rejects high-s, like real USDC)
    // will actually accept.
    function _toLowS(uint8 v, bytes32 r, bytes32 s) internal pure returns (uint8, bytes32, bytes32) {
        if (uint256(s) > SECP256K1N_HALF) {
            return (v == 27 ? 28 : 27, r, bytes32(SECP256K1N - uint256(s)));
        }
        return (v, r, s);
    }

    function _sign(
        address from,
        address recipient,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8, bytes32, bytes32) {
        bytes32 digest = usdc.receiveAuthorizationDigest(from, recipient, value, validAfter, validBefore, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return _toLowS(v, r, s);
    }

    function test_revertsWhenCallerNotPayee() public {
        bytes32 nonce = bytes32(uint256(100));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payer, to, 1e6, 0, block.timestamp + 3600, nonce);
        vm.prank(address(0xBAD));
        vm.expectRevert(MockUSDC.CallerNotPayee.selector);
        usdc.receiveWithAuthorization(payer, to, 1e6, 0, block.timestamp + 3600, nonce, v, r, s);
    }

    function test_revertsOnNonceReuse() public {
        bytes32 nonce = bytes32(uint256(101));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payer, to, 1e6, 0, block.timestamp + 3600, nonce);
        vm.prank(to);
        usdc.receiveWithAuthorization(payer, to, 1e6, 0, block.timestamp + 3600, nonce, v, r, s);

        vm.prank(to);
        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        usdc.receiveWithAuthorization(payer, to, 1e6, 0, block.timestamp + 3600, nonce, v, r, s);
    }

    function test_revertsBeforeValidAfter() public {
        bytes32 nonce = bytes32(uint256(102));
        uint256 validAfter = block.timestamp + 1000;
        (uint8 v, bytes32 r, bytes32 s) = _sign(payer, to, 1e6, validAfter, block.timestamp + 3600, nonce);
        vm.prank(to);
        vm.expectRevert(MockUSDC.AuthorizationNotYetValid.selector);
        usdc.receiveWithAuthorization(payer, to, 1e6, validAfter, block.timestamp + 3600, nonce, v, r, s);
    }

    function test_revertsAfterValidBefore() public {
        bytes32 nonce = bytes32(uint256(103));
        uint256 validBefore = vm.getBlockTimestamp() + 10;
        (uint8 v, bytes32 r, bytes32 s) = _sign(payer, to, 1e6, 0, validBefore, nonce);
        vm.warp(vm.getBlockTimestamp() + 20);
        vm.prank(to);
        vm.expectRevert(MockUSDC.AuthorizationExpired.selector);
        usdc.receiveWithAuthorization(payer, to, 1e6, 0, validBefore, nonce, v, r, s);
    }

    function test_revertsOnInvalidSignature() public {
        bytes32 nonce = bytes32(uint256(104));
        uint256 wrongKey = 0xB0B;
        bytes32 digest = usdc.receiveAuthorizationDigest(payer, to, 1e6, 0, block.timestamp + 3600, nonce);
        (uint8 rawV, bytes32 rawR, bytes32 rawS) = vm.sign(wrongKey, digest);
        (uint8 v, bytes32 r, bytes32 s) = _toLowS(rawV, rawR, rawS);
        vm.prank(to);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.receiveWithAuthorization(payer, to, 1e6, 0, block.timestamp + 3600, nonce, v, r, s);
    }

    /// @notice I3: reject the malleable "other" valid ECDSA signature for the
    /// same message. vm.sign returns the canonical low-s form; flipping to
    /// (r, n - s, flipped v) recovers the same signer but must be rejected,
    /// matching OpenZeppelin's ECDSA (which real USDC uses).
    function test_revertsOnMalleableSignature_highS() public {
        bytes32 nonce = bytes32(uint256(105));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payer, to, 1e6, 0, block.timestamp + 3600, nonce);

        bytes32 flippedS = bytes32(SECP256K1N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.prank(to);
        vm.expectRevert(MockUSDC.InvalidSignatureSValue.selector);
        usdc.receiveWithAuthorization(payer, to, 1e6, 0, block.timestamp + 3600, nonce, flippedV, r, flippedS);
    }

    /// @notice I3: reject a `v` outside {27, 28} even when `s` is otherwise
    /// low, matching OpenZeppelin's ECDSA v-range check.
    function test_revertsOnInvalidVValue() public {
        bytes32 nonce = bytes32(uint256(106));
        (, bytes32 r, bytes32 s) = _sign(payer, to, 1e6, 0, block.timestamp + 3600, nonce);
        uint8 invalidV = 29;

        vm.prank(to);
        vm.expectRevert(MockUSDC.InvalidSignatureVValue.selector);
        usdc.receiveWithAuthorization(payer, to, 1e6, 0, block.timestamp + 3600, nonce, invalidV, r, s);
    }

    /// @notice R4 guardrail: without this test, TransferToZeroAddress (M1)
    /// could be silently removed from _transfer and the suite would stay
    /// green, quietly making this mock more permissive than real USDC.
    function test_transferRevertsOnZeroAddress() public {
        vm.prank(payer);
        vm.expectRevert(MockUSDC.TransferToZeroAddress.selector);
        usdc.transfer(address(0), 1e6);
    }

    /// @notice R4 guardrail: without this test, TokenInsufficientBalance
    /// (I1, renamed from the colliding InsufficientBalance) could be
    /// silently removed from _transfer and the suite would stay green.
    function test_transferRevertsOnInsufficientBalance() public {
        vm.prank(payer);
        vm.expectRevert(MockUSDC.TokenInsufficientBalance.selector);
        usdc.transfer(to, 1_000e6 + 1);
    }
}
