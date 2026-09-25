# @ferry402/sdk

## Unreleased

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
