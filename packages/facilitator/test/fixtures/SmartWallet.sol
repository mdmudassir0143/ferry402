// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SmartWallet
/// @notice Test-only EIP-1271 smart-contract-wallet fixture, used only by
///         packages/facilitator/test/eip1271.test.ts. Its verdict on any
///         `(hash, signature)` pair is entirely controlled by the test
///         through `setAccepts`/`setReverts`, independent of the actual
///         bytes passed -- it deliberately performs no real signature
///         checking of its own, because the property under test is whether
///         the CALLER (`verifyPayment`/`settlePayment`) treats this wallet's
///         verdict correctly, not whether a smart wallet can implement its
///         own signature scheme. Mirrors
///         `packages/contracts/test/mocks/MockSmartWallet.sol` exactly, but
///         self-contained (no imports), like every other fixture in this
///         directory, so it compiles with a bare `solc` invocation:
///           solc --optimize --combined-json abi,bin test/fixtures/SmartWallet.sol
///         Regenerate `SmartWallet.abi.ts` from that output if this file
///         changes.
contract SmartWallet {
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
    ///         verdict, modeling a smart wallet whose validation logic
    ///         throws. Takes priority over `accepts`.
    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function isValidSignature(bytes32, bytes memory) external view returns (bytes4) {
        if (reverts) revert("SmartWallet: reverting by design");
        return accepts ? MAGIC_VALUE : INVALID_VALUE;
    }
}

/// @title DirtyPaddingWallet
/// @notice Returns the CORRECT 4-byte ERC-1271 magic value in the leading
///         bytes of its return word, but followed by non-zero (`0xff`)
///         padding instead of proper zero-padding -- only reachable via raw
///         assembly, since no ordinary Solidity `return` statement can
///         produce it. Used by `eip1271.test.ts` to prove
///         `verifyEip1271Signature` in `chains/base.ts` validates the FULL
///         32-byte return word (task-11 review round 1, "Vector B") rather
///         than decoding through a `bytes4`-typed `readContract`, which
///         viem itself confirms silently accepts this — see that
///         function's own doc comment.
contract DirtyPaddingWallet {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        assembly {
            mstore(0x00, 0x1626ba7effffffffffffffffffffffffffffffffffffffffffffffffffffffff)
            return(0x00, 0x20)
        }
    }
}
