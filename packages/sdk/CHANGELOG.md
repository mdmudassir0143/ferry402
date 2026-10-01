# @ferry402/sdk

## 0.2.1

Documentation only. No code, no types, no behaviour change — the `dist/` output
is byte-identical to 0.2.0.

This release exists because npm renders the README from the published tarball
and cannot update it without a version bump. 0.2.0 shipped the README as it
stood at publish time; it was rewritten shortly afterwards for readability
(plain-language opening, no table cell over 120 characters, the
`createPaymentHeader` requirement and the Base-only limitation both made
prominent rather than buried). Publishing that rewrite is the only way to put
it on the package page.

## 0.2.0

### Breaking

- **Two rejection codes changed value: both the `matchChallenge`-failure and
  the already-consumed-nonce branches in `ferry402()`'s middleware now reply
  `invalid_payment` instead of `payment_expired`.** This is a behavior
  change, not just a docs fix, and a client or test that pattern-matches on
  the literal string `payment_expired` from either path must be updated.
  Why: a `matchChallenge` mismatch has at least three indistinguishable
  causes — genuine expiry, a nonce derived for the wrong resource/merchant,
  or a stock x402 client's self-invented nonce — and the validity window is
  enforced by the HMAC derivation itself, not a store with timestamps to
  inspect, so there was never a record to confirm expiry specifically from.
  `payment_expired` asserted a cause this middleware could not actually
  establish; `invalid_payment` (a real x402 `ErrorReasons` member) says only
  what is known. The already-consumed branch is a definitively known replay,
  not expiry either, so it gets the same honest code. `verdict.invalidReason
  ?? 'invalid_payment'` (the facilitator's own generic-rejection fallback)
  was already `invalid_payment` and is unchanged — all three now share one
  code for "payment unacceptable, fetch a fresh 402," which is what a client
  ends up doing in every case regardless.

### Changed

- **`Ferry402Config.merchantEvm`, `.escrows`, and `.assets` are now
  `Partial<Record<SupportedChain, \`0x${string}\`>>`** (previously
  `Record<SupportedChain, ...>`, which forced every merchant — even one
  accepting only `base-sepolia` — to supply placeholder addresses for every
  other `SupportedChain` just to satisfy the type). This is a type-only
  loosening and not breaking for existing callers: a config that already
  populated all four chains still type-checks and behaves identically.
  `ferry402(config)` now also validates, at construction time, that every
  chain listed in `config.accept` has an entry in all three maps, and throws
  — naming the chain and which field(s) are missing — if not. Previously a
  missing entry for an accepted chain was not an error at all: it silently
  produced a `PaymentRequirements` with `payTo`/`asset` set to `undefined`,
  which `JSON.stringify` then drops from the 402 response entirely, so the
  first visible symptom was an opaque rejection from a payer's client or the
  facilitator's own schema parser — never a message naming the actual
  misconfiguration.

  **`buildRequirements` performs the same validation.** It is a public export
  documented for callers issuing their own 402s outside the middleware, and
  those callers never run `ferry402()`'s constructor. Before this release the
  total `Record` types protected them: a config missing an entry could not be
  constructed at all. Loosening to `Partial` gave that up, so the check runs
  on every `buildRequirements` call as well — otherwise a direct caller would
  silently receive `payTo`/`asset` as `undefined` cast to `` `0x${string}` ``.
  The construction-time check in `ferry402()` is kept on top of it so a
  misconfigured merchant fails at boot rather than on first request.

### Added

- `res.locals.x402.release(): Promise<void>` — lets a route handler release
  the `(from, nonce)` pair `ferry402()` already consumed, for when the
  handler's OWN `/settle` call fails. `ferry402()` only calls `/verify`; the
  handler calls `/settle` after `next()`, and until now it had no way to undo
  the consume step if that settlement failed, leaving that payer's nonce
  burned for the rest of the derivation window (up to
  `2 * TIME_BUCKET_SECONDS`) even though no payment ever completed.
  Best-effort (never throws, even if the underlying `ConsumedNonceStore`'s
  own `release` rejects) and idempotent (safe to call more than once, or
  after the window has passed).
- `Ferry402Locals` — exported type for the exact shape `ferry402()` writes to
  `res.locals.x402` (`payload`, `requirements`, `payer`, `release`), so a
  handler can type it directly instead of casting through `unknown`.

## 0.1.0

### Breaking

- **`ConsumedNonceStore` (`challengeStore.ts`) changed its public interface.**
  Both `consumeIfAbsent` and `release` gained a required, leading `from:
  \`0x${string}\`` parameter — the store is now keyed by the pair `(from,
  nonce)`, not by `nonce` alone. This was necessary because `paymentId`
  (Task 12's stateless challenge derivation) does not depend on who is
  paying, so every payer of the same resource in the same time bucket derives
  the identical nonce; a store keyed on `nonce` alone would treat a second,
  genuinely different payer's payment as a replay of the first.

  Any third-party `ConsumedNonceStore` implementation passed via
  `Ferry402Options.consumedNonceStore` must be updated:

  ```diff
  -consumeIfAbsent(nonce: `0x${string}`, expiresAt: number): Promise<boolean>
  -release(nonce: `0x${string}`): Promise<void>
  +consumeIfAbsent(from: `0x${string}`, nonce: `0x${string}`, expiresAt: number): Promise<boolean>
  +release(from: `0x${string}`, nonce: `0x${string}`): Promise<void>
  ```

  Both `from` and `nonce` arrive already normalized to lowercase
  (`normalizeAddress`/`normalizeNonce`, both now exported from the package
  root) before `ferry402` ever calls into a store — a custom store does not
  need to normalize casing itself, but composing its own storage key MUST
  incorporate both fields, not `nonce` alone, or it will reject distinct
  payers as replays of each other.

### Added

- `createPaymentHeader(requirement, signer, options)` — a client-side helper
  that derives the merchant-bound nonce (`computeNonce`) and signs the
  EIP-3009 `ReceiveWithAuthorization` for a `PaymentRequirements` entry,
  returning the base64 `X-PAYMENT` header value. Added because **no stock
  x402 client can pay a ferry402 route**: `x402@1.2.0`'s own client helpers
  mint a random nonce, and ferry402's merchant-binding fix (deriving the
  nonce from `(merchantEvm, paymentId)` instead) means a random nonce never
  matches a challenge ferry402 issued. This is the one supported way to pay
  a ferry402 route until a dedicated client package exists.

### Fixed

- `issueChallenge` now throws instead of silently `continue`-ing when a
  `PaymentRequirements` entry has no `extra.merchantEvm` (a config bug, since
  `Ferry402Config.merchantEvm` is required for every accepted chain). The old
  `continue` left that entry's `paymentId` at the all-zero placeholder
  `buildRequirements` uses internally and published it in the 402 body,
  which looks like a legitimate derived value rather than an obviously broken
  one.

### Packaging

- The package is now actually built and published: `exports`/`main`/
  `module`/`types`/`files`/`sideEffects: false` all point at a compiled
  `dist/` (via `tsc`), instead of `main`/`types` pointing straight at
  `src/index.ts`. ESM only — there is no `require` condition, and none is
  claimed. Proven by `test/consume-built-package.test.ts`, which packs the
  built artifact, installs the tarball into a directory outside this
  workspace, and imports it from plain Node.
- The published tarball now includes `README.md` and `LICENSE` (previously
  neither was present — `npm pack --dry-run` showed 22 files, all `dist/**`
  plus `package.json`, so the npm page would have rendered blank and the
  MIT license text would not have been distributed with the package).
