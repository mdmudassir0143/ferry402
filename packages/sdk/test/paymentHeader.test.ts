import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import type { PaymentRequirements } from 'x402/types'
import { createPaymentHeader } from '../src/paymentHeader.js'
import { computeNonce } from '../src/nonce.js'

/**
 * I5 (publish-blocking, final review): proves `createPaymentHeader`
 * produces a header a REAL EIP-712 verifier (viem's own
 * `recoverTypedDataAddress` — independent of this package, the same
 * recovery primitive `packages/facilitator` uses against real USDC) accepts
 * as signed by the payer, over the derived (not random) nonce.
 *
 * `viem` here is a devDependency only (see `package.json`) — this package
 * ships no runtime dependency on it; a consumer supplies any object
 * satisfying `EIP3009Signer`, and a viem `PrivateKeyAccount` is simply the
 * easiest one to construct in a test.
 */

const PAYER_PRIVATE_KEY = '0x6b1c368c7edf818892aab37a05945f4efe320569e8c2869f12644def09490e52'
const MERCHANT_EVM = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as const
const PAYMENT_ID = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const ESCROW = '0x1111111111111111111111111111111111111111' as const

function buildRequirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    resource: 'https://example.test/paid-resource',
    description: 'a paid resource',
    mimeType: 'application/json',
    payTo: ESCROW,
    maxTimeoutSeconds: 300,
    asset: ASSET,
    extra: { settleTo: 'hedera', merchant: '0.0.123456', merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID },
    ...overrides,
  }
}

describe('createPaymentHeader', () => {
  it('signs against the DERIVED nonce, not a fresh random one', async () => {
    const account = privateKeyToAccount(PAYER_PRIVATE_KEY)
    const requirement = buildRequirement()

    const header = await createPaymentHeader(requirement, account, {
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
    })

    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    const expectedNonce = computeNonce(MERCHANT_EVM, PAYMENT_ID)
    expect(decoded.payload.authorization.nonce).toBe(expectedNonce)
  })

  it('produces a header a real EIP-712 verifier recovers back to the signer', async () => {
    const account = privateKeyToAccount(PAYER_PRIVATE_KEY)
    const requirement = buildRequirement()

    const header = await createPaymentHeader(requirement, account, {
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
    })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    const { signature, authorization } = decoded.payload

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: ASSET },
      types: {
        ReceiveWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'ReceiveWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    })

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('builds the full x402 exact-evm PaymentPayload shape', async () => {
    const account = privateKeyToAccount(PAYER_PRIVATE_KEY)
    const requirement = buildRequirement()

    const header = await createPaymentHeader(requirement, account, {
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
    })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))

    expect(decoded.x402Version).toBe(1)
    expect(decoded.scheme).toBe('exact')
    expect(decoded.network).toBe('base-sepolia')
    expect(decoded.payload.authorization.from.toLowerCase()).toBe(account.address.toLowerCase())
    expect(decoded.payload.authorization.to).toBe(ESCROW)
    expect(decoded.payload.authorization.value).toBe('10000')
  })

  it('defaults validAfter/validBefore around now and requirement.maxTimeoutSeconds', async () => {
    const account = privateKeyToAccount(PAYER_PRIVATE_KEY)
    const requirement = buildRequirement({ maxTimeoutSeconds: 120 })
    const before = Math.floor(Date.now() / 1000)

    const header = await createPaymentHeader(requirement, account, {
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
    })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    const { validAfter, validBefore } = decoded.payload.authorization

    expect(Number(validAfter)).toBeLessThanOrEqual(before)
    expect(Number(validAfter)).toBeGreaterThan(before - 120)
    expect(Number(validBefore)).toBeGreaterThanOrEqual(before + 120)
  })

  it('respects an explicit validAfter/validBefore override', async () => {
    const account = privateKeyToAccount(PAYER_PRIVATE_KEY)
    const requirement = buildRequirement()

    const header = await createPaymentHeader(requirement, account, {
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
      validAfter: 1000n,
      validBefore: 2000n,
    })
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    expect(decoded.payload.authorization.validAfter).toBe('1000')
    expect(decoded.payload.authorization.validBefore).toBe('2000')
  })

  it('throws a clear error when extra.merchantEvm is missing (not a ferry402-issued requirement)', async () => {
    const account = privateKeyToAccount(PAYER_PRIVATE_KEY)
    const requirement = buildRequirement({ extra: { paymentId: PAYMENT_ID } })

    await expect(
      createPaymentHeader(requirement, account, { tokenName: 'USDC', tokenVersion: '2', chainId: 84532 }),
    ).rejects.toThrow(/extra.merchantEvm/)
  })

  it('throws a clear error when extra.paymentId is missing', async () => {
    const account = privateKeyToAccount(PAYER_PRIVATE_KEY)
    const requirement = buildRequirement({ extra: { merchantEvm: MERCHANT_EVM } })

    await expect(
      createPaymentHeader(requirement, account, { tokenName: 'USDC', tokenVersion: '2', chainId: 84532 }),
    ).rejects.toThrow(/extra.paymentId/)
  })
})
