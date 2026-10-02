# Troubleshooting

Real failure modes, grounded in the actual error paths in
`packages/sdk/src/` and `packages/facilitator/src/` — not guesses at what
might go wrong. Each entry gives the symptom as you'll actually see it, the
cause in the code, and the fix.

**Find your symptom in this table, then jump to its section:**

| Symptom | Section |
|---|---|
| A stock x402 client (`x402-fetch`, `x402-axios`, plain `x402@1.2.0`) always gets `invalid_payment` | [A stock x402 client gets `invalid_payment` against every request](#a-stock-x402-client-gets-invalid_payment-against-every-request) |
| The *first* payment works, a second for the same URL is rejected `invalid_payment` | [A second payment for the same URL is rejected](#a-second-payment-for-the-same-url-is-rejected) |
| `createFacilitatorApp(...)` throws immediately, before listening | [`createFacilitatorApp` throws about `"escrows"`](#createfacilitatorapp-throws-about-escrows) |
| Every single payment attempt is rejected with `invalid_payment_requirements` | [Every request returns `invalid_payment_requirements`](#every-request-returns-invalid_payment_requirements) |
| A correctly-signed payment is rejected with `insufficient_funds` | [`insufficient_funds` from `/verify`](#insufficient_funds-from-verify) |
| Concurrent `/settle` calls look like they might race, or already have | [Settlements race under concurrent load — what's covered and what isn't](#settlements-race-under-concurrent-load--whats-covered-and-what-isnt) |
| Loading `HEDERA_PRIVATE_KEY` throws, or signs but submit fails with `INVALID_SIGNATURE` | [A Hedera private key fails to load, or produces `INVALID_SIGNATURE`](#a-hedera-private-key-fails-to-load-or-produces-invalid_signature) |
| A balance or journal entry reads stale immediately after a successful `/settle` | [A balance or journal read comes back stale right after `/settle`](#a-balance-or-journal-read-comes-back-stale-right-after-settle) |
| GitHub Actions fails with `Multiple versions of pnpm specified` | [CI fails with `Multiple versions of pnpm specified`](#ci-fails-with-multiple-versions-of-pnpm-specified) |
| You need a `/verify` + `/settle` service and don't know whether to install or self-host | [Running a facilitator](#running-a-facilitator) |

See [`docs/architecture.md`](architecture.md) for how the pieces these
failures touch fit together, and [`docs/deployments.md`](deployments.md) for
the live deployment these examples reference. Cross-references go back to
the root [`README.md`](../README.md) where it already covers the same ground
in more depth.

## A stock x402 client gets `invalid_payment` against every request

**Symptom:** You're using `x402-fetch`, `x402-axios`, or anything built on
plain `x402@1.2.0`'s `createNonce()`. Every attempt to pay a `ferry402` route
comes back `402` with `error: "invalid_payment"` — indistinguishable, from
the client's side, from any other nonce mismatch, no matter how fast you
retry. (Before 0.2.0 this was reported as `payment_expired`; see the "Cause"
below for why that was replaced.)

**Cause:** This is by design, not a bug. `ferry402` binds the EIP-3009
authorization `nonce` to the merchant it was issued for —
`nonce = keccak256(abi.encode(merchantEvm, paymentId))`
(`packages/sdk/src/nonce.ts`'s `computeNonce`) — so a signed payment can never
be redirected to a merchant other than the one whose `402` the payer actually
saw (Amendment 1, see [`docs/architecture.md`](architecture.md#design-decisions-the-three-amendments)).
`x402@1.2.0`'s own client helpers mint that nonce as random bytes instead.

A random nonce will never equal either of `matchChallenge`'s derived
candidates (`packages/sdk/src/challengeDerivation.ts`), so the middleware
rejects it.

The rejection reason is `invalid_payment`, not `payment_expired`: a mismatch
here could equally be a genuinely expired challenge, a nonce derived for the
wrong resource or merchant, or (as here) a self-invented nonce — the window
is enforced by the HMAC derivation itself, not a store with timestamps to
inspect, so there is nothing to look back at and tell those apart. Claiming
expiry specifically would assert a cause ferry402 has no way to establish.

**Fix:** Use `createPaymentHeader()` from `@ferry402/sdk` instead of a generic
x402 client:

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

It derives the same nonce the server will check for and signs against it.
There is currently no packaged, higher-level client (a fetch/axios wrapper
that runs the 402 → sign → retry loop automatically) — see the root README's
"Client compatibility" section.

## A second payment for the same URL is rejected

**Symptom:** The first payment succeeds and the resource is served. A second
payment from the same payer, for the same URL, within a few minutes, comes
back `402` with `error: "invalid_payment"`. The 402 body carries the *same*
`extra.paymentId` as the first one, so retrying never works. After about ten
minutes it starts working again on its own.

**Cause:** The challenge is derived, not stored:

```
paymentId = HMAC-SHA256(secret, merchantEvm | resource | timeBucket)
nonce     = keccak256(abi.encode(merchantEvm, paymentId))
```

There is no per-purchase component in that preimage. Same merchant, same
resource string, same 5-minute bucket produces the same nonce every time — and
the `ConsumedNonceStore`, keyed `(from, nonce)`, has already recorded it from
the first purchase. The middleware cannot tell a genuine second purchase apart
from the same payment replayed, so it rejects it. That is the replay defence
working correctly; it just cannot see the difference.

Note this is per payer: a *different* payer buying the same resource in the
same window is fine, because the store is keyed on `(from, nonce)` rather than
the nonce alone.

**Fix:** Make each purchase a distinct resource. The nonce derives from the
full request URL, so any varying component is enough:

```
GET /api/quote?request=0f3c9a            →  distinct nonce
GET /api/quote?request=7b21ee            →  distinct nonce
```

Most metered APIs get this for free, since calls differ by path or parameters.
A parameterless endpoint that gets polled — an autonomous agent hitting the
same quote URL in a loop — does not, and will hit this on its second call.
[`examples/demo-ui`](../examples/demo-ui) appends a unique query string for
exactly this reason, and displays the URL it used rather than the bare route.

**What would fix it properly:** a per-purchase value mixed into the
derivation and transmitted alongside the payment, so each 402 yields a unique
nonce without the merchant having to vary the URL. EIP-3009 signs only six
fields and the nonce is the only free one, so that value has to travel outside
the signature — a protocol change, not a configuration one. It is not
implemented.

## `createFacilitatorApp` throws about `"escrows"`

**Symptom:** Calling `createFacilitatorApp(...)` throws synchronously, before
the app ever starts listening:

```
Error: createFacilitatorApp: the "escrows" option is required, and must name at least one
network -> the Escrow contract address this facilitator operator deployed and trusts.
Without it every /verify and /settle is rejected fail-closed, which looks like a broken
install rather than a missing field. Example:

  createFacilitatorApp({
    escrows: { 'base-sepolia': '0xYourDeployedEscrowAddress' },
    rpcUrls: { 'base-sepolia': process.env.BASE_SEPOLIA_RPC_URL },
    facilitatorPrivateKey: process.env.FACILITATOR_PRIVATE_KEY,
  })
```

**Cause:** `assertHasTrustedEscrows` (`packages/facilitator/src/server.ts`)
runs at construction time and rejects a missing or empty `escrows` map. This
check exists because the alternative failure mode is worse: a facilitator
built with no `escrows` at all would start up fine and then reject **every**
`/verify` and `/settle` call with the generic `invalid_payment_requirements` —
indistinguishable from a broken install, and much harder to diagnose than a
constructor throwing immediately with the fix spelled out.

**Fix:** Pass `escrows`, keyed by network, naming the `Escrow` contract(s)
you actually deployed and trust:

```ts
createFacilitatorApp({
  escrows: { 'base-sepolia': process.env.ESCROW_ADDRESS_BASE_SEPOLIA as `0x${string}` },
  rpcUrls: { 'base-sepolia': process.env.BASE_SEPOLIA_RPC_URL },
  facilitatorPrivateKey: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
})
```

See [`docs/deployments.md`](deployments.md#1-deploy-escrowsol) for how to
deploy an `Escrow` and get an address to put here.

## Every request returns `invalid_payment_requirements`

**Symptom:** `/verify` (and therefore every `ferry402`-guarded route) rejects
every single payment attempt with `invalid_payment_requirements`, even ones
you're confident are correctly signed. The facilitator otherwise looks
healthy — it responds, it just rejects everything.

**Cause:** This is `verifyPayment`'s check 1
(`packages/facilitator/src/chains/base.ts`), and it runs before any other
check in the function: `requirements.payTo` must exactly match
`options.escrows[requirements.network]`, the facilitator operator's own
trusted-escrow allowlist. `/verify` and `/settle` are both unauthenticated
HTTP endpoints that take `paymentRequirements` straight from an anonymous
caller, so without this check `payTo` would be a value the *caller* controls.
Three concrete misconfigurations all surface as this exact error:

1. The facilitator's `escrows` map has no entry at all for the network the
   request names — fails closed, not "no allowlist configured, so trust the
   caller."
2. The merchant's `config.escrows[network]` (what `ferry402()` publishes as
   `payTo` in its `402` response) doesn't match the address the facilitator
   was configured to trust for that same network — a mismatch between the
   merchant's config and the facilitator's config, usually from updating one
   side after redeploying `Escrow.sol` and forgetting the other.
3. A caller is deliberately naming a `payTo` the facilitator doesn't
   recognize — exactly the attack this allowlist exists to stop.

**Fix:** Confirm the merchant's `Ferry402Config.escrows[network]` and the
facilitator's `FacilitatorAppOptions.escrows[network]` name the *identical*
address, for every network the merchant accepts on. If you just redeployed
`Escrow.sol`, update both sides — `ESCROW_ADDRESS_BASE_SEPOLIA` in whatever
loads the merchant config, and the `escrows` map passed to
`createFacilitatorApp`.

## `insufficient_funds` from `/verify`

**Symptom:** A payment with an otherwise valid signature is rejected with
`error: "insufficient_funds"`, and the resource is never served.

**Cause:** This is `verifyPayment`'s check 8 (`packages/facilitator/src/chains/base.ts`) —
`getErc20Balance` reads the payer's *live* USDC balance (deliberately never
cached, unlike every other on-chain read this module memoizes) and rejects if
it's below `requirements.maxAmountRequired`. This check exists specifically
because of serve-then-settle: the resource is handed over the instant
`/verify` returns `isValid: true`, before `/settle` ever touches the chain
(see [`docs/architecture.md`](architecture.md#serve-then-settle-say-it-plainly)).
Without a solvency check, a throwaway keypair with a validly-signed,
zero-balance authorization would pass every other check and get a free
resource, repeatably.

A closely related, easy-to-confuse failure is
`invalid_exact_evm_payload_authorization_valid_before`: `/verify` also
requires `authorization.validBefore` to have at least
`VERIFY_SETTLEMENT_BUFFER_SECONDS` (10 seconds) of life left at verify time,
not merely be technically unexpired — the gap between a passing `/verify` and
`/settle` actually submitting (RPC latency, mempool inclusion, retries) can
otherwise let an authorization legitimately expire before it's ever redeemed.
If your authorizations are built with a short window (signing with
`validBefore` only a few seconds out), you'll see this reason instead of
`insufficient_funds`, for a different but related cause.

**Fix:** Confirm the payer's wallet actually holds at least
`maxAmountRequired` of the configured USDC on the chain they're paying on
before signing. If you're testing, fund the payer address first — see
[`docs/deployments.md`](deployments.md#other-live-balances-context-only-will-have-drifted)
for how to check a balance with a public RPC call and no credentials. If the
failure is actually the `validBefore` buffer, widen the window
`createPaymentHeader`'s `validBefore` option signs for (it defaults to
`requirement.maxTimeoutSeconds` from now, which is normally generous enough).

## Settlements race under concurrent load — what's covered and what isn't

**Symptom:** Under concurrent `/settle` traffic, you might expect "nonce too
low" / "replacement transaction underpriced" errors, or one settlement
silently stuck behind another.

**Status, accurately:** A `nonceManager` **is** wired on the facilitator's
settlement account today
(`packages/facilitator/src/chains/base.ts`'s `settlePayment`):

```ts
account = privateKeyToAccount(facilitatorPrivateKey, { nonceManager })
```

viem's `nonceManager` is a module-level singleton that queues nonce requests
for the same `(address, chainId)` pair through one promise chain. Without it,
two `/settle` calls arriving concurrently would both resolve the same pending
nonce via `eth_getTransactionCount`, and one transaction would land while the
other gets replaced or rejected as "nonce too low." With it, concurrent
settlements **within the same facilitator process** get distinct, sequential
nonces and both land — a fresh `account` object is constructed on every call,
but that's fine, since it holds no nonce state itself; the shared singleton
does.

**What this does not cover:** if you run the facilitator **horizontally
scaled** — more than one process or container, all configured with the same
`facilitatorPrivateKey` — each process has its own, independent in-memory
`nonceManager` state. Two processes submitting at the same moment can still
both read the same on-chain nonce and race, exactly as if `nonceManager`
weren't there at all.

**`nonceManager` fixes in-process settlement concurrency only — it does
nothing for horizontally-scaled facilitators sharing one signing key.** If
you need to scale the facilitator horizontally, either give each instance
its own funded settlement key (so there's no shared nonce sequence to race
on), or put a single-writer queue in front of `/settle` submissions.

## A Hedera private key fails to load, or produces `INVALID_SIGNATURE`

**Symptom:** Loading `HEDERA_PRIVATE_KEY` throws, or — more dangerously —
loads without error but every Hedera transaction it signs fails at submit
time with `INVALID_SIGNATURE`, with no indication of why.

**Cause:** A fresh Hedera testnet account from the Hedera portal typically
has an **ECDSA, DER-encoded** private key. Loading it with
`PrivateKey.fromStringED25519()` is the trap: that call does **not** throw on
a DER-encoded ECDSA key — it silently derives a different, wrong key, which
then produces a key that signs successfully but doesn't match the account's
real public key, surfacing only as an opaque `INVALID_SIGNATURE` at submit
time, far from where the mistake was actually made.

**Fix:** Load it with `PrivateKey.fromStringDer()` or `fromStringECDSA()`,
never `fromStringED25519()`:

```ts
import { PrivateKey } from '@hashgraph/sdk'

const operatorKey = PrivateKey.fromStringDer(process.env.HEDERA_PRIVATE_KEY!)
```

This is exactly what `packages/facilitator/scripts/create-topic.ts` and
`examples/demo/src/run.ts` both do — see either for a working reference.

## A balance or journal read comes back stale right after `/settle`

**Symptom:** You call `/settle`, get back a transaction hash, and
immediately read `Escrow.balanceOf(merchantEvm)` or query the Hedera mirror
node for the journal entry you just wrote — and the read comes back stale
(the pre-settlement balance, or a 404 for a message that was just submitted).

**Cause, Base Sepolia side:** `sepolia.base.org` is a public, load-balanced
RPC with no read-your-writes guarantee across requests — a `balanceOf` read
immediately after a settlement's own receipt can land on a different backend
node than the one that mined the block, and transiently return the
pre-settlement value. This was observed directly during this project's own
live end-to-end runs (see `packages/facilitator/test/e2e.test.ts`'s
`pollBalanceOf` doc comment).

**Cause, Hedera side:** mirror-node ingestion lags HCS consensus by a few
seconds in practice — a message can have a valid consensus timestamp before
the mirror node has indexed it and made it queryable via
`/api/v1/topics/{topicId}/messages/{sequenceNumber}`.

**Fix:** Poll the read, don't trust a single attempt. `examples/demo/src/run.ts`'s
`pollBalanceOf` (up to 10 attempts, 2 seconds apart) and
`fetchMirrorTopicMessage` (up to 20 attempts, 3 seconds apart) are the
reference implementations — reuse the same pattern rather than adding a fixed
`sleep` before a single read, which just moves the flake to a different
delay.

## CI fails with `Multiple versions of pnpm specified`

**Symptom:** A GitHub Actions run using `pnpm/action-setup@v4` fails with
`Multiple versions of pnpm specified`.

**Cause:** The root `package.json` pins `"packageManager": "pnpm@9.15.9"`.
If your workflow also passes an explicit `version:` input to
`pnpm/action-setup@v4`, the action sees two different sources of truth for
which pnpm version to install (its own `version:` input, and the
`packageManager` field it reads from `package.json`) and refuses to guess.

**Fix:** Drop the `version:` input entirely and let `pnpm/action-setup@v4`
read `packageManager` from `package.json` — it's the better source of truth
anyway, since it's exact, committed, and the same field Corepack uses
locally. This repo's own `.github/workflows/ci.yaml` does exactly this:

```yaml
# No `version:` input on purpose. The root package.json pins
# `packageManager: pnpm@9.15.9`, and pnpm/action-setup@v4 fails with
# "Multiple versions of pnpm specified" when given both.
- uses: pnpm/action-setup@v4
```

## Running a facilitator

**Symptom:** You need a `/verify` + `/settle` service and aren't sure whether
to install one or run it from source.

**Either works.** `@ferry402/facilitator` is published:

```bash
npm install @ferry402/facilitator
```

```ts
import { createFacilitatorApp } from '@ferry402/facilitator'

const app = createFacilitatorApp({
  escrows: { 'base-sepolia': process.env.ESCROW_ADDRESS_BASE_SEPOLIA as `0x${string}` },
  rpcUrls: { 'base-sepolia': process.env.BASE_SEPOLIA_RPC_URL },
  facilitatorPrivateKey: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
})
app.listen(4000)
```

**Run it yourself, though — don't point at someone else's.** The facilitator
holds a signing key, pays gas, and decides which escrow contracts to trust. A
facilitator you don't control can refuse to settle your payments. It still
cannot steal from escrow or redirect a payment to another merchant (see
[`SECURITY.md`](../SECURITY.md)), but availability is entirely in its hands.

This repo's own `examples/` import it from `packages/facilitator/src` rather
than from npm — not because it isn't published, but because they live in this
repo and testing against local source is the point.
