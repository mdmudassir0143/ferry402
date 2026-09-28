import { createHmac, timingSafeEqual } from 'node:crypto'
import { computeNonce } from './nonce.js'

/**
 * Task 12: stateless challenge derivation.
 *
 * ## The problem this replaces
 *
 * Before this file existed, `ferry402` minted a fresh, cryptographically
 * random `paymentId` on every anonymous GET (`buildRequirements`'s default)
 * and stored one `ChallengeStore` entry per accepted chain so a later
 * payment could be matched back to it. Issuing was free; the store was
 * bounded (`InMemoryChallengeStore`'s `DEFAULT_MAX_ENTRIES`). Put those two
 * facts together and roughly 5,000 anonymous GETs (2 entries each, against a
 * 10,000-entry cap) evict EVERY outstanding legitimate challenge — every
 * in-flight honest payer gets `payment_expired`, indistinguishable from an
 * attack. Memory was bounded; availability was not.
 *
 * ## The fix
 *
 * Derive `paymentId` instead of minting and storing it:
 *
 * ```
 * paymentId = HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)   // 32 bytes
 * nonce     = keccak256(abi.encode(merchantEvm, paymentId))              // computeNonce, unchanged
 * ```
 *
 * Issuing a challenge (`deriveChallenge`) is now a pure computation over
 * `(secret, merchantEvm, resource, Date.now())` — no read, no write, no
 * store of any kind. Verifying a payment (`matchChallenge`) recomputes the
 * SAME function for the current bucket AND the immediately preceding one,
 * and accepts the payer's `authorization.nonce` if it equals EITHER. A match
 * proves, with no storage at all:
 *
 * - **this server** issued it (only a process holding `secret` can
 *   reproduce the HMAC),
 * - **for this exact resource** (`resource` is hashed into the preimage —
 *   a challenge for `/cheap` cannot equal one derived for `/expensive`,
 *   because the preimages differ and HMAC-SHA256 is not going to collide
 *   them),
 * - **inside the window** (a nonce derived for a bucket more than one step
 *   in the past will never again equal `timeBucket(now)` or
 *   `timeBucket(now) - 1` — TTL enforcement falls out of arithmetic on
 *   `Date.now()`, not a `expiresAt` field someone has to remember to set
 *   and a store someone has to remember to prune).
 *
 * Resource binding and TTL are therefore STRUCTURAL: there is no separate
 * "does this nonce belong to this resource" check to forget, because an
 * attacker cannot produce a matching nonce for the wrong resource in the
 * first place, by construction of the HMAC preimage.
 *
 * ## What is deliberately NOT stateless: replay
 *
 * "This nonce was never redeemed before" is a statement about the past —
 * derivation alone cannot answer it, because the SAME (merchantEvm,
 * resource, bucket) triple always derives the SAME nonce for anyone who
 * asks (the 402 body publishes `extra.paymentId` to any anonymous
 * requester, same as the old random-paymentId design did). Replay defense
 * therefore still needs a `ConsumedNonceStore` (`challengeStore.ts`) — but
 * unlike the old issuance store, it only grows when a request reaches the
 * point of actually being paid (locally valid, then facilitator-verified),
 * never merely on being requested. Minting stays free; PERMANENT residency in
 * the replay store — an entry that survives past this one request — costs a
 * real signed, on-chain-payable authorization, since anything that fails the
 * facilitator's `/verify` is `release`d again (`middleware.ts`). That is the
 * asymmetry the old design was missing. It is not a claim about TRANSIENT
 * growth: a `consumeIfAbsent` happens BEFORE `/verify` is even called (see
 * `middleware.ts`'s "consume-before-verify, release-on-failure"), so an
 * attacker who only satisfies the LOCAL floor checks — a currently-valid
 * public nonce plus an arbitrary, distinct `authorization.from` and an
 * unverified signature — can still occupy a slot for the duration of that one
 * request and, with enough concurrency, drive `InMemoryConsumedNonceStore`
 * up to its `DEFAULT_MAX_ENTRIES` (100k) FIFO cap and start evicting live
 * entries, same as any other consume-then-release traffic would. That is
 * cheaper than a real authorization, though still bounded by concurrency and
 * (unlike the old issuance bug) requires knowing a nonce this server actually
 * derived, not an arbitrary free GET.
 *
 * ## Many payers, one derived nonce — keyed by `(from, nonce)` (round 1 fix)
 *
 * Because `paymentId` depends only on `(merchantEvm, resource, timeBucket)`
 * — never on WHO is asking — every anonymous requester of the SAME resource
 * within the SAME bucket sees the SAME challenge, hence the SAME nonce. An
 * earlier version of this design keyed `ConsumedNonceStore` purely by
 * `nonce`, which made two DIFFERENT, independently-signed payers of the same
 * resource in the same window collide: the first valid payment consumed the
 * nonce and the second was indistinguishable from a replay and rejected —
 * even though on-chain EIP-3009 nonce tracking is scoped per-`from` and
 * would not itself have conflicted (real USDC keys its own
 * authorization-used state as `_authorizationStates[from][nonce]`, exactly
 * for this reason). One paying customer per resource per window is a worse
 * regression for a metered API than the availability bug this task fixes.
 * `ConsumedNonceStore` (`challengeStore.ts`) is now keyed on the PAIR —
 * `authorization.from` alongside the nonce — so multiple genuinely different
 * payers of the identical derived challenge all succeed, while the SAME
 * payer replaying the SAME nonce is still rejected; keying on the pair adds
 * a dimension, it does not remove one.
 */

/** Minimum byte length `ferry402` requires of `config.secret`. */
export const MIN_SECRET_BYTES = 32

/**
 * Width, in seconds, of one derivation time bucket. A challenge derived for
 * bucket `N` remains valid through the END of bucket `N + 1` — the payment
 * path checks the CURRENT bucket and the PREVIOUS one (`matchChallenge`) —
 * giving an effective validity window of between `TIME_BUCKET_SECONDS` and
 * `2 * TIME_BUCKET_SECONDS`, depending where in its own bucket a challenge
 * happened to be issued. 300s mirrors the old design's `maxTimeoutSeconds`
 * default (`requirements.ts`).
 */
export const TIME_BUCKET_SECONDS = 300

/**
 * Validates `secret` at `ferry402(config)` CONSTRUCTION time (never lazily,
 * on first request) and throws if it is missing, not a string, or shorter
 * than `MIN_SECRET_BYTES`. There is deliberately no fallback that generates
 * one: see this file's and `types.ts`'s doc comments for why a silently
 * auto-generated per-process secret is worse than a loud failure — it would
 * not error, it would just make every multi-instance deployment quietly
 * reject legitimate payments under load, whenever a payer's request landed
 * on a different instance than the one that issued their 402.
 */
export function assertValidSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(
      'ferry402: config.secret is required. It must be a stable, ' +
        `cryptographically random string of at least ${MIN_SECRET_BYTES} bytes, ` +
        'identical across every process/instance serving this merchant\'s traffic ' +
        '(e.g. generated once with `openssl rand -hex 32` and loaded from a secret ' +
        'store / environment variable). ferry402 never generates one on your behalf: ' +
        'a per-process random secret would silently break multi-instance deployments ' +
        'under load rather than fail loudly at startup.',
    )
  }
  const byteLength = Buffer.byteLength(secret, 'utf8')
  if (byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `ferry402: config.secret must be at least ${MIN_SECRET_BYTES} bytes, got ${byteLength}. ` +
        'A short secret is brute-forceable, which would let an attacker derive valid ' +
        'nonces without ever seeing a 402 response, defeating this design entirely.',
    )
  }
}

/** The derivation time bucket `nowMs` falls in — an integer that increments
 *  once every `bucketSeconds`. Exported for direct testing of boundary
 *  behavior; `deriveChallenge`/`matchChallenge` are the intended call sites
 *  for production use. */
export function timeBucket(nowMs: number, bucketSeconds: number = TIME_BUCKET_SECONDS): number {
  return Math.floor(nowMs / 1000 / bucketSeconds)
}

/**
 * `HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)`, hex-encoded
 * with a `0x` prefix — the exact preimage is
 * `` `${merchantEvm.toLowerCase()}|${resource}|${bucket}` `` (pipe-delimited
 * so a boundary between `resource` and a numeric `bucket` can never be
 * ambiguous the way bare concatenation could be). `merchantEvm` is lowercased
 * before hashing so the checksummed and all-lowercase spellings of the same
 * address derive identically — the same defensive posture `computeNonce`
 * takes with its own address input, for the same reason: nothing about an
 * EVM address's DISPLAY casing should be able to change a derived value.
 *
 * Pinned against an INDEPENDENT implementation
 * (`openssl dgst -sha256 -hmac "$SECRET"`, not `@noble/hashes` or any other
 * JS library) in `challengeDerivation.test.ts` — see that file's golden
 * vector.
 */
export function derivePaymentId(
  secret: string,
  merchantEvm: `0x${string}`,
  resource: string,
  bucket: number,
): `0x${string}` {
  const message = `${merchantEvm.toLowerCase()}|${resource}|${bucket}`
  const digest = createHmac('sha256', secret).update(message, 'utf8').digest('hex')
  return `0x${digest}`
}

export interface DerivedChallenge {
  paymentId: `0x${string}`
  nonce: `0x${string}`
  bucket: number
}

/**
 * The challenge `ferry402` publishes in a 402 response for `(merchantEvm,
 * resource)` right now: the CURRENT bucket's derived `paymentId`/`nonce`.
 * Pure and synchronous — no store read, no store write. Calling this
 * repeatedly for the identical `(secret, merchantEvm, resource)` triple
 * within the same bucket always returns the identical result; that
 * determinism (not randomness) is the entire point — see this file's doc
 * comment.
 */
export function deriveChallenge(
  secret: string,
  merchantEvm: `0x${string}`,
  resource: string,
  nowMs: number = Date.now(),
): DerivedChallenge {
  const bucket = timeBucket(nowMs)
  const paymentId = derivePaymentId(secret, merchantEvm, resource, bucket)
  return { paymentId, nonce: computeNonce(merchantEvm, paymentId), bucket }
}

/**
 * Recomputes the derivation for the CURRENT bucket and the PREVIOUS one and
 * returns whichever `DerivedChallenge` has a `nonce` equal to
 * `presentedNonce` (already normalized to lowercase — see
 * `normalizeNonce` — bytes32 has no casing on-chain), or `undefined` if
 * neither matches.
 *
 * This is the single check that makes resource binding and TTL structural
 * rather than separately-checked facts: `presentedNonce` can only equal one
 * of these two candidates if whoever derived it knew `secret` (this server,
 * or someone it shared `secret` with — see the multi-instance test) AND
 * used this exact `resource` string AND did so within the last
 * `2 * TIME_BUCKET_SECONDS` seconds. No lookup, no store, is consulted to
 * reach that conclusion.
 *
 * Nonce equality is checked with `timingSafeEqual` on the fixed-length
 * 32-byte digest, not `===`, to avoid leaking a timing side-channel over how
 * many leading bytes of a guessed nonce happen to match — cheap insurance
 * given the comparison is on the request's hot path and costs nothing extra
 * to get right.
 */
export function matchChallenge(
  secret: string,
  merchantEvm: `0x${string}`,
  resource: string,
  presentedNonce: `0x${string}`,
  nowMs: number = Date.now(),
): DerivedChallenge | undefined {
  const presentedBytes = Buffer.from(presentedNonce.slice(2), 'hex')
  const currentBucket = timeBucket(nowMs)
  for (const bucket of [currentBucket, currentBucket - 1]) {
    const paymentId = derivePaymentId(secret, merchantEvm, resource, bucket)
    const nonce = computeNonce(merchantEvm, paymentId)
    const candidateBytes = Buffer.from(nonce.slice(2), 'hex')
    if (presentedBytes.length === candidateBytes.length && timingSafeEqual(presentedBytes, candidateBytes)) {
      return { paymentId, nonce, bucket }
    }
  }
  return undefined
}
