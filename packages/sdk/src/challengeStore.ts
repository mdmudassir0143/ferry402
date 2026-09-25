/**
 * Task 12: replay defense for the stateless challenge design
 * (`challengeDerivation.ts`).
 *
 * ## Why this file no longer holds *issued* challenges
 *
 * Before Task 12, this file's `ChallengeStore` recorded one entry per
 * challenge ISSUED — every anonymous GET wrote to it, for free, which is
 * exactly what let ~5,000 anonymous requests evict 10,000 legitimate
 * outstanding challenges and hand every in-flight honest payer
 * `payment_expired` (see the task-12 report). `challengeDerivation.ts`
 * removes that store entirely: issuing a challenge is now a pure
 * computation with no read or write of any kind.
 *
 * What derivation alone CANNOT do is answer "has this nonce already been
 * redeemed?" — that is a statement about the past, and answering it
 * requires remembering something. `ConsumedNonceStore` is that remainder:
 * it records nonces that were consumed BY A SUCCESSFULLY PAID request (one
 * that passed derivation, every local floor check, AND the facilitator's
 * `/verify`), and rejects a nonce already present. Crucially, unlike the old
 * store, THIS one only grows on paid requests — an anonymous GET never
 * touches it, and a malformed/badly-signed `X-PAYMENT` attempt is released
 * again rather than left consumed (see `middleware.ts`'s
 * "consume-before-verify, release-on-failure" section) — so growing this
 * store costs an attacker a real, locally-valid, facilitator-approved
 * authorization, not a free HTTP GET. That asymmetry is the property the
 * old design was missing.
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
   * Atomically checks whether `nonce` (already normalized — see
   * `normalizeNonce`) has been consumed before and, if not, records it with
   * `expiresAt` (ms since epoch) in one indivisible operation. Returns
   * `true` if `nonce` was newly consumed by THIS call, `false` if it was
   * already present — a replay.
   *
   * `expiresAt` is purely a pruning hint for implementations that want to
   * bound their own storage: a nonce outside the derivation window
   * (`matchChallenge` in `challengeDerivation.ts`) can never independently
   * validate again regardless of whether a record of it still physically
   * exists here, so forgetting it early costs nothing security-relevant.
   */
  consumeIfAbsent(nonce: `0x${string}`, expiresAt: number): Promise<boolean>

  /**
   * Releases a nonce that `consumeIfAbsent` just accepted but that turned
   * out NOT to correspond to a genuinely paid request — the facilitator
   * rejected it, or was unreachable. Used by `middleware.ts` so a payer who
   * submitted a bad signature (or hit a facilitator hiccup) can still retry
   * with a CORRECTED signature against the SAME nonce, within the same
   * derivation window, instead of the nonce being permanently burned.
   *
   * This matters more here than it did for the old `ChallengeStore.set`
   * reinstatement: because a derived nonce is PUBLIC (anyone can read
   * `extra.paymentId` off an anonymous 402 response and compute it, same as
   * before), skipping this release step would let anyone permanently deny
   * the legitimate payer service for a resource's entire
   * `2 * TIME_BUCKET_SECONDS` life by submitting one bogus-signature
   * `X-PAYMENT` attempt with an otherwise-well-formed authorization —
   * turning a transient nuisance into a total, and much cheaper, denial of
   * service. Best-effort: if a remote store can't be reached to release the
   * entry, the payer sees `payment_expired` on retry rather than a clean
   * retry — still fail-closed, just less convenient.
   */
  release(nonce: `0x${string}`): Promise<void>
}

const DEFAULT_MAX_ENTRIES = 100_000

/**
 * In-memory `ConsumedNonceStore`, the default `ferry402` uses when no
 * `consumedNonceStore` option is supplied. Single-process only — a payment
 * that consumes a nonce on instance A and is then replayed against instance
 * B will not be caught unless a shared implementation (Redis, a database) is
 * passed instead. This is the same class of limitation the old
 * `InMemoryChallengeStore` had, carried over deliberately rather than
 * silently fixed, since fixing it needs external infrastructure this
 * package does not provide.
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
  private readonly entries = new Map<string, number>() // nonce -> expiresAt

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  /** Number of nonces currently recorded as consumed. Exposed for tests and
   *  operational visibility only — never consulted by `ferry402` itself. */
  get size(): number {
    return this.entries.size
  }

  async consumeIfAbsent(nonce: `0x${string}`, expiresAt: number): Promise<boolean> {
    const key = nonce.toLowerCase()
    this.pruneExpired()
    if (this.entries.has(key)) return false
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey !== undefined) this.entries.delete(oldestKey)
    }
    this.entries.set(key, expiresAt)
    return true
  }

  async release(nonce: `0x${string}`): Promise<void> {
    this.entries.delete(nonce.toLowerCase())
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key)
    }
  }
}
