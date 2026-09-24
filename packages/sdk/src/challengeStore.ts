import type { PaymentRequirements } from './types.js'

/**
 * One outstanding 402 challenge, indexed by the specific EIP-3009 nonce
 * (`computeNonce(requirement.extra.merchantEvm, requirement.extra.paymentId)`)
 * a payer would sign to pay `requirement` specifically.
 *
 * `accepts` is the full multi-chain array issued alongside `requirement` —
 * kept so a later 402 response (e.g. a verify failure) can still echo the
 * complete set of options the payer originally saw, not just the one chain
 * they picked. `resource` is the exact absolute-URL string the challenge was
 * issued for — a payment must be presented back at that same resource; see
 * `middleware.ts`'s resource-binding check.
 */
export interface CachedChallenge {
  requirement: PaymentRequirements
  accepts: PaymentRequirements[]
  resource: string
  expiresAt: number
}

/**
 * Storage for outstanding 402 challenges, keyed by the exact EIP-3009 nonce
 * a payer signs against (see `computeNonce`).
 *
 * `anychain402` writes one entry per accepted chain every time it issues a
 * challenge — one nonce per chain, since `merchantEvm` differs per chain
 * even though `paymentId` is shared across a single `buildRequirements`
 * call — and reads/consumes a single entry back by nonce when a payment
 * arrives. Looking up by nonce (rather than, say, the requested resource
 * URL) means concurrent challenges never collide: two different payers
 * requesting the same protected resource at the same time get two different
 * `paymentId`s, hence two different nonces, hence two independent store
 * entries. Neither payer's challenge is at risk of being overwritten by the
 * other's.
 *
 * **Nonce casing:** every `nonce` parameter here MUST already be normalized
 * to lowercase (`normalizeNonce`/`computeNonce` in `nonce.ts`) before it
 * reaches this interface — `anychain402` guarantees this for every call it
 * makes. x402's own `PaymentPayloadSchema` accepts mixed/upper-case hex for
 * `authorization.nonce`, but `bytes32` has no casing on-chain, so two
 * differently-cased strings naming the same 32 bytes MUST be treated as the
 * same key. An implementation MAY additionally lowercase defensively inside
 * its own `get`/`set`/`consume`/`delete` (the in-memory default does), but
 * MUST NOT rely on a caller having skipped normalization.
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
  /** Returns the challenge issued for `nonce` WITHOUT removing it, or
   *  `undefined` if none is outstanding — never issued, already consumed, or
   *  past its `expiresAt`. A store MUST treat an expired entry as absent
   *  even if it hasn't physically removed it yet (see
   *  `InMemoryChallengeStore.get`). Intended for read-only inspection (e.g.
   *  validating the request locally) before deciding whether to `consume`;
   *  it must never be used as the sole gate for granting access, since two
   *  concurrent callers can both observe the same still-present entry. */
  get(nonce: `0x${string}`): Promise<CachedChallenge | undefined>
  /** Persists a newly issued challenge under `nonce`, replacing any prior
   *  entry at that key. Also used by `anychain402` to reinstate a challenge
   *  it `consume`d but then failed to confirm as valid (a facilitator error,
   *  or an explicit `isValid: false`) — see `middleware.ts`. */
  set(nonce: `0x${string}`, entry: CachedChallenge): Promise<void>
  /** Atomically returns AND removes the entry for `nonce`, so concurrent
   *  callers race safely: at most one can ever successfully consume a given
   *  challenge, and every other concurrent (or later) caller sees
   *  `undefined`. This is the method to call at the actual point of granting
   *  access — immediately before invoking a facilitator's `/verify` — not
   *  `get` followed by a separate `delete`, which leaves a window where
   *  concurrent replays of the same `X-PAYMENT` header can all observe the
   *  entry as present before any one of them removes it. A caller that finds
   *  the payment was NOT ultimately valid (facilitator error or explicit
   *  rejection) is expected to `set` the same entry back to reinstate it. */
  consume(nonce: `0x${string}`): Promise<CachedChallenge | undefined>
  /** Removes an entry outright, with no return value — used when a challenge
   *  should never be reinstated (not currently called by `anychain402`
   *  itself, which always goes through `consume`, but part of the interface
   *  for implementations/consumers that want it, e.g. explicit revocation). */
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
 * `consume` is trivially atomic here: Node is single-threaded and neither
 * `get` nor the subsequent `delete` awaits anything, so no other callback
 * can interleave between them within one `consume` call.
 *
 * Bounded to `maxEntries` (oldest-inserted evicted first) so a client that
 * can cause many distinct challenges to be minted (e.g. varying a resource's
 * query string, or repeatedly sending unparseable `X-PAYMENT` headers, each
 * of which causes `anychain402` to mint and store a fresh challenge) cannot
 * grow this process's memory without bound. Expired entries are pruned
 * lazily on every `set()`, and treated as absent by `get()`/`consume()` even
 * before they're swept.
 */
export class InMemoryChallengeStore implements ChallengeStore {
  private readonly entries = new Map<string, CachedChallenge>()
  private readonly maxEntries: number

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  async get(nonce: `0x${string}`): Promise<CachedChallenge | undefined> {
    const key = nonce.toLowerCase()
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  async set(nonce: `0x${string}`, entry: CachedChallenge): Promise<void> {
    const key = nonce.toLowerCase()
    this.pruneExpired()
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey !== undefined) this.entries.delete(oldestKey)
    }
    this.entries.set(key, entry)
  }

  async consume(nonce: `0x${string}`): Promise<CachedChallenge | undefined> {
    const key = nonce.toLowerCase()
    const entry = this.entries.get(key)
    // Delete unconditionally (not just on a "valid" hit) so an expired entry
    // is swept here too, same as get() - there is nothing useful left to
    // consume from it either way.
    this.entries.delete(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) return undefined
    return entry
  }

  async delete(nonce: `0x${string}`): Promise<void> {
    this.entries.delete(nonce.toLowerCase())
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }
}
