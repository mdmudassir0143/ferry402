// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdConstants} from "forge-std/StdConstants.sol";

/// @title Secp256k1TestHelper
/// @notice The single place this test suite defines secp256k1's curve order
///         and its half — every other test file inherits from this instead
///         of hardcoding its own copy.
///
///         Before this helper, `SECP256K1N`/`SECP256K1N_HALF` were duplicated
///         verbatim across `MockUSDC.sol`, `Escrow.t.sol`,
///         `EscrowInvariant.t.sol`, `EscrowSecurityDoubles.t.sol` and
///         `MockUSDC.t.sol`, asserted correct nowhere. Detection of a typo in
///         either literal is asymmetric: a too-LARGE half-bound is caught
///         deterministically by the malleable-signature test (a flipped
///         high-`s` signature that should be rejected gets accepted instead,
///         every single run). A too-SMALL half-bound is caught only
///         probabilistically by the ordinary happy-path test, since a fresh
///         ECDSA signature's `s` is uniformly distributed across roughly
///         half the possible values each run — a boundary this far off would
///         still pass most runs by chance (this is the direction that
///         SILENTLY WEAKENS the malleability check, and the direction this
///         codebase has already mistyped twice — see the task-7 and task-11
///         reports). `SECP256K1N` is derived here from forge-std's own
///         `StdConstants.SECP256K1_ORDER` (which forge-std tests itself)
///         rather than a second hardcoded literal, matching the equivalent
///         fix already applied on the TypeScript side
///         (`facilitator/src/chains/base.ts`'s `SECP256K1N`, pinned in
///         `facilitator/test/secp256k1n.test.ts` against the noble-curves
///         library's own secp256k1 implementation).
abstract contract Secp256k1TestHelper {
    uint256 internal constant SECP256K1N = StdConstants.SECP256K1_ORDER;
    uint256 internal constant SECP256K1N_HALF = SECP256K1N / 2;

    /// @notice Canonicalizes a raw `vm.sign` output to low-s. `vm.sign` does
    ///         not canonicalize its own output, so roughly half of all signed
    ///         digests come back high-s; a real wallet SDK (ethers, viem,
    ///         ...) normalizes to low-s (EIP-2) before returning a signature,
    ///         so any test helper that signs on a fuzzed/real key must do the
    ///         same to produce signatures MockUSDC (which rejects high-s,
    ///         like real USDC) will actually accept.
    function _toLowS(uint8 v, bytes32 r, bytes32 s) internal pure returns (uint8, bytes32, bytes32) {
        if (uint256(s) > SECP256K1N_HALF) {
            return (v == 27 ? 28 : 27, r, bytes32(SECP256K1N - uint256(s)));
        }
        return (v, r, s);
    }
}
