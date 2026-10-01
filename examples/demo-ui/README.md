# ferry402 demo-ui

A local, single-page web UI that runs the **real** ferry402 payment flow —
live Base Sepolia + Hedera testnet, no mocks — and streams every step to the
browser as it happens, so it can be screen-recorded for a demo video.

This is a web front end on top of the exact same logic
[`examples/demo`](../demo) runs from the command line: both import
`examples/demo/src/lib/*`, so standing up the facilitator + merchant,
signing, paying, reading the escrow ledger, and reading the HCS journal
back all happen through one shared, already-proven implementation. This
package only adds HTTP endpoints, Server-Sent Events, and a static UI on
top — see `src/server.ts`'s header comment.

## Prerequisites

- Node.js >= 20.18.3.
- The **ferry402 monorepo itself** already set up one level up: from the
  repo root, `pnpm install && pnpm -r build`. This imports
  `@ferry402/facilitator` directly from `../../packages/facilitator/src`
  (it's never published to npm), so that package's own `node_modules` —
  and `packages/sdk/dist`, which it resolves through the workspace symlink
  — must already exist.
- A funded Base Sepolia payer (USDC) and facilitator (ETH for gas), a
  deployed `Escrow` contract, and a Hedera testnet operator account with an
  existing HCS topic. All of this is already live and funded for this
  project — see the repo root's own `.env` (gitignored).

## Install

```bash
cd examples/demo-ui
npm install
```

`examples/demo-ui` is deliberately **outside** the pnpm workspace (see the
repo root's `pnpm-workspace.yaml`, which only lists `packages/*`) and uses
plain `npm`, exactly like `examples/demo` — so `npm install` resolves
`@ferry402/sdk` from the real, **published** `0.2.1` on npm, proving what a
real integrator gets. `@ferry402/facilitator` is loaded straight from this
monorepo's own source (see above), the same way a merchant who clones the
repo and self-hosts the facilitator would.

## Environment variables

Read from (in order of preference) `examples/demo-ui/.env`, then the repo
root's `.env`, then whatever's already in your shell — same lookup order
`examples/demo` uses:

| Variable | Meaning |
|---|---|
| `PAYER_PRIVATE_KEY` | The payer's EVM key (must hold Base Sepolia USDC). |
| `FACILITATOR_PRIVATE_KEY` | The facilitator's settlement wallet (must hold Base Sepolia ETH for gas). |
| `DEPLOYER_PRIVATE_KEY` | Reused as the merchant's EVM payout address (no funds are drawn from it). |
| `BASE_SEPOLIA_RPC_URL` | Defaults to `https://sepolia.base.org` if unset. |
| `ESCROW_ADDRESS_BASE_SEPOLIA` | The deployed `Escrow` contract address. |
| `HEDERA_ACCOUNT_ID` | Hedera testnet operator account, e.g. `0.0.9823488`. |
| `HEDERA_PRIVATE_KEY` | The operator's key, **ECDSA, DER-encoded**. |
| `HCS_TOPIC_ID` | The HCS journal topic, e.g. `0.0.10719807`. |
| `PORT` | Optional. HTTP port for this UI's own server. Defaults to `4402`. |

None of these — and nothing derived from one beyond a public address — are
ever sent to the browser. See "Hard rule" below.

## Run it

```bash
npm start
```

Then open **http://localhost:4402**. That's the one command.

## What each endpoint/step shows

- `GET /` — the UI.
- `GET /api/state` — the escrow ledger row, the escrow contract's real USDC
  balance, and the HCS journal total, so the page can show the starting
  position before anything runs. The "Starting position" card at the top
  calls this on load and on "Refresh".
- `POST /api/run` — runs one full payment, streaming Server-Sent Events
  (plain `fetch` + `ReadableStream` on the client, not the native
  `EventSource` API, since that can't read a POST body). Steps, in order:
  1. **Challenge** — `GET /api/quote` with no payment: the 402, the
     `accepts` entry, the derived `paymentId`/nonce.
  2. **Signed** — the payer signs the EIP-3009 authorization locally via
     `createPaymentHeader()`. Only the signer's address and the header's
     length are shown — never the header itself.
  3. **Served** — retried with `X-PAYMENT` → HTTP 200 and the resource
     JSON. (Verify, settle, and the HCS write all happen inside this one
     request on the server, exactly like a real merchant route — see
     `examples/demo/src/lib/flow.ts`'s `makePaidRoute`.)
  4. **Settled** — the transaction hash, gas used, amount, and a Basescan
     link, taken from the same response.
  5. **Ledger** — the merchant's escrow row, read on-chain before and after,
     polled until it reflects the settlement (see "A note on flakiness" in
     `examples/demo`'s README for why that's a poll, not a single read).
  6. **Journal** — the HCS entry, read back independently from the Hedera
     **mirror node** (not from the settlement response), with Hashscan
     links for the transaction and the topic.
  7. **Reconciled** — the climax: the HCS journal total, the escrow ledger
     row, and the escrow contract's real USDC balance, shown side by side
     with a large "ALL THREE AGREE" indicator when they match.
- `POST /api/check/:kind` — runs one security check (`replay`,
  `cross-route`, or `zero-balance`), also over SSE. **A rejection is the
  success case here** — the UI styles it green, as "Correctly rejected",
  and shows the real reason code (`invalid_payment`, `insufficient_funds`).
  - `cross-route` and `zero-balance` are free: both are rejected before any
    settlement is ever attempted, so they never cost real funds and never
    need a prior payment.
  - `replay` needs a header that has **already** been successfully paid
    once (replaying only means something once a nonce is actually
    consumed). It reuses the last real payment this server process made —
    from `/api/run` or from an earlier `replay` check — at no extra cost.
    If the server was just started and `replay` is the very first thing
    clicked, it makes one real payment first so there's something to
    replay, then immediately replays it.

Every event carries a `status` (`running` → `done`/`failed`) so the UI can
show each step's card as pending, active, done, or failed, plus a
`durationMs` for the per-step timing shown in the corner of each card.

## For whoever is recording

Suggested click order for a clean take:

1. Load the page. Let the "Starting position" numbers sit on screen for a
   beat — this is the before state.
2. Click **Run payment**. Don't touch anything else while it runs — the
   button disables itself and the server rejects a second concurrent
   request anyway. Steps 1–6 light up in order; let step 7's "ALL THREE
   AGREE" banner land before moving on. ~10–20 seconds end to end
   (`sepolia.base.org`'s latency is the main variable).
3. Click **Replay**, then **Cross-route**, then **Zero-balance**, pausing on
   each "Correctly rejected" result before the next. These are each only a
   couple of seconds (`zero-balance` and `cross-route` are free; `replay`
   reuses the payment from step 2, so it's free too).
4. Click **Run payment** again if you want a second take of the happy path
   — it's safe to click repeatedly; each run derives a fresh nonce (see
   "Known limitation" below), so back-to-back runs never collide.

## Hard rule: no key material ever reaches the browser

No private key, and nothing derived from one beyond a public address, is
ever written into an SSE event, a log line, or the served HTML/CSS/JS.
Verify this yourself at any time:

```bash
curl -s http://localhost:4402/ | grep -i privateKey      # nothing
curl -s http://localhost:4402/app.js | grep -i privateKey  # nothing
```

Every event field is one of: a public address, a transaction hash, a
derived `paymentId`/nonce (an HMAC/keccak output, not a secret itself — see
`packages/sdk`'s README on stateless challenge derivation), an amount, or a
timestamp. `createPaymentHeader()`'s signed `X-PAYMENT` header is deliberately
**not** sent to the browser either — only its length — even though a
signature isn't itself a private key.

## Known limitation: nonce derivation is per-(merchant, resource, 5-minute bucket)

ferry402 derives `paymentId`/nonce from `(merchantEvm, resource, time
bucket)` — never from a random draw per request (see `packages/sdk`'s
README). That means two challenge requests for the **identical** resource
string within the same ~5-minute bucket get the **identical** nonce. This
UI avoids that for its own "Run payment" button and `replay`'s fallback
real payment by appending a cache-busting query string to each fresh
request (see `RequestChallengeOptions.cacheBust` in
`examples/demo/src/lib/flow.ts`) — so clicking "Run payment" repeatedly is
always safe. `examples/demo`'s own CLI never needed this (it only ever
makes one real payment per process) and its behavior is unchanged.

## A note on narrow widths

This page is designed for a 1080p recording, scaled down — dark theme,
large type, generous spacing. It was also tested at a ~400px viewport
width: everything stacks into a single column with no horizontal
scrolling and no clipped text, so it **is usable** that narrow. It isn't
optimized for it, though — a step card's status badge can wrap onto its
own line under the title at that width, which looks slightly awkward but
doesn't break anything.

## License

MIT.
