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

    event PaymentSettled(
        address indexed merchant, address indexed payer, uint256 value, bytes32 nonce
    );

    error RecipientMismatch();

    constructor(address token_) {
        token = IEIP3009(token_);
    }

    function balanceOf(address merchant) external view returns (uint256) {
        return _balances[merchant];
    }

    function settleAuthorization(
        address merchant,
        Authorization calldata auth,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        if (auth.to != address(this)) revert RecipientMismatch();

        token.receiveWithAuthorization(
            auth.from, auth.to, auth.value,
            auth.validAfter, auth.validBefore, auth.nonce, v, r, s
        );

        _balances[merchant] += auth.value;
        emit PaymentSettled(merchant, auth.from, auth.value, auth.nonce);
    }
}
