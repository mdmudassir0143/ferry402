import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { PaymentPayloadSchema, VerifyResponseSchema } from 'x402/types'
import type { PaymentPayload, VerifyResponse } from 'x402/types'
import { buildRequirements } from './requirements.js'
import { normalizeNonce } from './nonce.js'
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
 * ## A structural trade-off, stated explicitly (not silently dropped)
 *
 * Because `paymentId` depends only on `(merchantEvm, resource, timeBucket)`
 * — never on WHO is asking — every anonymous requester of the SAME resource
 * within the SAME bucket sees the SAME challenge, and `ConsumedNonceStore`
 * is keyed purely by `nonce` (matching this task's spec literally). Two
 * DIFFERENT payers racing to pay the identical resource in the identical
 * window are therefore racing for ONE shared slot: whichever one's payment
 * the facilitator confirms first consumes the nonce, and the other is
 * indistinguishable from a replay and is rejected — even though on-chain
 * EIP-3009 nonce tracking is scoped per-`from` and would not itself have
 * conflicted. This is a genuine behavior change from Task 6, whose
 * per-request random `paymentId` gave concurrent payers of the same
 * resource independent slots (see the task-6 report's "concurrency
 * (nonce-keyed store, not resource-keyed)" tests, now superseded — a
 * challenge cannot be minted unique-per-payer before the payer has said
 * anything, without storing something, which is exactly what this task
 * removes). A route that needs independent concurrent slots can still get
 * one per caller by folding a caller-supplied unique token into its own
 * URL/query string (which becomes part of `resource`, and therefore of the
 * HMAC preimage) — a route-design choice, not something this middleware
 * does on the caller's behalf.
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
 * - The concurrent-different-payers trade-off above.
 */
export function ferry402(config: Ferry402Config, options: Ferry402Options = {}): RequestHandler {
  assertValidSecret(config.secret)
  const consumedNonceStore = options.consumedNonceStore ?? new InMemoryConsumedNonceStore()

  /**
   * Builds the `accepts` array for `resource` RIGHT NOW: one
   * `PaymentRequirements` entry per accepted chain, each carrying the
   * CURRENT bucket's derived `paymentId` in place of `buildRequirements`'s
   * own random default (which is generated and then immediately discarded
   * here — see this function's doc comment for why the random value must
   * never be the one actually published). Pure and synchronous: no store of
   * any kind is touched, for any request — this is the core of Task 12's
   * fix. Calling this for the same `resource` twice inside the same time
   * bucket returns byte-for-byte identical `paymentId`s, by design.
   */
  function issueChallenge(resource: string): PaymentRequirements[] {
    const requirements = buildRequirements(config, resource)
    for (const requirement of requirements) {
      const merchantEvm = requirement.extra?.merchantEvm as `0x${string}` | undefined
      if (!merchantEvm) continue // defensive; buildRequirements always sets this
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

  async function release(nonce: `0x${string}`): Promise<void> {
    try {
      await consumedNonceStore.release(nonce)
    } catch {
      // Best effort — see ConsumedNonceStore.release's doc comment. A failed
      // release just means the payer sees `payment_expired` on retry rather
      // than a clean one; still fail-closed, never fail-open.
    }
  }

  return async (req: Request, res: Response, next: NextFunction) => {
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
      send402(res, requirements, 'payment_expired')
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
      firstConsume = await consumedNonceStore.consumeIfAbsent(presentedNonce, expiresAt)
    } catch {
      send402(res, requirements, 'unexpected_verify_error')
      return
    }
    if (!firstConsume) {
      // Already consumed by a prior (or concurrently racing) request with
      // the identical nonce — a genuine replay. Rejected locally; the
      // facilitator is never called a second time for it.
      send402(res, requirements, 'payment_expired')
      return
    }

    const verdict = await callVerify(paymentPayload, requirementForVerify)
    if ('networkError' in verdict) {
      await release(presentedNonce)
      send402(res, requirements, 'unexpected_verify_error')
      return
    }

    if (!verdict.isValid) {
      await release(presentedNonce)
      send402(res, requirements, verdict.invalidReason ?? 'invalid_payment')
      return
    }

    // Never log `paymentPayload` (carries the payer's signature) or the raw
    // X-PAYMENT header anywhere on this path — see the task-6 judgement
    // notes. res.locals is request-scoped app state, not a log sink.
    res.locals.x402 = { payload: paymentPayload, requirements: requirementForVerify, payer: verdict.payer }
    next()
  }
}
