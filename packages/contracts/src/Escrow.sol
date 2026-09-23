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

    event PaymentSettled(
        address indexed merchant, address indexed payer, uint256 value, bytes32 nonce
    );

    error Reentrancy();
    error RecipientMismatch();
    error MerchantNotBound();
    error ZeroMerchant();

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
    function settleAuthorization(
        address merchant,
        bytes32 paymentId,
        Authorization calldata auth,
        uint8 v, bytes32 r, bytes32 s
    ) external nonReentrant {
        if (merchant == address(0)) revert ZeroMerchant();
        if (auth.to != address(this)) revert RecipientMismatch();
        if (auth.nonce != keccak256(abi.encode(merchant, paymentId))) revert MerchantNotBound();

        uint256 before = token.balanceOf(address(this));
        token.receiveWithAuthorization(
            auth.from, auth.to, auth.value,
            auth.validAfter, auth.validBefore, auth.nonce, v, r, s
        );
        uint256 received = token.balanceOf(address(this)) - before;

        _balances[merchant] += received;
        emit PaymentSettled(merchant, auth.from, received, auth.nonce);
    }
}
