// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HostileEscrow
/// @notice Test-only fixture for task-8 review round 2. A contract deployed
///         AT `payTo` that accepts the exact same calldata shape as
///         `Escrow.settleAuthorization` (same parameter types, same order —
///         see `Escrow.sol`), but ALWAYS emits `PaymentSettled` with
///         attacker-chosen values, regardless of what authorization was
///         actually submitted, and moves no tokens at all.
///
///         Exists to prove `settlePayment`'s trusted-escrow allowlist
///         (`chains/base.ts`'s `VerifyOptions.escrows`) rejects a caller who
///         points `requirements.payTo` at this contract BEFORE ever sending
///         a transaction to it -- not merely after observing that nothing
///         was credited (`escrow.balanceOf` doesn't even apply here, since
///         this contract has no ledger at all). Round 1's `PaymentSettled`
///         emitter check alone is NOT sufficient against this: this
///         contract's log genuinely comes from `payTo`, and a forger who
///         supplies `paymentRequirements` already knows `merchant`/`nonce`
///         and can echo them in the forged log too (this fixture doesn't
///         even bother forging those correctly, to make the point that it
///         doesn't need to for the ALLOWLIST test -- the allowlist rejects
///         this contract without ever inspecting a log).
///
///         `token` (final whole-branch review, C1, mechanism 3): a public
///         immutable getter with the exact same shape as `Escrow.sol`'s own
///         `token`. Added so this fixture can still reach `settlePayment`'s
///         on-chain submission at all once `verifyPayment` itself started
///         reading `escrow.token()` and rejecting any escrow that doesn't
///         expose one matching `requirements.asset` -- a fixture with NO
///         `token()` getter (this contract's original shape) is now caught
///         at `/verify`, before ever reaching the deeper defenses this
///         fixture exists to exercise. Constructed with the SAME real token
///         address the test's `requirements.asset` names, so the escrow↔asset
///         check passes and execution proceeds to actually attempt
///         settlement against this contract -- which is the scenario this
///         fixture is for: a hostile contract that looks bindable at
///         `/verify` but forges its settlement result.
contract HostileEscrow {
    struct Authorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    address public immutable token;

    event PaymentSettled(address indexed merchant, address indexed payer, uint256 value, bytes32 nonce);

    constructor(address token_) {
        token = token_;
    }

    /// @notice Same external ABI shape as `Escrow.settleAuthorization` (see
    ///         `packages/contracts/src/Escrow.sol`), so a caller that
    ///         mistakenly (or maliciously) points `payTo` here would have it
    ///         accepted without reverting. Forges a maximally damaging fake
    ///         credit -- `type(uint256).max`, an attacker-chosen "merchant"
    ///         and "payer" (both `msg.sender`, standing in for whatever the
    ///         forger controls), and an attacker-chosen nonce that doesn't
    ///         even bother matching the real submitted authorization.
    function settleAuthorization(
        address, /* merchant */
        bytes32, /* paymentId */
        Authorization calldata, /* auth */
        uint8, /* v */
        bytes32, /* r */
        bytes32 /* s */
    ) external {
        emit PaymentSettled(msg.sender, msg.sender, type(uint256).max, keccak256("forged"));
    }
}
