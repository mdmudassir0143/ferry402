// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockSmartWallet, DirtyPaddingWallet} from "./mocks/MockSmartWallet.sol";
import {Secp256k1TestHelper} from "./helpers/Secp256k1TestHelper.sol";

/// @title EscrowEip1271Test
/// @notice Task 11: EIP-1271 smart-contract-wallet signature support for
///         `Escrow.settleAuthorizationWithSignature`. Every test here must
///         fail against the pre-Task-11 contracts (no such function, no
///         `bytes signature` overload on `IEIP3009`/`MockUSDC`) — see
///         `MockSmartWallet.sol`'s doc comment for why the wallet double
///         doesn't perform real signature verification of its own: the
///         property under test is whether the CALLER (MockUSDC, and via it
///         Escrow) honors the wallet's verdict correctly, not whether a
///         smart wallet can implement its own signature scheme.
contract EscrowEip1271Test is Test, Secp256k1TestHelper {
    Escrow escrow;
    MockUSDC usdc;
    address merchant = address(0xBEEF);

    uint256 private _nextPaymentId = 1;

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new Escrow(address(usdc));
    }

    function _auth(address from, bytes32 paymentId, uint256 value)
        internal
        view
        returns (Escrow.Authorization memory)
    {
        return Escrow.Authorization({
            from: from,
            to: address(escrow),
            value: value,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(merchant, paymentId))
        });
    }

    /// @notice A smart wallet that accepts settles exactly like an EOA would
    /// — the headline property Task 11 exists to deliver.
    function test_settleAuthorizationWithSignature_smartWalletAccepts_settlesAndCredits() public {
        MockSmartWallet wallet = new MockSmartWallet(true);
        usdc.mint(address(wallet), 1_000e6);

        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(address(wallet), paymentId, 10e6);
        // Content is irrelevant (see MockSmartWallet's doc comment); its
        // length (anything but 65) is what routes MockUSDC to the EIP-1271
        // branch instead of ECDSA at all.
        bytes memory signature = hex"deadbeef";

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.PaymentSettled(merchant, address(wallet), 10e6, auth.nonce);

        escrow.settleAuthorizationWithSignature(merchant, paymentId, auth, signature);

        assertEq(escrow.balanceOf(merchant), 10e6);
        assertEq(usdc.balanceOf(address(escrow)), 10e6);
        assertEq(usdc.balanceOf(address(wallet)), 1_000e6 - 10e6);
    }

    /// @notice A wallet returning anything other than exactly the ERC-1271
    /// magic value must reject the payment.
    function test_settleAuthorizationWithSignature_smartWalletReturnsInvalid_rejects() public {
        MockSmartWallet wallet = new MockSmartWallet(false);
        usdc.mint(address(wallet), 1_000e6);

        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(address(wallet), paymentId, 10e6);
        bytes memory signature = hex"deadbeef";

        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        escrow.settleAuthorizationWithSignature(merchant, paymentId, auth, signature);

        assertEq(escrow.balanceOf(merchant), 0);
        assertEq(usdc.balanceOf(address(wallet)), 1_000e6);
    }

    /// @notice A wallet whose `isValidSignature` reverts must be treated as a
    /// rejection — a clean, catchable revert, never an unhandled/uncaught
    /// error that could brick settlement for every future call against it.
    function test_settleAuthorizationWithSignature_smartWalletReverts_rejectedNotUnhandled() public {
        MockSmartWallet wallet = new MockSmartWallet(true);
        wallet.setReverts(true);
        usdc.mint(address(wallet), 1_000e6);

        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(address(wallet), paymentId, 10e6);
        bytes memory signature = hex"deadbeef";

        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        escrow.settleAuthorizationWithSignature(merchant, paymentId, auth, signature);

        assertEq(escrow.balanceOf(merchant), 0);
    }

    /// @notice A codeless `from` can never satisfy IERC1271 — a non-65-byte
    /// signature against a plain address (no deployed code) must reject
    /// without attempting the call at all.
    function test_settleAuthorizationWithSignature_codelessFrom_rejects() public {
        address from = address(0xC0DEC0DE);
        assertEq(from.code.length, 0);
        usdc.mint(from, 1_000e6);

        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(from, paymentId, 10e6);
        bytes memory signature = hex"deadbeef";

        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        escrow.settleAuthorizationWithSignature(merchant, paymentId, auth, signature);

        assertEq(escrow.balanceOf(merchant), 0);
        assertEq(usdc.balanceOf(from), 1_000e6);
    }

    /// @notice The plain-ECDSA path through the SAME `bytes` overload (a
    /// 65-byte `r || s || v` blob from a real EOA key) must behave exactly
    /// like the dedicated `(v, r, s)` overload — adding EIP-1271 support must
    /// never disturb ordinary EOA settlement.
    function test_settleAuthorizationWithSignature_eoaPath_unchanged() public {
        uint256 payerKey = 0xA11CE;
        address payer = vm.addr(payerKey);
        usdc.mint(payer, 1_000e6);

        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(payer, paymentId, 10e6);
        bytes32 digest = usdc.receiveAuthorizationDigest(
            auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce
        );
        (uint8 rawV, bytes32 rawR, bytes32 rawS) = vm.sign(payerKey, digest);
        (uint8 v, bytes32 r, bytes32 s) = _toLowS(rawV, rawR, rawS);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.PaymentSettled(merchant, payer, 10e6, auth.nonce);

        escrow.settleAuthorizationWithSignature(merchant, paymentId, auth, signature);

        assertEq(escrow.balanceOf(merchant), 10e6);
        assertEq(usdc.balanceOf(payer), 1_000e6 - 10e6);
    }

    /// @notice A 65-byte signature whose `from` HAS code must still take the
    /// EIP-1271 path — never be misrouted to `ecrecover` just because its
    /// length happens to match a plain ECDSA blob. This is the exact gap
    /// task-11 review round 1 found in a length-based dispatch rule: a
    /// 1-of-1 smart-contract wallet whose owner signs the raw digest
    /// produces exactly this shape (65 bytes), and length-based dispatch
    /// would `ecrecover` it to the OWNER's address — never the wallet's own
    /// (a contract holds no private key, so it can never BE the recovered
    /// address) — and revert, even though the wallet's own
    /// `isValidSignature` would have accepted it. Real USDC's own
    /// `SignatureChecker.isValidSignatureNow` dispatches on `from`'s code,
    /// not signature shape, for exactly this reason.
    function test_settleAuthorizationWithSignature_smartWalletWith65ByteSignature_stillUsesEip1271() public {
        MockSmartWallet wallet = new MockSmartWallet(true);
        usdc.mint(address(wallet), 1_000e6);

        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(address(wallet), paymentId, 10e6);
        // Exactly 65 bytes -- shaped like a plain ECDSA (r, s, v) blob -- but
        // means nothing as ECDSA data; MockSmartWallet ignores it entirely
        // (see its doc comment). Low-s and v=27 so this would even survive
        // the ECDSA path's OWN shape checks if it were (wrongly) routed
        // there, making this a genuine dispatch-rule test, not merely a
        // malformed-signature test in disguise.
        bytes memory signature = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.PaymentSettled(merchant, address(wallet), 10e6, auth.nonce);

        escrow.settleAuthorizationWithSignature(merchant, paymentId, auth, signature);

        assertEq(escrow.balanceOf(merchant), 10e6);
    }

    /// @notice A wallet returning the correct 4-byte magic value followed by
    /// non-zero padding (not a proper zero-padded 32-byte word) must be
    /// rejected — task-11 review round 1's "Vector B". `DirtyPaddingWallet`
    /// can only produce this via raw assembly; no ordinary Solidity `return`
    /// can. Proves `MockUSDC._checkEip1271` validates the full return word,
    /// not just its leading 4 bytes.
    function test_settleAuthorizationWithSignature_dirtyMagicValuePadding_rejects() public {
        DirtyPaddingWallet wallet = new DirtyPaddingWallet();
        usdc.mint(address(wallet), 1_000e6);

        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(address(wallet), paymentId, 10e6);
        bytes memory signature = hex"deadbeef";

        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        escrow.settleAuthorizationWithSignature(merchant, paymentId, auth, signature);

        assertEq(escrow.balanceOf(merchant), 0);
    }

    /// @notice Same merchant-nonce binding as `settleAuthorization` — a
    /// signature valid for one merchant must not settle to another, even
    /// through the new entry point.
    function test_settleAuthorizationWithSignature_revertsWhenMerchantNotBound() public {
        MockSmartWallet wallet = new MockSmartWallet(true);
        usdc.mint(address(wallet), 1_000e6);

        bytes32 paymentId = bytes32(_nextPaymentId++);
        Escrow.Authorization memory auth = _auth(address(wallet), paymentId, 10e6);
        bytes memory signature = hex"deadbeef";

        address attacker = address(0xA77AC4);
        vm.expectRevert(Escrow.MerchantNotBound.selector);
        escrow.settleAuthorizationWithSignature(attacker, paymentId, auth, signature);
    }
}
