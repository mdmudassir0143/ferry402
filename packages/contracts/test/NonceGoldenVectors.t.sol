// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Secp256k1TestHelper} from "./helpers/Secp256k1TestHelper.sol";

/// @title NonceGoldenVectorsTest
/// @notice I1 (final whole-branch review): `Escrow._checkBinding` computes
///         `auth.nonce == keccak256(abi.encode(merchant, paymentId))`, and
///         every OTHER Solidity test that exercises this check builds its
///         EXPECTED nonce with that exact same `keccak256(abi.encode(...))`
///         expression (see `Escrow.t.sol::_auth`, `EscrowEip1271.t.sol`,
///         `EscrowSecurityDoubles.t.sol`). That proves internal
///         self-consistency, never that the expression is the RIGHT one — a
///         mutation from `abi.encode` to `abi.encodePacked` changes what the
///         contract computes AND what every test's helper recomputes, in
///         lockstep, leaving all pre-existing contract tests green while
///         every real payment reverts `MerchantNotBound` on-chain (because
///         the off-chain TypeScript `computeNonce` — pinned to these same
///         two vectors in `packages/sdk/test/nonce.test.ts` and
///         `packages/facilitator/test/verify.test.ts` — still computes the
///         `abi.encode` form and would never match). Only a live run against
///         a real deployment would catch that divergence, and the live run
///         is excluded from CI.
///
///         This test closes the gap: the nonces below are LITERAL bytes32
///         values copied from the SDK's own golden vectors
///         (`packages/sdk/test/nonce.test.ts`), never recomputed with
///         `abi.encode` in this file. Settling a real, correctly-signed
///         authorization against exactly one of these literals is the ONLY
///         way `Escrow._checkBinding` can pass; if the contract's own
///         expression ever diverges from `keccak256(abi.encode(merchant,
///         paymentId))`, the recomputed nonce no longer matches the literal
///         and `settleAuthorization` reverts `MerchantNotBound` — a failure
///         this file's own test helpers cannot mask, since they never
///         perform that computation themselves.
contract NonceGoldenVectorsTest is Test, Secp256k1TestHelper {
    Escrow escrow;
    MockUSDC usdc;
    uint256 payerKey = 0xA11CE;
    address payer;

    // Golden vector 1 — packages/sdk/test/nonce.test.ts ("matches cast
    // keccak/abi-encode for vector 1 (round addresses/ids)"), identical to
    // packages/facilitator/test/verify.test.ts's own GOLDEN_NONCE_1.
    address constant MERCHANT_1 = 0x1111111111111111111111111111111111111111;
    bytes32 constant PAYMENT_ID_1 = 0x00000000000000000000000000000000000000000000000000000000000004d2;
    bytes32 constant GOLDEN_NONCE_1 = 0xb6f7d82208db09a705e0a7e18d8c0326c05e7fc142836aa6572fa044d76f8b5f;

    // Golden vector 2 — packages/sdk/test/nonce.test.ts ("matches cast
    // keccak/abi-encode for vector 2 (EIP-55 checksummed address)").
    // A leading "00" byte keeps this from parsing as a (checksum-checked)
    // 20-byte address literal at all -- see the compiler's own suggested
    // workaround for a literal that "looks like an address" but is
    // deliberately uniform-case (0xAaAa...Aa fails EIP-55 checksum, and
    // Solidity rejects any mixed-length-40-hex-digit literal that isn't
    // properly checksummed, even a uniformly-cased one).
    address constant MERCHANT_2 = address(uint160(0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa));
    bytes32 constant PAYMENT_ID_2 = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;
    bytes32 constant GOLDEN_NONCE_2 = 0xf7d46eb5d06246fdafa7920b77e432277a012c8ea3e1c6ec7f1b413719419056;

    function setUp() public {
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        escrow = new Escrow(address(usdc));
        usdc.mint(payer, 1_000e6);
    }

    /// @notice Mutation-checked: switch `Escrow._checkBinding` to
    ///         `abi.encodePacked(merchant, paymentId)` and this test goes
    ///         red; restore `abi.encode` and it is green again — see the
    ///         branch's final-fix report for the transcript.
    function test_goldenVector1_settlesAgainstLiteralNonce() public {
        _assertLiteralNonceSettles(MERCHANT_1, PAYMENT_ID_1, GOLDEN_NONCE_1);
    }

    function test_goldenVector2_settlesAgainstLiteralNonce() public {
        _assertLiteralNonceSettles(MERCHANT_2, PAYMENT_ID_2, GOLDEN_NONCE_2);
    }

    function _assertLiteralNonceSettles(address merchant, bytes32 paymentId, bytes32 literalNonce) private {
        Escrow.Authorization memory auth = Escrow.Authorization({
            from: payer,
            to: address(escrow),
            value: 10e6,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: literalNonce
        });
        bytes32 digest =
            usdc.receiveAuthorizationDigest(auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        (v, r, s) = _toLowS(v, r, s);

        // If Escrow's binding expression ever diverges from
        // keccak256(abi.encode(merchant, paymentId)), this reverts
        // MerchantNotBound instead of succeeding: the literal nonce above
        // stops matching what the contract recomputes internally.
        escrow.settleAuthorization(merchant, paymentId, auth, v, r, s);

        assertEq(escrow.balanceOf(merchant), 10e6);
    }
}
