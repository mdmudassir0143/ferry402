# ferry402

`ferry402` lets an [x402](https://x402.org)-protected HTTP service accept a
payment signed by a user on another chain, settling it into a non-custodial,
per-chain `Escrow` contract the merchant can always withdraw from. Hedera is
the clearing ledger: every settled payment is journaled, in order, to a
Hedera Consensus Service (HCS) topic, giving a merchant or auditor a
timestamped, mirror-node-queryable index to reconcile on-chain escrow state
against — rather than taking the facilitator's word for what it settled.

**Today that means Base and Base Sepolia.** The chain layer is an adapter
boundary and the config types already name Polygon, but no Polygon adapter
is written — see the `accept` row under "Configuration". Everything below
was built and proven against Base Sepolia.

See [`docs/superpowers/specs/2026-09-23-ferry402-design.md`](docs/superpowers/specs/2026-09-23-ferry402-design.md)
for the full design, including the three amendments that are load-bearing
throughout this codebase (merchant binding, crediting the observed balance
delta rather than the requested amount, and merchant identity being two
separate identifiers).

## Documentation

| Document | What's in it |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | How a payment moves end to end, the trust model, and the design decisions behind it. |
| [`docs/deployments.md`](docs/deployments.md) | Every deployed address and every settlement transaction, with explorer links and commands to reproduce the reconciliation yourself. |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Real failure modes, the symptom you actually see, and the fix. |
| [`SECURITY.md`](SECURITY.md) | Threat model, the attacks each property closes, known limitations, and how to report a vulnerability. |
| [`AGENTS.md`](AGENTS.md) | Conventions for agents working on this repo, and a payer loop for autonomous agents paying for resources. |
| [`examples/demo`](examples/demo) | A runnable, narrated demo against live Base Sepolia + Hedera testnet. |

## Quickstart

```bash
git clone https://github.com/mdmudassir0143/ferry402.git
cd ferry402
pnpm install
pnpm -r build   # @ferry402/sdk publishes from dist/; facilitator resolves it through the workspace symlink
```

Guard a route — the one-line integration:

```ts
import express from 'express'
import { ferry402 } from '@ferry402/sdk'

const app = express()

app.get('/premium-endpoint', ferry402(config), (_req, res) => {
  res.json({ data: 'this only serves once payment verifies' })
})
```

Run the facilitator that `ferry402()` calls `/verify` against:

```ts
import { createFacilitatorApp } from '@ferry402/facilitator'

const app = createFacilitatorApp({
  escrows: { 'base-sepolia': process.env.ESCROW_ADDRESS_BASE_SEPOLIA as `0x${string}` },
  rpcUrls: { 'base-sepolia': process.env.BASE_SEPOLIA_RPC_URL },
  facilitatorPrivateKey: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
})

app.listen(3000)
```

Both snippets above are copy-pasteable and run as-is (given a real `config`/
`.env` — see "Configuration" below); `pnpm install && pnpm -r build && pnpm -r test`
is what this repo's own CI-equivalent path runs, and every command in this
README was run against this branch while writing it.

`ferry402(config)` returns an Express `RequestHandler`. An unpaid request
gets a `402` with an `accepts` array describing every chain this merchant
takes payment on; a request carrying a valid `X-PAYMENT` header (a
base64-encoded, signed EIP-3009 `ReceiveWithAuthorization` payload) is
verified against the facilitator and, once approved, falls through to your
own route handler via `next()`.

**`ferry402()` only verifies — it does not itself call `/settle`.** Actually
collecting the payment (submitting the authorization to `Escrow.sol`) and
journaling it to HCS is the route handler's job, immediately after `next()`
runs — see `packages/facilitator/README.md`'s "Typical wiring" section and
`packages/facilitator/test/e2e.test.ts` for a complete, real-network example
of that wiring end to end.

## How a payment moves through the system

```
402 ──▶ signed authorization ──▶ verify ──▶ serve ──▶ settle ──▶ HCS journal
```

1. **402** — an unpaid `GET` gets a `PaymentRequirements` array, one entry
   per accepted chain, each carrying a merchant-bound `paymentId`/nonce
   derived stateless-ly from `(secret, merchantEvm, resource, time bucket)`.
2. **Signed authorization** — the payer signs an EIP-3009
   `ReceiveWithAuthorization` over that exact nonce and retries with an
   `X-PAYMENT` header.
3. **Verify** — `ferry402()` recomputes the nonce locally (proving resource
   binding and TTL with no store lookup), then calls the facilitator's
   `POST /verify`, which checks the signature and the payer's real on-chain
   balance.
4. **Serve** — once verified, the request falls through to your route
   handler via `next()`. The resource is served here, *before* settlement —
   this codebase is serve-then-settle, matching the trust model x402 itself
   assumes (a verified signature is as good as cash for a $0.01 API call).
5. **Settle** — your handler calls the facilitator's `POST /settle`, which
   submits the authorization to `Escrow.sol` on the source chain. USDC moves
   from the payer directly into the escrow, credited to the merchant's
   ledger row — the facilitator never custodies funds.
6. **HCS journal** — your handler journals the *observed* settled amount
   (read back from the settlement transaction's `PaymentSettled` log, not
   the amount merely requested) to a Hedera Consensus Service topic, giving
   an ordered, mirror-node-queryable audit trail independent of trusting the
   facilitator's word.

## Configuration

### `Ferry402Config` (merchant-side, `@ferry402/sdk`)

| Field | Required | Notes |
|---|---|---|
| `secret` | **Yes** | **Minimum 32 bytes.** `ferry402(config)` throws synchronously at construction if missing or short — there is no fallback to a randomly-generated value. Every process/instance serving this merchant's traffic **must share the exact same `secret`**: it is what lets two independent `ferry402` instances validate each other's issued challenges with no shared store at all. A per-process random secret would not error — it would silently make every horizontally-scaled or rolling-restarted deployment reject legitimate payments under load, whenever a payer's retry landed on a different instance than the one that issued their 402. Generate once with `openssl rand -hex 32`; load from a secret store/env var; never commit it. |
| `merchant` | Yes | Your **Hedera account id** (e.g. `"0.0.123456"`) — the clearing-layer identity the HCS journal keys on. |
| `merchantEvm` | Yes | Per-chain **EVM address**, e.g. `{ 'base-sepolia': '0x...' }`. **Not the same identifier as `merchant`** — one is a Hedera account id, the other an EVM address, and the nonce binding (`keccak256(abi.encode(merchantEvm, paymentId))`) hashes the EVM address specifically. Mixing them up, or using the wrong chain's address, makes every settlement on that chain revert `MerchantNotBound`. |
| `accept` | Yes | Which chains this merchant takes payment on. **The type allows `'base' \| 'base-sepolia' \| 'polygon' \| 'polygon-amoy'`, but the facilitator in this repo only serves `base` and `base-sepolia`.** Listing `polygon` or `polygon-amoy` produces a 402 advertising a chain no payment can complete on — every attempt comes back `invalid_network`. The Polygon entries are type scaffolding for a chain adapter that is not written yet. |
| `escrows` | Yes | Per-chain `Escrow` contract address funds are paid into (`payTo` in the 402 response). |
| `assets` | Yes | Per-chain USDC (v1 only supports USDC) contract address. |
| `facilitator` | Yes | Base URL of the facilitator `ferry402()` calls `/verify` against. |
| `price` | Yes | Decimal-dollar string, e.g. `"$0.01"`. Rejects (does not round) more than 6 fractional digits. |
| `settleTo` | Yes | Always `'hedera'` in v1. |

### `FacilitatorAppOptions` (`createFacilitatorApp`, `@ferry402/facilitator`)

| Field | Required | Notes |
|---|---|---|
| `escrows` | **Yes — fails closed** | A per-network map from `'base' \| 'base-sepolia'` to the `Escrow` address this facilitator operator actually deployed and trusts. `POST /verify` and `POST /settle` are both unauthenticated and otherwise take `payTo` straight from the caller — **`escrows` is the allowlist that stops an anonymous caller naming their own contract as the payment destination.** A facilitator started with **no `escrows` at all** (or missing an entry for a network) rejects **every** request for that network: `/verify` returns `invalid_payment_requirements`, `/settle` fails generically. If every request comes back rejected in production, check this first — it looks "up" from a health-check perspective while still refusing 100% of real traffic. |
| `rpcUrls` | No | Per-network RPC override. Omitted networks fall back to viem's public `base`/`base-sepolia` endpoints — fine for development, not recommended for production (rate limits and availability of a public endpoint gate the whole payment path). |
| `facilitatorPrivateKey` | No (defaults to `process.env.FACILITATOR_PRIVATE_KEY`) | Submits every settlement transaction to `Escrow.sol`. Needs gas on every chain it settles on. Never logged. |

## Client compatibility: stock x402 clients cannot pay a ferry402 route

**No client built against plain `x402@1.2.0`** (`x402-fetch`, `x402-axios`,
or a hand-rolled client using that package's `createNonce()`) **can complete
a ferry402 payment.** This is a deliberate consequence of closing a real
vulnerability, not a bug:

- Amendment 1 (see the design doc) binds the EIP-3009 authorization `nonce`
  to the merchant it was issued for — `nonce = keccak256(abi.encode(merchantEvm,
  paymentId))` — so a signed payment can never be redirected to a merchant
  other than the one whose 402 the payer actually saw.
- `x402@1.2.0`'s own client helpers mint that nonce as **random bytes**
  instead. A random nonce never equals either of ferry402's derived
  candidates, so `ferry402`'s middleware rejects it with `invalid_payment`
  — indistinguishable, from the client's side, from any other nonce
  mismatch (an expired challenge included; ferry402 cannot tell the two
  apart, since the validity window is enforced by the HMAC derivation
  itself rather than a store it could inspect for a cause).

Use `createPaymentHeader` from `@ferry402/sdk` instead — it derives the
correct nonce and signs the authorization for you:

```ts
import { createPaymentHeader } from '@ferry402/sdk'
import { privateKeyToAccount } from 'viem/accounts'

const res = await fetch('http://merchant.example/premium-endpoint')
const { accepts } = await res.json()

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`)
const header = await createPaymentHeader(accepts[0], account, {
  tokenName: 'USDC', tokenVersion: '2', chainId: 84532,
})

await fetch('http://merchant.example/premium-endpoint', { headers: { 'X-PAYMENT': header } })
```

This is a lift of the exact signing logic proven against a real chain in
`packages/facilitator/test/e2e.test.ts` — see `@ferry402/sdk`'s own README
for the full option reference. There is currently no packaged, higher-level
client (a fetch/axios wrapper that runs this loop automatically) — that is
known future work, not something this repo ships today.

## Security properties

- **Merchant binding (Amendment 1).** The authorization nonce commits to
  `(merchantEvm, paymentId)`. A signature cannot be redeemed by, or
  redirected to, any merchant other than the one it was signed for —
  enforced independently by `Escrow.settleAuthorization` on-chain and by
  the facilitator's `/verify` off-chain, both recomputing the identical
  hash.
- **Replay defense, derived not stored.** Resource binding and the payment
  window fall out of a keyed derivation
  (`HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)`), not a
  lookup table an attacker could exhaust — issuing a 402 costs zero storage,
  for any volume of anonymous requests. "Never redeemed before" is the one
  property derivation alone cannot prove, so a `ConsumedNonceStore` is
  still consulted, but it is only written to once a request reaches the
  point of actually being paid.
- **Non-custodial withdrawal.** Every payment settles into a per-chain
  `Escrow` contract the merchant can always `withdraw` from. There is no
  admin path — not for the facilitator, not for `ferry402` itself — that
  can move a merchant's credited funds anywhere else. A facilitator can
  refuse service or misbehave, but it cannot drain escrow.
- **Observed-delta crediting (Amendment 2).** Settlement credits the
  *measured* balance change on the escrow contract, never the amount an
  authorization merely requested — this matters under any token whose
  transfer doesn't move exactly the requested amount.

### Known limitations

- **The default `InMemoryConsumedNonceStore` is per-process.** It is not
  shared across horizontally-scaled instances, and a process restart clears
  it — for the derivation window still open at restart time (up to
  `2 * TIME_BUCKET_SECONDS` = 10 minutes by default), replay protection for
  any nonce derived just before the restart is gone. Pass your own
  `ConsumedNonceStore` (Redis, a database, ...) via
  `ferry402(config, { consumedNonceStore })` for a production,
  multi-instance deployment.
- **No packaged payer-side client** beyond the `createPaymentHeader` helper
  — see "Client compatibility" above.
- **Consolidation/netting across chains, and a Hedera-side
  `SettlementLedger.sol`,** are in the original design doc but not part of
  this slice: this repo implements per-chain escrow and HCS journaling
  only. A merchant reconciles by reading the journal directly.
- **The HCS journal topic has no submit key.** The deployed topic
  (`0.0.10719807`) was created with `submit_key: null`, so anyone can append
  a message to it, and with `admin_key: null`, so it can never be
  reconfigured or deleted. A journal entry is therefore *not* standalone
  proof that a payment happened — it is an ordered, timestamped index. The
  trustworthy check is the reconciliation: filter entries by `merchantEvm`
  and verify each `txHash` against Base Sepolia, which is what the demo and
  the e2e test both do. Set a submit key on your own topic if you want
  append to be restricted.
- **No third-party audit.** The contract has a 39-test Foundry suite
  including fuzz and invariant runs, and the security properties below are
  each tested, but nobody outside this project has reviewed it. Testnet
  only.

## The live proof

Every claim above was exercised against real networks, not mocks.
`packages/facilitator/test/e2e.test.ts` (gated behind `RUN_E2E=1`) and
[`examples/demo`](examples/demo) both run genuine payments against Base
Sepolia and Hedera testnet. As of 2026-10-01 there have been **seven live
settlements**, every one of them `status: 1` on chain:

| | |
|---|---|
| `Escrow` on Base Sepolia | [`0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429`](https://sepolia.basescan.org/address/0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429) |
| Deployment tx | [`0xcbca16cf…93819f25`](https://sepolia.basescan.org/tx/0xcbca16cf6820716b31f0e33ae68084f7d4835c0c80458da82d50f81293819f25) · block 47300767 · 1187384 gas |
| Token | [Base Sepolia USDC](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) (6 decimals) |
| Most recent settlement | [`0x02f82398…7c381ffe`](https://sepolia.basescan.org/tx/0x02f82398c8ddedc1d93246081c5d92719772e990b76e50ff3b219bdb7c381ffe) · block 47538498 · 107712 gas |
| HCS journal topic | [`0.0.10719807`](https://hashscan.io/testnet/topic/0.0.10719807) — 7 entries, one per settlement |

**Three-way reconciliation, read live rather than asserted:** the HCS journal
entries for this merchant sum to **70000**, `Escrow.balanceOf(merchantEvm)`
reads **70000**, and the real `USDC.balanceOf(escrow)` on Base Sepolia also
reads **70000**. The journal agrees with the ledger, and the ledger is fully
backed by tokens the contract actually holds.

A settlement costs **141900 gas** the first time a given merchant is paid and
**~107700** every time after — the difference is the cold storage write on
that merchant's balance slot.

Reproduce the on-chain half yourself. These are public reads; no credentials,
no API key:

```bash
cast call 0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 "balanceOf(address)(uint256)" 0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b --rpc-url https://sepolia.base.org
cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "balanceOf(address)(uint256)" 0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 --rpc-url https://sepolia.base.org
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10719807/messages?limit=25&order=asc"
```

[`docs/deployments.md`](docs/deployments.md) has the full table — all seven
transactions with blocks, gas, amounts and consensus timestamps — plus the
Hedera topic's configuration and what it means that the topic has no submit
key.

## Packages

| Package | What it is |
|---|---|
| [`packages/contracts`](packages/contracts) | `Escrow.sol` — the non-custodial per-chain vault. A standalone Foundry project (no `package.json` — it is **not** a pnpm workspace member; `forge test` runs it directly). |
| [`@ferry402/sdk`](packages/sdk) | The `ferry402()` Express middleware, `createPaymentHeader`, `buildRequirements`, and the stateless-challenge/nonce primitives. Published as an ESM-only build from `dist/`. |
| [`@ferry402/facilitator`](packages/facilitator) | `createFacilitatorApp()` — the `/verify` + `/settle` HTTP service, plus the HCS journal writer (`journal.ts`). Self-hostable; nothing requires trusting a hosted instance. Marked `private` — it is not yet packaged for standalone publishing. |
| [`examples/demo`](examples/demo) | A runnable, narrated end-to-end demo against live Base Sepolia + Hedera testnet. Depends on the **published** `@ferry402/sdk` from npm, so it exercises what an integrator actually installs. |

## Prerequisites

- **Node >= 20.18.3** (see `engines` in every `package.json`)
- **pnpm 9** (`packageManager` pins `9.15.9`)
- **[Foundry](https://getfoundry.sh)** (`forge`/`cast`/`anvil`) — required to build/test `packages/contracts`, and to deploy `Escrow.sol`
- A **funded Base Sepolia key** (or Base mainnet, for a real deployment) to deploy `Escrow.sol` and to run the facilitator's settlement wallet
- A **Hedera testnet (or mainnet) account** — an account id and private key, used as the HCS journal's operator

## Environment variables

Copy `.env.example` to `.env` and fill in real values. **Never commit `.env`**
(it is gitignored, and must stay that way).

| Variable | Used by | Notes |
|---|---|---|
| `BASE_SEPOLIA_RPC_URL` | facilitator bootstrap, deploy script | Public RPC by default (`https://sepolia.base.org`); a production deployment should point this at a private RPC provider. |
| `DEPLOYER_PRIVATE_KEY` | `forge create` (contract deployment only) | Testnet key. Needs Base Sepolia ETH for gas. Never read by the facilitator at runtime. |
| `FACILITATOR_PRIVATE_KEY` | `@ferry402/facilitator`'s `/settle` | Submits every settlement transaction to `Escrow.sol`. Needs Base Sepolia ETH for gas. Never logged, anywhere. |
| `PAYER_PRIVATE_KEY` | test/demo clients only | Signs the EIP-3009 authorization via `createPaymentHeader`. Needs USDC, **not ETH** — EIP-3009 is signed off-chain; the payer never submits a transaction or pays gas. |
| `ESCROW_ADDRESS_BASE_SEPOLIA` | facilitator bootstrap (`escrows` option), merchant config | Set after deploying `Escrow.sol` (see below). **Not a secret** — this is the trusted-escrow allowlist entry an operator must pass explicitly to `createFacilitatorApp({ escrows: {...} })`; it is never read automatically. |
| `HEDERA_ACCOUNT_ID` | HCS topic creation, journal writer | Hedera account id, e.g. `0.0.123456`. |
| `HEDERA_PRIVATE_KEY` | HCS topic creation, journal writer | **If ECDSA (the common case for a fresh testnet account from the Hedera portal), it is DER-encoded — load with `PrivateKey.fromStringDer()` or `fromStringECDSA()`, never `fromStringED25519()`.** The ED25519 loader does not error on a mismatched key type; it silently derives the wrong key, and the resulting `INVALID_SIGNATURE` at submit time gives no indication why. |
| `HCS_TOPIC_ID` | journal writer | Set after creating the topic (see below). **Not a secret.** |

### Deploying `Escrow.sol`

```bash
cd packages/contracts
forge create src/Escrow.sol:Escrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --constructor-args <USDC_ADDRESS>
```

(`--constructor-args` must be the **last** flag — `forge create`'s variadic
arg parser otherwise swallows a following flag like `--broadcast` into the
constructor-args list and reports a bogus arg-count mismatch.)

### Creating the HCS journal topic

```bash
pnpm --filter @ferry402/facilitator exec tsx scripts/create-topic.ts
```

Prints the new topic id (e.g. `0.0.10719807`) — set it as `HCS_TOPIC_ID`.

## Testing

```bash
pnpm install
pnpm -r build   # builds @ferry402/sdk and @ferry402/facilitator
pnpm -r test    # sdk: vitest (123 tests) · facilitator: vitest (92 passed, 1 skipped)
```

**`pnpm -r test` does NOT run the contract tests.** `packages/contracts` is a
plain Foundry project with no `package.json`, so it is not a pnpm workspace
member and `pnpm -r` never touches it. Run those separately:

```bash
cd packages/contracts
forge test   # 39 tests, 6 suites, including a 128k-call invariant fuzz run
```

None of the above touches a real network or spends real funds.

### Live end-to-end run

`packages/facilitator/test/e2e.test.ts` runs one genuine payment against real
networks: a real deployed `Escrow` on Base Sepolia, a real EIP-3009
authorization over real (testnet) USDC, a real settlement transaction, and a
real HCS journal entry read back from the Hedera testnet mirror node. It is
**deliberately excluded from `pnpm test`** — it spends real testnet USDC and
ETH on every run and depends on two live networks being reachable. Run it
explicitly, with `.env` fully populated:

```bash
RUN_E2E=1 pnpm --filter @ferry402/facilitator test:e2e
```

Without `RUN_E2E=1` the file is still collected (so it shows up as
**skipped**, never silently missing) but neither its setup nor its assertions
run — importing it is safe even with no `.env` on disk at all. See "The live
proof" above for the most recent run's results.

## License

MIT — see [LICENSE](LICENSE).
