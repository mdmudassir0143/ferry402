# Architecture

This is how `ferry402` actually works, end to end, for someone deciding
whether to put it in front of a real route. It assumes you've read the root
[`README.md`](../README.md) — this document doesn't repeat the quickstart or
the config reference, it explains the mechanics and the trust model behind
them. See [`docs/deployments.md`](deployments.md) for the live transaction
record this document's claims are checked against, and
[`docs/troubleshooting.md`](troubleshooting.md) for what happens when one of
these steps fails.

## The problem, and what actually crosses a chain boundary

An x402-protected merchant route lives on one chain's USDC. A payer may hold
USDC on a different chain, or the merchant may simply not want to write
chain-specific settlement code for every chain they're willing to accept from.
`ferry402` lets a merchant advertise payment acceptance across multiple EVM
chains (`'base' | 'base-sepolia' | 'polygon' | 'polygon-amoy'` in the SDK's
`SupportedChain` type) from one Express middleware call, while keeping Hedera
as a clearing-layer ledger that is authoritative across all of them.

The one fact to hold onto while reading the rest of this document: **value
never bridges per payment.** A payer's USDC moves exactly once, on the chain
it already lives on — from the payer's wallet into that chain's `Escrow.sol`
contract, via the same `receiveWithAuthorization` call any EIP-3009 transfer
uses. Nothing is wrapped, bridged, or re-minted on another chain. What *does*
cross to Hedera is a small JSON record of the fact that the payment happened —
written as one Hedera Consensus Service (HCS) message, via
`ConsensusSubmitMessage` — not the money itself. Hedera carries the journal;
the source chain carries the money.

This matters because it's also the boundary of what this slice implements.
`packages/facilitator/src/chains/base.ts` has exactly one chain adapter today
(`SUPPORTED_CHAINS = { base, 'base-sepolia': baseSepolia }`). `polygon` and
`polygon-amoy` are real members of the SDK's `SupportedChain` type —
`buildRequirements` will happily build a `PaymentRequirements` entry for
them — but a `/verify` or `/settle` call naming either network has no adapter
to run against and is rejected as `invalid_network`. The config surface is
ahead of the settlement implementation on purpose (so the merchant-facing API
doesn't need to change shape when a chain is added); don't configure
`accept: ['polygon']` today and expect it to work. See the design doc's
[Arbitrum/Polygon chain-adapter build sequence](superpowers/specs/2026-09-23-ferry402-design.md#build-sequence)
for where that's headed.

There is also no cross-chain netting or consolidation in this slice — see
["What is not built"](#what-is-not-built) below.

## The full request lifecycle

```
Payer                ferry402 (merchant)              Facilitator                   Escrow.sol              HCS Topic
  |                         |                               |                      (Base Sepolia)             (Hedera)
  |--- GET /resource ------>|                               |                            |                       |
  |                         | issueChallenge(resource)      |                            |                       |
  |                         | paymentId = HMAC-SHA256(      |                            |                       |
  |                         |   secret, merchantEvm|resource|timeBucket)                 |                       |
  |                         | nonce = keccak256(abi.encode( |                            |                       |
  |                         |   merchantEvm, paymentId))    |                            |                       |
  |                         | — pure, no store write        |                            |                       |
  |<-- 402 {accepts:[...]}--|                               |                            |                       |
  |                         |                               |                            |                       |
  | signs EIP-3009 ReceiveWithAuthorization over that exact nonce (createPaymentHeader)   |                       |
  |                         |                               |                            |                       |
  |--- GET /resource ------>|                               |                            |                       |
  |   X-PAYMENT: <header>   |                               |                            |                       |
  |                         | matchChallenge() recomputes   |                            |                       |
  |                         | the nonce for this/prev bucket|                            |                       |
  |                         | local floor checks (amount,   |                            |                       |
  |                         | payTo, validAfter/Before)     |                            |                       |
  |                         | consumeIfAbsent(from, nonce)  |                            |                       |
  |                         |-- POST /verify -------------->|                            |                       |
  |                         |                               | re-check trusted-escrow   |                       |
  |                         |                               | allowlist for payTo       |                       |
  |                         |                               | recompute merchant-bound  |                       |
  |                         |                               | nonce, reject mismatch    |                       |
  |                         |                               | recover + validate sig    |                       |
  |                         |                               | escrow.token() == asset?  |                       |
  |                         |                               | balanceOf(payer) >= price |                       |
  |                         |<-- { isValid: true, payer } --|                            |                       |
  |<== 200, resource body ==|                               |                            |                       |
  |   SERVED HERE — before any on-chain settlement           |                           |                       |
  |                         |-- POST /settle --------------->|                           |                       |
  |                         |                               |-- settleAuthorization(    |                       |
  |                         |                               |     merchantEvm,paymentId,|                       |
  |                         |                               |     auth, v, r, s) ------->|                       |
  |                         |                               |                            | pulls USDC via        |
  |                         |                               |                            | receiveWithAuthorization
  |                         |                               |<-- PaymentSettled(merchant,|                       |
  |                         |                               |    payer, value, nonce) ---|                       |
  |                         |<-- { success, tx, settledAmount } --                       |                       |
  |                         |-- journalEntryForSettlement + writeEntry ------------------------------------->   |
  |                         |                               |                            |      ConsensusSubmitMessage
  |                         |                               |                            |       (~$0.0008, sequenced)
```

Step by step:

1. **Unpaid request.** An anonymous `GET` arrives with no `X-PAYMENT` header.
   `ferry402()` calls its own `issueChallenge` and returns a `402` with an
   `accepts` array — one `PaymentRequirements` entry per chain in
   `config.accept`.
2. **Stateless challenge derivation.** Each entry's `extra.paymentId` is
   `HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)` — a pure
   function of config and the current 300-second time bucket, computed fresh
   on every request with zero reads or writes. See
   `packages/sdk/src/challengeDerivation.ts`. The nonce the payer will sign is
   `keccak256(abi.encode(merchantEvm, paymentId))` (`packages/sdk/src/nonce.ts`'s
   `computeNonce`) — the same hash `Escrow.sol` recomputes on-chain.
3. **Payer signs EIP-3009.** The payer calls `createPaymentHeader()`
   (`packages/sdk/src/paymentHeader.ts`), which derives that exact nonce and
   signs a `ReceiveWithAuthorization` struct over it, then base64-encodes the
   result as an `X-PAYMENT` header value. **A stock `x402@1.2.0` client cannot
   do this step** — see [`docs/troubleshooting.md`](troubleshooting.md) for
   why that's by design, not a bug.
4. **Retry with `X-PAYMENT`.** `ferry402()` recomputes the nonce locally
   (`matchChallenge`, checking the current and previous time bucket), runs
   cheap local floor checks (amount, `payTo`, validity window), atomically
   consumes the `(from, nonce)` pair against its `ConsumedNonceStore`, and
   only then calls the facilitator.
5. **Facilitator `/verify`.** `verifyPayment` (`packages/facilitator/src/chains/base.ts`)
   re-runs the merchant-binding check independently, confirms `payTo` is on
   the facilitator's own trusted-escrow allowlist, recovers and validates the
   signature (ECDSA or EIP-1271), confirms the escrow's bound token matches
   the requirement's `asset`, and reads the payer's live USDC balance. See
   ["What `/verify` has to prove"](#what-verify-has-to-prove) below for why
   this check list is longer than "is the signature valid."
6. **Resource served.** On `isValid: true`, `ferry402()` calls `next()` and
   your route handler runs — **before** anything has touched the chain.
7. **`/settle` on-chain.** Your route handler (not `ferry402()` itself — see
   the root README's "Typical wiring") calls the facilitator's `POST /settle`,
   which re-verifies from scratch and then submits
   `Escrow.settleAuthorization` (or the EIP-1271 variant) from the
   facilitator's own wallet. `Escrow.sol` pulls USDC via
   `receiveWithAuthorization`, measures the balance delta, credits the
   merchant's ledger row, and emits `PaymentSettled`.
8. **HCS journal write.** The route handler builds a `JournalEntry` from the
   *observed* `PaymentSettled.value` (never the amount merely requested — see
   Amendment 2 below) and submits it to the configured HCS topic via
   `writeEntry`/`writeEntries` (`packages/facilitator/src/journal.ts`).

## Serve-then-settle: say it plainly

**The resource is served after `/verify` returns `isValid: true`, and before
`/settle` ever touches the chain.** This is not an implementation accident —
it's the same trust assumption x402 itself makes (a verified signature is
treated as good as cash for a small payment), made explicit here because it
has a real consequence: between step 6 and step 7, there is a window where the
merchant has given away the resource against a signature that has not yet
been redeemed on-chain.

That means `/verify` cannot just check "is this signature valid." A
signature can be perfectly genuine and still never settle. `verifyPayment`
closes each of the concrete ways that can happen:

- **Payer solvency.** `insufficient_funds` — `getErc20Balance` reads the
  payer's live USDC balance (never cached, unlike everything else this module
  memoizes) and rejects if it's below `maxAmountRequired`. Without this, a
  throwaway keypair with a validly-signed, zero-balance authorization would
  pass every other check and get a free resource, repeatably, for the cost of
  generating a keypair.
- **Settlement-time buffer.** `authorization.validBefore` must still have at
  least `VERIFY_SETTLEMENT_BUFFER_SECONDS` (10 seconds) of life left at
  `/verify` time, not merely be unexpired right now. `receiveWithAuthorization`
  enforces `validBefore` at redemption time, and the RPC round trip, mempool
  inclusion, and `/settle`'s own retry/timeout budget can eat several seconds
  before the authorization actually lands — an authorization that passed
  `/verify` with one second left could legitimately expire before `/settle`
  ever submits it.
- **Escrow-asset binding.** `requirements.payTo` being on the trusted-escrow
  allowlist proves `payTo` is a real `Escrow.sol` this facilitator operates;
  it proves nothing about whether `requirements.asset` is the *same* token
  that escrow will actually try to pull from. `getEscrowToken` reads
  `escrow.token()` live (memoized — it's immutable on-chain) and rejects a
  mismatch. Without this, a misconfigured `assets[chain]` would verify a
  signature against the wrong token's EIP-712 domain, pass every other check,
  and then revert at `/settle` on every single request.
- **Merchant binding**, covered below, closes the "redirect to a different
  merchant" case specifically.

What all of that does **not** close: a verified, solvent, correctly-bound
authorization can still fail to settle for reasons outside `/verify`'s
control — another transaction spending the payer's balance in the gap, a
reorg, or the facilitator's own wallet running low on gas. The residual risk
of serve-then-settle is real, not eliminated; `/verify`'s job is to make
every *predictable* way an accepted payment fails to settle as narrow as
possible, not to make settlement a certainty. A merchant serving an
expensive resource for a correspondingly large payment should weigh that
residual window explicitly; it's the same trade-off x402 asks of every
`exact`-scheme integration, not something `ferry402` introduces.

## Design decisions: the three amendments

These are documented in full, with the defect each one fixes, in
[the design doc's three amendments](superpowers/specs/2026-09-23-ferry402-design.md#amendment-1--merchant-binding-2026-09-24).
Summarized here as decisions, because they shape nearly every file in
`packages/sdk` and `packages/facilitator`:

**Amendment 1 — merchant binding.** EIP-3009's `ReceiveWithAuthorization`
typehash commits the payer's signature to six fields — `from, to, value,
validAfter, validBefore, nonce` — and none of them is "which merchant gets
credited." An early design passed `merchant` as a separate, caller-supplied
argument to a permissionless `settleAuthorization`, which meant *anyone*
holding a valid `(auth, v, r, s)` tuple — the resource server, the
facilitator, any proxy in between — could call `settleAuthorization(attacker,
auth, v, r, s)` and redirect the credit. The fix folds the beneficiary into
the nonce itself: `nonce = keccak256(abi.encode(merchantEvm, paymentId))`.
Changing the merchant changes the nonce, which invalidates the payer's
signature. `Escrow.settleAuthorization` recomputes this and reverts
`MerchantNotBound` on a mismatch; `/verify` recomputes the identical hash
off-chain so a redirect attempt fails before any gas is spent.

**Amendment 2 — credit the observed delta.** `Escrow.sol` credits
`token.balanceOf(address(this))` measured before and after the
`receiveWithAuthorization` call — the actual amount received — never
`auth.value`, the amount merely requested. Under a fee-on-transfer,
deflationary, or rebasing token those two numbers can differ, and because the
escrow is pooled custody, over-crediting against `auth.value` would create
first-come-first-served insolvency the moment withdrawal is used. The journal
writer inherits this discipline: `journalEntryForSettlement` only ever reads
`settledAmount` off a successful `SettleResult` (itself sourced from the
verified `PaymentSettled` log), never from an authorization.

**Amendment 3 — two-part merchant identity.** Hedera, the clearing layer,
keys on a Hedera account id (`0.0.123456`). Each source chain's `Escrow`
ledger row — and the nonce's `merchantEvm` preimage — keys on an EVM address.
An early design conflated the two under one `merchant` field; emitting the
Hedera account id in `PaymentRequirements.extra` makes the nonce
uncomputable by any client (the contract hashes an `address`, not a dotted
account id), so every payment would fail `MerchantNotBound`. The fix is
`Ferry402Config` carrying both: `merchant` (Hedera account id) and
`merchantEvm` (a `Record<SupportedChain, 0x...>`, one address per chain, since
a merchant may use a different payout address per chain). Every
`JournalEntry` carries both too, so a reader can join a Hedera-side record
back to the exact on-chain `Escrow` row it reconciles against.

## Trust model

Precisely, and without overclaiming:

- **A malicious or merely broken facilitator can refuse service, or fail to
  settle a verified payment.** `/verify` and `/settle` are the facilitator's
  only two endpoints, and nothing stops an operator from going offline, lying
  about `isValid`, or never calling `/settle` at all. A merchant depending on
  a third-party-hosted facilitator should treat this as an availability risk,
  not a custody risk — which is the next point.
- **A malicious facilitator cannot steal from escrow, and cannot redirect a
  payment to another merchant.** `Escrow.withdraw` only ever moves
  `_balances[msg.sender]` — there is no admin or facilitator-privileged
  withdrawal path in `Escrow.sol` at all. And because the nonce the payer
  signs is bound to a specific `merchantEvm` (Amendment 1), the facilitator
  cannot substitute a different beneficiary when it calls
  `settleAuthorization` — the contract's own `MerchantNotBound` check,
  independent of anything the facilitator claims, enforces this on-chain.
- **The facilitator operator chooses which escrow contracts it trusts**, via
  the `escrows` option `createFacilitatorApp` requires. This is the one
  allowlist standing between an anonymous caller's self-declared `payTo` and
  "the facilitator will actually try to settle against this." A network with
  no entry here is rejected outright (see
  [`docs/troubleshooting.md`](troubleshooting.md#every-request-returns-invalid_payment_requirements)),
  not silently trusted.
- **The merchant (via `ferry402()`) controls `config.secret`, `merchantEvm`,
  `escrows`, and `assets`.** A merchant who misconfigures any of these can
  break their own payment path (every settlement reverting
  `MerchantNotBound`, for instance) but cannot thereby give an attacker
  access to funds that would not otherwise be exposed — the structural
  guarantees above hold independent of merchant-side config mistakes, up to
  and including the merchant simply being unable to get paid.
- **The payer controls their own signature and nothing else.** A payer can
  decline to sign, or sign and never submit. They cannot forge a signature
  for funds they don't control, and (because of merchant binding) cannot have
  their signed authorization redirected to a merchant other than the one
  whose challenge they actually saw.
- **The HCS journal is an index, not proof of payment on its own.** See
  [`docs/deployments.md`](deployments.md#the-hedera-record) for why
  `submit_key: null` makes this true by design, and why reconciliation
  against the source chain — not the journal alone — is what a merchant or
  auditor should actually trust.

## Why Hedera for the ledger

Two properties this design actually needs, not generic blockchain appeal:

- **Ordering and timestamps, cheaply, for an append-only log.** Every
  settlement needs one durable, ordered record a merchant or auditor can
  replay independent of trusting the facilitator's own database. HCS gives
  each submitted message a global sequence number and a consensus timestamp
  for about **$0.0008 per `ConsensusSubmitMessage`** — see the design doc's
  cost note: against even a small payment that's a trivial fraction of the
  amount moved, and cheap enough to write one entry per settlement rather
  than batching out of cost necessity.
- **A message size that happens to fit the journal entry.** HCS caps a
  `ConsensusSubmitMessage` at **1024 bytes**
  (`packages/facilitator/src/journal.ts`'s `HCS_MAX_MESSAGE_BYTES`). A
  `JournalEntry` — schema version, type, a Hedera account id, an EVM address,
  a source chain name, `"USDC"`, a decimal amount string, a payer address, a
  transaction hash, a 32-byte nonce, and an ISO-8601 timestamp — comfortably
  fits inside that limit as a single JSON object; `encodeEntries` exists to
  batch *multiple* entries into one message when that's cheaper, and to
  reject (never silently truncate or chunk) any single entry that can't fit
  even alone.

Hedera never holds the money in this design — it holds the record of where
the money went, ordered and timestamped in a way the facilitator cannot
rewrite after the fact.

## What is not built

Two pieces are in [the design doc](superpowers/specs/2026-09-23-ferry402-design.md)
but explicitly out of scope for this slice:

- **Cross-chain netting and consolidation.** The design doc's "Netting +
  consolidation" build step — batching a merchant's per-chain positions and
  moving value to Hedera via a bridge, chosen on measured cost — has not been
  built. Today a merchant reconciles and withdraws per chain, directly from
  that chain's `Escrow.sol`; nothing in this repo moves value *between*
  chains on the merchant's behalf.
- **`SettlementLedger.sol` on Hedera.** The design doc specifies a
  Hedera-side contract holding the merchant registry and authoritative net
  position per `(merchant, sourceChain)`, verified against the HCS journal.
  This repo implements the journal writer (`packages/facilitator/src/journal.ts`)
  and per-chain `Escrow.sol`, but no Hedera-side contract — a merchant
  reconciles by reading the journal and cross-checking it against chain
  state directly (see [`docs/deployments.md`](deployments.md) for exactly
  how), not by querying a Hedera contract for a pre-computed net position.

Also worth restating from above since it's easy to miss: `polygon` and
`polygon-amoy` are accepted by the SDK's config types but have no facilitator
chain adapter yet — only `base` and `base-sepolia` actually settle.
