import { describe, it, expect, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Request, Response, NextFunction } from 'express'
import type { Server } from 'node:http'
import { ferry402 } from '../src/index.js'
import { computeNonce } from '../src/nonce.js'
import { MIN_SECRET_BYTES, TIME_BUCKET_SECONDS, timeBucket } from '../src/challengeDerivation.js'
import type { ConsumedNonceStore } from '../src/challengeStore.js'
import { InMemoryConsumedNonceStore } from '../src/challengeStore.js'
import type { Ferry402Config, PaymentRequirements } from '../src/types.js'

// 32 bytes exactly (MIN_SECRET_BYTES) - the boundary this fixture must
// satisfy for every "happy path" test in this file.
const SECRET = 's'.repeat(MIN_SECRET_BYTES)

// Reused verbatim from Task 5's requirements.test.ts fixture, extended with
// the fields buildRequirements needs, plus Task 12's `secret`.
const config: Ferry402Config = {
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
  secret: SECRET,
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
 * entry: `computeNonce(entry.extra.merchantEvm, entry.extra.paymentId)`. This
 * is unchanged by Task 12 — only HOW `paymentId` is produced changed (derived
 * instead of random); the nonce formula itself (`nonce.ts`) is untouched.
 */
function nonceFor(requirement: PaymentRequirements): `0x${string}` {
  return computeNonce(requirement.extra?.merchantEvm, requirement.extra?.paymentId)
}

// A well-formed nonce that cannot correspond to any valid derivation for
// anything ferry402 would actually compute (garbage, not a real HMAC output).
const UNKNOWN_NONCE = `0x${'11'.repeat(32)}` as const

function toHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

// supertest wraps a bare Express *function* in a brand-new http.Server (on a
// brand-new ephemeral port) every single time `request(app)` is called - two
// sequential `request(app).get(...)` calls therefore hit two DIFFERENT ports,
// so the request's Host header (and thus `resource`) differs between a
// challenge and its follow-up payment unless the SAME listening server is
// reused. The fix is a test-fixture concern only: listen once per test and
// reuse that one server/port for every request in the round trip.
const servers: Server[] = []

function buildApp(cfg: Ferry402Config = config, options?: Parameters<typeof ferry402>[1]): Server {
  const app = express()
  app.use('/premium', ferry402(cfg, options))
  app.get('/premium', (_req, res) => res.json({ ok: true }))
  const server = app.listen(0)
  servers.push(server)
  return server
}

function appWith(verifyResult: unknown): Server {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(verifyResult), { status: 200 })) as any
  return buildApp()
}

/**
 * A minimal fake Express `Request`/`Response` pair for driving a `ferry402`
 * `RequestHandler` DIRECTLY, bypassing Express/HTTP/supertest entirely. Used
 * where the volume (10,000 iterations) or precision (two isolated middleware
 * instances that must see the IDENTICAL `resource` string with no port
 * artifact from two separately-`listen()`ed servers) makes a real HTTP round
 * trip either too slow or actively the wrong tool.
 */
function fakeGetReq(resource: string, xPaymentHeader?: string): Request {
  const url = new URL(resource)
  return {
    protocol: url.protocol.slice(0, -1),
    get: (name: string) => (name.toLowerCase() === 'host' ? url.host : undefined),
    originalUrl: url.pathname + url.search,
    header: (name: string) => (name.toLowerCase() === 'x-payment' ? xPaymentHeader : undefined),
  } as unknown as Request
}

interface FakeRes {
  statusCode: number
  body: unknown
  headers: Record<string, string>
}

function fakeRes(): Response & FakeRes {
  const res: FakeRes & Partial<Response> = { statusCode: 0, body: undefined, headers: {} }
  res.set = ((name: string, value: string) => {
    res.headers[name] = value
    return res
  }) as unknown as Response['set']
  res.status = ((code: number) => {
    res.statusCode = code
    return res
  }) as unknown as Response['status']
  res.json = ((body: unknown) => {
    res.body = body
    return res
  }) as unknown as Response['json']
  res.locals = {}
  return res as unknown as Response & FakeRes
}

/**
 * The naive third-party `ConsumedNonceStore` an integrator might plug in via
 * `ferry402(config, { consumedNonceStore })` without having thought about
 * nonce casing at all — no internal lowercasing, unlike the default. Stands
 * in for the OLD `CaseSensitiveMapStore` extension-point test, retargeted at
 * Task 12's replacement seam.
 */
class CaseSensitiveMapConsumedNonceStore implements ConsumedNonceStore {
  private readonly entries = new Map<string, number>()

  async consumeIfAbsent(nonce: `0x${string}`, expiresAt: number): Promise<boolean> {
    if (this.entries.has(nonce)) return false
    this.entries.set(nonce, expiresAt)
    return true
  }

  async release(nonce: `0x${string}`): Promise<void> {
    this.entries.delete(nonce)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) server.close()
})

describe('ferry402 middleware', () => {
  it('returns 402 with an accepts array when no payment is present', async () => {
    const res = await request(appWith({})).get('/premium')
    expect(res.status).toBe(402)
    expect(res.body.accepts).toHaveLength(2)
    expect(res.body.x402Version).toBe(1)
  })

  it('sets Cache-Control: no-store on a 402 response (must never be cached by an intermediary)', async () => {
    const res = await request(appWith({})).get('/premium')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('serves the route when the facilitator says the payment is valid', async () => {
    // A real 20-byte address, not a placeholder like '0xabc' - x402's
    // VerifyResponseSchema validates `payer` against EvmAddressRegex.
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

  describe('secret validation (Task 12: throw at construction, never silently generate)', () => {
    it('throws when config.secret is missing', () => {
      const { secret: _secret, ...rest } = config
      expect(() => ferry402(rest as Ferry402Config)).toThrow(/secret/i)
    })

    it('throws when config.secret is undefined', () => {
      expect(() => ferry402({ ...config, secret: undefined as unknown as string })).toThrow(/secret/i)
    })

    it('throws when config.secret is an empty string', () => {
      expect(() => ferry402({ ...config, secret: '' })).toThrow(/secret/i)
    })

    it(`throws when config.secret is ${MIN_SECRET_BYTES - 1} bytes (one short of the minimum)`, () => {
      expect(() => ferry402({ ...config, secret: 'x'.repeat(MIN_SECRET_BYTES - 1) })).toThrow(
        new RegExp(String(MIN_SECRET_BYTES)),
      )
    })

    it(`does not throw when config.secret is exactly ${MIN_SECRET_BYTES} bytes`, () => {
      expect(() => ferry402({ ...config, secret: 'x'.repeat(MIN_SECRET_BYTES) })).not.toThrow()
    })

    it('never falls back to generating a random secret - two configs with no secret both throw identically, they do not silently diverge', () => {
      const { secret: _secret, ...rest } = config
      expect(() => ferry402(rest as Ferry402Config)).toThrow()
      expect(() => ferry402(rest as Ferry402Config)).toThrow()
    })
  })

  describe('Task 12: stateless challenge derivation - core properties', () => {
    it('10,000 anonymous requests write ZERO entries to the consumed-nonce store (the availability bug this task fixes)', async () => {
      const store = new InMemoryConsumedNonceStore()
      let consumeCalls = 0
      let releaseCalls = 0
      const spyStore: ConsumedNonceStore = {
        consumeIfAbsent: async (nonce, expiresAt) => {
          consumeCalls++
          return store.consumeIfAbsent(nonce, expiresAt)
        },
        release: async (nonce) => {
          releaseCalls++
          return store.release(nonce)
        },
      }
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy as any
      const handler = ferry402(config, { consumedNonceStore: spyStore })

      for (let i = 0; i < 10_000; i++) {
        const req = fakeGetReq(`https://api.test/premium?i=${i}`)
        const res = fakeRes()
        // eslint-disable-next-line no-await-in-loop
        await handler(req, res, (() => {}) as NextFunction)
        if (res.statusCode !== 402) throw new Error(`expected 402, got ${res.statusCode} at i=${i}`)
      }

      expect(consumeCalls).toBe(0)
      expect(releaseCalls).toBe(0)
      expect(store.size).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('a challenge for resource A is rejected at resource B, with no store involved (structural resource binding)', async () => {
      const store = new InMemoryConsumedNonceStore()
      let consumeCalls = 0
      const spyStore: ConsumedNonceStore = {
        consumeIfAbsent: async (nonce, expiresAt) => {
          consumeCalls++
          return store.consumeIfAbsent(nonce, expiresAt)
        },
        release: async (nonce) => store.release(nonce),
      }
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp(config, { consumedNonceStore: spyStore })

      const challengeA = await request(server).get('/premium?resource=A')
      const requirementA = challengeA.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirementA.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirementA))

      const res = await request(server).get('/premium?resource=B').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('payment_expired')
      expect(fetchSpy).not.toHaveBeenCalled()
      // The rejection happened before ever reaching the consume step - no
      // store lookup, no store write, for either resource.
      expect(consumeCalls).toBe(0)
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

    it('a payment at bucket boundary MINUS ONE (the "previous" bucket) still verifies', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      // An arbitrary, deterministic bucket boundary far from both epoch 0
      // and Date.now() - nothing in this test depends on real wall-clock
      // time at all, both requests use fully mocked Date.now() values.
      const boundaryMs = 5_000 * TIME_BUCKET_SECONDS * 1000

      vi.spyOn(Date, 'now').mockReturnValue(boundaryMs - 1000) // 1s before the boundary -> bucket B-1
      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      vi.spyOn(Date, 'now').mockReturnValue(boundaryMs + 500) // just after -> bucket B (current); B-1 is "previous"
      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('a payment derived TWO buckets in the past is rejected - the window is exactly current+previous, not unlimited', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const boundaryMs = 5_001 * TIME_BUCKET_SECONDS * 1000 // distinct boundary from the previous test

      vi.spyOn(Date, 'now').mockReturnValue(boundaryMs - 1000) // bucket B-1
      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      // bucket B+1 - two full buckets after B-1, so neither "current" (B+1)
      // nor "previous" (B) matches.
      vi.spyOn(Date, 'now').mockReturnValue(boundaryMs + TIME_BUCKET_SECONDS * 1000 + 500)
      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('payment_expired')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it("two INDEPENDENT middleware instances sharing a secret accept each other's challenges, with no shared store", async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any

      // Two entirely separate closures - separate InMemoryConsumedNonceStore
      // instances, no module-level state, no shared object of any kind.
      // Only `config.secret` is shared.
      const handlerA = ferry402(config)
      const handlerB = ferry402(config)

      const resource = 'https://api.test/premium'
      const challengeRes = fakeRes()
      await handlerA(fakeGetReq(resource), challengeRes, (() => {}) as NextFunction)
      expect(challengeRes.statusCode).toBe(402)
      const requirement = (challengeRes.body as { accepts: PaymentRequirements[] }).accepts[0]
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      let nextCalled = false
      const payRes = fakeRes()
      await handlerB(fakeGetReq(resource, toHeader(payload)), payRes, (() => {
        nextCalled = true
      }) as NextFunction)

      expect(nextCalled).toBe(true)
      expect(payRes.statusCode).toBe(0) // next() was called, never send402
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it("issues a DIFFERENT paymentId per accepted chain in the same 402 - paymentId's HMAC preimage includes merchantEvm, which differs per chain (a deliberate change from Task 6's single-shared-random-paymentId design)", async () => {
      const res = await request(appWith({})).get('/premium')
      const [baseSepolia, polygonAmoy] = res.body.accepts as PaymentRequirements[]
      expect(baseSepolia.extra?.paymentId).not.toBe(polygonAmoy.extra?.paymentId)
    })
  })

  describe('paymentId determinism (Task 12 supersedes Task 6\'s randomness guarantee)', () => {
    it('sends the facilitator the SAME paymentId the 402 challenge issued, not a re-derived one', async () => {
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
    })

    it('issues the SAME paymentId for two independent GETs of the identical resource within the same time bucket (determinism, not randomness, is the point of Task 12)', async () => {
      const server = appWith({})
      const first = await request(server).get('/premium')
      const second = await request(server).get('/premium')
      expect(first.body.accepts[0].extra.paymentId).toBe(second.body.accepts[0].extra.paymentId)
    })

    it('issues a DIFFERENT paymentId for a different resource (same instant, same chain)', async () => {
      const server = appWith({})
      const first = await request(server).get('/premium?id=1')
      const second = await request(server).get('/premium?id=2')
      expect(first.body.accepts[0].extra.paymentId).not.toBe(second.body.accepts[0].extra.paymentId)
    })

    it('rejects a payment against a well-formed but never-derivable nonce, without calling the facilitator', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const payload = makePayload('base-sepolia', UNKNOWN_NONCE)
      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))

      expect(res.status).toBe(402)
      expect(res.body.accepts).toHaveLength(2)
      expect(res.body.error).toBe('payment_expired')
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('replay protection (Task 6 C1, carried forward: a consumed nonce must not grant unlimited service)', () => {
    it('under two CONCURRENT identical requests, exactly ONE succeeds and the facilitator is called exactly once (atomic consume, not get-then-check-across-an-await)', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      const header = toHeader(payload)

      const [a, b] = await Promise.all([
        request(server).get('/premium').set('X-PAYMENT', header),
        request(server).get('/premium').set('X-PAYMENT', header),
      ])

      const statuses = [a.status, b.status].sort((x, y) => x - y)
      expect(statuses).toEqual([200, 402])
      // If consumption were a `get`/check followed by a separate `set` after
      // an await, BOTH concurrent callers could observe "not yet consumed"
      // before either records it - this pins that it cannot happen here.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

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
      // payment. Rejected atomically at the consumed-nonce check, BEFORE the
      // facilitator is ever called a second time.
      const second = await request(server).get('/premium').set('X-PAYMENT', header)
      expect(second.status).toBe(402)
      expect(second.body.error).toBe('payment_expired')
      expect(second.body.accepts).toHaveLength(2)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('releases the consumed nonce (does not permanently burn it) when the facilitator rejects the payment, so a corrected retry still succeeds', async () => {
      // Consuming happens optimistically, before the verdict is known. A
      // rejected (not merely replayed) payment must not permanently destroy
      // the nonce: since it is PUBLIC (derivable/readable by anyone from an
      // anonymous 402), failing to release it would let anyone permanently
      // deny the legitimate payer service for this resource's whole
      // derivation window with a single bogus-signature attempt.
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ isValid: false, invalidReason: 'insufficient_funds' }), { status: 200 }),
        )
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

    it('releases the nonce when the facilitator is unreachable too, not just on an explicit isValid:false', async () => {
      const fetchSpy = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      const header = toHeader(payload)

      const errored = await request(server).get('/premium').set('X-PAYMENT', header)
      expect(errored.status).toBe(402)
      expect(errored.body.error).toBe('unexpected_verify_error')

      const retried = await request(server).get('/premium').set('X-PAYMENT', header)
      expect(retried.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('normalizes the payer-supplied nonce even against a deliberately case-sensitive custom ConsumedNonceStore - a replay with DIFFERENT casing is still caught', async () => {
      // Proves the protection a CUSTOM store's users get comes from
      // `ferry402` itself normalizing before it ever calls the store, not
      // from any lowercasing the store might or might not do internally, and
      // not merely from Buffer's own case-insensitive hex decoding (which is
      // enough for `matchChallenge`'s byte comparison alone, but does
      // nothing for a STRING-keyed store that never sees normalized input).
      // A single accepted uppercase nonce would pass even without
      // normalization; the real test is that the SAME nonce, replayed under
      // a DIFFERENT casing, is still recognized as the SAME key.
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp(config, { consumedNonceStore: new CaseSensitiveMapConsumedNonceStore() })

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const canonicalNonce = nonceFor(requirement)
      const uppercaseNonce = (`0x${canonicalNonce.slice(2).toUpperCase()}`) as `0x${string}`

      const firstPayload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', canonicalNonce)
      const first = await request(server).get('/premium').set('X-PAYMENT', toHeader(firstPayload))
      expect(first.status).toBe(200)

      const secondPayload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', uppercaseNonce)
      const second = await request(server).get('/premium').set('X-PAYMENT', toHeader(secondPayload))
      expect(second.status).toBe(402)
      expect(second.body.error).toBe('payment_expired')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('resource binding (Task 6 C2, carried forward — now structural, see the "Task 12 core properties" block above for the no-store proof)', () => {
    it('rejects a challenge presented at a different resource than it was issued for', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium?id=1')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))

      // Same nonce, same everything - just a different resource string
      // (`resource` includes the query string). Task 6 reported this as
      // `invalid_payment_requirements` (an explicit lookup found a resource
      // mismatch); Task 12 reports it as `payment_expired` because there is
      // no longer a separate lookup to fail — the nonce simply never matches
      // the derivation for this resource in the first place.
      const res = await request(server).get('/premium?id=999').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('payment_expired')
      expect(res.body.accepts).toHaveLength(2)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('nonce casing (Task 6 I1, carried forward: x402 permits mixed-case hex; bytes32 has no casing on-chain)', () => {
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
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      const sentBody = JSON.parse(init.body as string)
      expect(sentBody.paymentRequirements.extra.paymentId).toBe(requirement.extra?.paymentId)
    })
  })

  describe('local floor checks (Task 6 I2, carried forward: do not delegate everything to the facilitator)', () => {
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

    it('returns a clean 402 (not a crash) for a value in exponent notation that BigInt cannot parse', async () => {
      // x402's own validator for `value` is Number.isInteger(Number(v)) &&
      // Number(v) >= 0 with a length cap of 18 chars - operating on the
      // Number() COERCION, not the string's shape. "1e30" passes that but
      // BigInt("1e30") throws a SyntaxError. No real payment is needed to
      // reach this: the 402 body publishes extra.merchantEvm, and `resource`
      // is whatever the attacker requested, so a matching nonce is fully
      // computable by anyone from public information (Task 6 review round
      // 3's Critical finding - still true, unchanged, under Task 12).
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      payload.payload.authorization.value = '1e30'

      const res = await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_exact_evm_payload_authorization_value')
      expect(res.body.accepts).toHaveLength(2)
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
      const res = await request(server).get('/premium').set('X-PAYMENT', '%%%not-valid-base64-or-json%%%')
      expect(res.status).toBe(402)
      expect(res.body.error).toBe('invalid_payload')
      expect(res.body.accepts).toHaveLength(2)
    })

    it('returns 402 for well-formed JSON that fails the x402 PaymentPayloadSchema', async () => {
      const server = appWith({})
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
      // 'base' is a real x402 network but is NOT in this merchant's
      // config.accept, so no PaymentRequirements entry (and no derivation)
      // exists for it at all - rejected before any HMAC is computed.
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

  describe('no logging of sensitive data (Task 6 judgement notes, carried forward)', () => {
    it('never logs anything during a full successful payment cycle', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const server = buildApp()

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))

      expect(logSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('never logs anything on a rejected/invalid payment attempt either', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const server = appWith({ isValid: false, invalidReason: 'insufficient_funds' })

      const challengeRes = await request(server).get('/premium')
      const requirement = challengeRes.body.accepts[0] as PaymentRequirements
      const payload = makePayload(requirement.network as 'base-sepolia' | 'polygon-amoy', nonceFor(requirement))
      await request(server).get('/premium').set('X-PAYMENT', toHeader(payload))

      expect(logSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})

// Sanity: `timeBucket` is re-exported and usable directly, matching the
// public surface `challengeDerivation.test.ts` exercises in depth.
describe('challengeDerivation re-export sanity', () => {
  it('timeBucket increments once per TIME_BUCKET_SECONDS', () => {
    const t0 = timeBucket(0)
    const t1 = timeBucket(TIME_BUCKET_SECONDS * 1000 - 1)
    const t2 = timeBucket(TIME_BUCKET_SECONDS * 1000)
    expect(t0).toBe(t1)
    expect(t2).toBe(t0 + 1)
  })
})
