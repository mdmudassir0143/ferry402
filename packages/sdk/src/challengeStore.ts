import type { PaymentRequirements } from './types.js'

/**
 * One outstanding 402 challenge, indexed by the specific EIP-3009 nonce
 * (`computeNonce(requirement.extra.merchantEvm, requirement.extra.paymentId)`)
 * a payer would sign to pay `requirement` specifically.
 *
 * `accepts` is the full multi-chain array issued alongside `requirement` —
 * kept so a later 402 response (e.g. a verify failure) can still echo the
 * complete set of options the payer originally saw, not just the one chain
 * they picked.
 */
export interface CachedChallenge {
  requirement: PaymentRequirements
  accepts: PaymentRequirements[]
  expiresAt: number
}

/**
 * Storage for outstanding 402 challenges, keyed by the exact EIP-3009 nonce
 * a payer signs against (see `computeNonce`).
 *
 * `anychain402` writes one entry per accepted chain every time it issues a
 * challenge — one nonce per chain, since `merchantEvm` differs per chain
 * even though `paymentId` is shared across a single `buildRequirements`
 * call — and reads a single entry back by nonce when a payment arrives.
 * Looking up by nonce (rather than, say, the requested resource URL) means
 * concurrent challenges never collide: two different payers requesting the
 * same protected resource at the same time get two different `paymentId`s,
 * hence two different nonces, hence two independent store entries. Neither
 * payer's challenge is at risk of being overwritten by the other's.
 *
 * Every method is async so a real deployment can back this with a shared
 * store (Redis, a database, ...) instead of the in-memory default —
 * `anychain402(config, { store })` accepts any implementation of this
 * interface without any other code changing. This is the seam for the
 * follow-up work the task-6 report flags: `InMemoryChallengeStore` (the
 * default) does not survive a process restart and is not shared across
 * horizontally-scaled instances behind a load balancer. Swapping the store
 * fixes both without touching `anychain402` or its callers.
 */
export interface ChallengeStore {
  /** Returns the challenge issued for `nonce`, or `undefined` if none is
   *  outstanding — never issued, already consumed, or past its `expiresAt`.
   *  A store MUST treat an expired entry as absent even if it hasn't
   *  physically removed it yet (see `InMemoryChallengeStore.get`). */
  get(nonce: `0x${string}`): Promise<CachedChallenge | undefined>
  /** Persists a newly issued challenge under `nonce`, replacing any prior
   *  entry at that key (in practice this never happens in normal operation:
   *  a fresh `paymentId` makes every nonce effectively unique). */
  set(nonce: `0x${string}`, entry: CachedChallenge): Promise<void>
  /** Removes an entry — e.g. once consumed, though `anychain402` does not
   *  currently call this itself (see the "known limitations" note in
   *  `middleware.ts`: settlement/replay protection is out of scope here). */
  delete(nonce: `0x${string}`): Promise<void>
}

const DEFAULT_MAX_ENTRIES = 10_000

/**
 * In-memory `ChallengeStore`, the default `anychain402` uses when no `store`
 * option is supplied. Good enough for a single-process deployment; NOT
 * durable across restarts and NOT shared across horizontally-scaled
 * instances behind a load balancer (a payment routed to a different
 * instance than the one that issued its challenge will find no entry here
 * and — correctly, if unhelpfully — be told its challenge expired). Both
 * limitations are accepted for this task's slice (see the task-6 report)
 * and are exactly what swapping in a real `ChallengeStore` (Redis, a
 * database) is for.
 *
 * Bounded to `maxEntries` (oldest-inserted evicted first) so a client that
 * can cause many distinct challenges to be minted (e.g. varying a resource's
 * query string, or repeatedly sending unparseable `X-PAYMENT` headers, each
 * of which causes `anychain402` to mint and store a fresh challenge) cannot
 * grow this process's memory without bound. Expired entries are pruned
 * lazily on every `set()`, and treated as absent by `get()` even before
 * they're swept.
 */
export class InMemoryChallengeStore implements ChallengeStore {
  private readonly entries = new Map<string, CachedChallenge>()
  private readonly maxEntries: number

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  async get(nonce: `0x${string}`): Promise<CachedChallenge | undefined> {
    const entry = this.entries.get(nonce)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(nonce)
      return undefined
    }
    return entry
  }

  async set(nonce: `0x${string}`, entry: CachedChallenge): Promise<void> {
    this.pruneExpired()
    if (this.entries.size >= this.maxEntries && !this.entries.has(nonce)) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey !== undefined) this.entries.delete(oldestKey)
    }
    this.entries.set(nonce, entry)
  }

  async delete(nonce: `0x${string}`): Promise<void> {
    this.entries.delete(nonce)
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }
}
