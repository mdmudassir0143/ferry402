# anychain402 — Design

**Status:** approved design, pre-implementation
**Date:** 2026-09-23
**Author:** Mohammad Mudassir (with Claude Opus 5)

## Summary

`anychain402` lets an x402-protected service accept payment from users on Base,
Polygon and Arbitrum while keeping Hedera as the ledger of record. A developer
installs one package and wraps a route; the service becomes payable from any
supported chain without the developer writing chain-specific code.

The system is **non-custodial**: funds land in a per-chain escrow the merchant
can always exit. Hedera holds net positions, settlement policy and an immutable
journal. Value crosses a bridge only on explicit consolidation, never per payment.

## Problem

An x402 service on Hedera can only be paid by users holding HBAR or HTS tokens.
Hedera does not appear among the five chains in Bitquery's August 2026 x402
analysis, which measured $2.6B across 18.3M payments. The reachable audience for
a Hedera-native x402 app is therefore close to zero, while Base and Polygon alone
carry 17.8M payments per month.

Existing work does not close this gap:

- `divi2806/x402-cross-bridge-sdk` implements the same pattern but settles to
  **USDC on Base**, does not support Hedera, and is at 1 star / 10 commits.
- Hedera's own x402 implementation is settlement-agnostic as a protocol but
  "on Hedera it settles in HBAR or HTS tokens" — Hedera-only settlement.
- Multi-chain x402 SDKs (e.g. `UltravioletaDAO/uvd-x402-sdk-python`) add Hedera
  as *a* settlement chain, not as a clearing layer for payments made elsewhere.

## Goals

1. A developer adds cross-chain payment acceptance in one line of code.
2. The merchant never loses custody, and can always withdraw without our help.
3. No bridge in the per-payment hot path.
4. Hedera is the authoritative, auditable record of all positions.
5. The facilitator is self-hostable; nothing requires trusting a hosted service.

## Non-goals (v1)

- Float / instant merchant payout. Deliberately deferred: it is a balance-sheet
  business with money-transmission exposure. Interfaces should not preclude a
  float provider being added later as a separate opt-in role.
- Non-EVM source chains (Solana, Stellar).
- Tokens other than USDC.
- Fiat off-ramp.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Custody | Non-custodial escrow | No licensing exposure; "non-custodial" is verifiable in contracts, which is what makes infrastructure trustworthy |
| Settlement | Net, on demand | Average Base x402 payment is ~$3.70; per-payment bridging costs more than the payment |
| Hedera's role | Clearing + ledger of record | The rails *into* Hedera are poor (see below); routing around them while keeping Hedera authoritative is the honest design |
| Source chains v1 | Base, Polygon, Arbitrum | 98% of x402 payment count (Base+Polygon) plus 90% of dollar value (Arbitrum) |
| Contracts | Foundry | 57% of Solidity devs per the 2025 Solidity survey; fork testing is first-class |
| Authorization | EIP-3009 `transferWithAuthorization` | Gasless for the payer, no approval transaction, already used by x402 |

### Why not bridge per payment

| Rail | Hedera support | Notes |
|---|---|---|
| Circle CCTP | **No** | Hedera has native USDC via Circle Mint but is not on the CCTP domain list |
| Relay | **No** | 85+ chains, Hedera absent; EVM-oriented |
| Stargate (LayerZero) | Yes | Pool-issued token, fungible with native USDC until the pool drains |
| Squid (Axelar) | Yes | Defaults to axlUSDC (wrapped) |
| Hashport | **Decommissioned** | Shut down 2026-05-31; wrapped assets permanently unredeemable |

No burn-and-mint rail into Hedera exists. Consolidation must therefore be batched,
rail-agnostic, and able to degrade gracefully when a route is unavailable.

## Architecture

```
agent/user on Base ──signs EIP-3009──▶ Escrow.sol (Base)      ─┐
agent/user on Polygon ───────────────▶ Escrow.sol (Polygon)   ─┼─▶ facilitator
agent/user on Arbitrum ──────────────▶ Escrow.sol (Arbitrum)  ─┘      │
                                                                      │ journal
                                                          HCS topic ◀─┘
                                                                      │
                                              SettlementLedger.sol (Hedera)
                                              = authoritative net position
                                                     │
                            merchant withdraws ──────┼── on source chain (no bridge)
                                                     └── consolidated to Hedera (batched)
```

### Payment flow

1. Client requests a protected route with no payment.
2. Middleware returns **402** with a `PaymentRequirements` array advertising
   Base, Polygon and Arbitrum.
3. Client selects a chain it holds USDC on and signs an EIP-3009 authorization
   naming that chain's `Escrow` as recipient.
4. Client retries with the `X-PAYMENT` header.
5. Middleware calls facilitator `/verify`; on success the request is served.
6. Facilitator `/settle` submits the authorization on the source chain. USDC
   lands in `Escrow`, credited to the merchant.
7. Facilitator writes a journal entry to the HCS topic.
8. `SettlementLedger` on Hedera reflects the merchant's net position per chain.
9. Merchant withdraws on the source chain, or requests consolidation to Hedera.

## Components

### `packages/contracts` (Foundry)

**`Escrow.sol`** — deployed once per source chain.
- `settleAuthorization(auth, sig)` — pulls USDC via EIP-3009, credits merchant
- `balanceOf(merchant)` / `withdraw(amount, to)` — always available to merchant
- Per-chain, per-payer nonce set for replay protection
- No admin path that can move merchant funds

**`SettlementLedger.sol`** — Hedera.
- Merchant registry (Hedera account ↔ per-chain payout addresses)
- Net position per `(merchant, sourceChain)`
- `recordStatement(statement, sig)` — signed net statement, verified against the
  HCS journal
- Settlement windows and consolidation requests
- Handles HTS association for USDC on Hedera

### `packages/sdk` (TypeScript)

The developer-facing product. Target surface:

```ts
import { anychain402 } from '@anychain402/sdk'

app.use('/api/premium', anychain402({
  price: '$0.01',
  accept: ['base', 'polygon', 'arbitrum'],
  settleTo: 'hedera',
  merchant: '0.0.123456',
  facilitator: 'https://facilitator.example.com'
}))
```

- Framework adapters: Express, Hono, Next.js route handlers
- Client shim so an agent can pay from whichever chain it holds funds on
- Typed config; no chain-specific code in user space

### `packages/facilitator`

- `/verify` and `/settle` endpoints, one adapter per source chain
- Netting engine: accumulates `(merchant, chain)` positions
- HCS journal writer
- Containerised, self-hostable, stateless except for the journal

### `packages/nextjs`

Merchant dashboard: positions per chain, settlement history, statement export
read directly from the mirror node.

## Data model

### HCS journal entry

```json
{
  "v": 1,
  "type": "payment",
  "merchant": "0.0.123456",
  "sourceChain": "base",
  "asset": "USDC",
  "amount": "10000",
  "payer": "0x...",
  "txHash": "0x...",
  "nonce": "0x...",
  "ts": "2026-09-23T10:00:00Z"
}
```

Entry types: `payment`, `withdrawal`, `statement`, `consolidation`.
Each carries the originating transaction hash, making the topic an auditable
join between chain state and ledger state.

**Cost note:** `ConsensusSubmitMessage` is $0.0008. Against a ~$3.70 average
payment this is ~0.02% — acceptable per payment. It would *not* be acceptable
for sub-cent payments, so the journal writer must support batched entries.

## Security model

Threats in priority order:

1. **Replay** — an authorization submitted twice, or on two chains. Nonces are
   scoped per chain and per escrow; the domain separator includes chain ID.
   This is the primary fuzzing target.
2. **Facilitator compromise** — a hostile facilitator can refuse service or
   mis-journal, but cannot move funds: escrow withdrawal is merchant-only and
   the ledger verifies statements against the journal.
3. **Escrow drain** — no admin withdrawal path exists. Merchant balance accounting
   must be invariant-tested.
4. **Bridge failure during consolidation** — consolidation is opt-in, batched, and
   must fail closed, leaving funds withdrawable on the source chain.

## Testing strategy

- Foundry unit + invariant tests on `Escrow`: balance conservation, no
  double-settlement, withdraw-always-possible
- Fuzz tests on nonce/replay handling across simulated chain IDs
- Fork tests against real USDC contracts on Base, Polygon, Arbitrum
- SDK integration tests against a local facilitator
- One verifiable testnet payment end to end, evidenced by Hashscan + mirror node

## Build sequence

1. **Spike** — verify x402 multi-`accepts` behaviour and EIP-3009 support on all
   three chains' USDC. Everything downstream assumes both.
2. **Vertical slice** — Base only, end to end: middleware → verify → settle →
   escrow → HCS journal. One real testnet payment.
3. **Hedera ledger** — `SettlementLedger.sol`, net positions, statement verification.
4. **Chains 2 and 3** — Polygon and Arbitrum behind the same adapter interface.
5. **Netting + consolidation** — batched settlement, bridge adapter chosen on
   measured cost.
6. **Dashboard, scaffold-hbar template, docs, `.harness/`.**

Steps 1–3 already constitute a working product for a Hedera-native merchant.

## Risks

| Risk | Mitigation |
|---|---|
| x402 does not support multiple `accepts` entries as assumed | Spike in step 1; fallback is per-chain endpoints with client-side selection |
| A chain's USDC lacks EIP-3009 | Permit2 path as a per-chain adapter variant |
| Bridge liquidity unavailable at consolidation | Fail closed; funds stay withdrawable on source chain |
| Facilitator downtime blocks acceptance | Self-hostable; escrow withdrawal never depends on it |
| Hedera is "just a ledger" for Base-only merchants | Accepted. Target customer is the Hedera-native app wanting external users |
| Fast-moving competitive space (360+ x402 facilitator repos) | Ship the vertical slice early; the differentiator is Hedera clearing, not the rail |

## Distribution

- `@anychain402/sdk` on npm — the product
- scaffold-hbar template — the on-ramp, and the route to a Hedera docs listing
  with credited authorship

**Tooling constraint:** scaffold-hbar's `template.json` restricts
`packageManager` to `yarn | npm | none`. pnpm is not a valid value, so the
template uses yarn while the SDK monorepo may use pnpm.

## Open questions

1. Final package/repo name — `anychain402` assumed.
2. Bridge choice for consolidation (Stargate vs Squid) — decide on measured cost
   in step 5, not now.
3. Whether the hosted facilitator becomes a paid service — out of scope for v1.

---

## Amendment 1 — merchant binding (2026-09-24)

**Supersedes the Escrow description in Components.** Found by the Task 2 review;
confirmed by the controller.

### The defect

EIP-3009's `ReceiveWithAuthorization` typehash commits the payer's signature to
exactly six fields: `from, to, value, validAfter, validBefore, nonce`. The original
design passed `merchant` as a separate, caller-supplied argument to a permissionless
`settleAuthorization`. The beneficiary was therefore **not bound to the payer's
signature**: anyone holding `(auth, v, r, s)` could call
`settleAuthorization(attacker, auth, v, r, s)` and receive the credit. The token's
`msg.sender == to` check does not help, because the Escrow is still the caller.

In x402 the signed payload travels in an `X-PAYMENT` header to the resource server,
which relays it to the facilitator — so the resource server, the facilitator, and any
proxy between them hold a blob that credits an address of their choosing. This
silently converted the design into "trust the resource server and facilitator", which
contradicts the non-custodial goal in Goals #2.

Choosing `receiveWithAuthorization` over `transferWithAuthorization` closed this hole
at the token layer; the Escrow reintroduced it one layer up, and worse — the observer
picks the beneficiary rather than merely griefing.

### The fix

The beneficiary is bound into the authorization nonce, which EIP-3009 leaves as a free
32 bytes:

```
nonce = keccak256(abi.encode(merchant, paymentId))
```

The payer signs that nonce as part of the authorization. `Escrow.settleAuthorization`
takes `paymentId` and recomputes the nonce, rejecting any mismatch. Changing the
merchant changes the nonce, which invalidates the payer's signature. This costs no
extra gas, requires no typehash change, and introduces no trusted role.

Rejected alternatives: a second payer signature (doubles signing UX); restricting
settlement to a facilitator role (narrows who can exploit it rather than removing the
capability, and creates exactly the privileged fund-moving role the Global Constraints
forbid).

### Downstream consequences — binding on later tasks

- The SDK client must derive the nonce by this rule, not randomly.
- `PaymentRequirements.extra` must carry `paymentId` so the client can derive it.
- The facilitator's `/verify` must recompute the nonce and reject a mismatch **before**
  settling, so a redirect attempt fails off-chain rather than reverting on-chain.

## Amendment 2 — credit the observed delta (2026-09-24)

`settleAuthorization` credited `auth.value`, the amount *requested*, rather than the
amount actually received. Under a fee-on-transfer, deflationary or rebasing token the
ledger over-credits relative to real holdings, and because the Escrow is pooled custody
this becomes first-come-first-served insolvency once withdrawal exists. "USDC only" is
project policy, not a code guarantee, and the constructor validates nothing.

Fixed by measuring `token.balanceOf(address(this))` before and after the pull and
crediting the difference, under a reentrancy guard — the guard is load-bearing, since
a nested settle would otherwise corrupt the measured window.

## Amendment 3 — merchant identity is two identifiers, not one (2026-09-24)

**Found during Task 5.** The design conflated two different things under the name
`merchant`:

- On **Hedera**, the clearing layer, a merchant is a Hedera account id (`0.0.123456`).
  This is what the HCS journal and `SettlementLedger` key on.
- On **each source chain**, the merchant is an **EVM address**. This is the key of the
  `Escrow` ledger row, the account allowed to `withdraw`, and — critically — one of the
  two preimages of the authorization nonce:
  `keccak256(abi.encode(merchant, paymentId))` where `merchant` is `address`.

Emitting the Hedera account id in `PaymentRequirements.extra` makes the nonce
uncomputable by the client: it cannot produce an authorization the contract will accept,
because the contract hashes an `address` and the client was handed a dotted account id.
The two never agree, so **every payment would fail `MerchantNotBound`**.

### Fix

The SDK config carries both:

- `merchant: string` — the Hedera account id, clearing-layer identity
- `merchantEvm: Record<SupportedChain, \`0x${string}\`>` — the merchant's EVM address per
  source chain, mirroring the existing `escrows` map

Each `PaymentRequirements` entry's `extra` carries the `merchantEvm` for *that* chain
alongside `merchant` and `paymentId`, so the client computes
`nonce = keccak256(abi.encode(extra.merchantEvm, extra.paymentId))` — exactly what the
contract recomputes.

Per-chain rather than a single address because a merchant may control different
addresses on different chains, and `SettlementLedger`'s merchant registry was already
specified as "Hedera account ↔ per-chain payout addresses".

### Binding on later tasks

- **Task 6:** the client derives the nonce from `extra.merchantEvm`, never `extra.merchant`.
- **Task 7:** `/verify` recomputes the binding using the EVM address.
- **Task 8:** `settlePayment` passes the EVM address as the contract's `merchant` argument.
- **Task 9:** the HCS journal records the Hedera account id as `merchant`, and should also
  record the EVM address so the two identities can be reconciled off-chain.
