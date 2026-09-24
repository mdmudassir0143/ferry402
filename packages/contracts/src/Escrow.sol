// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEIP3009} from "./interfaces/IEIP3009.sol";

contract Escrow {
    struct Authorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    IEIP3009 public immutable token;
    mapping(address => uint256) private _balances;

    uint256 private _lock = 1;

    event PaymentSettled(address indexed merchant, address indexed payer, uint256 value, bytes32 nonce);
    event Withdrawn(address indexed merchant, address indexed to, uint256 amount);

    error Reentrancy();
    error RecipientMismatch();
    error MerchantNotBound();
    error ZeroMerchant();
    error InsufficientBalance();
    error TransferFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_) {
        token = IEIP3009(token_);
    }

    function balanceOf(address merchant) external view returns (uint256) {
        return _balances[merchant];
    }

    /// @notice Nonce binding: the payer signs an authorization whose nonce is
    /// keccak256(abi.encode(merchant, paymentId)). Changing the merchant changes the
    /// nonce, which invalidates the payer's signature. This is what stops anyone who
    /// observes the signed payload from redirecting the credit to themselves.
    /// @dev The nonce deliberately omits the payer (the token already keys nonce
    /// state per authorizer), so `paymentId` must be unique per (payer, merchant)
    /// pair: the same payer paying the same merchant twice with the same
    /// `paymentId` collides on the same nonce and reverts `AuthorizationAlreadyUsed`.
    function settleAuthorization(
        address merchant,
        bytes32 paymentId,
        Authorization calldata auth,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (merchant == address(0)) revert ZeroMerchant();
        if (auth.to != address(this)) revert RecipientMismatch();
        if (auth.nonce != keccak256(abi.encode(merchant, paymentId))) revert MerchantNotBound();

        uint256 before = token.balanceOf(address(this));
        token.receiveWithAuthorization(
            auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s
        );
        uint256 received = token.balanceOf(address(this)) - before;

        _balances[merchant] += received;
        emit PaymentSettled(merchant, auth.from, received, auth.nonce);
    }

    /// @notice Withdraws from the caller's own merchant balance. There is no
    /// owner/admin path: msg.sender can only ever move `_balances[msg.sender]`,
    /// never another merchant's funds. Guarded by nonReentrant because this is
    /// the second function (alongside settleAuthorization) that mutates the
    /// shared token balance and a per-merchant ledger entry.
    /// @dev If `to == address(this)`, the token transfer just returns the
    /// funds to the pool while `_balances[msg.sender]` is still debited,
    /// leaving an unattributed surplus in the pool's token balance. This is
    /// harmless: the solvency invariant is `token.balanceOf(this) >= sum(_balances)`,
    /// not equality, and a merchant can only ever do this to their own funds.
    function withdraw(uint256 amount, address to) external nonReentrant {
        uint256 bal = _balances[msg.sender];
        if (amount > bal) revert InsufficientBalance();
        // Effects before interaction: decrement the ledger before the
        // external token transfer, so a reentrant call (blocked by
        // nonReentrant regardless) would in any case see the post-decrement
        // balance, not a stale one.
        unchecked {
            _balances[msg.sender] = bal - amount;
        }
        _safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    /// @notice Tolerates both bool-returning ERC20 transfers (real USDC) and
    /// non-standard tokens that return no data at all (e.g. USDT-style),
    /// without pulling in an OpenZeppelin dependency. `token` has no
    /// allowlist at construction, so this keeps a non-conforming token from
    /// bricking every withdrawal on an ABI-decode revert.
    /// @dev On failure, bubbles the callee's original revert reason instead
    /// of masking it: a bare low-level call swallows revert data into a
    /// single `ok == false`, and bubbling matters both for on-chain
    /// diagnosability and because callers up the stack (including this
    /// contract's own nonReentrant guard on a reentrant call) may need the
    /// real reason, not a generic one. `TransferFailed()` is reserved for the
    /// two cases that carry no reason of their own: a bare revert with empty
    /// return data, and a token that returns `false`.
    function _safeTransfer(address to_, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSignature("transfer(address,uint256)", to_, amount));
        if (!ok) {
            if (data.length == 0) revert TransferFailed();
            assembly {
                revert(add(data, 0x20), mload(data))
            }
        }
        if (data.length != 0 && !abi.decode(data, (bool))) revert TransferFailed();
    }
}
