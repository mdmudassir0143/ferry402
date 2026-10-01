# AGENTS.md

`ferry402` is an Express middleware, plus a matching facilitator service,
that lets an HTTP route charge for access using **x402** — the protocol
where an unpaid request gets back `402 Payment Required` instead of data —
settled by a signed **EIP-3009** token transfer and journaled to Hedera's
**HCS** (an ordered, timestamped message log). **This file is two unrelated
documents stapled together — read the one that matches you, and skip the
other:**

| You are... | Read | Skip |
|---|---|---|
| A coding agent about to edit a file in this repo | [Part 1 — Working on this repository](#part-1--working-on-this-repository) | Part 2 |
| An autonomous agent that just got a `402` from someone else's API and needs to pay it | [Part 2 — Paying for resources with ferry402](#part-2--paying-for-resources-with-ferry402) | Part 1 |

Part 2 never touches this repo's source — it's a protocol guide for a client
calling a `ferry402`-protected API from the outside. If you're not sure which
one you are: about to edit a file in this checkout → Part 1; just received a
`402` from someone else's API → Part 2.

---

## Part 1 — Working on this repository

### Layout

This is a pnpm workspace (`pnpm-workspace.yaml`: `packages/*`), with one
deliberate exception:

| Path | What it is | In the pnpm workspace? |
|---|---|---|
| `packages/sdk` | `@ferry402/sdk` — the public, published package | Yes |
| `packages/facilitator` | `@ferry402/facilitator` — private, self-hosted, not published | Yes |
| `packages/contracts` | `Escrow.sol`, Foundry project | **No** — it has no `package.json` at all |
| `examples/demo` | Runnable end-to-end demo | **No** — standalone npm project outside the workspace |

`packages/contracts` is a plain Foundry project. Because it has no
`package.json`, `pnpm -r <script>` silently never touches it — this is not a
misconfiguration to "fix", it's the reason `forge test` has to be run
separately (see below). `examples/demo` is *also* deliberately kept outside
the workspace and depends on the **published** `@ferry402/sdk@0.1.0` from
npm, not a `workspace:*` link — its whole point is to prove what a real
integrator gets after `npm install @ferry402/sdk`, not what the monorepo's
own symlinked source looks like. Don't "fix" it onto `workspace:*`; that
would defeat the thing it's testing.

### Build before you test

```bash
pnpm install
pnpm -r build   # REQUIRED before `pnpm -r test` — see why below
pnpm -r test
```

`@ferry402/sdk`'s `package.json` points `main`/`types`/`exports` at
`./dist/...`, not `./src/...`. pnpm links `packages/facilitator`'s
`node_modules/@ferry402/sdk` to `packages/sdk` via `workspace:*`, but that
symlink still resolves through `packages/sdk`'s own `package.json` fields —
which means it resolves through `dist/`. Until `tsc -p tsconfig.json` has
run once for `packages/sdk`, `dist/` doesn't exist, and every test file in
`packages/facilitator` that imports `@ferry402/sdk` fails at module
resolution, not at a test assertion. If facilitator tests are failing with
an import error and you haven't touched the SDK, run `pnpm -r build` first.

Contracts are not reached by `pnpm -r test` at all (see Layout above) —
run them separately:

```bash
cd packages/contracts
forge test   # unit + invariant + golden-vector suites, no network required
```

The one test suite that is deliberately **not** run by either of the above:

```bash
RUN_E2E=1 pnpm --filter @ferry402/facilitator test:e2e
```

This spends real testnet USDC and ETH and depends on two live networks
(Base Sepolia, Hedera testnet) being reachable. It is collected (so it shows
as "skipped", never silently missing) without `RUN_E2E=1`, but neither its
setup nor its assertions run. Don't invoke this unless you're specifically
asked to, and never in a loop — it costs real (testnet) funds on every run.

There is no wired-up linter (`pnpm -r lint` exists as a script name but no
package currently defines an actual lint step or an eslint config) — don't
assume a green `pnpm -r lint` means anything.

### ESM, Node floor

Every package is `"type": "module"` — no `require()` support, no CJS
interop condition in `exports`. `engines.node` is pinned to `>=20.18.3`
consistently across `packages/sdk`, `packages/facilitator`, and
`examples/demo`'s own `package.json` — don't write code that needs a newer
Node API than that floor guarantees, and don't assume a `require` can ever
work against `@ferry402/sdk`.

### Secrets

`.env` is gitignored (`.gitignore`: `.env`, `.env.*`, `!.env.example`) and
must stay that way. Never commit it, never echo its contents to a terminal
you don't control, and never print a `*_PRIVATE_KEY` value in a log line,
commit message, PR description, or agent transcript. `.env.example` marks
which variables are secrets and which aren't (e.g. `ESCROW_ADDRESS_BASE_SEPOLIA`
and `HCS_TOPIC_ID` are explicitly **not** secrets — they're public addresses
— but `FACILITATOR_PRIVATE_KEY`, `DEPLOYER_PRIVATE_KEY`, `PAYER_PRIVATE_KEY`,
and `HEDERA_PRIVATE_KEY` are). If you're asked to debug something and it
would help to print `process.env`, filter private keys out first.

### Hard invariants — do not break these silently

**The nonce derivation is implemented twice, in two different languages,
and both must agree byte-for-byte:**

```
nonce = keccak256(abi.encode(merchantEvm, paymentId))
```

- TypeScript: `packages/sdk/src/nonce.ts`'s `computeNonce` (used by
  `ferry402()`'s middleware, `createPaymentHeader`, and
  `packages/facilitator/src/chains/base.ts`'s `verifyPayment`/`settlePayment`
  — all three import the *same* function, deliberately, rather than each
  restating the hash).
- Solidity: `packages/contracts/src/Escrow.sol`'s `_checkBinding`.

Both are pinned to the **same literal golden vectors** — not just
"independently tested", the actual `bytes32` values are copied verbatim
across files: `packages/sdk/test/nonce.test.ts`,
`packages/contracts/test/NonceGoldenVectors.t.sol`, and
`packages/facilitator/test/verify.test.ts` all assert against the identical
hardcoded nonces.

Read `NonceGoldenVectors.t.sol`'s own doc comment for why this matters more
than it sounds: if you change the encoding on only one side (say,
`abi.encode` → `abi.encodePacked` in Solidity, or the equivalent in
`nonce.ts`), that side's *own* test suite stays green, because its test
helpers recompute the nonce the same new way you just changed it to. Only a
live cross-language run would catch the divergence — and the live e2e test
is excluded from CI by design (see above).

The failure mode in production is every single settlement reverting
`MerchantNotBound`, discovered only on a real chain. If you ever touch
`computeNonce` or `_checkBinding`, change both sides in the same commit and
re-run both `pnpm --filter @ferry402/sdk test` and `forge test`.

Other invariants worth knowing before you refactor around them (see
`docs/superpowers/specs/2026-09-23-ferry402-design.md`'s three Amendments
for the full incident history each one closes):

- **Merchant binding (Amendment 1).** The authorization nonce must commit to
  the merchant's EVM address. Don't add a code path where the Escrow trusts
  a caller-supplied `merchant` argument without recomputing the nonce from
  it — that's the exact hole Amendment 1 closed.
- **Observed-delta crediting (Amendment 2).** `Escrow` credits
  `balanceOf(after) - balanceOf(before)`, never `auth.value`. Don't
  reintroduce a path that credits the requested amount directly.
- **Two merchant identifiers (Amendment 3).** `merchant` (Hedera account id)
  and `merchantEvm` (per-chain EVM address) are never interchangeable. A
  journal entry or a contract call that accidentally swaps them doesn't
  silently miscredit — it reverts or fails validation — but it does mean
  "just use `merchant` here, they're basically the same" is never a safe
  simplification.
- **Trusted-escrow allowlist fails closed.** `createFacilitatorApp`'s
  `escrows` option is the only thing stopping an anonymous `/verify` or
  `/settle` caller from naming their own contract as `payTo`. A network with
  no entry is rejected, not trusted by default — don't change that to an
  opt-in allowlist.

---

## Part 2 — Paying for resources with ferry402

You are an agent that wants to consume a resource guarded by `ferry402()`.
This section is everything you need: why your usual x402 client won't work,
a real loop that does, how to read rejections, and how to confirm you
actually got what you paid for.

### Why a stock x402 client cannot pay a ferry402 route

This is a security property, not a missing feature. `ferry402` binds the
EIP-3009 authorization's `nonce` to the merchant it was issued for:

```
nonce = keccak256(abi.encode(merchantEvm, paymentId))
```

`paymentId` itself is **derived**, not random —
`HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)` — computed
server-side from a secret only the merchant's own `ferry402()` instances
hold. A stock `x402@1.2.0` client (`x402-fetch`, `x402-axios`, or anything
using `x402/client`'s `createNonce()`) mints its own nonce as random bytes.

A random 32 bytes will never equal the two values `ferry402`'s
`matchChallenge` actually checks against (the current and previous
derivation window), so the request fails closed with `invalid_payment` —
indistinguishable, from your side, from any other nonce mismatch (a
genuinely stale challenge included).

There is no configuration flag that makes a random nonce work; you must
derive the nonce the way the merchant's middleware will recompute it, which
means using `@ferry402/sdk`'s own `createPaymentHeader` (or re-implementing
`computeNonce` exactly — not recommended; see Part 1's invariant above for
why a reimplementation is the easiest way to get this byte-for-byte wrong).

### The payer loop

This is the real flow — request, read the 402, extract `accepts`, sign,
retry — lifted from `examples/demo/src/run.ts`'s own STEP 1–4 (the one place
in this codebase that runs this exact sequence against a live chain):

```ts
import { createPaymentHeader } from '@ferry402/sdk'
import type { PaymentRequirements } from '@ferry402/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as Hex)

async function payAndFetch(url: string): Promise<unknown> {
  // 1. Ask for free first. Every ferry402 route answers an unpaid GET
  //    with 402 and an `accepts` array — one entry per chain this merchant
  //    takes payment on.
  const first = await fetch(url)
  if (first.status !== 402) {
    // Not ferry402-guarded, or already free — nothing to pay.
    return first.json()
  }
  const { accepts } = (await first.json()) as { accepts: PaymentRequirements[] }

  // 2. Choose a network you actually hold USDC on. Read `network`,
  //    `maxAmountRequired` (atomic units — see "Budgeting" below) and
  //    `payTo` straight off the entry you pick. Never hardcode these.
  const requirement = accepts.find((r) => r.network === 'base-sepolia')
  if (!requirement) throw new Error('merchant does not accept base-sepolia')

  // 3. Sign. createPaymentHeader derives the SAME nonce this merchant's
  //    middleware will check for (see "Why a stock x402 client cannot pay
  //    a ferry402 route" above) and returns a ready-to-send header.
  const header = await createPaymentHeader(requirement, account, {
    tokenName: 'USDC', // read from the token contract's name(), or the
    tokenVersion: '2', //  merchant's deployment notes — both are
    chainId: 84532, //      deployment-specific and not safe to assume
  })

  // 4. Retry with X-PAYMENT.
  const paid = await fetch(url, { headers: { 'X-PAYMENT': header } })
  if (paid.status === 200) return paid.json()

  const body = (await paid.json().catch(() => ({}))) as { error?: string }
  throw new Error(`payment rejected: ${body.error ?? paid.status}`)
}
```

For Base Sepolia specifically, the USDC contract used throughout this
project's own live testing is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
(name `"USDC"`, domain version `"2"`), chain id `84532` — but **don't
hardcode these across deployments**: `tokenName`/`tokenVersion` are
deployment-specific (a different USDC deployment, or a different accepted
asset entirely, can use different values), which is exactly why
`createPaymentHeader` takes them as explicit options instead of guessing.

### Handling rejections

Read `packages/sdk/src/middleware.ts` and
`packages/facilitator/src/chains/base.ts` directly if you need the full
decision tree — this table is what actually comes back on the wire, and
flags where the code a merchant returns is **less specific than the real
cause**, which matters for deciding whether to retry:

| `error` code | Where it comes from | What it actually means | What to do |
|---|---|---|---|
| `invalid_payload` | Local (malformed payload) or facilitator (missing `extra.merchantEvm`/`paymentId`, bad address shape) | The `X-PAYMENT` header you sent isn't structurally valid, or you built it from a stale/foreign `accepts` entry | Fetch a fresh 402 from *this* URL and rebuild the header from that response |
| `invalid_network` | Local: you claimed a `network` this merchant has no entry for. Facilitator: unsupported network. | Typo, or you picked a chain the merchant doesn't accept | Re-read `accepts[].network` verbatim |
| **`invalid_payment`** | Collapses four distinct causes — see [below](#invalid_payment-the-four-causes-it-collapses) | The nonce you presented doesn't match what the server would derive right now | **Always fetch a brand-new 402 and sign fresh** — see below |
| `invalid_exact_evm_payload_authorization_value` | Local or facilitator | You signed `value` below `maxAmountRequired` | Re-read the price off a fresh 402 and sign that amount |
| `invalid_exact_evm_payload_recipient_mismatch` | Local, facilitator, or on-chain (`Escrow.RecipientMismatch`, surfaced by the facilitator as this same code) | `authorization.to` doesn't equal `payTo` | Use `requirement.payTo` verbatim as `to` |
| `invalid_exact_evm_payload_authorization_valid_after` / `_valid_before` | Local or facilitator (facilitator adds a 10-second settlement buffer on top of the raw check) | Your signed time window hasn't started, or is too close to expiring to safely settle | Let `createPaymentHeader`'s defaults set the window; don't sign a `validBefore` only a few seconds out |
| `invalid_exact_evm_payload_signature` | Facilitator only | Malformed/malleable signature, wrong signer, or a failing EIP-1271 check (smart-contract wallets) | Re-sign; if `from` is a smart-contract wallet, confirm it actually returns the correct magic value |
| `invalid_payment_requirements` | Facilitator only | `payTo` isn't a trusted escrow, or its token doesn't match `requirement.asset` | Not something you caused — a merchant/facilitator misconfiguration. Contact the operator |
| `insufficient_funds` | Facilitator only, from a **live** on-chain balance read | Your wallet's current on-chain balance is below the price, checked right before the resource would be served | Top up USDC on that network, then retry — the nonce was not consumed (see "Idempotency" below) |
| `unexpected_verify_error` | Facilitator unreachable/timed out, bad facilitator response, RPC down, or a local store error | A transient infrastructure problem, not a problem with your signature | Safe to retry the identical header — see "Idempotency" below |

A merchant's own route handler can also surface `/settle`-time failures
(`duplicate_settlement`, `unexpected_settle_error`) however it chooses to
report them — these aren't part of `ferry402()`'s own 402 vocabulary, since
`/settle` only ever runs after a resource was already served. If you see one
of these from a merchant's custom error field, treat it the same as
`invalid_payment`: get a fresh 402.

#### `invalid_payment`: the four causes it collapses

A single `invalid_payment` response can mean any of these — the client has
no way to tell which:

1. **Genuinely expired challenge** — past the ~10-minute derivation window.
   (Local.)
2. **A nonce derived for the wrong resource or merchant address.** (Local.)
3. **A stock-client nonce that was never derived at all** — see "Why a stock
   x402 client cannot pay" above. (Local.)
4. **A nonce already consumed** — including by your own earlier identical
   request. (Local.) Facilitator responses with `isValid: false` and no
   specific `invalidReason` also surface as this same code.

**What to do:** always fetch a brand-new 402 and sign fresh. Retrying the
identical header is pointless for causes 2–4, and cause 1 needs a fresh
derivation anyway.

*Before 0.2.0 this code was `payment_expired`, which asserted expiry
specifically — a claim ferry402 was never actually in a position to make,
since the window is enforced by HMAC derivation, not a store with
timestamps to inspect. `invalid_payment`, a real x402 `ErrorReasons` member,
says only what is actually known.*

### Idempotency and retries

**A consumed nonce can never be reused — a retry after that needs a fresh
challenge, not the same signed header.** The specifics, read directly off
`middleware.ts`:

- If the nonce reaches a genuine double-spend check (the same `(from,
  nonce)` pair was already recorded) or fails the resource/merchant/TTL
  match, you get `invalid_payment` and the nonce was **never released** —
  because it was never newly consumed by this request in the first place.
  Retrying the identical header will fail the identical way forever. Get a
  new 402.
- If the facilitator call fails for any reason — network error, timeout, or
  the facilitator reports `isValid: false` for *any* reason including
  `insufficient_funds` or a bad signature — the middleware explicitly
  **releases** the nonce it had provisionally consumed
  (`ConsumedNonceStore.release`).
  - This means the identical signed header genuinely can be retried in
    these cases, as long as you're still inside its `validBefore` window:
    e.g. `insufficient_funds` → top up → retry the *same* header;
    `unexpected_verify_error` → wait a moment → retry the *same* header.
- Once a payment actually succeeds (`isValid: true`, and later `/settle`
  redeems it on-chain), that nonce is permanently spent. There is no
  idempotent "pay again safely" here by design — EIP-3009 nonces, like the
  merchant binding they're bound to, are single-use.

If you can't tell from the error code alone which bucket you're in, the
safe default is: on `insufficient_funds` or `unexpected_verify_error`, retry
the same header a bounded number of times; on anything else, fetch a new
402.

### Keep payments sequential

This is about a different nonce entirely — not the EIP-3009 authorization
nonce above, but the ordinary Ethereum account transaction nonce of the
**facilitator's own settlement wallet** (`FACILITATOR_PRIVATE_KEY`). Every
successful payment triggers one `/settle` call, which broadcasts one
transaction from that single wallet, and two transactions from the same
account racing for the same nonce is a real failure mode: one lands, the
other gets dropped, replaced, or stuck.

`packages/facilitator/src/chains/base.ts`'s `settlePayment` constructs its
account with `privateKeyToAccount(facilitatorPrivateKey, { nonceManager })`
— viem's `nonceManager` singleton, which queues nonce acquisition for the
same `(address, chainId)` through one in-process promise chain. **What this
covers:** concurrent `/settle` calls handled by the *same facilitator
process* get distinct, sequential nonces, and both land.

**What it does not cover:** `nonceManager`'s queue is in-memory, per
process. If the facilitator you're paying is horizontally scaled — multiple
processes or instances sharing the same `FACILITATOR_PRIVATE_KEY` behind a
load balancer — each process has its own independent queue, and two
processes can still read the same on-chain nonce and race. Nothing in this
codebase coordinates nonce assignment across processes.

You, as the paying agent, have no visibility into how the facilitator you're
talking to is deployed. Firing many payment requests at the same merchant in
tight parallel multiplies your exposure to this race — one of your payments
can fail with a confusing, generically-reported settle error that is
actually just a dropped transaction, not a problem with your signature.

**The safe default is to run your own payment loop sequentially**: await
the full request → 402 → sign → retry → response cycle for one payment
before starting the next, rather than issuing several `payAndFetch` calls
concurrently against the same merchant.

### Budgeting

The price is published in the 402 itself (`maxAmountRequired`), as a
decimal-string **atomic unit** amount — never a dollar figure you compute
yourself. USDC uses 6 decimals, so `"10000"` is $0.01. This project's own
live settlements on Base Sepolia are all exactly this: seven real
settlements of `10000` atomic units ($0.01) each (see
`.superpowers/sdd/2026-09-23-anychain402-base-slice/verified-chain-facts.md`
for the verified on-chain figures).

You never need ETH for the payment itself — EIP-3009 authorizations are
signed off-chain and the facilitator's own wallet pays the gas to submit
them — but you do need the quoted USDC amount actually available in your
wallet on the chain you chose, checked live by the facilitator's
`insufficient_funds` gate before anything is served.

### Verifying a payment landed

A successful `200` response means the resource was served and a settlement
was *attempted* — it does not, by itself, prove the money moved, since this
codebase's architecture is serve-then-settle (the resource is handed over
once `/verify` passes, before `/settle` has redeemed anything on-chain).
There are two places to actually confirm it:

1. **The HCS journal** — an ordered record a merchant writes to after a
   successful settlement, readable from the public Hedera mirror node with
   no credentials:

   ```bash
   curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10719807/messages?limit=25&order=asc"
   ```

2. **The on-chain escrow ledger row and the token's own balance** — also
   public, no credentials:

   ```bash
   cast call 0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 "balanceOf(address)(uint256)" \
     <merchantEvmAddress> --rpc-url https://sepolia.base.org
   cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "balanceOf(address)(uint256)" \
     0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 --rpc-url https://sepolia.base.org
   ```

**Trust the chain read over the journal entry.** The HCS topic's
`submit_key` is `null` — anyone can append a message to it, including one
shaped to look like a legitimate journal entry for a merchant they don't
control. The journal is a useful ordered index (and the mirror node is far
cheaper to poll than re-deriving reconciliation from raw chain state every
time) — but it is **never standalone proof of payment**.

The only thing that actually proves a payment landed is the settlement
transaction itself and the resulting balance on the `Escrow` contract —
cross-check a journal entry's `txHash` against the real chain, never take
the entry alone as proof. See `SECURITY.md`'s "Known limitations" for the
full reasoning, and `docs/deployments.md` / `docs/troubleshooting.md` for
more worked reconciliation examples.
