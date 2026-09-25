// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice The `bytes signature` overload real USDC v2.2 also exposes.
    ///         A 65-byte `signature` is a plain ECDSA `(r, s, v)` blob and is
    ///         verified identically to the `(v, r, s)` overload above; any
    ///         other length is an EIP-1271 smart-contract-wallet signature,
    ///         verified by calling `from.isValidSignature(digest, signature)`
    ///         and requiring exactly the ERC-1271 magic value `0x1626ba7e`.
    ///         Added so a payer whose `from` is a smart-contract wallet (a
    ///         `(v, r, s)` tuple has no meaning for a contract, which holds
    ///         no private key) can still redeem an authorization — see
    ///         `MockUSDC.sol`'s implementation.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
