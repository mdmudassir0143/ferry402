import { describe, it, expect, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Server } from 'node:http'
import { anychain402 } from '../src/index.js'
import { computeNonce } from '../src/nonce.js'
import type { Anychain402Config, PaymentRequirements } from '../src/types.js'

// Reused verbatim from Task 5's requirements.test.ts fixture (per the
// controller's ruling: T6 reuses T5's config fixture rather than inventing a
// second one), extended with the fields buildRequirements needs.
const config: Anychain402Config = {
  price: '$0.01',
  accept: ['base-sepolia', 'polygon-amoy'],
  settleTo: 'hedera',
  merchant: '0.0.123456',
  merchantEvm: {
    base: '0x3333333333333333333333333333333333333d',
    'base-sepolia': '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
    polygon: '0x4444444444444444444444444444444444444e',
    'polygon-amoy': '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb',
  },
  facilitator: 'http://localhost:4000',
  escrows: {
    base: '0x0000000000000000000000000000000000000000',
    'base-sepolia': '0x1111111111111111111111111111111111111111',
    polygon: '0x0000000000000000000000000000000000000000',
    'polygon-amoy': '0x2222222222222222222222222222222222222222',
  },
  assets: {
    base: '0x0000000000000000000000000000000000000000',
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    polygon: '0x0000000000000000000000000000000000000000',
    'polygon-amoy': '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  },
}

/**
 * A well-formed x402 PaymentPayload (PaymentPayloadSchema, exact-evm variant)
 * for the given network. Field shapes verified directly against the
 * installed x402@1.2.0 package's zod schema (chunk-V3RMM5AE.mjs):
 *   - from/to: /^0x[0-9a-fA-F]{40}$/
 *   - value/validAfter/validBefore: numeric strings (Number.isInteger)
 *   - nonce: /^0x[0-9a-fA-F]{64}$/
 *   - signature: /^0x[0-9a-fA-F]+$/
 */
function makePayload(network: 'base-sepolia' | 'polygon-amoy', nonce: string) {
  return {
    x402Version: 1,
    scheme: 'exact' as const,
    network,
    payload: {
      signature: `0x${'ab'.repeat(65)}`,
      authorization: {
        from: '0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc',
        to: config.escrows[network],
        value: '10000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce,
      },
    },
  }
}

/**
 * The real nonce a payer would sign for a given issued `PaymentRequirements`
 * entry: `computeNonce(entry.extra.merchantEvm, entry.extra.paymentId)`. The
 * middleware's challenge store is keyed by exactly this value (not the bare
 * `paymentId`), so every test that pays against a real challenge must derive
 * its `X-PAYMENT` nonce this way rather than reusing `extra.paymentId`
 * directly.
 */
function nonceFor(requirement: PaymentRequirements): `0x${string}` {
  return computeNonce(requirement.extra?.merchantEvm, requirement.extra?.paymentId)
}

// A well-formed nonce that was never issued by any challenge in the test -
// i.e. it does not equal computeNonce(merchantEvm, paymentId) for anything
// anychain402 actually generated.
const UNKNOWN_NONCE = `0x${'11'.repeat(32)}` as const

function toHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

// supertest wraps a bare Express *function* in a brand-new http.Server (on a
// brand-new ephemeral port) every single time `request(app)` is called - see
// supertest's Test constructor. Two sequential `request(app).get(...)` calls
// against "the same app" therefore hit two DIFFERENT ports, so the request's
// Host header (and thus `resource`) differs between a challenge and its
// follow-up payment. Real deployments don't have this problem (one process,
// one host); the fix here is purely a test-fixture concern: listen once per
// test and reuse that one server/port for every request in the round trip,
// exactly like a real client would.
const servers: Server[] = []

function buildApp(): Server {
  const app = express()
  app.use('/premium', anychain402(config))
  app.get('/premium', (_req, res) => res.json({ ok: true }))
  const server = app.listen(0)
  servers.push(server)
  return server
}

function appWith(verifyResult: unknown): Server {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(verifyResult), { status: 200 })) as any
  return buildApp()
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) server.close()
})

describe('anychain402 middleware', () => {
  it('returns 402 with an accepts array when no payment is present', async () => {
    const res = await request(appWith({})).get('/premium')
    expect(res.status).toBe(402)
    expect(res.body.accepts).toHaveLength(2)
    expect(res.body.x402Version).toBe(1)
  })

  it('serves the route when the facilitator says the payment is valid', async () => {
    // A real 20-byte address, not a placeholder like '0xabc' - x402's
    // VerifyResponseSchema validates `payer` against EvmAddressRegex
    // (/^0x[0-9a-fA-F]{40}$/), so a short/invalid one fails the "parse,
    // don't hand-roll" check middleware.ts now applies to /verify responses
    // and would misreport as `unexpected_verify_error` here.
    const server = appWith({ isValid: true, payer: '0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc' })
    const challengeRes = await request(server).get('/premium')
    const requirement = challengeRes.body.accepts[0] as PaymentRequirements
    const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

    const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('returns 402 with the reason when verification fails', async () => {
    const server = appWith({ isValid: false, invalidReason: 'insufficient_funds' })
    const challengeRes = await request(server).get('/premium')
    const requirement = challengeRes.body.accepts[0] as PaymentRequirements
    const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

    const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
    expect(res.status).toBe(402)
    expect(res.body.error).toBe('insufficient_funds')
    expect(res.body.accepts).toHaveLength(2)
  })

  describe('the paymentId round trip (correction 3)', () => {
    it('sends the facilitator the SAME paymentId the 402 challenge issued, not a freshly generated one', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const issuedRequirements: PaymentRequirements[] = challengeRes.body.accepts
      const requirement = issuedRequirements[0]
      const issuedPaymentId = requirement.extra?.paymentId
      expect(issuedPaymentId).toBeTruthy()

      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      const sentBody = JSON.parse(init.body as string)
      expect(sentBody.paymentRequirements.extra.paymentId).toBe(issuedPaymentId)
      // Guards the regression directly: two independent calls to
      // buildRequirements never produce the same id, so if the middleware had
      // re-derived requirements on the payment path (the brief's bug) this id
      // could not possibly equal what the challenge handed out.
    })

    it('never issues the same paymentId across two independent challenges', async () => {
      const server = appWith({})
      const first = await request(server).get('/premium')
      const second = await request(server).get('/premium')
      expect(first.body.accepts[0].extra.paymentId).not.toBe(second.body.accepts[0].extra.paymentId)
    })

    it('rejects a payment against a well-formed but never-issued nonce, without calling the facilitator', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      // No prior GET /premium against this server -> UNKNOWN_NONCE cannot be
      // in the store under any key.
      const payload = makePayload('base-sepolia', UNKNOWN_NONCE)
      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))

      expect(res.status).toBe(402)
      expect(res.body.accepts).toHaveLength(2)
      expect(res.body.error).toBe('payment_expired')
      // Must fail closed locally, without ever asking the facilitator to
      // verify a payload that cannot possibly match anything we issued.
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('a challenge past its maxTimeoutSeconds is treated as unknown (TTL expiry), not a crash', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      // Fast-forward past the 300s default maxTimeoutSeconds by mocking
      // Date.now (not vi.useFakeTimers, which would also stub setTimeout and
      // risk interfering with supertest/Express's own use of real timers).
      const realNow = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 301_000)

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('payment_expired')
      expect(res.body.accepts).toHaveLength(2)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('concurrency (nonce-keyed store, not resource-keyed)', () => {
    it('honors the FIRST of two outstanding challenges for the same resource when it is the one paid', async () => {
      // Regression barrier for the resource-keyed design: two challenges for
      // the identical resource string used to share one cache slot, so the
      // second challenge silently evicted the first's paymentId. This test
      // deterministically demonstrates two outstanding challenges for one
      // resource (issued back to back, both still live) and pays the FIRST
      // one - the ordinary "two users hit one endpoint" case, not a
      // contrived race. Confirmed (see the task-6 report) to FAIL against
      // the prior resource-keyed implementation: paying challenge A there
      // sends challenge B's paymentId to the facilitator instead of A's.
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeA = await request(server).get('/premium')
      const challengeB = await request(server).get('/premium')
      const requirementA = challengeA.body.accepts[0] as PaymentRequirements
      const requirementB = challengeB.body.accepts[0] as PaymentRequirements
      expect(requirementA.extra?.paymentId).not.toBe(requirementB.extra?.paymentId)

      const payload = makePayload(requirementA.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirementA))
      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      const sentBody = JSON.parse(init.body as string)
      expect(sentBody.paymentRequirements.extra.paymentId).toBe(requirementA.extra?.paymentId)
    })

    it('also honors the SECOND of two outstanding challenges for the same resource, independently of the first', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      await request(server).get('/premium')
      const challengeB = await request(server).get('/premium')
      const requirementB = challengeB.body.accepts[0] as PaymentRequirements

      const payload = makePayload(requirementB.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirementB))
      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))

      expect(res.status).toBe(200)
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      const sentBody = JSON.parse(init.body as string)
      expect(sentBody.paymentRequirements.extra.paymentId).toBe(requirementB.extra?.paymentId)
    })
  })

  describe('replay protection (review C1: a consumed challenge must not grant unlimited service)', () => {
    it('serves the route once, then rejects the identical X-PAYMENT header replayed a second time', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      const header = toHeader(payload)

      const first = await request(server).get('/premium').set('X-PAYMENT', header)
      expect(first.status).toBe(200)
      expect(first.body).toEqual({ ok: true })

      // Same header, byte for byte - a bearer credential replay, not a new
      // payment. Must not buy a second response even though the facilitator
      // would (per this mock) happily say isValid: true again.
      const second = await request(server).get('/premium').set('X-PAYMENT', header)
      expect(second.status).toBe(402)
      expect(second.body.error).toBe('payment_expired')
      expect(second.body.accepts).toHaveLength(2)

      // The replay was rejected locally, from the now-consumed challenge
      // store - it never reached the facilitator a second time.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('reinstates the challenge (does not burn it) when the facilitator rejects the payment', async () => {
      // Consuming happens optimistically, before the verdict is known. A
      // rejected (not merely replayed) payment must not permanently destroy
      // the challenge - nothing was collected, so the payer gets to correct
      // their signature and retry with the SAME nonce within the TTL.
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ isValid: false, invalidReason: 'insufficient_funds' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      const header = toHeader(payload)

      const rejected = await request(server).get('/premium').set('X-PAYMENT', header)
      expect(rejected.status).toBe(402)
      expect(rejected.body.error).toBe('insufficient_funds')

      const retried = await request(server).get('/premium').set('X-PAYMENT', header)
      expect(retried.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('resource binding (review C2: a challenge for one resource must not pay for another)', () => {
    it('rejects a challenge presented at a different resource than it was issued for', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium?id=1')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      // Same nonce, same everything - just a different resource string
      // (`resource` includes the query string). The reviewer's probe used
      // two distinct routes under one router mount; a differing query
      // string reproduces the identical class of bug against a single route.
      const res = await request(server).get('/premium?id=999').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_payment_requirements')
      expect(res.body.accepts).toHaveLength(2)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('still honors the SAME challenge when presented back at the SAME resource it was issued for', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium?id=1')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      const res = await request(server).get('/premium?id=1').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('nonce casing (review I1: x402 permits mixed-case hex; bytes32 has no casing on-chain)', () => {
    it('accepts a payment whose authorization.nonce is presented in uppercase hex', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const canonicalNonce = nonceFor(requirement)
      const uppercaseNonce = (`0x${canonicalNonce.slice(2).toUpperCase()}`) as `0x${string}`
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', uppercaseNonce)

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      // And the store key genuinely normalized rather than coincidentally
      // matching: the /verify body still carries the original (lowercase)
      // paymentId the challenge issued.
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      const sentBody = JSON.parse(init.body as string)
      expect(sentBody.paymentRequirements.extra.paymentId).toBe(requirement.extra?.paymentId)
    })
  })

  describe('local floor checks (review I2: do not delegate everything to the facilitator)', () => {
    it('rejects an authorization whose value is below maxAmountRequired', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      payload.payload.authorization.value = '1' // maxAmountRequired is '10000'

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_exact_evm_payload_authorization_value')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('rejects an authorization paying an address other than the required payTo', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      payload.payload.authorization.to = '0xdEaDdEaDdEaDdEaDdEaDdEaDdEaDdEaDdEaDdEaD' // not the Escrow

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_exact_evm_payload_recipient_mismatch')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('rejects an authorization that has already expired (validBefore in the past)', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      payload.payload.authorization.validBefore = '1'

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_exact_evm_payload_authorization_valid_before')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('rejects an authorization that is not valid yet (validAfter in the future)', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      payload.payload.authorization.validAfter = '9999999999'

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_exact_evm_payload_authorization_valid_after')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('still accepts a well-formed authorization that pays MORE than maxAmountRequired', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      payload.payload.authorization.value = '20000' // more than the required 10000

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('malformed input handling', () => {
    it('returns 402 (not a thrown error) for a non-base64, non-JSON X-PAYMENT header', async () => {
      const server = appWith({})
      await request(server).get('/premium') // seed a cached challenge
      const res = await request(server).get('/premium').set('X-PAYMENT', '%%%not-valid-base64-or-json%%%')
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_payload')
      expect(res.body.accepts).toHaveLength(2)
    })

    it('returns 402 for well-formed JSON that fails the x402 PaymentPayloadSchema', async () => {
      const server = appWith({})
      await request(server).get('/premium')
      const res = await request(server)
        .get('/premium')
        .set('X-PAYMENT', toHeader({ hello: 'world' }))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_payload')
    })

    it('returns 402 invalid_network when a real nonce is presented with a mismatched outer network', async () => {
      const server = appWith({})
      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements // base-sepolia
      // The nonce is only valid for base-sepolia (it is derived from
      // base-sepolia's merchantEvm+paymentId); claiming 'base' in the outer
      // envelope must be rejected even though 'base' is a real SupportedChain.
      const payload = { ...makePayload('base-sepolia', nonceFor(requirement)), network: 'base' }
      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_network')
    })
  })

  describe('facilitator failure handling', () => {
    it('returns a clean 402 (not an unhandled rejection) when the facilitator is unreachable', async () => {
      const fetchSpy = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.accepts).toHaveLength(2)
      expect(res.body.error).toBe('unexpected_verify_error')
      // Pins that this genuinely exercised the facilitator-error path rather
      // than short-circuiting on payment_expired before ever reaching fetch
      // (the bug that silently made the pre-fix version of these two tests
      // pass for the wrong reason - see the task-6 report).
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('returns a clean 402 when the facilitator responds with a non-2xx status', async () => {
      const fetchSpy = vi.fn(async () => new Response('internal error', { status: 500 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.accepts).toHaveLength(2)
      expect(res.body.error).toBe('unexpected_verify_error')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })
})
