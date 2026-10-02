# ferry402 demo

A self-contained, narrated, runnable demo of `ferry402` against **live Base
Sepolia + Hedera testnet** — no mocks, no local anvil. Clone the repo, set
`.env`, run one command, and watch a real payment flow: 402 challenge, a
signed EIP-3009 authorization, settlement into a non-custodial `Escrow` on
Base Sepolia, and a journal entry written to — and read back from — a Hedera
Consensus Service (HCS) topic. It then demonstrates three of `ferry402`'s
security properties against the same live payment.

This directory depends on the **published** `@ferry402/sdk` from npm (see
`package.json` — a plain `"0.1.0"` dependency, not a pnpm `workspace:*`
link), so it proves what a real integrator who just ran `npm install
@ferry402/sdk` actually gets. The facilitator half runs from this monorepo's
own source rather than from npm — not because it isn't published (it is, as
`@ferry402/facilitator`), but because this example lives in the repo and
testing against local source is the point.

## What it does

1. `GET /api/quote` with no payment → **402**, printing the `accepts` array
   and the derived EIP-3009 nonce.
2. The payer signs the authorization locally via `createPaymentHeader()`
   (published `@ferry402/sdk`).
3. Retried with `X-PAYMENT` → **200**, the quote resource is served.
4. The settlement transaction hash, with a `sepolia.basescan.org` link.
5. The merchant's `Escrow` ledger row, before and after (polled — see
   "A note on flakiness" below).
6. The HCS journal entry, read back from the **mirror node**, with a
   `hashscan.io` link.
7. A closing reconciliation line: the HCS journal total for this merchant vs.
   the on-chain escrow ledger row vs. the escrow contract's real USDC
   balance.

Then three security checks against that same payment:

- Replaying the identical `X-PAYMENT` header → rejected (`invalid_payment`).
- Presenting the `/api/quote` challenge at a different route
  (`/api/quote/premium`) → rejected (`invalid_payment` — nonce derivation is
  resource-bound).
- A payment signed by a brand-new, never-funded key → rejected at `/verify`
  with `insufficient_funds`, **before** anything is served.

Every step prints what happened and why; expected rejections are printed as
one-line verdicts, never as stack traces.

## Prerequisites

- Node.js >= 20.18.3.
- The **ferry402 monorepo itself** already set up one level up: from the
  repo root, `pnpm install && pnpm -r build`. This demo imports
  `@ferry402/facilitator` directly from `../../packages/facilitator/src`
  rather than from npm, so that package's own `node_modules` — and
  `packages/sdk/dist`, which it resolves through the workspace symlink —
  must already exist.
- A funded Base Sepolia payer (USDC) and facilitator (ETH for gas), a
  deployed `Escrow` contract, and a Hedera testnet operator account with an
  existing HCS topic. All of this is already live and funded for this
  project — see the repo root's own `.env` (gitignored).
- `anvil`/Foundry is **not** needed here — this demo only talks to real
  testnets.

## Environment variables

Read from (in order of preference) `examples/demo/.env`, then the repo
root's `.env`, then whatever's already in your shell:

| Variable | Meaning |
|---|---|
| `PAYER_PRIVATE_KEY` | The payer's EVM key (must hold Base Sepolia USDC). |
| `FACILITATOR_PRIVATE_KEY` | The facilitator's settlement wallet (must hold Base Sepolia ETH for gas). |
| `DEPLOYER_PRIVATE_KEY` | Reused as the merchant's EVM payout address (matches `packages/facilitator/test/e2e.test.ts`'s own convention — no funds are drawn from it). |
| `BASE_SEPOLIA_RPC_URL` | Defaults to `https://sepolia.base.org` if unset. |
| `ESCROW_ADDRESS_BASE_SEPOLIA` | The deployed `Escrow` contract address. |
| `HEDERA_ACCOUNT_ID` | Hedera testnet operator account, e.g. `0.0.9823488`. |
| `HEDERA_PRIVATE_KEY` | The operator's key, **ECDSA, DER-encoded** (loaded with `PrivateKey.fromStringDer()` — never `fromStringED25519()`, which silently derives the wrong key instead of throwing). |
| `HCS_TOPIC_ID` | The HCS journal topic, e.g. `0.0.10719807`. |

None of these are printed, logged, or committed by this demo.

## Run it

```bash
cd examples/demo
npm install
npm start
```

That's the one command (`npm start`) once `npm install` has fetched the
published SDK and this demo's own dependencies.

## What to expect

A full run costs a tiny amount of real testnet value: ~$0.01 of USDC from
the payer (settled twice if you count the zero-balance security check's
authorization, but that one is rejected before any money moves), one Base
Sepolia transaction's gas from the facilitator, and one
`ConsensusSubmitMessage` (~$0.0008) on Hedera. It typically finishes in well
under a minute. Expect:

- Seven numbered `STEP` sections tracing the happy path, each with a
  Basescan and/or Hashscan link you can open live.
- Three `SECURITY CHECK` sections, each ending in a one-line
  `REJECTED (expected): ...` verdict — no stack traces.
- A final `DEMO COMPLETE` banner.

Run it again right after — it's fully repeatable: a fresh `paymentId` is
derived each run from the current time bucket, and the reconciliation line
in step 7 will simply show a larger running total.

### A note on flakiness

`sepolia.base.org` is a public, load-balanced RPC with no read-your-writes
guarantee: a `balanceOf` read immediately after a settlement's own receipt
can transiently land on a different backend node than the one that just
mined the block, and return the pre-settlement balance. This was observed
directly during this project's original live end-to-end run (see
`packages/facilitator/test/e2e.test.ts`'s `pollBalanceOf` doc comment) — step
5 above polls that read (up to 10 attempts, 2s apart) rather than papering
over it with a single, potentially-stale read. The mirror node in step 6 is
polled for the same reason (HCS mirror-node ingestion lags consensus by a
few seconds in practice). In the runs used to validate this demo, both reads
resolved on the very first attempt — the polling exists for the tail case,
not because every run hits it.

## Why not a workspace link for the SDK?

`examples/demo` is deliberately **outside** the pnpm workspace (see the
repo root's `pnpm-workspace.yaml`, which only lists `packages/*`) and uses
plain `npm`, not `pnpm`, specifically so `npm install` resolves
`@ferry402/sdk` from the real npm registry — proving the published package
actually works for a consumer, not just inside this monorepo's own symlinked
dev environment.

## What to read next

- [Architecture](../../docs/architecture.md) — what each step of this demo is actually doing, and why.
- [Deployments](../../docs/deployments.md) — the full table of every settlement this project has made on Base Sepolia, including the ones this demo adds.
- [Troubleshooting](../../docs/troubleshooting.md) — if a step here fails.
- [`SECURITY.md`](../../SECURITY.md) — the properties the three security checks at the end are demonstrating.
