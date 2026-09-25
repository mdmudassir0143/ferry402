// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEIP3009} from "../../src/interfaces/IEIP3009.sol";
import {IERC1271} from "../../src/interfaces/IERC1271.sol";
import {Secp256k1TestHelper} from "../helpers/Secp256k1TestHelper.sol";

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
contract MockUSDC is IEIP3009, Secp256k1TestHelper {
    string public constant name = "MockUSDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // secp256k1 curve order / 2 (SECP256K1N_HALF, inherited from
    // Secp256k1TestHelper) is the same bound OpenZeppelin's ECDSA library
    // enforces. Rejecting s above this bound rejects the malleable "other"
    // valid signature for the same message, matching real USDC's behavior.

    bytes32 public immutable DOMAIN_SEPARATOR;

    // internal, not private: LossyMockUSDC overrides _transfer to model a
    // fee-on-transfer token and needs to read/write balances directly.
    mapping(address => uint256) internal _balances;
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
    // Named distinctly from Escrow.InsufficientBalance(): both are
    // zero-argument errors, and Solidity selectors are derived from the
    // signature string alone (not the declaring contract), so identically
    // named errors in different contracts collide on the same 4-byte
    // selector. A test asserting Escrow's ledger-check revert must not be
    // able to pass "by accident" via this token-level revert instead.
    error TokenInsufficientBalance();
    error TransferToZeroAddress();

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
        bytes32 digest = _checkAuthorization(from, to, value, validAfter, validBefore, nonce);
        if (uint256(s) > SECP256K1N_HALF) revert InvalidSignatureSValue();
        if (v != 27 && v != 28) revert InvalidSignatureVValue();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != from) revert InvalidSignature();

        _finalizeAuthorization(from, to, value, nonce);
    }

    /// @notice The `bytes signature` overload (Task 11). Branches on `from`'s
    ///         on-chain code — mirroring real USDC v2.2's own
    ///         `SignatureChecker.isValidSignatureNow`, which both
    ///         `receiveWithAuthorization` overloads collapse onto — NOT on
    ///         `signature.length` (task-11 review round 1: length-based
    ///         dispatch misroutes a 1-of-1 smart-contract wallet's
    ///         incidentally-65-byte owner signature to `ecrecover`, which
    ///         recovers the OWNER's address, not the wallet's, and reverts,
    ///         even though the wallet's own `isValidSignature` would have
    ///         accepted it). A codeless `from` takes the identical
    ///         non-malleable ECDSA check as the `(v, r, s)` overload above,
    ///         and REQUIRES exactly 65 bytes (any other length rejects
    ///         outright, with no external call attempted — a codeless
    ///         address can never implement EIP-1271). A `from` with code
    ///         ALWAYS takes EIP-1271, regardless of length: `isValidSignature`
    ///         must return exactly `0x1626ba7e` as the FULL 32-byte word (see
    ///         `_checkEip1271`'s doc comment for why this is a raw `staticcall`
    ///         rather than a typed `try/catch` decode) — a wrong value, dirty
    ///         padding, or a revert all reject.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        bytes32 digest = _checkAuthorization(from, to, value, validAfter, validBefore, nonce);

        if (from.code.length == 0) {
            if (signature.length != 65) revert InvalidSignature();
            bytes32 r = abi.decode(signature[0:32], (bytes32));
            bytes32 s = abi.decode(signature[32:64], (bytes32));
            uint8 v = uint8(signature[64]);
            if (uint256(s) > SECP256K1N_HALF) revert InvalidSignatureSValue();
            if (v != 27 && v != 28) revert InvalidSignatureVValue();
            address signer = ecrecover(digest, v, r, s);
            if (signer == address(0) || signer != from) revert InvalidSignature();
        } else {
            if (!_checkEip1271(from, digest, signature)) revert InvalidSignature();
        }

        _finalizeAuthorization(from, to, value, nonce);
    }

    /// @notice Verifies an EIP-1271 signature via a raw `staticcall`,
    ///         requiring the FULL 32-byte return word to equal
    ///         `bytes32(IERC1271.isValidSignature.selector)` — deliberately
    ///         NOT a `try { ... } returns (bytes4 magicValue)` typed decode,
    ///         mirroring real USDC's own `SignatureChecker.sol` exactly
    ///         (a raw call plus a full-word `abi.decode(result, (bytes32))`
    ///         comparison, not a typed `bytes4` return).
    ///
    ///         Verified directly (`test_settleAuthorizationWithSignature_dirtyMagicValuePadding_rejects`,
    ///         mutated back to a typed decode and re-run): on THIS Solidity
    ///         version, a wallet returning `0x1626ba7e` followed by non-zero
    ///         padding does NOT cause a typed decode to silently accept it —
    ///         Solidity's own ABI-decoding of `bytes4` rejects the dirty
    ///         padding, but as an UNCAUGHT low-level revert that bypasses
    ///         this function's own `catch` clause entirely (it happens
    ///         during the caller's decoding of an otherwise-successful
    ///         call, not as a failure of the call itself), surfacing as an
    ///         opaque, unlabeled revert instead of this contract's own
    ///         `InvalidSignature()`. So the raw-`staticcall` form here isn't
    ///         closing a silent-acceptance hole on the Solidity side (there
    ///         isn't one) — it's what keeps this rejection reason uniform
    ///         and catchable, the same discipline `_safeTransfer` already
    ///         applies to a codeless/non-conforming token. The TypeScript
    ///         side (`verifyEip1271Signature` in `chains/base.ts`) is where
    ///         this exact shape of return value genuinely IS silently
    ///         accepted by a naive typed decode (confirmed directly against
    ///         viem) — see that function's doc comment.
    ///
    ///         `result.length == 32` additionally rejects a short/long/empty
    ///         return (including a revert, which yields empty `result` and
    ///         `success == false`) in the same expression, so a revert, a
    ///         wrong value, and dirty padding are all a uniform `false`.
    function _checkEip1271(address from, bytes32 digest, bytes calldata signature) private view returns (bool) {
        (bool success, bytes memory result) =
            from.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
        return success && result.length == 32 && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    /// @notice Shared guardrails for both `receiveWithAuthorization`
    ///         overloads: payee-only caller, time window, single-use nonce.
    ///         Returns the EIP-712 digest both overloads verify a signature
    ///         over, so it is computed exactly once regardless of which
    ///         signature scheme is used.
    function _checkAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private view returns (bytes32 digest) {
        if (msg.sender != to) revert CallerNotPayee();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();
        digest = receiveAuthorizationDigest(from, to, value, validAfter, validBefore, nonce);
    }

    /// @notice Marks `nonce` used and moves the funds — the shared tail of
    ///         both `receiveWithAuthorization` overloads, run only after
    ///         whichever signature scheme applies has already verified.
    function _finalizeAuthorization(address from, address to, uint256 value, bytes32 nonce) private {
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        // Real USDC's _transfer reverts on transfers to the zero address;
        // matching that here keeps this mock at least as strict as the real
        // token, per this contract's own "intentionally strict" docstring.
        if (to == address(0)) revert TransferToZeroAddress();
        uint256 fromBalance = _balances[from];
        if (fromBalance < amount) revert TokenInsufficientBalance();
        unchecked {
            _balances[from] = fromBalance - amount;
        }
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }
}
