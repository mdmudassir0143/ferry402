// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEIP3009} from "../../src/interfaces/IEIP3009.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {Secp256k1TestHelper} from "../helpers/Secp256k1TestHelper.sol";

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
        if (to == address(0)) revert TransferToZeroAddress();
        uint256 fromBalance = _balances[from];
        if (fromBalance < amount) revert TokenInsufficientBalance();
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

    /// @dev Interface-conformance stub only: no test in this suite exercises
    /// the `bytes signature` overload against this double.
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata)
        external
        pure
    {
        revert("ReentrantMockUSDC: bytes-signature overload unused");
    }
}

/// @notice Malicious token whose transfer() reenters Escrow.withdraw before
/// returning, simulating a token that calls back into the caller mid-transfer
/// (e.g. an upgradeable or non-standard token). Used to prove nonReentrant
/// blocks a reentrant withdrawal (task 3 hard gate).
///
/// @dev The nested attempt is a direct Solidity call, and Escrow._safeTransfer
/// bubbles the callee's original revert data rather than masking it, so the
/// nested revert reason propagates unchanged all the way to the top-level
/// call. This double's own address never holds an Escrow ledger balance, so
/// a nested `withdraw` attempted as this contract (msg.sender for the nested
/// call is this token itself) would fail with Escrow.InsufficientBalance()
/// even with nonReentrant *removed* -- but that is a *different* selector
/// than Reentrancy(), which is what the guard produces when present (it is
/// checked before anything else in the modifier). Asserting on the specific
/// top-level selector is what makes this mutation-resistant: removing
/// nonReentrant changes the observed revert from Reentrancy() to
/// InsufficientBalance(), so the test would fail differently rather than
/// pass either way.
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
        // the outer withdraw call is still on the stack. A direct call, so
        // if this reverts, it reverts transfer() too, whose revert data
        // Escrow._safeTransfer bubbles unchanged.
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

    /// @dev Interface-conformance stub only: no test in this suite exercises
    /// the `bytes signature` overload against this double.
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata)
        external
        pure
    {
        revert("ReentrantWithdrawMockUSDC: bytes-signature overload unused");
    }
}

/// @notice USDT-style token whose transfer() returns no data at all --
/// bytecode-level, not just a `false` -- even though its ABI signature
/// declares `bool`. Used for I4/R2: proves Escrow.withdraw actually
/// succeeds and credits correctly through a no-return-data token, not just
/// "doesn't revert". (Every other double in this suite returns `true`, so
/// without this one the no-return-data tolerance that is the entire
/// justification for _safeTransfer was untested.)
contract NoReturnDataMockUSDC is IEIP3009 {
    mapping(address => uint256) private _bal;

    function mint(address to, uint256 amount) external {
        _bal[to] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _bal[account];
    }

    /// @dev Bypasses Solidity's normal ABI-encoding return epilogue via
    /// inline assembly, so this genuinely returns zero-length data -- the
    /// way real USDT does -- rather than an implicit `false` or `true`.
    function transfer(address to, uint256 amount) external returns (bool) {
        _bal[msg.sender] -= amount;
        _bal[to] += amount;
        assembly ("memory-safe") {
            return(0, 0)
        }
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

    /// @dev Interface-conformance stub only: no test in this suite exercises
    /// the `bytes signature` overload against this double.
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata)
        external
        pure
    {
        revert("NoReturnDataMockUSDC: bytes-signature overload unused");
    }
}

/// @notice Token whose transfer() returns an explicit `false`, the ERC20
/// convention for "the transfer failed, without reverting". Used for
/// I4/R3/R2: proves Escrow._safeTransfer treats a `false` return as a
/// failure (TransferFailed()), not a silent success.
contract FalseReturningMockUSDC is IEIP3009 {
    mapping(address => uint256) private _bal;

    function mint(address to, uint256 amount) external {
        _bal[to] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _bal[account];
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
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

    /// @dev Interface-conformance stub only: no test in this suite exercises
    /// the `bytes signature` overload against this double.
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata)
        external
        pure
    {
        revert("FalseReturningMockUSDC: bytes-signature overload unused");
    }
}

contract EscrowSecurityDoublesTest is Test, Secp256k1TestHelper {
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
    /// @dev Asserting the *specific* selector (Reentrancy, not just "some
    /// revert") is what makes this mutation-resistant. If nonReentrant were
    /// removed, the nested withdraw would still fail -- this double's own
    /// address never holds an Escrow ledger balance, so it would revert
    /// InsufficientBalance() instead -- and since Escrow._safeTransfer
    /// bubbles the original revert reason, that different selector would
    /// surface at the top level and this expectRevert would then correctly
    /// fail to match. Verified manually: see task-3-report.md.
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

    /// @notice I4/R2 regression: a withdrawal through a USDT-style token that
    /// returns no data at all must actually succeed and credit correctly --
    /// not merely "not revert". Every other double in this suite returns
    /// `true`, so without this test the no-return-data tolerance that is the
    /// entire justification for _safeTransfer was completely untested.
    function test_withdraw_succeedsAgainstNoReturnDataToken() public {
        NoReturnDataMockUSDC token = new NoReturnDataMockUSDC();
        Escrow escrow = new Escrow(address(token));
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
        escrow.withdraw(4e6, merchant);

        assertEq(escrow.balanceOf(merchant), 6e6);
        assertEq(token.balanceOf(merchant), 4e6);
    }

    /// @notice I4/R3/R2 regression: a token whose transfer() returns an
    /// explicit `false` must be treated as a failed transfer, not a silent
    /// success -- the ledger must not be left decremented against tokens
    /// that never actually moved.
    function test_withdraw_revertsAgainstFalseReturningToken() public {
        FalseReturningMockUSDC token = new FalseReturningMockUSDC();
        Escrow escrow = new Escrow(address(token));
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
        vm.expectRevert(Escrow.TransferFailed.selector);
        escrow.withdraw(4e6, merchant);

        assertEq(escrow.balanceOf(merchant), 10e6);
    }

    /// @notice R1 regression: a low-level call to a codeless address returns
    /// ok == true with empty returndata -- there is no code to execute --
    /// which is indistinguishable from a real no-return-data token unless
    /// _safeTransfer checks `token.code.length` explicitly. The high-level
    /// `token.transfer(...)` call this replaced got that check for free from
    /// solc (an automatic extcodesize check, because the call expects a
    /// return value); the switch to a low-level call dropped it.
    /// @dev A real MockUSDC is used to legitimately fund the merchant's
    /// ledger row first: settleAuthorization's own high-level
    /// `token.balanceOf(...)` call would otherwise revert against a codeless
    /// token before ever crediting anything, so this scenario can only be
    /// reached by making the token codeless *after* funding -- e.g. via
    /// vm.etch, standing in for a token that selfdestructs or is otherwise
    /// removed after merchants have already accrued a ledger balance.
    function test_withdraw_revertsAgainstCodelessToken() public {
        uint256 payerKey = 0xA11CE;
        address payer = vm.addr(payerKey);
        address merchant = address(0xBEEF);

        MockUSDC token = new MockUSDC();
        Escrow escrow = new Escrow(address(token));
        token.mint(payer, 1_000e6);

        bytes32 paymentId = bytes32(uint256(1));
        Escrow.Authorization memory auth = Escrow.Authorization({
            from: payer,
            to: address(escrow),
            value: 10e6,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: keccak256(abi.encode(merchant, paymentId))
        });
        bytes32 digest = token.receiveAuthorizationDigest(
            auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce
        );
        (uint8 rawV, bytes32 r, bytes32 rawS) = vm.sign(payerKey, digest);
        (uint8 v, bytes32 r2, bytes32 s) = _toLowS(rawV, r, rawS);
        escrow.settleAuthorization(merchant, paymentId, auth, v, r2, s);
        assertEq(escrow.balanceOf(merchant), 10e6);

        // Erase the token's bytecode, simulating a codeless address at the
        // stored `token` immutable (e.g. a selfdestructed token).
        vm.etch(address(token), "");
        assertEq(address(token).code.length, 0);

        vm.prank(merchant);
        vm.expectRevert(Escrow.TransferFailed.selector);
        escrow.withdraw(10e6, merchant);

        // Nothing must have moved: the ledger row is untouched by the
        // rejected withdrawal.
        assertEq(escrow.balanceOf(merchant), 10e6);
    }
}
