import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { PaymentPayloadSchema, VerifyResponseSchema } from 'x402/types'
import type { PaymentPayload, VerifyResponse } from 'x402/types'
import { buildRequirements } from './requirements.js'
import { computeNonce, normalizeNonce } from './nonce.js'
import { InMemoryChallengeStore } from './challengeStore.js'
import type { ChallengeStore, CachedChallenge } from './challengeStore.js'
import type { Anychain402Config, PaymentRequirements } from './types.js'

const DEFAULT_TIMEOUT_SECONDS = 300

/** Timeout for the facilitator's `/verify` round trip. A facilitator that
 *  hangs (rather than erroring quickly) must not hang this request forever
 *  — see the task-6 review's I3. */
const VERIFY_TIMEOUT_MS = 5_000

export interface Anychain402Options {
  /**
   * Storage for outstanding 402 challenges. Defaults to a fresh
   * `InMemoryChallengeStore` — fine for a single process, but see
   * `ChallengeStore`'s doc comment (`challengeStore.ts`) for why that
   * default doesn't survive a restart or share state across
   * horizontally-scaled instances. Pass a shared implementation (Redis, a
   * database, ...) to fix that without changing anything else here.
   */
  store?: ChallengeStore
}

/**
 * Express middleware that turns any route into an x402-payable one, across
 * every chain in `config.accept`, settling into a per-chain non-custodial
 * `Escrow`.
 *
 * ## The paymentId round trip
 *
 * `buildRequirements` (Task 5) mints a fresh, random `paymentId` on *every*
 * call — see its doc comment. The payer is expected to derive the EIP-3009
 * authorization `nonce` it signs as `computeNonce(merchantEvm, paymentId)`
 * (`keccak256(abi.encode(merchantEvm, paymentId))`; see `nonce.ts` and
 * `Escrow.settleAuthorization`'s doc comment in `packages/contracts`), using
 * the `paymentId`/`merchantEvm` published in the 402 challenge's
 * `accepts[].extra`. A facilitator's `/verify` (Task 7) — and ultimately the
 * `Escrow` contract itself at settlement — recomputes that same hash from
 * whatever `paymentRequirements` it is handed and rejects anything that
 * doesn't match the payer's signed `nonce`.
 *
 * That means the `paymentRequirements` this middleware sends to `/verify`
 * MUST be byte-for-byte the same object (same `paymentId`, same
 * `merchantEvm`) the payer saw in the 402 challenge they signed against. If
 * this middleware called `buildRequirements` a second time when the
 * `X-PAYMENT` request arrived, that call would mint a *different* random
 * `paymentId` — the payer's nonce would never match it, and every payment
 * would fail. This is a real bug in the task brief's starting-point code,
 * which called `buildRequirements` unconditionally on every request.
 *
 * ## Why the challenge store is keyed by nonce, not by resource
 *
 * An earlier version of this middleware cached issued challenges keyed by
 * `resource` (the requested URL). That collapses under ordinary concurrency:
 * two payers requesting the same protected endpoint at close to the same
 * time would get two different `paymentId`s, but the *second* challenge
 * would overwrite the first's cache entry. The fix: at challenge time, this
 * middleware already knows exactly which nonce a payer would have to sign to
 * pay each issued `PaymentRequirements` entry —
 * `computeNonce(entry.extra.merchantEvm, entry.extra.paymentId)` — so it
 * stores one `ChallengeStore` entry per entry (one per accepted chain),
 * keyed by that nonce (always normalized to lowercase — see `normalizeNonce`
 * — since x402's schema permits mixed-case hex but a `bytes32` has no
 * casing on-chain). On the payment path, the payer's own
 * `authorization.nonce` is an exact key into that store: no guessing via
 * `resource`, no collision between concurrent payers.
 *
 * ## One challenge, one payment: consume, don't just verify
 *
 * A `ChallengeStore` entry is a bearer credential once its nonce is known —
 * whoever can replay a valid `X-PAYMENT` header can replay it again. Nothing
 * about a successful `/verify` prevents that on its own: `/verify` is a
 * stateless signature/shape check, and `Escrow`'s on-chain nonce tracking
 * only ever runs at *settlement*, which this function does not perform (see
 * "known limitations" below). Without an explicit step here, one signed
 * authorization would buy unlimited calls to the protected route for the
 * entire `maxTimeoutSeconds` window.
 *
 * So a payment that passes every local check is `store.consume`d —
 * atomically returned-and-removed — immediately before calling `/verify`,
 * not `get` followed by a separate `delete` after. `get`-then-`delete` would
 * leave a window where several concurrent replays of the identical header
 * all observe the entry as present (via `get`) before any one of them
 * removes it, so several would independently pass verification. `consume`
 * closes that window: at most one caller ever receives the entry back: every
 * concurrent or later `consume` of the same nonce gets `undefined`.
 *
 * Consuming happens optimistically, before we know whether the facilitator
 * will actually approve the payment. If it turns out NOT to be valid — a
 * facilitator network/HTTP error, or an explicit `isValid: false` — the
 * consumed entry is reinstated (`store.set` with the same data) rather than
 * left gone, deliberately: nothing was actually collected in either case (no
 * on-chain settlement has happened), so there is no reason to force the
 * payer to fetch a brand-new challenge (a new price commitment) just because
 * our own infrastructure hiccuped, or to make an honest retry-with-a-corrected-signature
 * impossible after a rejected attempt. Only a confirmed `isValid: true`
 * permanently retires the challenge.
 *
 * Checks that can be answered locally (resource match, network match, the
 * authorization's value/recipient/time-window) run BEFORE `consume`, against
 * a read-only `get` — a payload that fails one of these was never a genuine
 * attempt at this specific challenge, so there is nothing to consume or
 * reinstate; the challenge simply remains available for a corrected retry.
 *
 * A payment that arrives with an unrecognized nonce (never issued, already
 * consumed, already expired) fails closed: `402` with a *freshly* issued
 * challenge and `error: 'payment_expired'`, without ever calling the
 * facilitator.
 *
 * ## Local floor checks
 *
 * `maxAmountRequired`, `payTo`, and the authorization's time window are all
 * inputs this middleware already has in hand once it has looked up the
 * matching `PaymentRequirements` — there is no reason to spend a network
 * round trip to a facilitator (a separate trust domain, reachable at a
 * configured URL) to reject a payload that authorizes too little value, pays
 * the wrong address, or has already expired. These are checked locally
 * before `consume`. There is deliberately no separate "asset" check: x402's
 * exact-evm `authorization` carries no asset field at all — the token is
 * pinned implicitly by `payTo`, since in this v1 design each `Escrow` is
 * deployed against one immutable token (`Escrow.token` is set at
 * construction and never changes), so an authorization paying the correct
 * `payTo` cannot be paying a different asset than the one that `Escrow`
 * accepts.
 *
 * KNOWN LIMITATIONS (accepted for this task's slice, see the task-6 report):
 * - The default `InMemoryChallengeStore` is in-memory and per process. It
 *   does not survive a restart and is not shared across horizontally-scaled
 *   instances — a payment routed to a different instance than the one that
 *   issued its challenge is (correctly, if unhelpfully) told its challenge
 *   expired. Pass `{ store }` with a shared implementation (Redis, a
 *   database) to fix this; `anychain402`'s signature does not need to
 *   change.
 * - This function only calls `/verify`, never `/settle`. Double-*collection*
 *   protection (the same authorization being settled on-chain twice) is the
 *   `Escrow` contract's single-use nonce, at settlement time — out of scope
 *   here. What IS in scope here, and implemented, is double-*service*
 *   protection: consuming the challenge on first use means a replayed
 *   `X-PAYMENT` header cannot buy a second response, independent of
 *   whatever happens (or doesn't) at settlement.
 * - A malformed or schema-invalid `X-PAYMENT` cannot be correlated to any
 *   outstanding challenge (there is no nonce to look up yet), so it is
 *   answered with a freshly-minted challenge rather than the one — if any —
 *   the payer actually intended to pay against.
 */
export function anychain402(config: Anychain402Config, options: Anychain402Options = {}): RequestHandler {
  const store = options.store ?? new InMemoryChallengeStore()

  async function issueChallenge(resource: string): Promise<PaymentRequirements[]> {
    const requirements = buildRequirements(config, resource)
    const maxTimeoutSeconds = requirements[0]?.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    const expiresAt = Date.now() + maxTimeoutSeconds * 1000
    try {
      await Promise.all(
        requirements.map((requirement) => {
          const nonce = computeNonce(
            requirement.extra?.merchantEvm as `0x${string}`,
            requirement.extra?.paymentId as `0x${string}`,
          )
          return store.set(nonce, { requirement, accepts: requirements, resource, expiresAt })
        }),
      )
    } catch {
      // A store backed by something remote (Redis, a database) can fail on
      // its own terms. The challenge we hand back may end up unredeemable
      // (any payment against it will simply see "no such challenge" — a
      // safe, if unhelpful, failure mode) but returning SOME valid 402 body
      // beats letting this rejection propagate: on Express 4 (within our
      // declared peer range) an async middleware's rejected promise is not
      // forwarded anywhere, which would otherwise surface as an unhandled
      // rejection and a hung request rather than a clean response.
    }
    return requirements
  }

  function send402(res: Response, accepts: PaymentRequirements[], error?: string): void {
    // A 402 challenge/rejection must never be cached by an intermediary —
    // each one is tied to a fresh paymentId and, once consumed, to a
    // specific one-time nonce.
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

  return async (req: Request, res: Response, next: NextFunction) => {
    const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`
    const header = req.header('X-PAYMENT')

    if (!header) {
      send402(res, await issueChallenge(resource))
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
      send402(res, await issueChallenge(resource), 'invalid_payload')
      return
    }

    // Parsed against x402's own PaymentPayloadSchema, not a hand-rolled
    // shape check — see the task-6 corrections this implements.
    const parsed = PaymentPayloadSchema.safeParse(decoded)
    if (!parsed.success) {
      send402(res, await issueChallenge(resource), 'invalid_payload')
      return
    }
    const paymentPayload = parsed.data

    if (!('authorization' in paymentPayload.payload)) {
      // The schema's other branch is the exact-svm variant ({ transaction }),
      // which carries no `nonce` at all. v1 is EVM-only (USDC on
      // base/base-sepolia/polygon/polygon-amoy), so there is nothing to look
      // up a challenge by here.
      send402(res, await issueChallenge(resource), 'invalid_payload')
      return
    }
    const authorization = paymentPayload.payload.authorization
    const nonce = normalizeNonce(authorization.nonce)

    let cached: CachedChallenge | undefined
    try {
      cached = await store.get(nonce)
    } catch {
      send402(res, await issueChallenge(resource), 'unexpected_verify_error')
      return
    }
    if (!cached) {
      send402(res, await issueChallenge(resource), 'payment_expired')
      return
    }

    // Resource binding: a challenge issued for one resource must never be
    // honored for another, even under the same route mount (`resource`
    // includes the full request URL, query string and all) and even if a
    // shared store makes another route's challenge technically reachable.
    // Without this, a nonce is only bound to a chain and a price - not to
    // WHICH protected resource that price was for.
    if (cached.resource !== resource) {
      send402(res, cached.accepts, 'invalid_payment_requirements')
      return
    }

    // The nonce is the source of truth for which chain this payment is for.
    // A payload whose outer `network` disagrees with the chain the nonce was
    // actually minted for is rejected rather than trusted — this also
    // catches an unaccepted network reusing a real nonce from a different,
    // accepted chain.
    if (cached.requirement.network !== paymentPayload.network) {
      send402(res, cached.accepts, 'invalid_network')
      return
    }

    // Local floor checks - cheap, and every input is already in hand. A
    // facilitator is a separate trust domain reachable over the network;
    // there is no reason to ask it to reject what we can already reject.
    if (BigInt(authorization.value) < BigInt(cached.requirement.maxAmountRequired)) {
      send402(res, cached.accepts, 'invalid_exact_evm_payload_authorization_value')
      return
    }
    if (authorization.to.toLowerCase() !== cached.requirement.payTo.toLowerCase()) {
      send402(res, cached.accepts, 'invalid_exact_evm_payload_recipient_mismatch')
      return
    }
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (Number(authorization.validAfter) > nowSeconds) {
      send402(res, cached.accepts, 'invalid_exact_evm_payload_authorization_valid_after')
      return
    }
    if (Number(authorization.validBefore) <= nowSeconds) {
      send402(res, cached.accepts, 'invalid_exact_evm_payload_authorization_valid_before')
      return
    }

    // Every check above was read-only (via `get`). Only now, immediately
    // before the facilitator call, do we actually consume the challenge —
    // see this function's doc comment ("consume, don't just verify") for why
    // this is the precise point that must be atomic.
    let consumed: CachedChallenge | undefined
    try {
      consumed = await store.consume(nonce)
    } catch {
      send402(res, await issueChallenge(resource), 'unexpected_verify_error')
      return
    }
    if (!consumed) {
      // Raced with another consumer of the same nonce (a genuine replay, or
      // a concurrent duplicate request), or expired in the gap since `get`.
      // Either way: no longer redeemable.
      send402(res, await issueChallenge(resource), 'payment_expired')
      return
    }

    const verdict = await callVerify(paymentPayload, consumed.requirement)
    if ('networkError' in verdict) {
      await reinstate(nonce, consumed)
      send402(res, consumed.accepts, 'unexpected_verify_error')
      return
    }

    if (!verdict.isValid) {
      await reinstate(nonce, consumed)
      send402(res, consumed.accepts, verdict.invalidReason ?? 'invalid_payment')
      return
    }

    // Never log `paymentPayload` (carries the payer's signature) or the raw
    // X-PAYMENT header anywhere on this path — see the task-6 judgement
    // notes. res.locals is request-scoped app state, not a log sink.
    res.locals.x402 = { payload: paymentPayload, requirements: consumed.requirement, payer: verdict.payer }
    next()
  }

  async function reinstate(nonce: `0x${string}`, entry: CachedChallenge): Promise<void> {
    try {
      await store.set(nonce, entry)
    } catch {
      // Best effort: if the store can't be written back to, the payer will
      // see this challenge as expired on retry rather than reinstated. That
      // is still fail-closed (no unintended access granted), just less
      // convenient than a successful reinstatement would have been.
    }
  }
}
