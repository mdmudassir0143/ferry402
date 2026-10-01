import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { PaymentPayloadSchema, VerifyResponseSchema } from 'x402/types'
import type { PaymentPayload, VerifyResponse } from 'x402/types'
import { assertChainsConfigured, buildRequirements } from './requirements.js'
import { normalizeAddress, normalizeNonce } from './nonce.js'
import { assertValidSecret, deriveChallenge, matchChallenge, TIME_BUCKET_SECONDS } from './challengeDerivation.js'
import { InMemoryConsumedNonceStore } from './challengeStore.js'
import type { ConsumedNonceStore } from './challengeStore.js'
import type { Ferry402Config, PaymentRequirements } from './types.js'

/** Timeout for the facilitator's `/verify` round trip. A facilitator that
 *  hangs (rather than erroring quickly) must not hang this request forever
 *  — see the task-6 review's I3. */
const VERIFY_TIMEOUT_MS = 5_000

/**
 * Parses a decimal-digits-only atomic-unit amount string to a `bigint`, or
 * returns `undefined` if it isn't one.
 *
 * Deliberately stricter than x402's own `value` validator
 * (`Number.isInteger(Number(v)) && Number(v) >= 0`, length <= 18), which
 * operates on the `Number()` coercion rather than the string's actual shape
 * and so accepts JS exponent notation: `"1e30"` is only 4 characters (well
 * under the 18-char cap) and `Number("1e30")` is an integer, so it passes
 * x402's schema — but `BigInt("1e30")` throws a `SyntaxError`. Both
 * `authorization.value` (payer-controlled) and `maxAmountRequired`
 * (server-controlled, but parsed identically for uniformity) go through
 * this before any `BigInt` arithmetic, in `middleware.ts`.
 */
function parseAtomicAmount(value: string): bigint | undefined {
  if (!/^\d+$/.test(value)) return undefined
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

export interface Ferry402Options {
  /**
   * Storage for consumed nonces (replay protection only — see
   * `challengeStore.ts`'s doc comment for why Task 12 removed the old
   * *issued*-challenge store entirely). Defaults to a fresh
   * `InMemoryConsumedNonceStore` — fine for a single process, but NOT
   * shared across horizontally-scaled instances: a nonce consumed on
   * instance A and replayed against instance B will not be caught unless a
   * shared implementation (Redis, a database, ...) is passed here instead.
   * `ferry402`'s signature does not need to change to fix that.
   */
  consumedNonceStore?: ConsumedNonceStore
}

/**
 * The exact shape `ferry402()` writes to `res.locals.x402` once a payment
 * verifies, so a route handler can read it with `res.locals.x402 as
 * Ferry402Locals` instead of `as unknown as { ... }`.
 *
 * `release` (Fix 2, 0.2.0) exists because `ferry402()` only calls `/verify`
 * — the route handler is what calls `/settle` (see this file's "KNOWN
 * LIMITATIONS" note) — and the `(from, nonce)` pair was already consumed
 * BEFORE `next()` ran, to close the same race the facilitator round trip
 * itself cannot close atomically. If the handler's OWN `/settle` call then
 * fails, nothing upstream of the handler can know that and release the pair
 * on its behalf; without this escape hatch that payer's nonce stays burned
 * for the rest of the derivation window (up to `2 * TIME_BUCKET_SECONDS`)
 * even though no payment actually completed. Calling it is entirely
 * optional (the happy path never needs it) and safe: best-effort, never
 * throws, and idempotent — see `releaseOnce`.
 */
export interface Ferry402Locals {
  /** The payer's decoded, verified `PaymentPayload`. */
  payload: PaymentPayload
  /** The exact `PaymentRequirements` entry `/verify` approved — pass this,
   *  byte-for-byte, to `/settle`. */
  requirements: PaymentRequirements
  /** The payer address the facilitator recovered from the signature. */
  payer: string | undefined
  /** Releases the `(from, nonce)` pair this request consumed. Call it from a
   *  `/settle` failure branch; see this interface's doc comment. */
  release: () => Promise<void>
}

/**
 * Express middleware that turns any route into an x402-payable one, across
 * every chain in `config.accept`, settling into a per-chain non-custodial
 * `Escrow`.
 *
 * ## Task 12: stateless challenge derivation
 *
 * `paymentId`/`nonce` are DERIVED, not minted and stored — see
 * `challengeDerivation.ts` for the full design rationale:
 *
 * ```
 * paymentId = HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)
 * nonce     = keccak256(abi.encode(merchantEvm, paymentId))     // computeNonce, unchanged
 * ```
 *
 * `issueChallenge` below is a pure, synchronous function: no store read, no
 * store write, for any request, ever. The payment path recomputes the same
 * derivation for the CURRENT and PREVIOUS time bucket
 * (`challengeDerivation.matchChallenge`) and accepts
 * `authorization.nonce` if it equals either — proving, with zero storage,
 * that THIS server issued it, for THIS resource, inside the window.
 * Resource binding and TTL are therefore structural: neither is a check
 * that can be forgotten, because a mismatched nonce cannot be produced by
 * construction (only a holder of `config.secret` can reproduce the HMAC,
 * and `resource`/the time bucket are baked into its preimage).
 *
 * `config.secret` is required and validated (`assertValidSecret`) at
 * CONSTRUCTION time — `ferry402(config)` throws synchronously if it is
 * missing or under 32 bytes, before ever registering a request handler.
 *
 * ## What is NOT stateless: replay
 *
 * Proving "never redeemed before" needs memory of the past, which no pure
 * derivation can supply. `ConsumedNonceStore` (`challengeStore.ts`) is that
 * memory, but — unlike the old issuance store — it is written to ONLY when
 * a request reaches the point of actually being paid: after every local
 * floor check passes, immediately before calling the facilitator's
 * `/verify`, this middleware atomically `consumeIfAbsent`s the presented
 * nonce. If the facilitator then rejects the payment (or is unreachable),
 * the nonce is `release`d again rather than left permanently consumed — see
 * `ConsumedNonceStore.release`'s doc comment for why skipping that release
 * step would turn one bogus-signature request into a total, cheap denial of
 * service against a specific resource for its whole derivation window
 * (a derived nonce is PUBLIC, same as the old random `paymentId` was: an
 * anonymous GET learns it, so anyone can attempt to burn it).
 *
 * Consuming happens atomically (`ConsumedNonceStore.consumeIfAbsent` is a
 * single check-and-set) so concurrent replays of the identical `X-PAYMENT`
 * header race safely: at most one can ever proceed past this point,
 * regardless of how many arrive at once or how slow the facilitator is to
 * answer — see `challengeStore.ts` for why this MUST be one atomic
 * operation, never a read followed by a write after an `await`.
 *
 * ## The paymentId round trip
 *
 * The `paymentRequirements` object this middleware sends to `/verify` MUST
 * be byte-for-byte the same `paymentId` the payer actually signed against.
 * Because the payer's request can arrive after the time bucket has rolled
 * over, the bucket that actually matched (`matchChallenge`'s return value)
 * may be the PREVIOUS one, not the CURRENT one `issueChallenge` would derive
 * for a brand-new request made right now — so the requirement object handed
 * to `/verify` (and surfaced on `res.locals.x402.requirements` for
 * settlement) is built from `matched.paymentId` specifically, never from a
 * freshly-`issueChallenge`d one.
 *
 * ## Many payers, one derived challenge: keyed by `(from, nonce)`, not `nonce`
 *
 * Because `paymentId` depends only on `(merchantEvm, resource, timeBucket)`
 * — never on WHO is asking — every anonymous requester of the SAME resource
 * within the SAME bucket sees the SAME challenge, hence the SAME nonce. A
 * `ConsumedNonceStore` keyed by `nonce` alone would therefore treat a SECOND,
 * genuinely different, independently-signed payer's payment as a replay of
 * the FIRST payer's — one paying customer per resource per window, which for
 * a metered API is a worse regression than the availability bug this task
 * fixes (that one needed an attacker; this happens between two honest
 * customers). Round 1 review caught this. Fixed by keying
 * `ConsumedNonceStore` on the PAIR — `authorization.from` alongside the
 * nonce — matching how real USDC itself keys authorization-used state
 * (`_authorizationStates[from][nonce]`, per-authorizer, not global): a store
 * keyed by nonce alone was STRICTER than the token, rejecting payments the
 * chain would have accepted, which is the mirror image of the discipline
 * Task 11 enforced the other way (never MORE PERMISSIVE than the token).
 * Two different payers of the same resource in the same window now both
 * succeed; the SAME payer replaying the SAME nonce is still rejected —
 * keying on the pair adds a dimension, it does not remove one. See
 * `challengeStore.ts` for the full rationale and `middleware.test.ts`'s
 * "multiple payers" tests for the mutation-checked proof.
 *
 * ## Local floor checks
 *
 * Unchanged from Task 6: `maxAmountRequired`, `payTo`, and the
 * authorization's time window are checked locally, before ever consuming a
 * nonce or calling the facilitator — see the inline comments below for the
 * `parseAtomicAmount` rationale (x402's own `value` validator admits `"1e30"`
 * which crashes bare `BigInt`).
 *
 * KNOWN LIMITATIONS (accepted for this task's slice):
 * - The default `InMemoryConsumedNonceStore` is per-process; see
 *   `Ferry402Options.consumedNonceStore`.
 * - This function only calls `/verify`, never `/settle` — double-collection
 *   protection (the same authorization redeemed twice on-chain) is
 *   `Escrow`'s own single-use nonce tracking, out of scope here.
 */
export function ferry402(config: Ferry402Config, options: Ferry402Options = {}): RequestHandler {
  assertValidSecret(config.secret)
  assertChainsConfigured(config)
  const consumedNonceStore = options.consumedNonceStore ?? new InMemoryConsumedNonceStore()

  /**
   * Builds the `accepts` array for `resource` RIGHT NOW: one
   * `PaymentRequirements` entry per accepted chain, each carrying the
   * CURRENT bucket's derived `paymentId`. Passes
   * `skipPaymentIdGeneration: true` to `buildRequirements` — every entry's
   * placeholder `paymentId` is overwritten below before this function
   * returns, so there is no reason to spend a `crypto.randomBytes(32)` draw
   * generating one first, on every single request (see that option's doc
   * comment in `requirements.ts`). Pure and synchronous: no store of any
   * kind is touched, for any request — this is the core of Task 12's fix.
   * Calling this for the same `resource` twice inside the same time bucket
   * returns byte-for-byte identical `paymentId`s, by design.
   */
  function issueChallenge(resource: string): PaymentRequirements[] {
    const requirements = buildRequirements(config, resource, { skipPaymentIdGeneration: true })
    for (const requirement of requirements) {
      const merchantEvm = requirement.extra?.merchantEvm as `0x${string}` | undefined
      if (!merchantEvm) {
        // Defensive, now effectively a second layer behind
        // `assertChainsConfigured` (0.2.0: `types.ts`'s
        // `Ferry402Config.merchantEvm` became `Partial`, so TypeScript alone
        // no longer rules this out) — reaching here means config itself is
        // broken. The old behavior was `continue`, which left this
        // entry's `extra.paymentId` at `buildRequirements`'
        // `skipPaymentIdGeneration` all-zero placeholder and published THAT
        // in the 402 body — strictly worse than the random `paymentId` a
        // pre-Task-12 `continue` would have left in place, because an
        // all-zero placeholder looks like a legitimate (if wrong) derived
        // value rather than an obviously-broken one. A misconfigured
        // merchant must fail loudly, not silently publish a payable-looking
        // placeholder.
        throw new Error(
          `ferry402: no merchantEvm configured for network "${requirement.network}" - ` +
            'config.merchantEvm must have an entry for every chain in config.accept.',
        )
      }
      const derived = deriveChallenge(config.secret, merchantEvm, resource)
      requirement.extra = { ...requirement.extra, paymentId: derived.paymentId }
    }
    return requirements
  }

  function send402(res: Response, accepts: PaymentRequirements[], error?: string): void {
    // A 402 challenge/rejection must never be cached by an intermediary.
    res.set('Cache-Control', 'no-store')
    res.status(402).json(error === undefined ? { x402Version: 1, accepts } : { x402Version: 1, accepts, error })
  }

  async function callVerify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse | { networkError: true }> {
    try {
      const verifyRes = await fetch(`${config.facilitator}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      })
      if (!verifyRes.ok) return { networkError: true }
      const json: unknown = await verifyRes.json()
      // Parsed against x402's own VerifyResponseSchema, not an `as` cast —
      // the facilitator is a separate trust domain reachable at a configured
      // URL, and its response deserves the same "parse, don't hand-roll"
      // treatment as the inbound X-PAYMENT payload (task-6 correction 1).
      const parsed = VerifyResponseSchema.safeParse(json)
      if (!parsed.success) return { networkError: true }
      return parsed.data
    } catch {
      // Facilitator unreachable, timed out (including our own
      // AbortSignal.timeout firing), or returned unparseable JSON. Never let
      // this reject the request handler — a down facilitator must fail the
      // payment cleanly, not crash the route.
      return { networkError: true }
    }
  }

  async function release(from: `0x${string}`, nonce: `0x${string}`): Promise<void> {
    try {
      await consumedNonceStore.release(from, nonce)
    } catch {
      // Best effort — see ConsumedNonceStore.release's doc comment. A failed
      // release just means the payer sees `invalid_payment` (the
      // already-consumed branch below) on retry rather than a clean one;
      // still fail-closed, never fail-open.
    }
  }

  /**
   * Fix 2 (0.2.0): wraps `release` with a one-shot guard, for
   * `res.locals.x402.release` — the handle a route handler calls when ITS
   * OWN `/settle` call fails, so the nonce this middleware already consumed
   * doesn't stay burned for the rest of the derivation window over a payment
   * that never actually completed. Without the guard, a SECOND call after
   * the pair has already been re-consumed by a legitimate retry would
   * release THAT retry's slot too — reopening the exact replay window
   * `ConsumedNonceStore` exists to close. `released` is captured per call
   * (one closure per request), so it cannot leak between requests.
   */
  function releaseOnce(from: `0x${string}`, nonce: `0x${string}`): () => Promise<void> {
    let released = false
    return async () => {
      if (released) return
      released = true
      await release(from, nonce)
    }
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`
      // Computed unconditionally, once, for every request: unlike the old
      // store-backed `issueChallenge`, this costs nothing but a few HMAC
      // computations — no I/O, no allocation proportional to request volume.
      const requirements = issueChallenge(resource)
      const header = req.header('X-PAYMENT')

      if (!header) {
        send402(res, requirements)
        return
      }

      // Decode + parse are wrapped together: Buffer's base64 decoder does not
      // throw on malformed input (it just decodes whatever it can), so the
      // realistic failure here is JSON.parse throwing on the resulting bytes —
      // but both are guarded regardless, since neither is a case this
      // middleware should ever let escape as an unhandled exception.
      let decoded: unknown
      try {
        decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
      } catch {
        send402(res, requirements, 'invalid_payload')
        return
      }

      // Parsed against x402's own PaymentPayloadSchema, not a hand-rolled
      // shape check — see the task-6 corrections this implements.
      const parsed = PaymentPayloadSchema.safeParse(decoded)
      if (!parsed.success) {
        send402(res, requirements, 'invalid_payload')
        return
      }
      const paymentPayload = parsed.data

      if (!('authorization' in paymentPayload.payload)) {
        // The schema's other branch is the exact-svm variant ({ transaction }),
        // which carries no `nonce` at all. v1 is EVM-only (USDC on
        // base/base-sepolia/polygon/polygon-amoy).
        send402(res, requirements, 'invalid_payload')
        return
      }
      const authorization = paymentPayload.payload.authorization
      const presentedNonce = normalizeNonce(authorization.nonce)
      // Task 12 round-1 review fix: replay defense is keyed on the PAIR, not
      // the nonce alone — see ConsumedNonceStore's doc comment for why (the
      // derivation has no payer term, so two different payers of the same
      // resource in the same window derive the identical nonce; real USDC
      // itself keys authorization-used state as `_authorizationStates[from]
      // [nonce]` for exactly this reason).
      const presentedFrom = normalizeAddress(authorization.from)

      const selected = requirements.find((r) => r.network === paymentPayload.network)
      if (!selected) {
        // The claimed network isn't one this merchant accepts at all — cheap,
        // pre-derivation rejection; no HMAC needed to know this is wrong.
        send402(res, requirements, 'invalid_network')
        return
      }

      const merchantEvm = selected.extra?.merchantEvm as `0x${string}`
      // THE structural check: resource binding and TTL both fall out of this
      // single recomputation (see challengeDerivation.ts's doc comment) rather
      // than being separate lookups. A nonce for a different resource, a
      // different merchant address, or more than one bucket in the past can
      // never equal either candidate, by construction of the HMAC preimage —
      // there is no store here to consult either way.
      const matched = matchChallenge(config.secret, merchantEvm, resource, presentedNonce)
      if (!matched) {
        // `invalid_payment`, NOT `payment_expired`: a mismatch here has at
        // least three distinct possible causes — the nonce genuinely expired,
        // it was derived for a different resource or merchant, or the client
        // (every stock x402 client — see paymentHeader.ts) signed a random
        // nonce it invented itself — and this check has no way to tell which
        // one happened. The validity WINDOW is enforced by the HMAC
        // derivation itself (challengeDerivation.ts), not a store with
        // timestamps to inspect, so there is no record here to look back at
        // and classify the cause from. Reporting `payment_expired` would
        // assert a specific cause (expiry) we have not established;
        // `invalid_payment` — a real x402 `ErrorReasons` member — says only
        // what is actually known: the presented nonce does not match.
        send402(res, requirements, 'invalid_payment')
        return
      }

      // Local floor checks - cheap, and every input is already in hand. A
      // facilitator is a separate trust domain reachable over the network;
      // there is no reason to ask it to reject what we can already reject.
      // `selected`'s static fields (maxAmountRequired, payTo) do not depend on
      // which bucket matched, so they can be read straight off it.
      //
      // `value` is parsed via `parseAtomicAmount`, NOT a bare `BigInt(...)`:
      // x402's own validator for this field is
      // `Number.isInteger(Number(v)) && Number(v) >= 0`, which operates on the
      // `Number()` coercion rather than the string's shape and so admits JS
      // exponent notation - `"1e30"` passes (an integer, and only 4 characters,
      // nowhere near the 18-char length cap) but `BigInt("1e30")` throws a
      // SyntaxError. Reaching this line needs no valid payment at all: the 402
      // challenge body itself publishes `extra.merchantEvm`, and the
      // derivation is public knowledge of the request's own resource, so
      // anyone can derive a matching nonce and reach here with a crafted
      // `value` alone (review round 3's Critical finding, task 6).
      const authorizedValue = parseAtomicAmount(authorization.value)
      const requiredValue = parseAtomicAmount(selected.maxAmountRequired)
      if (authorizedValue === undefined || requiredValue === undefined || authorizedValue < requiredValue) {
        send402(res, requirements, 'invalid_exact_evm_payload_authorization_value')
        return
      }
      if (authorization.to.toLowerCase() !== selected.payTo.toLowerCase()) {
        send402(res, requirements, 'invalid_exact_evm_payload_recipient_mismatch')
        return
      }
      const nowSeconds = Math.floor(Date.now() / 1000)
      if (Number(authorization.validAfter) > nowSeconds) {
        send402(res, requirements, 'invalid_exact_evm_payload_authorization_valid_after')
        return
      }
      if (Number(authorization.validBefore) <= nowSeconds) {
        send402(res, requirements, 'invalid_exact_evm_payload_authorization_valid_before')
        return
      }

      // The payer may have signed against the PREVIOUS bucket (see
      // matchChallenge) rather than the CURRENT one `requirements`/`selected`
      // were just built with — substitute `matched.paymentId` so what we hand
      // the facilitator (and, downstream, on-chain settlement) is
      // byte-for-byte what the payer actually signed.
      const requirementForVerify: PaymentRequirements = {
        ...selected,
        extra: { ...selected.extra, paymentId: matched.paymentId },
      }

      // Every check above was read-only. Only now, immediately before the
      // facilitator call, do we actually consume the nonce — atomically, so
      // concurrent replays of the identical X-PAYMENT header race safely (see
      // ConsumedNonceStore's doc comment for why this must be a single
      // check-and-set, not a read followed by a write after an await).
      const expiresAt = Date.now() + 2 * TIME_BUCKET_SECONDS * 1000
      let firstConsume: boolean
      try {
        firstConsume = await consumedNonceStore.consumeIfAbsent(presentedFrom, presentedNonce, expiresAt)
      } catch {
        send402(res, requirements, 'unexpected_verify_error')
        return
      }
      if (!firstConsume) {
        // Already consumed by a prior (or concurrently racing) request with
        // the identical (from, nonce) pair — a genuine replay BY THE SAME
        // PAYER. A different payer presenting the same nonce is a different
        // pair and is never rejected here (see ConsumedNonceStore's doc
        // comment). Rejected locally; the facilitator is never called a
        // second time for it. `invalid_payment`, not `payment_expired`: unlike
        // the matchChallenge branch above, this IS a definitively known
        // cause — a recorded replay, not expiry — so there is nothing
        // ambiguous left to hedge about.
        send402(res, requirements, 'invalid_payment')
        return
      }

      const verdict = await callVerify(paymentPayload, requirementForVerify)
      if ('networkError' in verdict) {
        await release(presentedFrom, presentedNonce)
        send402(res, requirements, 'unexpected_verify_error')
        return
      }

      if (!verdict.isValid) {
        await release(presentedFrom, presentedNonce)
        send402(res, requirements, verdict.invalidReason ?? 'invalid_payment')
        return
      }

      // Never log `paymentPayload` (carries the payer's signature) or the raw
      // X-PAYMENT header anywhere on this path — see the task-6 judgement
      // notes. res.locals is request-scoped app state, not a log sink.
      // `release` (Fix 2, 0.2.0) closes over THIS request's own (from, nonce)
      // — see `Ferry402Locals`'s doc comment for why the handler needs it.
      const locals: Ferry402Locals = {
        payload: paymentPayload,
        requirements: requirementForVerify,
        payer: verdict.payer,
        release: releaseOnce(presentedFrom, presentedNonce),
      }
      res.locals.x402 = locals
      next()
    } catch (err) {
      // This handler's own returned promise must never reject — Express 5
      // forwards a rejected middleware promise to `next(err)` automatically,
      // but Express 4 (still an accepted peer dependency, see
      // `package.json`'s `^4.18.0 || ^5.0.0`) does NOT: it neither awaits
      // nor attaches a `.catch()` to whatever an async middleware function
      // returns, so an uncaught throw here would surface as an unhandled
      // rejection on Node's own event loop, independent of this request's
      // response cycle. Under Node's default `--unhandled-rejections=throw`
      // (since Node 15), that CRASHES THE WHOLE PROCESS — every in-flight
      // request, not just the one that triggered it.
      //
      // The realistic trigger is `issueChallenge` throwing on a
      // misconfigured `merchantEvm` (Task 13 carry-forward 3 — see its doc
      // comment: a config assembled from untyped JSON/env vars, which is how
      // production config is usually built, is not caught by
      // `Ferry402Config`'s TS types alone). This `try`/`catch` applies, to
      // every throw in this handler, the exact rule `callVerify` above
      // already states for itself: "Never let this reject the request
      // handler — a down facilitator must fail the payment cleanly, not
      // crash the route." `next(err)` is core Express API, identical on
      // both majors, so this is safe regardless of which peer version is
      // installed. See `middleware.test.ts`'s "misconfigured merchantEvm"
      // tests — including one driven through a real Express app via
      // `supertest`, not just a direct call — for the mutation-checked
      // proof.
      next(err)
    }
  }
}
