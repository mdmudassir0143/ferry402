import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Address, Hex } from 'viem'
import { computeNonce } from '@anychain402/sdk'
import { createFacilitatorApp } from '../src/server.js'
import {
  startAnvilWithDomainToken,
  startAnvilWithEscrow,
  ANVIL_DEPLOYER_PRIVATE_KEY,
  ANVIL_PAYER_PRIVATE_KEY,
  ANVIL_PAYER_ADDRESS,
  type AnvilFixture,
  type EscrowAnvilFixture,
} from './support/anvil.js'
import { ESCROW_ADDRESS, buildRequirements, buildPayload, signAuthorization, type AuthorizationFields } from './support/fixtures.js'

const MERCHANT_EVM: Address = '0x1111111111111111111111111111111111111111'
const PAYMENT_ID: Hex = '0x00000000000000000000000000000000000000000000000000000000000004d2'
const TOKEN_NAME = 'Server Test Token'
const TOKEN_VERSION = '3'

let anvil: AnvilFixture
let escrowAnvil: EscrowAnvilFixture

beforeAll(async () => {
  ;[anvil, escrowAnvil] = await Promise.all([
    startAnvilWithDomainToken({ name: TOKEN_NAME, version: TOKEN_VERSION }),
    startAnvilWithEscrow(),
  ])
}, 30_000)

afterAll(async () => {
  await Promise.all([anvil?.stop(), escrowAnvil?.stop()])
})

function authFields(overrides: Partial<AuthorizationFields> = {}): AuthorizationFields {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    from: ANVIL_PAYER_ADDRESS,
    to: ESCROW_ADDRESS,
    value: '1000000',
    validAfter: String(nowSeconds - 60),
    validBefore: String(nowSeconds + 300),
    nonce: computeNonce(MERCHANT_EVM, PAYMENT_ID),
    ...overrides,
  }
}

describe('POST /verify', () => {
  it('returns isValid: true for a well-formed, correctly signed payload', async () => {
    // Without this override, verifyPayment would default to base-sepolia's
    // real public RPC -- unreachable (or simply the wrong chain) for a
    // token that only exists on this test's local anvil instance.
    const app = createFacilitatorApp({ rpcUrls: { 'base-sepolia': anvil.rpcUrl } })
    const auth = authFields()
    const signature = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: anvil.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: anvil.chainId,
      authorization: auth,
    })
    const paymentPayload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const paymentRequirements = buildRequirements({
      asset: anvil.tokenAddress,
      extra: { merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID },
    })

    const res = await request(app).post('/verify').send({ paymentPayload, paymentRequirements })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ isValid: true, payer: ANVIL_PAYER_ADDRESS })
  })

  it('returns 400 with invalid_payload for a body that does not match VerifyRequestSchema', async () => {
    const app = createFacilitatorApp()
    const res = await request(app).post('/verify').send({ nonsense: true })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ isValid: false, invalidReason: 'invalid_payload' })
  })

  it('never crashes the process on a malformed authorization.value inside an otherwise well-shaped body', async () => {
    const app = createFacilitatorApp()
    const auth = authFields({ value: '1e30' })
    const paymentPayload = buildPayload({
      network: 'base-sepolia',
      signature: `0x${'ab'.repeat(65)}`,
      authorization: auth,
    })
    const paymentRequirements = buildRequirements({
      asset: anvil.tokenAddress,
      extra: { merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID },
    })

    const res = await request(app).post('/verify').send({ paymentPayload, paymentRequirements })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_value' })
  })

  // Task 7 regression: before `express.json({ limit: MAX_REQUEST_BODY_SIZE })`
  // plus the trailing error-handling middleware were added, a malformed JSON
  // body reached Express's own default error handler, which responds with an
  // HTML page containing a full stack trace and absolute filesystem paths --
  // never this module's `{isValid, invalidReason}` shape. That fix shipped in
  // task 7 (proven by manual probe at the time, per the task-7 report) but
  // was never covered by an automated test until now.
  it('returns JSON (not an HTML stack trace) for a malformed JSON body', async () => {
    const app = createFacilitatorApp()
    const res = await request(app)
      .post('/verify')
      .set('Content-Type', 'application/json')
      .send('{"paymentPayload": not-valid-json')

    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ isValid: false, invalidReason: 'invalid_payload' })
    // The information-leak half of the regression: the raw response text
    // must never contain the kind of markers Express's default HTML error
    // page carries (a stack trace, or the framework's own name).
    expect(res.text).not.toMatch(/<html/i)
    expect(res.text).not.toMatch(/Error:/)
  })

  // Same regression, for a body that exceeds MAX_REQUEST_BODY_SIZE (16kb) --
  // body-parser's own `PayloadTooLargeError` goes through the identical
  // error-handling middleware, and pre-fix would hit the same HTML-leak bug.
  it('returns JSON (not an HTML stack trace) for a body over the size limit', async () => {
    const app = createFacilitatorApp()
    const oversized = 'a'.repeat(20_000)
    const res = await request(app)
      .post('/verify')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ paymentPayload: oversized }))

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ isValid: false, invalidReason: 'invalid_payload' })
    expect(res.text).not.toMatch(/<html/i)
  })
})

describe('POST /settle', () => {
  function merchantEvm(seed: number): Address {
    return `0x${seed.toString(16).padStart(40, '0')}` as Address
  }

  it('settles a well-formed, correctly signed payload and credits the merchant on-chain', async () => {
    const app = createFacilitatorApp({
      rpcUrls: { 'base-sepolia': escrowAnvil.rpcUrl },
      facilitatorPrivateKey: ANVIL_DEPLOYER_PRIVATE_KEY,
    })
    const merchant = merchantEvm(0xaaaa)
    const paymentId = PAYMENT_ID
    const nowSeconds = Math.floor(Date.now() / 1000)
    const auth: AuthorizationFields = {
      from: ANVIL_PAYER_ADDRESS,
      to: escrowAnvil.escrowAddress,
      value: '10000',
      validAfter: String(nowSeconds - 60),
      validBefore: String(nowSeconds + 300),
      nonce: computeNonce(merchant, paymentId),
    }
    const signature = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: escrowAnvil.tokenAddress,
      tokenName: 'SettleToken',
      tokenVersion: '1',
      chainId: escrowAnvil.chainId,
      authorization: auth,
    })
    const paymentPayload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const paymentRequirements = buildRequirements({
      asset: escrowAnvil.tokenAddress,
      payTo: escrowAnvil.escrowAddress,
      maxAmountRequired: '10000',
      extra: { merchantEvm: merchant, paymentId },
    })

    const res = await request(app).post('/settle').send({ paymentPayload, paymentRequirements })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.payer).toBe(ANVIL_PAYER_ADDRESS)
    expect(res.body.network).toBe('base-sepolia')
    expect(res.body.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })

  it('returns 400 with success:false for a body that does not match SettleRequestSchema', async () => {
    const app = createFacilitatorApp()
    const res = await request(app).post('/settle').send({ nonsense: true })

    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.errorReason).toBe('invalid_payload')
  })

  // Same Task 7 regression as /verify's, proven separately here because
  // `/settle`'s error response has a DIFFERENT shape (`success`/`transaction`/
  // `network`, not `isValid`) -- the shared error-handling middleware branches
  // on `req.path` specifically so this route doesn't get /verify's shape.
  it('returns JSON (not an HTML stack trace) for a malformed JSON body', async () => {
    const app = createFacilitatorApp()
    const res = await request(app)
      .post('/settle')
      .set('Content-Type', 'application/json')
      .send('{"paymentPayload": not-valid-json')

    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ success: false, errorReason: 'invalid_payload', transaction: '', network: '' })
    expect(res.text).not.toMatch(/<html/i)
  })
})
