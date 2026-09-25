# ferry402

`ferry402` lets an [x402](https://x402.org)-protected HTTP service accept
payment from users on Base (and, per chain, Polygon) while keeping **Hedera**
as the ledger of record. A developer installs one package and wraps a route;
the service becomes payable without writing chain-specific code, without
custody risk, and without a bridge in the per-payment hot path.

The system is **non-custodial**: every payment settles into a per-chain
`Escrow.sol` contract the merchant can always withdraw from — nobody, not even
`ferry402`'s own facilitator, has an admin path to another merchant's funds.
Every settled payment is also journaled, in order, to a Hedera Consensus
Service (HCS) topic, so a merchant (or an auditor) can reconcile on-chain
escrow state against an immutable, mirror-node-queryable record without
trusting the facilitator's word for it.

See `docs/superpowers/specs/2026-09-23-ferry402-design.md` for the full design
(problem statement, architecture, and the two spec amendments that are
load-bearing throughout this codebase — merchant identity is two identifiers,
not one, and a settlement credits the *observed* balance delta, never the
amount an authorization merely requested).

## One-line integration

```ts
import express from 'express'
import { ferry402 } from '@ferry402/sdk'

const app = express()

app.get('/premium-endpoint', ferry402(config), (_req, res) => {
  res.json({ data: 'this only serves once payment verifies' })
})
```

`ferry402(config)` returns an Express `RequestHandler`. An unpaid request gets
a `402` with an `accepts` array describing every chain this merchant takes
payment on; a request carrying a valid `X-PAYMENT` header (a base64-encoded,
signed EIP-3009 `ReceiveWithAuthorization` payload) is verified against the
facilitator and, once approved, falls through to your own route handler via
`next()`.

**`ferry402()` only verifies — it does not itself call `/settle`.** Actually
collecting the payment (submitting the authorization to `Escrow.sol`) and
journaling it to HCS is the route handler's job, immediately after `next()`
runs — see `packages/facilitator/README.md`'s "Typical wiring" section and
`packages/facilitator/test/e2e.test.ts` for a complete, real-network example
of that wiring end to end.

## Packages

| Package | What it is |
|---|---|
| [`packages/contracts`](packages/contracts) | `Escrow.sol` — the non-custodial per-chain vault. Foundry project. |
| [`@ferry402/sdk`](packages/sdk) | The `ferry402()` Express middleware, `buildRequirements`, and the stateless-challenge/nonce primitives a merchant integrates directly. |
| [`@ferry402/facilitator`](packages/facilitator) | `createFacilitatorApp()` — the `/verify` + `/settle` HTTP service, plus the HCS journal writer (`journal.ts`). Self-hostable; nothing requires trusting a hosted instance. |

## Prerequisites

- **Node >= 20.18.3** (see `engines` in every `package.json`)
- **pnpm 9** (`packageManager` pins `9.15.9`)
- **[Foundry](https://getfoundry.sh)** (`forge`/`cast`/`anvil`) — required to build/test `packages/contracts`, and to deploy `Escrow.sol`
- A **funded Base Sepolia key** (or Base mainnet, for a real deployment) to deploy `Escrow.sol` and to run the facilitator's settlement wallet
- A **Hedera testnet (or mainnet) account** — an account id and private key, used as the HCS journal's operator

## Environment variables

Copy `.env.example` to `.env` and fill in real values. **Never commit `.env`.**

| Variable | Used by | Notes |
|---|---|---|
| `BASE_SEPOLIA_RPC_URL` | facilitator bootstrap, deploy script | Public RPC by default (`https://sepolia.base.org`); a production deployment should point this at a private RPC provider — see `chains/base.ts`'s doc comment on why a public endpoint's rate limits/availability gate the whole payment path. |
| `DEPLOYER_PRIVATE_KEY` | `forge create` (contract deployment only) | Testnet key. Needs Base Sepolia ETH for gas. Never read by the facilitator at runtime. |
| `FACILITATOR_PRIVATE_KEY` | `@ferry402/facilitator`'s `/settle` | Submits every settlement transaction to `Escrow.sol`. Needs Base Sepolia ETH for gas. Never logged, anywhere. |
| `PAYER_PRIVATE_KEY` | test/demo clients only | Signs the EIP-3009 authorization. Needs USDC, **not ETH** — EIP-3009 is signed off-chain; the payer never submits a transaction or pays gas. |
| `ESCROW_ADDRESS_BASE_SEPOLIA` | facilitator bootstrap (`escrows` option), merchant config | Set after deploying `Escrow.sol` (see below). **Not a secret** — this is the trusted-escrow allowlist entry an operator must pass explicitly to `createFacilitatorApp({ escrows: {...} })`; it is never read automatically. A network missing from that map is rejected outright (fail-closed) — see `packages/facilitator/src/chains/base.ts`'s `VerifyOptions.escrows` doc comment. |
| `HEDERA_ACCOUNT_ID` | HCS topic creation, journal writer | Hedera account id, e.g. `0.0.123456`. |
| `HEDERA_PRIVATE_KEY` | HCS topic creation, journal writer | **If ECDSA (the common case for a fresh testnet account from the Hedera portal), it is DER-encoded — load with `PrivateKey.fromStringDer()` or `fromStringECDSA()`, never `fromStringED25519()`.** The ED25519 loader does not error on a mismatched key type; it silently derives the wrong key, and the resulting `INVALID_SIGNATURE` at submit time gives no indication why. See `packages/facilitator/scripts/create-topic.ts`. |
| `HCS_TOPIC_ID` | journal writer | Set after creating the topic (see below). **Not a secret.** |

## Running the facilitator

```ts
import { createFacilitatorApp } from '@ferry402/facilitator'

const app = createFacilitatorApp({
  escrows: { 'base-sepolia': process.env.ESCROW_ADDRESS_BASE_SEPOLIA as `0x${string}` },
  rpcUrls: { 'base-sepolia': process.env.BASE_SEPOLIA_RPC_URL },
  facilitatorPrivateKey: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
})

app.listen(3000)
```

`escrows` is **required** and fails closed: a network with no entry in it
rejects every `/verify` and `/settle` request for that network, rather than
trusting whatever `payTo` an anonymous caller sends. See
`packages/facilitator/README.md` for the full configuration surface, the HCS
journal-writer wiring, and partial-batch-write semantics.

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
pnpm -r build   # @ferry402/sdk publishes from dist/; facilitator resolves it through the workspace symlink
pnpm -r test    # contracts: `forge test` (37 tests) · sdk: vitest (116 tests) · facilitator: vitest (82 tests)
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
run — importing it is safe even with no `.env` on disk at all.

#### Proof from the most recent live run (2026-09-26)

- Escrow deployed to Base Sepolia: [`0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429`](https://sepolia.basescan.org/address/0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429)
- Settlement transaction: [`0x2961061318d479160c90f85e2eae9a5bc0a5f568104df77ec393064c7888c780`](https://sepolia.basescan.org/tx/0x2961061318d479160c90f85e2eae9a5bc0a5f568104df77ec393064c7888c780) (`gasUsed: 107712`, real `receiveWithAuthorization` call against Base Sepolia USDC)
- HCS journal entry: topic [`0.0.10719807`](https://hashscan.io/testnet/topic/0.0.10719807), message [`https://hashscan.io/testnet/transaction/1790371121.483280892`](https://hashscan.io/testnet/transaction/1790371121.483280892) — read back and verified against the Hedera testnet mirror node, `amount` matching the on-chain `PaymentSettled.value` exactly.
- The test suite ran three times against live networks while this task was verified (two full passes after a type-safety fix, one earlier failure caused by public-RPC read lag — see the task report); every successful run produced an independently-verifiable settlement and journal entry the same way.

Full run log, every command, and the two "never tested against reality until
now" findings (the 500k settlement gas limit; the `duplicate_settlement`
classifier against real USDC's actual revert string) are in
`.superpowers/sdd/2026-09-23-anychain402-base-slice/task-10-report.md`.

## License

MIT
