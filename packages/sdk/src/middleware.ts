import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { PaymentPayloadSchema } from 'x402/types'
import type { PaymentPayload } from 'x402/types'
import { buildRequirements } from './requirements.js'
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

interface CachedChallenge {
  requirements: PaymentRequirements[]
  expiresAt: number
}

/**
 * Upper bound on concurrently-outstanding challenges one middleware instance
 * will remember. `resource` (the cache key) includes the request's query
 * string, so without a cap a client could grow this map without bound by
 * hitting the protected route with distinct query strings. Oldest entry is
 * evicted first (insertion order) once the cap is hit.
 */
const MAX_TRACKED_CHALLENGES = 10_000

const DEFAULT_TIMEOUT_SECONDS = 300

/**
 * Express middleware that turns any route into an x402-payable one, across
 * every chain in `config.accept`, settling into a per-chain non-custodial
 * `Escrow`.
 *
 * ## The paymentId round trip
 *
 * `buildRequirements` (Task 5) mints a fresh, random `paymentId` on *every*
 * call — see its doc comment. The payer is expected to derive the EIP-3009
 * authorization `nonce` it signs as
 * `keccak256(abi.encode(merchantEvm, paymentId))`
 * (see `Escrow.settleAuthorization`'s doc comment in `packages/contracts`),
 * using the `paymentId` and `merchantEvm` published in the 402 challenge's
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
 * The fix: generate the challenge's `PaymentRequirements[]` exactly once,
 * cache it (keyed by `resource`, the same absolute-URL string
 * `buildRequirements` embeds as `resource`/`description`) for
 * `maxTimeoutSeconds`, and reuse that cached array — same `paymentId` and
 * all — when a payment for that same resource arrives instead of rebuilding
 * it. A payment that arrives with no matching cached challenge (never
 * issued, or the challenge's window lapsed) cannot possibly correspond to
 * anything the payer could have signed against, so it fails closed: `402`
 * with a *freshly* issued challenge and `error: 'payment_expired'`, without
 * ever calling the facilitator.
 *
 * KNOWN LIMITATIONS (accepted for this task's slice, see the task-6 report):
 * - The cache is in-memory and per middleware instance/process. It does not
 *   survive a restart and is not shared across horizontally-scaled
 *   instances behind a load balancer — a payment routed to a different
 *   instance than the one that issued its challenge is (correctly, if
 *   unhelpfully) told its challenge expired. A shared store (Redis, etc.)
 *   can replace this Map later without changing this function's signature.
 * - Two concurrent challenges for the *identical* `resource` string within
 *   the same TTL window overwrite one another (last write wins) — the
 *   earlier caller's `paymentId` is lost. This is a deliberate
 *   single-slot-per-resource trade-off: the failure mode is "re-request a
 *   challenge," not an incorrect payment being accepted.
 * - This function only calls `/verify`, never `/settle`. Preventing the same
 *   verified-but-unsettled payload from being replayed against `/verify`
 *   twice is explicitly out of scope here — the `Escrow` contract's
 *   single-use nonce is the actual double-spend defense at settlement time.
 */
export function anychain402(config: Anychain402Config): RequestHandler {
  const challenges = new Map<string, CachedChallenge>()

  function pruneExpired(now: number): void {
    for (const [key, entry] of challenges) {
      if (entry.expiresAt <= now) challenges.delete(key)
    }
  }

  function issueChallenge(resource: string): PaymentRequirements[] {
    const requirements = buildRequirements(config, resource)
    const maxTimeoutSeconds = requirements[0]?.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    const now = Date.now()
    pruneExpired(now)
    if (challenges.size >= MAX_TRACKED_CHALLENGES) {
      const oldestKey = challenges.keys().next().value
      if (oldestKey !== undefined) challenges.delete(oldestKey)
    }
    challenges.set(resource, { requirements, expiresAt: now + maxTimeoutSeconds * 1000 })
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
      send402(res, issueChallenge(resource))
      return
    }

    const cached = challenges.get(resource)
    if (!cached || cached.expiresAt <= Date.now()) {
      challenges.delete(resource)
      send402(res, issueChallenge(resource), 'payment_expired')
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
      send402(res, cached.requirements, 'invalid_payload')
      return
    }

    // Parsed against x402's own PaymentPayloadSchema, not a hand-rolled
    // shape check — see the task-6 corrections this implements.
    const parsed = PaymentPayloadSchema.safeParse(decoded)
    if (!parsed.success) {
      send402(res, cached.requirements, 'invalid_payload')
      return
    }
    const paymentPayload = parsed.data

    const selected = cached.requirements.find((r) => r.network === paymentPayload.network)
    if (!selected) {
      send402(res, cached.requirements, 'invalid_network')
      return
    }

    const verdict = await callVerify(paymentPayload, selected)
    if ('networkError' in verdict) {
      send402(res, cached.requirements, 'unexpected_verify_error')
      return
    }

    if (!verdict.isValid) {
      send402(res, cached.requirements, verdict.invalidReason ?? 'invalid_payment')
      return
    }

    // Never log `paymentPayload` (carries the payer's signature) or the raw
    // X-PAYMENT header anywhere on this path — see the task-6 judgement
    // notes. res.locals is request-scoped app state, not a log sink.
    res.locals.x402 = { payload: paymentPayload, requirements: selected, payer: verdict.payer }
    next()
  }
}
