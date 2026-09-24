// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SettleToken
/// @notice Test-only EIP-3009 + ERC20-ish token fixture, used only by
///         packages/facilitator/test/settle.fork.test.ts.
///
///         Neither of this directory's other two fixtures is enough on its
///         own for a settlement test: `DomainToken.sol` exposes `name()`/
///         `version()` (so `/verify` can read the real EIP-712 domain from
///         chain) but deliberately never implements `receiveWithAuthorization`
///         at all -- it exists only to prove `/verify` doesn't hardcode the
///         domain. `packages/contracts/test/mocks/MockUSDC.sol` DOES
///         implement a real, executable `receiveWithAuthorization` (and is
///         exhaustively proven correct by `packages/contracts/test/Escrow.t.sol`),
///         but its EIP-712 domain's `version` is a private constructor-time
///         constant with no public getter -- fine for Foundry tests that sign
///         directly against its own `receiveAuthorizationDigest`, but not
///         for this facilitator's `verifyPayment`, which independently reads
///         `name()`/`version()` over RPC (Task 7's whole point: never
///         hardcode a token's domain). `settlePayment` needs BOTH properties
///         at once -- a real, redeemable authorization AND a domain the
///         facilitator can read live -- hence this fixture, which combines
///         them. Its EIP-3009 logic mirrors `MockUSDC.sol` line-for-line
///         (same guardrails: single-use nonces, time windows, non-malleable
///         low-s/v-in-{27,28} signatures); the only real difference is that
///         `version` is a public constant instead of a private one baked
///         directly into `DOMAIN_SEPARATOR`.
///
///         Self-contained (no imports), like `DomainToken.sol` in this same
///         directory, so it compiles with a bare `solc` invocation and needs
///         no foundry project of its own:
///           solc --optimize --combined-json abi,bin test/fixtures/SettleToken.sol
///         Regenerate `SettleToken.abi.ts` from that output if this file
///         changes.
contract SettleToken {
    string public constant name = "SettleToken";
    string public constant version = "1";
    uint8 public constant decimals = 6;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // secp256k1 curve order / 2 -- the same bound OpenZeppelin's ECDSA
    // library (and real USDC) enforces, rejecting the malleable "other"
    // valid signature for a given message.
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
    error TokenInsufficientBalance();
    error TransferToZeroAddress();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)
            )
        );
    }

    /// @notice Test-only faucet. Deliberately unguarded, matching MockUSDC.sol.
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

    /// @notice The EIP-712 digest for a ReceiveWithAuthorization struct,
    ///         exposed so tests can sign it directly if needed.
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

    /// @notice EIP-3009 receiveWithAuthorization, restricted to
    ///         `msg.sender == to` (matching MockUSDC.sol) so only the named
    ///         recipient (the Escrow contract, in practice) can redeem.
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
