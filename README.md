# ferry402

[![npm](https://img.shields.io/npm/v/@ferry402/sdk)](https://www.npmjs.com/package/@ferry402/sdk)
[![CI](https://github.com/mdmudassir0143/ferry402/actions/workflows/ci.yaml/badge.svg)](https://github.com/mdmudassir0143/ferry402/actions/workflows/ci.yaml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**Charge for an HTTP endpoint, let anyone pay from another chain, and keep an
auditable record of every payment on Hedera.**

One line of Express middleware turns a route into a paid one. A caller pays in
USDC on Base; the money lands in an escrow contract only you can withdraw
from; and every settled payment is written to a Hedera Consensus Service
topic, so you can prove what you were paid without trusting anyone's word for
it.

Built on [x402](https://x402.org), the HTTP 402 payment standard.

> **Status: testnet, unaudited.** Working and proven against live Base Sepolia
> and Hedera testnet — [every payment is on chain and verifiable](#proof-its-real).
> No third-party audit. Don't put mainnet money through it yet. See
> [SECURITY.md](SECURITY.md).

---

## Try it in 30 seconds

```bash
git clone https://github.com/mdmudassir0143/ferry402.git
cd ferry402/examples/demo
npm install && npm run demo
```

That runs a real payment against live Base Sepolia and Hedera testnet and
narrates every step — the 402 challenge, the signed authorization, the
settlement transaction, the Hedera journal entry, and a three-way
reconciliation. It then demonstrates three attacks being rejected. You'll need
a funded `.env` ([see below](#environment-variables)).

## Install

```bash
npm install @ferry402/sdk
```

Charge for a route:

```ts
import express from 'express'
import { ferry402 } from '@ferry402/sdk'

const app = express()

app.get('/premium', ferry402(config), (_req, res) => {
  res.json({ data: 'only served once payment verifies' })
})
```

Run the facilitator the middleware verifies against:

```ts
import { createFacilitatorApp } from '@ferry402/facilitator'

const app = createFacilitatorApp({
  escrows: { 'base-sepolia': process.env.ESCROW_ADDRESS_BASE_SEPOLIA as `0x${string}` },
  rpcUrls: { 'base-sepolia': process.env.BASE_SEPOLIA_RPC_URL },
  facilitatorPrivateKey: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
})

app.listen(3000)
```

**The middleware verifies; it doesn't collect.** After `next()` runs, your
handler calls the facilitator's `/settle` to actually move the money and
writes the journal entry. [`examples/demo/src/run.ts`](examples/demo/src/run.ts)
shows the complete wiring, and
[`packages/facilitator/README.md`](packages/facilitator/README.md) explains why
it's split this way.

## How a payment works

```
402 ──▶ signed authorization ──▶ verify ──▶ serve ──▶ settle ──▶ HCS journal
```

**1 · The 402.** An unpaid request gets a list of payment options, one per
chain you accept. Each carries a `paymentId` and nonce derived from
`(secret, your EVM address, the resource, a 5-minute time bucket)` — computed
on the fly, never stored.

**2 · The signature.** The payer signs an EIP-3009
`ReceiveWithAuthorization` over that exact nonce and retries with an
`X-PAYMENT` header. No gas, no transaction — just a signature.

**3 · Verify.** The middleware recomputes the nonce locally, which proves the
payment was issued for *this* resource and is still inside its window with no
database lookup. It then asks the facilitator to check the signature and the
payer's real on-chain balance.

**4 · Serve.** Your handler runs. Note the resource is served *before*
settlement — see [the honest caveat](#serve-then-settle).

**5 · Settle.** Your handler calls `/settle`, which submits the authorization
to `Escrow.sol`. USDC moves from the payer straight into escrow, credited to
your ledger row. The facilitator never holds funds.

**6 · Journal.** Your handler writes the *observed* settled amount — read back
from the transaction's `PaymentSettled` log, not the amount that was requested
— to a Hedera topic.

Full detail in [docs/architecture.md](docs/architecture.md).

## The one thing that will trip you up

**Stock x402 clients cannot pay a ferry402 route.** Not `x402-fetch`, not
`x402-axios`, not anything built on plain `x402@1.2.0`.

Those clients generate the authorization nonce as random bytes. ferry402
*derives* it, binding it to the merchant who issued the 402:

```
nonce = keccak256(abi.encode(merchantEvm, paymentId))
```

That binding is what stops a signed payment being redirected to a different
merchant — anyone who intercepted the signature could otherwise credit
themselves. A random nonce never matches, so the payment is rejected. This is
the security property working, not a bug.

Use `createPaymentHeader` instead:

```ts
import { createPaymentHeader } from '@ferry402/sdk'
import { privateKeyToAccount } from 'viem/accounts'

const res = await fetch('http://merchant.example/premium')
const { accepts } = await res.json()

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`)
const header = await createPaymentHeader(accepts[0], account, {
  tokenName: 'USDC', tokenVersion: '2', chainId: 84532,
})

await fetch('http://merchant.example/premium', { headers: { 'X-PAYMENT': header } })
```

There's no packaged fetch/axios wrapper that runs this loop for you yet.
[AGENTS.md](AGENTS.md) has a complete payer loop for autonomous agents.

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | How a payment moves, the trust model, the design decisions |
| [Deployments](docs/deployments.md) | Every address and transaction, with commands to verify them yourself |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms, causes, fixes |
| [Security](SECURITY.md) | Threat model, what each property defends, how to report a vulnerability |
| [Agents](AGENTS.md) | For agents contributing here, and for agents paying for resources |
| [Contributing](CONTRIBUTING.md) | Setup, what a good change looks like |

## Configuration

Both config objects are fully documented in their own packages —
[`@ferry402/sdk`](packages/sdk/README.md#configuration-reference) and
[`@ferry402/facilitator`](packages/facilitator/README.md#configuring-createfacilitatorapp).
The fields worth knowing before you start:

| Field | Where | Notes |
|---|---|---|
| `secret` | SDK | Required, min 32 bytes. **Every instance must share it** — see below |
| `merchant` | SDK | Your Hedera account id, e.g. `0.0.123456` |
| `merchantEvm` | SDK | Per-chain EVM payout address. **A different identifier from `merchant`** |
| `accept` | SDK | Chains you take payment on. **Base only today** — see below |
| `escrows` | facilitator | Required allowlist of escrow addresses. **Fails closed** — see below |

**`secret` must be identical across every instance** serving a merchant. It's
what lets two processes validate each other's challenges with no shared
database. Generate it once with `openssl rand -hex 32` and load it from your
secret store. A per-process random value wouldn't throw — it would silently
reject legitimate payments whenever a payer's retry landed on a different
instance than the one that issued their 402.

**`merchant` and `merchantEvm` are not interchangeable.** One is a Hedera
account id, the other an EVM address, and the nonce binding hashes the EVM
address specifically. Mixing them up makes every settlement revert
`MerchantNotBound`.

**`accept` only works for Base today.** The type names `'base' |
'base-sepolia' | 'polygon' | 'polygon-amoy'`, but the facilitator in this repo
only serves the two Base networks. Listing a Polygon network produces a 402
that no payment can satisfy — every attempt returns `invalid_network`. The
Polygon entries are scaffolding for an adapter nobody has written.

**The facilitator's `escrows` option fails closed.** `/verify` and `/settle`
are unauthenticated and otherwise take the payment destination straight from
the caller, so this allowlist is what stops an anonymous caller naming their
own contract. It's required: omit it and `createFacilitatorApp` throws at
construction.

## Proof it's real

Every payment made through this project has settled on Base Sepolia with
`status: 1` — eight at the time of writing, and the demo adds one each run.

| | |
|---|---|
| `Escrow` contract | [`0x99Cd…C429`](https://sepolia.basescan.org/address/0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429) |
| Deployed in | [tx `0xcbca16cf…`](https://sepolia.basescan.org/tx/0xcbca16cf6820716b31f0e33ae68084f7d4835c0c80458da82d50f81293819f25) · block 47300767 · 1187384 gas |
| Token | [Base Sepolia USDC](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) (6 decimals) |
| A settlement | [tx `0xc700a2c4…`](https://sepolia.basescan.org/tx/0xc700a2c466d5666c9af0a624075a167d016a9ef88f65f602b60081e5669e499a) · block 47558459 · 107700 gas |
| Hedera journal | [topic `0.0.10719807`](https://hashscan.io/testnet/topic/0.0.10719807) · one entry per settlement |

**Three independent sources always agree.** The Hedera journal entries for
this merchant sum to exactly what `Escrow.balanceOf(merchantEvm)` reports,
which in turn equals the escrow's real `USDC.balanceOf`. The journal matches
the ledger, and the ledger is fully backed by tokens the contract actually
holds — nothing is credited that isn't there.

Don't take that on trust. The three commands below are public reads needing no
credentials or API key, and they should print the same number three times
(`80000` at the time of writing; higher once someone runs the demo again):

```bash
cast call 0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 "balanceOf(address)(uint256)" \
  0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b --rpc-url https://sepolia.base.org
cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "balanceOf(address)(uint256)" \
  0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 --rpc-url https://sepolia.base.org
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10719807/messages?limit=25&order=asc"
```

Gas: **141900** for a merchant's first payment, **~107700** after. The
difference is the cold storage write on their balance slot.

Every transaction, with blocks, gas, amounts and consensus timestamps,
are in [docs/deployments.md](docs/deployments.md).

## What it defends against

- **Merchant binding.** The nonce commits to `(merchantEvm, paymentId)`, so a
  signature can't be redirected to another merchant. Enforced twice
  independently: on-chain by `Escrow.settleAuthorization`, off-chain by the
  facilitator, both recomputing the same hash.
- **Replay, without an exhaustible store.** Resource binding and the payment
  window fall out of an HMAC derivation, not a lookup table an attacker could
  fill up with free requests. Issuing a 402 costs no storage at all. The one
  thing derivation can't prove is "never redeemed before", so a
  `ConsumedNonceStore` is consulted — but only written once a request is
  actually being paid for.
- **Non-custodial withdrawal.** Payments land in an escrow only the merchant
  can withdraw from. There is no admin path — not for the facilitator, not for
  ferry402 — that can move credited funds. A facilitator can refuse service;
  it cannot drain escrow.
- **Crediting what actually arrived.** Settlement credits the measured balance
  change, never the amount an authorization requested. That matters for any
  token whose transfer doesn't move exactly what was asked for.

[SECURITY.md](SECURITY.md) has the full threat model.

## Known limitations

<a id="serve-then-settle"></a>
**Serve-then-settle.** The resource is served once `/verify` passes, before
settlement is on-chain. This is x402's own trust assumption — a verified
signature treated as good as cash for a small payment — but the window is
real: a payer could spend their balance elsewhere in the gap, or settlement
could fail after you've handed over the resource. `/verify` checks live
balance, a settlement-time buffer, and that the escrow's token matches, which
narrows it as far as this architecture allows. The residual risk lands on the
merchant.

**The same payer can't buy the same URL twice within 5 minutes.** The
challenge is derived from `(merchantEvm, resource, time bucket)` with no
per-purchase component, so a repeat purchase of an identical URL by the same
payer derives an identical nonce — which the consumed-nonce store has already
seen. The second payment is rejected with `invalid_payment`, and the 402 it
gets back carries the *same* `paymentId`, so retrying doesn't help; that payer
is blocked on that URL for up to 10 minutes.

In practice most metered endpoints vary by path or query parameter, which
yields a distinct resource and a distinct nonce. But an endpoint that takes no
parameters and is polled repeatedly — an autonomous agent hitting the same
quote endpoint, say — hits this immediately. The workaround is to vary the URL
per request; [`examples/demo-ui`](examples/demo-ui) does exactly that and
shows the URL it used. A real fix needs a per-purchase value in the derivation,
transmitted alongside the payment, which is a protocol change rather than a
config one.

**Replay protection is per-process by default.** `InMemoryConsumedNonceStore`
isn't shared between instances, and a restart clears it — losing replay
protection for the window still open at that moment (up to 10 minutes). Pass
your own store (Redis, a database) via
`ferry402(config, { consumedNonceStore })` for anything multi-instance.

**The Hedera topic has no submit key.** Topic `0.0.10719807` was created with
`submit_key: null`, so anyone can append to it, and `admin_key: null`, so that
can never change. A journal entry is therefore **not standalone proof of
payment** — it's an ordered, timestamped index. The trustworthy check is the
reconciliation: filter by `merchantEvm` and verify each `txHash` against the
chain, which is what the demo and the e2e test both do. Set a submit key on
your own topic if you want appends restricted.

**No audit.** 39 Foundry tests including fuzz and invariant runs, and every
property above is tested — but nobody outside this project has reviewed it.

**No packaged payer client**, beyond `createPaymentHeader`.

**Cross-chain netting and a Hedera-side `SettlementLedger.sol`** are in the
design but not built. This repo does per-chain escrow and journaling; you
reconcile by reading the journal.

## Repo layout

| | |
|---|---|
| [`packages/contracts`](packages/contracts) | `Escrow.sol`, the non-custodial vault. Standalone Foundry project — **not** a pnpm workspace member, so `pnpm -r` never touches it |
| [`packages/sdk`](packages/sdk) | `@ferry402/sdk` — the middleware, `createPaymentHeader`, and the challenge/nonce primitives. ESM only |
| [`packages/facilitator`](packages/facilitator) | `createFacilitatorApp()` — the `/verify` + `/settle` service and journal writer. `private`, so self-host from source |
| [`examples/demo`](examples/demo) | The narrated live demo. Installs the **published** SDK from npm, so it tests what you'd actually get |

## Development

**You'll need** Node >= 20.18.3, pnpm 9 (pinned via `packageManager`, so
`corepack enable` is enough), and [Foundry](https://getfoundry.sh) for the
contracts.

```bash
pnpm install
pnpm -r build   # required before testing: the facilitator resolves the SDK through dist/
pnpm -r test    # sdk 138 · facilitator 92 (+1 skipped)
```

Contract tests run separately, because `packages/contracts` has no
`package.json` and isn't a workspace member:

```bash
cd packages/contracts && forge test   # 39 tests, including a 128k-call invariant run
```

None of that touches a network or spends anything.

### The live end-to-end test

```bash
RUN_E2E=1 pnpm --filter @ferry402/facilitator test:e2e
```

One genuine payment against real networks. Excluded from `pnpm test` because
it spends real testnet USDC and ETH every run. Without `RUN_E2E=1` the file is
still collected and reported as **skipped** rather than silently missing, and
needs no credentials.

### Environment variables

Copy `.env.example` to `.env`. **Never commit `.env`** — it's gitignored and
must stay that way. `.env.example` documents every variable; the two that
cause the most trouble:

**`HEDERA_PRIVATE_KEY`** — a fresh ECDSA account from the Hedera portal gives
you a DER-encoded key. Load it with `PrivateKey.fromStringDer()` or
`fromStringECDSA()`, **never** `fromStringED25519()`. The ED25519 loader
doesn't error on the wrong key type; it silently derives a different key, and
the `INVALID_SIGNATURE` you get at submit time gives no hint why.

**`PAYER_PRIVATE_KEY`** — needs USDC, not ETH. EIP-3009 is signed off-chain,
so the payer never submits a transaction or pays gas.

### Deploying your own

```bash
cd packages/contracts
forge create src/Escrow.sol:Escrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --constructor-args <USDC_ADDRESS>
```

`--constructor-args` must come **last** — `forge create`'s variadic parser
otherwise swallows the next flag into the constructor args and reports a bogus
arg-count mismatch.

Then create a journal topic:

```bash
pnpm --filter @ferry402/facilitator exec tsx scripts/create-topic.ts
```

It prints the topic id; set it as `HCS_TOPIC_ID`.

## Design notes

The [design doc](docs/superpowers/specs/2026-09-23-ferry402-design.md) records
the full architecture, including three amendments that are load-bearing
throughout the codebase: merchant binding, crediting the observed balance delta
rather than the requested amount, and merchant identity being two separate
identifiers.

## Licence

MIT — see [LICENSE](LICENSE).
