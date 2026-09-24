import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { PaymentPayloadSchema } from 'x402/types'
import type { PaymentPayload } from 'x402/types'
import { buildRequirements } from './requirements.js'
import { computeNonce } from './nonce.js'
import { InMemoryChallengeStore } from './challengeStore.js'
import type { ChallengeStore } from './challengeStore.js'
import type { Anychain402Config, PaymentRequirements } from './types.js'

/**
 * Shape of a facilitator's `POST /verify` response, per x402's
 * `VerifyResponseSchema`. Not imported from `x402/types` because we only
 * read two fields and never construct or validate a value against it — the
 * facilitator is Task 7's concern, this middleware just trusts its answer
 * (a network/HTTP-level failure is handled separately, see `callVerify`).
 */
interface VerifyResponse {
  isValid: boolean
  invalidReason?: string
  payer?: string
}

const DEFAULT_TIMEOUT_SECONDS = 300

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
 * would overwrite the first's cache entry — so the first payer's
 * subsequently-submitted payment, signed against a nonce derived from their
 * own `paymentId`, would be looked up against the *second* payer's
 * `paymentId` and (correctly) fail to match. Two users hitting one paid
 * endpoint is the ordinary case for an API, not a corner one; keying by
 * `resource` made this middleware reliable only at a concurrency of one.
 *
 * The fix: at challenge time, this middleware already knows exactly which
 * nonce a payer would have to sign to pay each issued `PaymentRequirements`
 * entry — `computeNonce(entry.extra.merchantEvm, entry.extra.paymentId)` —
 * so it stores one `ChallengeStore` entry per entry (one per accepted
 * chain), keyed by that nonce. On the payment path, the payer's own
 * `authorization.nonce` is an exact key into that store: no guessing via
 * `resource`, no collision between concurrent payers (different `paymentId`s
 * hash to different nonces), and a nonce with no matching entry means
 * exactly one thing — "no such outstanding challenge" — rather than
 * "someone else's challenge overwrote yours."
 *
 * A payment that arrives with an unrecognized nonce (never issued, already
 * expired) fails closed: `402` with a *freshly* issued challenge and
 * `error: 'payment_expired'`, without ever calling the facilitator.
 *
 * KNOWN LIMITATIONS (accepted for this task's slice, see the task-6 report):
 * - The default `InMemoryChallengeStore` is in-memory and per process. It
 *   does not survive a restart and is not shared across horizontally-scaled
 *   instances — a payment routed to a different instance than the one that
 *   issued its challenge is (correctly, if unhelpfully) told its challenge
 *   expired. Pass `{ store }` with a shared implementation (Redis, a
 *   database) to fix this; `anychain402`'s signature does not need to
 *   change.
 * - This function only calls `/verify`, never `/settle`. Preventing the same
 *   verified-but-unsettled payload from being replayed against `/verify`
 *   twice is explicitly out of scope here — the `Escrow` contract's
 *   single-use nonce is the actual double-spend defense at settlement time.
 * - A malformed or schema-invalid `X-PAYMENT` cannot be correlated to any
 *   outstanding challenge (there is no nonce to look up yet), so it is
 *   answered with a freshly-minted challenge rather than the one — if any —
 *   the payer actually intended to pay against. This is unavoidable without
 *   also authenticating challenge issuance, which is out of scope here; see
 *   the report for the (pre-existing, not newly introduced) resource
 *   implication of minting on every such attempt.
 */
export function anychain402(config: Anychain402Config, options: Anychain402Options = {}): RequestHandler {
  const store = options.store ?? new InMemoryChallengeStore()

  async function issueChallenge(resource: string): Promise<PaymentRequirements[]> {
    const requirements = buildRequirements(config, resource)
    const maxTimeoutSeconds = requirements[0]?.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    const expiresAt = Date.now() + maxTimeoutSeconds * 1000
    await Promise.all(
      requirements.map((requirement) => {
        const nonce = computeNonce(
          requirement.extra?.merchantEvm as `0x${string}`,
          requirement.extra?.paymentId as `0x${string}`,
        )
        return store.set(nonce, { requirement, accepts: requirements, expiresAt })
      }),
    )
    return requirements
  }

  function send402(res: Response, accepts: PaymentRequirements[], error?: string): void {
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
      })
      if (!verifyRes.ok) return { networkError: true }
      return (await verifyRes.json()) as VerifyResponse
    } catch {
      // Facilitator unreachable, timed out, or returned unparseable JSON.
      // Never let this reject the request handler — a down facilitator must
      // fail the payment cleanly, not crash the route.
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
    const nonce = paymentPayload.payload.authorization.nonce as `0x${string}`

    const cached = await store.get(nonce)
    if (!cached) {
      send402(res, await issueChallenge(resource), 'payment_expired')
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

    const verdict = await callVerify(paymentPayload, cached.requirement)
    if ('networkError' in verdict) {
      send402(res, cached.accepts, 'unexpected_verify_error')
      return
    }

    if (!verdict.isValid) {
      send402(res, cached.accepts, verdict.invalidReason ?? 'invalid_payment')
      return
    }

    // Never log `paymentPayload` (carries the payer's signature) or the raw
    // X-PAYMENT header anywhere on this path — see the task-6 judgement
    // notes. res.locals is request-scoped app state, not a log sink.
    res.locals.x402 = { payload: paymentPayload, requirements: cached.requirement, payer: verdict.payer }
    next()
  }
}
