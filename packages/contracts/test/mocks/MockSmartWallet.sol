// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "../../src/interfaces/IERC1271.sol";

/// @title MockSmartWallet
/// @notice Minimal EIP-1271 smart-contract-wallet test double. Its verdict on
///         any given `(hash, signature)` pair is entirely controlled by the
///         test through `setAccepts`/`setReverts`, independent of whatever
///         bytes are actually passed — this deliberately does NOT perform any
///         real signature checking of its own, because the property under
///         test throughout Task 11 is "does the caller (MockUSDC,
///         `verifyPayment`) treat this wallet's verdict correctly", not
///         "can a smart wallet implement its own signature scheme".
contract MockSmartWallet is IERC1271 {
    /// @dev EIP-1271's magic value: `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`.
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant INVALID_VALUE = 0xffffffff;

    bool public accepts;
    bool public reverts;

    constructor(bool accepts_) {
        accepts = accepts_;
    }

    /// @notice Flips whether this wallet accepts the next signature it is
    ///         asked about. Never affects `reverts`.
    function setAccepts(bool accepts_) external {
        accepts = accepts_;
    }

    /// @notice When true, `isValidSignature` reverts instead of returning a
    ///         verdict — modeling a smart wallet whose validation logic
    ///         throws (e.g. an out-of-gas guard call, a paused multisig).
    ///         Takes priority over `accepts`.
    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function isValidSignature(bytes32, bytes memory) external view returns (bytes4) {
        if (reverts) revert("MockSmartWallet: reverting by design");
        return accepts ? MAGIC_VALUE : INVALID_VALUE;
    }
}

/// @title DirtyPaddingWallet
/// @notice Returns the CORRECT 4-byte ERC-1271 magic value in the leading
///         bytes of its return word, but followed by non-zero (`0xff`)
///         padding instead of the zero padding Solidity's own ABI encoding
///         of a `bytes4` return value would normally produce — only
///         reachable at all via raw assembly, since no ordinary Solidity
///         `return` statement can produce it. Exists to prove a caller
///         validates the FULL 32-byte return word (as real USDC's
///         `SignatureChecker.sol` does, and as `MockUSDC._checkEip1271`
///         mirrors) rather than decoding through a `bytes4`-typed
///         `try {...} returns (bytes4)` (task-11 review round 1, "Vector
///         B"). NOTE: on this Solidity version, a typed decode does NOT
///         silently accept this dirty padding the way viem's `bytes4` ABI
///         decode does — confirmed by mutating `_checkEip1271` back to a
///         typed decode and re-running this double against it: it produces
///         an UNCAUGHT low-level revert instead (bypassing even the typed
///         decode's own `catch` clause), not a silent accept. See
///         `MockUSDC._checkEip1271`'s own doc comment for the full finding;
///         the viem-side equivalent (`verifyEip1271Signature` in
///         `chains/base.ts`) is where this exact return shape genuinely IS
///         silently accepted by a naive typed decode.
contract DirtyPaddingWallet {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        assembly {
            mstore(0x00, 0x1626ba7effffffffffffffffffffffffffffffffffffffffffffffffffffffff)
            return(0x00, 0x20)
        }
    }
}
