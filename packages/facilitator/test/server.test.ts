import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Address, Hex } from 'viem'
import { computeNonce } from '@anychain402/sdk'
import { createFacilitatorApp } from '../src/server.js'
import { startAnvilWithDomainToken, ANVIL_PAYER_PRIVATE_KEY, ANVIL_PAYER_ADDRESS, type AnvilFixture } from './support/anvil.js'
import { ESCROW_ADDRESS, buildRequirements, buildPayload, signAuthorization, type AuthorizationFields } from './support/fixtures.js'

const MERCHANT_EVM: Address = '0x1111111111111111111111111111111111111111'
const PAYMENT_ID: Hex = '0x00000000000000000000000000000000000000000000000000000000000004d2'
const TOKEN_NAME = 'Server Test Token'
const TOKEN_VERSION = '3'

let anvil: AnvilFixture

beforeAll(async () => {
  anvil = await startAnvilWithDomainToken({ name: TOKEN_NAME, version: TOKEN_VERSION })
}, 30_000)

afterAll(async () => {
  await anvil?.stop()
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
})
