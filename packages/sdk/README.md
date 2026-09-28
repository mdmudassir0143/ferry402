# @ferry402/sdk

The merchant-side (and payer-side) half of [ferry402](https://github.com/mdmudassir0143/ferry402):
an [x402](https://x402.org) Express middleware that turns any route into a
payable one, settling into a non-custodial per-chain `Escrow` contract with
Hedera as the clearing ledger.

See the [repo root README](https://github.com/mdmudassir0143/ferry402#readme)
for the full system — this package, the facilitator, and the contracts.

## Install

```bash
npm install @ferry402/sdk
```

ESM only (`"type": "module"`, no `require` condition). Requires Node >= 20.18.3
and Express `^4.18.0 || ^5.0.0` as a peer dependency.

## Quickstart: guard a route

```ts
import express from 'express'
import { ferry402 } from '@ferry402/sdk'
import type { Ferry402Config } from '@ferry402/sdk'

const config: Ferry402Config = {
  price: '$0.01',
  accept: ['base-sepolia'],
  settleTo: 'hedera',
  merchant: '0.0.123456', // your Hedera account id
  merchantEvm: { 'base-sepolia': '0xYourPayoutAddress', base: '0x...', polygon: '0x...', 'polygon-amoy': '0x...' },
  facilitator: 'http://localhost:4000',
  escrows: { 'base-sepolia': '0xDeployedEscrowAddress', base: '0x...', polygon: '0x...', 'polygon-amoy': '0x...' },
  assets: { 'base-sepolia': '0xUSDCAddress', base: '0x...', polygon: '0x...', 'polygon-amoy': '0x...' },
  secret: process.env.FERRY402_SECRET!, // >= 32 bytes, shared across every instance
}

const app = express()

app.get('/premium-endpoint', ferry402(config), (_req, res) => {
  res.json({ data: 'this only serves once payment verifies' })
})
```

An unpaid request gets a `402` with an `accepts` array; a request carrying a
valid `X-PAYMENT` header falls through to your handler via `next()`.
**`ferry402()` only verifies — it does not call `/settle`.** Actually
collecting the payment and journaling it to HCS is your handler's job,
immediately after `next()` runs — see the root README's "How it works" and
`@ferry402/facilitator`'s docs for the settlement half of that wiring.

## Paying a route: `createPaymentHeader`

**No stock x402 client (`x402-fetch`, `x402-axios`, or anything built against
plain `x402@1.2.0`) can pay a ferry402 route.** ferry402 binds the EIP-3009
authorization `nonce` to the merchant it was issued for —
`nonce = keccak256(abi.encode(merchantEvm, paymentId))` — instead of letting
the payer mint random bytes, specifically so a signed payment can never be
redirected to a merchant other than the one who issued the 402. Upstream
`x402` clients generate a random nonce; ferry402 never recognizes it as
matching any challenge it issued, so the payment fails closed with
`payment_expired`.

Use `createPaymentHeader` instead — it derives the same nonce ferry402
expects and signs the `ReceiveWithAuthorization` for you:

```ts
import { createPaymentHeader } from '@ferry402/sdk'
import { privateKeyToAccount } from 'viem/accounts'

// 1. Hit the route with no payment; read the 402's `accepts` array.
const res = await fetch('http://merchant.example/premium-endpoint')
const { accepts } = await res.json()
const requirement = accepts[0] // pick the chain you want to pay on

// 2. Sign a payment header against it.
const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as `0x${string}`)
const header = await createPaymentHeader(requirement, account, {
  tokenName: 'USDC',   // the asset's EIP-712 domain name — read it from the
  tokenVersion: '2',   // token contract, or your deployment notes; it
  chainId: 84532,      // varies by deployment and can't be assumed
})

// 3. Retry with the header.
const paid = await fetch('http://merchant.example/premium-endpoint', {
  headers: { 'X-PAYMENT': header },
})
```

`signer` is any object with an `address` and a viem-compatible
`signTypedData` — a viem `PrivateKeyAccount` (as above) works directly; no
`viem` dependency is required by this package itself.

## Configuration reference

| Field | Notes |
|---|---|
| `secret` | **Required, >= 32 bytes.** `ferry402(config)` throws at construction if missing/short. Must be identical across every process/instance serving this merchant — it's what lets two instances validate each other's challenges with no shared store. Generate with `openssl rand -hex 32`; never commit it. |
| `escrows` | Per-chain `Escrow` contract address. Not this package's concern to validate against a live facilitator, but note: a **facilitator** started with no matching `escrows` entry for a chain rejects every payment on that chain (fail-closed) — see `@ferry402/facilitator`. |
| `merchant` | Your Hedera account id (e.g. `"0.0.123456"`) — the clearing-layer identity the HCS journal keys on. |
| `merchantEvm` | Per-chain EVM payout address — the `Escrow` ledger row key and one of the two preimages of the nonce binding. **Different from `merchant`**: one is a Hedera account id, the other is an EVM address, and mixing them up breaks the nonce derivation for that chain. |
| `accept` | Which chains (`'base' \| 'base-sepolia' \| 'polygon' \| 'polygon-amoy'`) this merchant takes payment on. |
| `assets` | Per-chain USDC (or other supported asset) contract address. |
| `facilitator` | Base URL of the facilitator this middleware calls `/verify` against. |
| `price` | Decimal-dollar string, e.g. `"$0.01"`. USDC (6 decimals) only in v1. |

## Known limitation

The default `InMemoryConsumedNonceStore` (replay protection) is **per-process**.
A restart clears it for the current derivation window, and it is not shared
across horizontally-scaled instances — pass your own `ConsumedNonceStore`
(Redis, a database, ...) via `ferry402(config, { consumedNonceStore })` for a
multi-instance deployment.

## License

MIT — see [LICENSE](./LICENSE).
