// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StringRevertToken
/// @notice Test-only EIP-3009 + ERC20-ish token fixture, used only by
///         settle.fork.test.ts's duplicate-settlement (`Error(string)` tier)
///         regression test.
///
///         Identical to `SettleToken.sol` in every respect except how it
///         reports a replayed (already-consumed) authorization: real Circle
///         USDC (`FiatTokenV2`) rejects nonce reuse with a plain Solidity
///         `require(..., "FiatTokenV2: authorization is used or canceled")`
///         — a STRING revert, decodable via the standard `Error(string)`
///         selector with no ABI needed (see `decodeSettleRevert`'s tier 2 in
///         `chains/base.ts`) — not a custom error the way `SettleToken.sol`'s
///         `AuthorizationAlreadyUsed()` is (tier 3, selector-matched). Both
///         tiers map to x402's `duplicate_settlement`, but only the selector
///         tier had a committed regression test before this fixture existed;
///         this one exercises the string tier against a real revert instead
///         of only a probe (task-8 review round 2).
contract StringRevertToken {
    string public constant name = "StringRevertToken";
    string public constant version = "1";
    uint8 public constant decimals = 6;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // secp256k1's curve order (task-11 review round 1, item (e)): derived
    // as ORDER / 2 rather than a separately hand-written half literal -- see
    // SettleToken.sol's identical constant for the full rationale.
    uint256 private constant _SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant _SECP256K1N_HALF = _SECP256K1N / 2;

    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)
            )
        );
    }

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

    /// @notice Same guardrails as `SettleToken.sol`, but reports a replayed
    ///         nonce with real Circle USDC's OWN revert string, verbatim —
    ///         not a custom error.
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
        require(msg.sender == to, "FiatTokenV2: caller must be the payee");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled");
        require(uint256(s) <= _SECP256K1N_HALF, "FiatTokenV2: invalid signature 's' value");
        require(v == 27 || v == 28, "FiatTokenV2: invalid signature 'v' value");

        bytes32 digest = receiveAuthorizationDigest(from, to, value, validAfter, validBefore, nonce);
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == from, "FiatTokenV2: invalid signature");

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "FiatTokenV2: transfer to the zero address");
        uint256 fromBalance = _balances[from];
        require(fromBalance >= amount, "FiatTokenV2: transfer amount exceeds balance");
        unchecked {
            _balances[from] = fromBalance - amount;
        }
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }
}
