/**
 * Task 12: replay defense for the stateless challenge design
 * (`challengeDerivation.ts`).
 *
 * ## Why this file no longer holds *issued* challenges
 *
 * Before Task 12, this file's `ChallengeStore` recorded one entry per
 * challenge ISSUED — every anonymous GET wrote to it, for free, which is
 * exactly what let ~5,000 anonymous requests evict 10,000 legitimate
 * outstanding challenges and reject every in-flight honest payer
 * (see the task-12 report). `challengeDerivation.ts`
 * removes that store entirely: issuing a challenge is now a pure
 * computation with no read or write of any kind.
 *
 * What derivation alone CANNOT do is answer "has this nonce already been
 * redeemed?" — that is a statement about the past, and answering it
 * requires remembering something. `ConsumedNonceStore` is that remainder:
 * it records `(from, nonce)` pairs that were consumed BY A SUCCESSFULLY PAID
 * request (one that passed derivation, every local floor check, AND the
 * facilitator's `/verify`), and rejects a pair already present. Crucially,
 * unlike the old store, an anonymous GET never touches it at all, and a
 * malformed/badly-signed `X-PAYMENT` attempt is `release`d again rather than
 * left consumed (see `middleware.ts`'s "consume-before-verify,
 * release-on-failure" section) — so a PERMANENT entry here costs an attacker
 * a real, locally-valid, facilitator-approved authorization, not a free HTTP
 * GET. That asymmetry (permanent growth needs a real authorization) is the
 * property the old design was missing; it is narrower than "this store only
 * grows on paid requests" — `consumeIfAbsent` runs BEFORE `/verify`, so a
 * request that only clears the local floor checks still occupies a slot
 * TRANSIENTLY (until its `release`), and enough concurrent such attempts can
 * still drive `InMemoryConsumedNonceStore` up to its FIFO cap (see
 * `DEFAULT_MAX_ENTRIES` below) — see `challengeDerivation.ts`'s doc comment
 * for the full accounting of what this asymmetry does and does not buy.
 *
 * ## Why `(from, nonce)`, not `nonce` alone (round 1 review fix)
 *
 * `challengeDerivation.ts`'s `paymentId` has no payer term —
 * `HMAC(secret, merchantEvm ‖ resource ‖ bucket)` — so every payer hitting
 * the SAME resource in the SAME time bucket derives the SAME nonce. A store
 * keyed by nonce alone would therefore treat a SECOND, genuinely different,
 * independently-signed payer's payment as a replay of the FIRST payer's —
 * one paying customer per resource per window, which for a metered API is
 * worse than the denial-of-payment gap this task exists to close (the
 * original bug needed an attacker; this happened between two honest
 * customers). Keying by the pair instead — `authorization.from` alongside
 * the nonce — fixes this, and it is not an arbitrary choice: real USDC's
 * EIP-3009 implementation keys its own on-chain authorization-used bitmap as
 * `_authorizationStates[from][nonce]`, precisely because a nonce is only
 * ever meaningful relative to who authorized it. A store keyed by nonce
 * alone was STRICTER than the token itself — rejecting payments the chain
 * would have happily accepted — which is the mirror image of the discipline
 * Task 11 enforced in the other direction (a verifier must never be MORE
 * PERMISSIVE than the token); it must not be more restrictive either.
 * Same-payer replay of the identical nonce is, of course, still rejected —
 * keying on the pair adds a dimension, it does not remove one.
 *
 * ## Atomicity
 *
 * `consumeIfAbsent` MUST be a single atomic check-and-set, never `has()`
 * followed by a separate `set()` after an `await`. Splitting it across an
 * await reopens exactly the race Task 6 already fixed once on the old
 * `ChallengeStore.consume` (see `middleware.ts`'s original "consume, don't
 * just verify" doc comment): several concurrent replays of the identical
 * `X-PAYMENT` header would all observe "not yet consumed" before any one of
 * them records it, and all would pass. A remote-backed implementation
 * (Redis, a database) MUST use that store's own atomic primitive — `SET key
 * val NX`, an `INSERT ... ON CONFLICT DO NOTHING` that reports whether a row
 * was inserted, etc. — never a read followed by a write.
 */
export interface ConsumedNonceStore {
  /**
   * Atomically checks whether the pair `(from, nonce)` (both already
   * normalized — see `normalizeAddress`/`normalizeNonce` in `nonce.ts`) has
   * been consumed before and, if not, records it with `expiresAt` (ms since
   * epoch) in one indivisible operation. Returns `true` if the pair was
   * newly consumed by THIS call, `false` if it was already present — a
   * replay of the SAME payer's SAME nonce. A different `from` presenting the
   * identical `nonce` (expected under this design — see this file's doc
   * comment) is a DIFFERENT pair and is never blocked by this check alone.
   *
   * `expiresAt` is purely a pruning hint for implementations that want to
   * bound their own storage: a nonce outside the derivation window
   * (`matchChallenge` in `challengeDerivation.ts`) can never independently
   * validate again regardless of whether a record of it still physically
   * exists here, so forgetting it early costs nothing security-relevant.
   */
  consumeIfAbsent(from: `0x${string}`, nonce: `0x${string}`, expiresAt: number): Promise<boolean>

  /**
   * Releases a `(from, nonce)` pair that `consumeIfAbsent` just accepted but
   * that turned out NOT to correspond to a genuinely paid request — the
   * facilitator rejected it, or was unreachable. Used by `middleware.ts` so
   * a payer who submitted a bad signature (or hit a facilitator hiccup) can
   * still retry with a CORRECTED signature against the SAME nonce, within
   * the same derivation window, instead of the pair being permanently
   * burned.
   *
   * This matters more here than it did for the old `ChallengeStore.set`
   * reinstatement: because a derived nonce is PUBLIC (anyone can read
   * `extra.paymentId` off an anonymous 402 response and compute it, same as
   * before), skipping this release step would let anyone permanently deny a
   * legitimate payer service for a resource's entire
   * `2 * TIME_BUCKET_SECONDS` life by submitting one bogus-signature
   * `X-PAYMENT` attempt (with THAT payer's own `from`) with an otherwise
   * well-formed authorization — turning a transient nuisance into a total,
   * and much cheaper, denial of service. Best-effort: if a remote store
   * can't be reached to release the entry, the payer sees `invalid_payment`
   * (the already-consumed branch in `middleware.ts`) on retry rather than a
   * clean retry — still fail-closed, just less convenient.
   */
  release(from: `0x${string}`, nonce: `0x${string}`): Promise<void>
}

const DEFAULT_MAX_ENTRIES = 100_000

function compositeKey(from: `0x${string}`, nonce: `0x${string}`): string {
  return `${from.toLowerCase()}:${nonce.toLowerCase()}`
}

/**
 * In-memory `ConsumedNonceStore`, the default `ferry402` uses when no
 * `consumedNonceStore` option is supplied. Single-process only — a payment
 * that consumes a `(from, nonce)` pair on instance A and is then replayed
 * against instance B will not be caught unless a shared implementation
 * (Redis, a database) is passed instead. This is the same class of
 * limitation the old `InMemoryChallengeStore` had, carried over deliberately
 * rather than silently fixed, since fixing it needs external infrastructure
 * this package does not provide.
 *
 * `consumeIfAbsent` is trivially atomic here: Node is single-threaded and
 * neither the `has` check nor the following `set` awaits anything, so no
 * other callback can interleave between them within one call.
 *
 * Bounded to `maxEntries` (oldest-inserted evicted first) and lazily pruned
 * of expired entries on every write — but see this file's doc comment for
 * why growth here is gated behind an actual paid request rather than a free
 * one, which is what makes an attacker-driven eviction sweep vastly more
 * expensive than it was against the old issuance store.
 */
export class InMemoryConsumedNonceStore implements ConsumedNonceStore {
  private readonly entries = new Map<string, number>() // "from:nonce" -> expiresAt

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  /** Number of `(from, nonce)` pairs currently recorded as consumed. Exposed
   *  for tests and operational visibility only — never consulted by
   *  `ferry402` itself. */
  get size(): number {
    return this.entries.size
  }

  async consumeIfAbsent(from: `0x${string}`, nonce: `0x${string}`, expiresAt: number): Promise<boolean> {
    const key = compositeKey(from, nonce)
    this.pruneExpired()
    if (this.entries.has(key)) return false
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey !== undefined) this.entries.delete(oldestKey)
    }
    this.entries.set(key, expiresAt)
    return true
  }

  async release(from: `0x${string}`, nonce: `0x${string}`): Promise<void> {
    this.entries.delete(compositeKey(from, nonce))
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key)
    }
  }
}
