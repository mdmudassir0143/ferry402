# @anychain402/facilitator

The x402 facilitator: verifies and settles EIP-3009 payments into a per-chain
`Escrow` on Base, and journals settled payments to a Hedera Consensus Service
(HCS) topic for reconciliation. See
`docs/superpowers/specs/2026-09-23-anychain402-design.md` at the repo root for
the full design (including Amendments 2 and 3, both binding on the shapes
below).

## Configuring `createFacilitatorApp`

```ts
import { createFacilitatorApp } from '@anychain402/facilitator'

const app = createFacilitatorApp({
  // REQUIRED. See "The escrows option" below.
  escrows: {
    'base-sepolia': process.env.ESCROW_ADDRESS_BASE_SEPOLIA as `0x${string}`,
    // 'base': process.env.ESCROW_ADDRESS_BASE as `0x${string}`,
  },
  // Optional: per-network RPC overrides. Omitted networks fall back to
  // viem's public base/base-sepolia endpoints.
  rpcUrls: {
    'base-sepolia': process.env.BASE_SEPOLIA_RPC_URL,
  },
  // Optional: defaults to process.env.FACILITATOR_PRIVATE_KEY. Never logged.
  facilitatorPrivateKey: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
})

app.listen(3000)
```

### The `escrows` option

`POST /verify` and `POST /settle` are both **unauthenticated** endpoints that
take `paymentRequirements` — including `payTo`, the escrow address a payment
credits — straight from an anonymous HTTP caller. Without an operator-supplied
allowlist, `payTo` is a value the *caller* controls, not this facilitator.

`escrows` is that allowlist: a per-network map from `'base' | 'base-sepolia'`
to the address of the `Escrow` contract *this facilitator operator actually
deployed and trusts* for that network — the only value `payTo` is ever allowed
to be. It is shaped exactly like `rpcUrls`, for the same reason: an operator
already has to know its own RPC endpoints, and a self-hosting merchant knows
its own deployed escrow address.

**This fails closed.** `createFacilitatorApp()` called with no `escrows` (or
with a network missing from the map) rejects *every* request for that
network — `/verify` returns `invalid_payment_requirements`, `/settle` a
generic failure — rather than silently trusting whatever `payTo` the caller
sent. This is deliberate (see the `VerifyOptions.escrows` doc comment in
`src/chains/base.ts`), but it means a facilitator that looks "up" from a
health-check perspective can still reject 100% of real traffic if `escrows`
was never wired up. If every request comes back `invalid_payment_requirements`
in production, check this first.

Populate it once you've deployed `Escrow.sol` per network (Task 10 covers
deployment) — there is no default; an un-deployed or unconfigured network is
supposed to be rejected, not guessed at.

## The HCS journal writer (`src/journal.ts`)

Every settled payment (`SettleResult` with `success: true`) should be recorded
to an HCS topic so a merchant can reconcile on-chain escrow state against an
ordered, mirror-node-queryable ledger. Typical wiring, after a successful
`settlePayment` call:

```ts
import { journalEntryForSettlement, writeEntry, createHederaTopicSubmitter } from '@anychain402/facilitator'
import { Client } from '@hashgraph/sdk'

const client = Client.forTestnet().setOperator(process.env.HEDERA_ACCOUNT_ID!, process.env.HEDERA_PRIVATE_KEY!)
const submitter = createHederaTopicSubmitter(client)

const entry = journalEntryForSettlement({
  merchant, // the Hedera account id, e.g. "0.0.123456"
  merchantEvm, // the SAME merchant's EVM address on this source chain
  sourceChain: 'base-sepolia',
  settlement: settleResult, // the SettleResult from settlePayment(), success: true
})

await writeEntry(entry, { topicId: process.env.HCS_TOPIC_ID!, submitter })
```

- `merchant` and `merchantEvm` are **two different identifiers for the same
  merchant** (Amendment 3) — the Hedera account id the clearing layer keys on,
  and the per-chain EVM address the `Escrow` ledger row is keyed by. Both are
  required on every entry so it can be reconciled against either system.
- `amount` is always the **observed** on-chain credit
  (`SettleResult.settledAmount`, sourced from the verified `PaymentSettled`
  log), never the amount an authorization requested (Amendment 2) — this
  matters under a fee-on-transfer token, where the two can differ.
- For many small payments, prefer `encodeEntries`/`writeEntries`, which batch
  multiple entries into as few HCS messages as the 1024-byte limit allows
  (`ConsensusSubmitMessage` costs ~$0.0008 per message).
- `writeEntry`/`writeEntries` take an injectable `submitter` (a
  `TopicSubmitter`) rather than constructing a Hedera client internally — this
  is what makes the validation/batching logic testable without a live Hedera
  account. `createHederaTopicSubmitter(client)` is the real,
  `@hashgraph/sdk`-backed implementation; provide your own fake in tests.
- Live topic creation and an end-to-end submit against Hedera testnet are
  Task 10's job — this package validates, encodes, batches, and defines the
  submission seam, but has no Hedera credentials to prove a real submit
  against.

## Environment variables

See `.env.example` at the repo root for the full list
(`FACILITATOR_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`,
`ESCROW_ADDRESS_BASE_SEPOLIA`, `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`,
`HCS_TOPIC_ID`). None of them are read automatically by this package —
`createFacilitatorApp`'s options and `journal.ts`'s injectable `submitter` are
the actual configuration surface; an operator's own bootstrap code is
responsible for reading `process.env` and passing values in, as shown above.

## Testing

```
pnpm --filter @anychain402/facilitator test
```

Chain-facing tests (`verify.test.ts`, `settle.fork.test.ts`, `server.test.ts`,
etc.) spin up a local `anvil` instance per suite — no real network access or
credentials required. `journal.test.ts` is fully offline: it exercises
encoding, validation, and batching directly, and `writeEntry`/`writeEntries`
against a fake `TopicSubmitter` that records calls instead of touching Hedera.
