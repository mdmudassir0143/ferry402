import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Address, Hex } from 'viem'
import { computeNonce } from '@anychain402/sdk'
import { verifyPayment } from '../src/chains/base.js'
import { startAnvilWithDomainToken, ANVIL_PAYER_PRIVATE_KEY, ANVIL_PAYER_ADDRESS, type AnvilFixture } from './support/anvil.js'
import { ESCROW_ADDRESS, buildRequirements, buildPayload, signAuthorization, type AuthorizationFields } from './support/fixtures.js'

/**
 * Covers task-7 review round 1's I2 (the domain `chainId` must come from the
 * declared network, not a live RPC call — and a misconfigured RPC must be
 * caught, not silently used) and I3 (the client/token-domain reads must be
 * cached, not repeated on every call). Both are given their own anvil
 * instances, isolated from `verify.test.ts`'s shared one, because both
 * deliberately construct non-standard configurations (a wrong chain id, an
 * anvil instance that gets stopped mid-test).
 */

const MERCHANT_EVM: Address = '0x1111111111111111111111111111111111111111'
const PAYMENT_ID: Hex = '0x00000000000000000000000000000000000000000000000000000000000004d2'
const TOKEN_NAME = 'Chain Config Test Token'
const TOKEN_VERSION = '1'

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

function requirementsFor(assetAddress: Address) {
  return buildRequirements({
    asset: assetAddress,
    extra: { merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID },
  })
}

describe('verifyPayment — chain id mismatch (I2)', () => {
  let mismatched: AnvilFixture

  // Deliberately NOT base-sepolia's declared chain id (84532) -- exactly the
  // "rpcUrls entry accidentally points base-sepolia at some other chain's
  // node" misconfiguration I2 is about.
  const WRONG_CHAIN_ID = 999999

  beforeAll(async () => {
    mismatched = await startAnvilWithDomainToken({ name: TOKEN_NAME, version: TOKEN_VERSION, chainId: WRONG_CHAIN_ID })
  }, 30_000)

  afterAll(async () => {
    await mismatched?.stop()
  })

  it('rejects with unexpected_verify_error rather than silently verifying against the wrong chain', async () => {
    // A legitimate payer would sign against base-sepolia's REAL declared id
    // (84532) -- what their wallet is told the network is -- regardless of
    // what an operator's misconfigured rpcUrls entry happens to point at.
    const auth = authFields()
    const signature = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: mismatched.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: 84532,
      authorization: auth,
    })

    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature, authorization: auth }),
      requirementsFor(mismatched.tokenAddress),
      { rpcUrl: mismatched.rpcUrl },
    )

    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('unexpected_verify_error')
  })
})

describe('verifyPayment — client/domain caching (I3)', () => {
  let anvil: AnvilFixture

  beforeAll(async () => {
    anvil = await startAnvilWithDomainToken({ name: TOKEN_NAME, version: TOKEN_VERSION })
  }, 30_000)

  it('keeps verifying successfully against a cached client/domain after the RPC becomes unreachable', async () => {
    // Warm-up call: real RPC traffic (client construction + chain-id check +
    // name()/version() reads) all happen here.
    const auth1 = authFields()
    const signature1 = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: anvil.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: anvil.chainId,
      authorization: auth1,
    })
    const warmup = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: signature1, authorization: auth1 }),
      requirementsFor(anvil.tokenAddress),
      { rpcUrl: anvil.rpcUrl },
    )
    expect(warmup.isValid).toBe(true)

    // Kill the RPC entirely. If the second call below needed a fresh
    // eth_chainId or name()/version() read -- rather than reusing the
    // memoized client-verification result and token domain from the
    // warm-up call -- it would now fail (connection refused), not merely
    // run slowly.
    await anvil.stop()

    const auth2 = authFields({ value: '2000000' })
    const signature2 = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: anvil.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: anvil.chainId,
      authorization: auth2,
    })
    const afterRpcDied = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: signature2, authorization: auth2 }),
      requirementsFor(anvil.tokenAddress),
      { rpcUrl: anvil.rpcUrl },
    )
    expect(afterRpcDied.isValid).toBe(true)
    expect(afterRpcDied.payer).toBe(ANVIL_PAYER_ADDRESS)
  })
})
