// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEIP3009} from "../../src/interfaces/IEIP3009.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Fee-on-transfer variant of MockUSDC: skims a fixed `fee` on every
/// transfer, so the recipient receives strictly less than the amount debited
/// from the sender. Used to prove Escrow credits the observed balance delta,
/// not the requested `auth.value` (round 2, I2/I5 regression).
contract LossyMockUSDC is MockUSDC {
    uint256 public immutable fee;

    constructor(uint256 fee_) {
        fee = fee_;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fromBalance = _balances[from];
        if (fromBalance < amount) revert InsufficientBalance();
        unchecked {
            _balances[from] = fromBalance - amount;
        }
        uint256 delivered = amount - fee;
        _balances[to] += delivered;
        emit Transfer(from, to, delivered);
    }
}

/// @notice Malicious token whose receiveWithAuthorization reenters the Escrow
/// with a nested settleAuthorization call before returning. Used to prove
/// nonReentrant blocks it (round 2, I2/I5 regression).
contract ReentrantMockUSDC is IEIP3009 {
    Escrow public escrow;
    mapping(address => uint256) private _bal;

    function setEscrow(address e) external {
        escrow = Escrow(e);
    }

    function mint(address to, uint256 amount) external {
        _bal[to] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _bal[account];
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32, /* nonce */
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _bal[from] -= value;
        _bal[to] += value;

        // Attempt a nested settle, under a different (merchant, paymentId),
        // before the outer call unwinds.
        Escrow.Authorization memory nested = Escrow.Authorization({
            from: from,
            to: to,
            value: value,
            validAfter: validAfter,
            validBefore: validBefore,
            nonce: keccak256(abi.encode(address(0xF00D), bytes32(uint256(777))))
        });
        escrow.settleAuthorization(address(0xF00D), bytes32(uint256(777)), nested, v, r, s);
    }
}

/// @notice Malicious token whose transfer() reenters Escrow.withdraw before
/// returning, simulating a token that calls back into the caller mid-transfer
/// (e.g. an upgradeable or non-standard token). Used to prove nonReentrant
/// blocks a reentrant withdrawal (task 3 hard gate).
contract ReentrantWithdrawMockUSDC is IEIP3009 {
    Escrow public escrow;
    mapping(address => uint256) private _bal;

    function setEscrow(address e) external {
        escrow = Escrow(e);
    }

    function mint(address to, uint256 amount) external {
        _bal[to] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _bal[account];
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _bal[msg.sender] -= amount;
        _bal[to] += amount;
        // Attempt a nested withdraw before this transfer returns, i.e. while
        // the outer withdraw call is still on the stack.
        escrow.withdraw(amount, to);
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256, /* validAfter */
        uint256, /* validBefore */
        bytes32, /* nonce */
        uint8, /* v */
        bytes32, /* r */
        bytes32 /* s */
    ) external {
        _bal[from] -= value;
        _bal[to] += value;
    }
}

contract EscrowSecurityDoublesTest is Test {
    uint256 constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 constant SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function _toLowS(uint8 v, bytes32 r, bytes32 s) internal pure returns (uint8, bytes32, bytes32) {
        if (uint256(s) > SECP256K1N_HALF) {
            return (v == 27 ? 28 : 27, r, bytes32(SECP256K1N - uint256(s)));
        }
        return (v, r, s);
    }

    function _authFor(address payer, address escrowAddr, address merchant, bytes32 paymentId, uint256 value)
        internal
        view
        returns (Escrow.Authorization memory)
    {
        return Escrow.Authorization({
            from: payer,
            to: escrowAddr,
            value: value,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(merchant, paymentId))
        });
    }

    function _signFor(LossyMockUSDC usdc, uint256 payerKey, Escrow.Authorization memory a)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 digest = usdc.receiveAuthorizationDigest(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce);
        (uint8 rawV, bytes32 r, bytes32 rawS) = vm.sign(payerKey, digest);
        return _toLowS(rawV, r, rawS);
    }

    /// @notice I2/I5 regression: this must fail if `received` in Escrow is ever
    /// reverted back to crediting `auth.value`, since LossyMockUSDC delivers
    /// strictly less than `value`. That divergence is this test's whole point.
    function test_settleAuthorization_creditsObservedDelta_notRequestedValue() public {
        uint256 payerKey = 0xA11CE;
        address payer = vm.addr(payerKey);
        address merchant = address(0xBEEF);
        uint256 fee = 1e6;
        uint256 expected = 10e6 - fee;

        LossyMockUSDC usdc = new LossyMockUSDC(fee);
        Escrow escrow = new Escrow(address(usdc));
        usdc.mint(payer, 1_000e6);

        bytes32 paymentId = bytes32(uint256(1));
        Escrow.Authorization memory auth = _authFor(payer, address(escrow), merchant, paymentId, 10e6);
        (uint8 v, bytes32 r, bytes32 s) = _signFor(usdc, payerKey, auth);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Escrow.PaymentSettled(merchant, payer, expected, auth.nonce);

        escrow.settleAuthorization(merchant, paymentId, auth, v, r, s);

        assertEq(escrow.balanceOf(merchant), expected);
        assertEq(usdc.balanceOf(address(escrow)), expected);
    }

    /// @notice I2/I5 regression: a token that reenters settleAuthorization
    /// mid-call must be blocked by the nonReentrant guard.
    function test_nonReentrant_blocksNestedSettle() public {
        ReentrantMockUSDC token = new ReentrantMockUSDC();
        Escrow escrow = new Escrow(address(token));
        token.setEscrow(address(escrow));
        token.mint(address(0xA11CE), 1_000e6);

        Escrow.Authorization memory auth = Escrow.Authorization({
            from: address(0xA11CE),
            to: address(escrow),
            value: 10e6,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(address(0xBEEF), bytes32(uint256(1))))
        });

        vm.expectRevert(Escrow.Reentrancy.selector);
        escrow.settleAuthorization(address(0xBEEF), bytes32(uint256(1)), auth, 27, bytes32(0), bytes32(0));
    }

    /// @notice Task 3 hard gate: withdraw must carry nonReentrant. A token
    /// whose transfer() calls back into Escrow.withdraw mid-call must have
    /// that nested call blocked, and the whole outer withdraw must revert
    /// rather than silently swallow the nested failure.
    function test_withdraw_nonReentrant_blocksNestedWithdraw() public {
        ReentrantWithdrawMockUSDC token = new ReentrantWithdrawMockUSDC();
        Escrow escrow = new Escrow(address(token));
        token.setEscrow(address(escrow));
        token.mint(address(0xA11CE), 1_000e6);

        address merchant = address(0xBEEF);
        Escrow.Authorization memory auth = Escrow.Authorization({
            from: address(0xA11CE),
            to: address(escrow),
            value: 10e6,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(merchant, bytes32(uint256(1))))
        });
        escrow.settleAuthorization(merchant, bytes32(uint256(1)), auth, 27, bytes32(0), bytes32(0));
        assertEq(escrow.balanceOf(merchant), 10e6);

        vm.prank(merchant);
        vm.expectRevert(Escrow.Reentrancy.selector);
        escrow.withdraw(10e6, merchant);

        // The outer call's effects must also be rolled back: the
        // checks-effects decrement is not left applied when the interaction
        // step ultimately reverts.
        assertEq(escrow.balanceOf(merchant), 10e6);
    }
}
