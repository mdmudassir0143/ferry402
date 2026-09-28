// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC1271
/// @notice The EIP-1271 smart-contract-wallet signature-validation interface.
///         A contract implementing this can approve a signature over `hash`
///         on its own terms (multisig threshold, session key, passkey, etc.)
///         without ever holding an ECDSA private key of its own. A conforming
///         implementation MUST return exactly `0x1626ba7e`
///         (`this.isValidSignature.selector`) when `signature` is valid for
///         `hash`, and any other 4-byte value otherwise — never revert to
///         signal rejection, though callers must tolerate one anyway (an
///         unexpected revert is treated identically to an invalid return
///         value everywhere this interface is used in this codebase).
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}
