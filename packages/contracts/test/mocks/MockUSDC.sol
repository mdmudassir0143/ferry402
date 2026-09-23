// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEIP3009} from "../../src/interfaces/IEIP3009.sol";

/// @title MockUSDC
/// @notice Minimal EIP-3009 + ERC20-ish token for tests. Mimics real USDC's
///         6 decimals and `receiveWithAuthorization` semantics closely enough
///         to exercise Escrow's redemption path, including its guardrails:
///         - only the named `to` may submit the authorization
///         - nonces are single-use per authorizer
///         - authorizations are time-windowed
///         - signatures must be non-malleable (low-s, v in {27,28}), matching
///           OpenZeppelin's ECDSA library, which real USDC uses
///         This contract is intentionally strict. It must never be weakened
///         to make a test pass — a test failing against this mock signals a
///         real bug in the caller, not a mock problem.
contract MockUSDC is IEIP3009 {
    string public constant name = "MockUSDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // secp256k1 curve order / 2, the same bound OpenZeppelin's ECDSA library
    // enforces. Rejecting s above this bound rejects the malleable "other"
    // valid signature for the same message, matching real USDC's behavior.
    uint256 private constant _SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error CallerNotPayee();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();
    error InvalidSignatureSValue();
    error InvalidSignatureVValue();
    error InsufficientBalance();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    /// @notice Test-only faucet. Deliberately unguarded: MockUSDC is never
    /// deployed outside tests, so anyone-can-mint is intentional, not a bug.
    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice The EIP-712 digest for a ReceiveWithAuthorization struct, exposed
    ///         so tests can sign it directly with `vm.sign`.
    function receiveAuthorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice EIP-3009 receiveWithAuthorization. Deliberately restricted to
    ///         `msg.sender == to` so only the named recipient can redeem —
    ///         this is what prevents front-running of a payer's signature.
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
    ) external {
        if (msg.sender != to) revert CallerNotPayee();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();
        if (uint256(s) > _SECP256K1N_HALF) revert InvalidSignatureSValue();
        if (v != 27 && v != 28) revert InvalidSignatureVValue();

        bytes32 digest = receiveAuthorizationDigest(from, to, value, validAfter, validBefore, nonce);
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert InvalidSignature();

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 fromBalance = _balances[from];
        if (fromBalance < amount) revert InsufficientBalance();
        unchecked {
            _balances[from] = fromBalance - amount;
        }
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }
}
