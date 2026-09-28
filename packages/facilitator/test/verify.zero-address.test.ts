import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Address, Hex } from 'viem'

/**
 * Mocks ONLY `recoverAddress` (spreading through the real module for
 * everything else, including `createPublicClient`/`http`/`isAddress`, which
 * `chains/base.ts` and the anvil test harness both still need for real).
 *
 * Why mock at all: the spec requires verifyPayment to "handle the
 * address(0) recovery result explicitly -- never let it match a zero
 * `from`". A REAL ECDSA signature that recovers to address(0) cannot be
 * constructed by a test (or an attacker) -- it would require finding a
 * discrete-log preimage. The only way to exercise this specific defensive
 * branch at all is to force `recoverAddress` to return the zero address
 * regardless of input, and check that verifyPayment still refuses to treat
 * that as a match for a payload whose own `authorization.from` is also the
 * zero address. This is scoped to its own file so the mock never leaks
 * into `verify.test.ts`'s real-signature assertions.
 */
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    recoverAddress: vi.fn().mockResolvedValue('0x0000000000000000000000000000000000000000'),
  }
})

const { verifyPayment } = await import('../src/chains/base.js')
const { startAnvilWithDomainToken } = await import('./support/anvil.js')
const { ESCROW_ADDRESS, DEFAULT_ESCROWS, buildRequirements, buildPayload } = await import('./support/fixtures.js')
const { computeNonce } = await import('@ferry402/sdk')

const MERCHANT_EVM: Address = '0x1111111111111111111111111111111111111111'
const PAYMENT_ID: Hex = '0x00000000000000000000000000000000000000000000000000000000000004d2'
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

let anvil: Awaited<ReturnType<typeof startAnvilWithDomainToken>>

beforeAll(async () => {
  anvil = await startAnvilWithDomainToken({ name: 'Zero Test Token', version: '1' })
}, 30_000)

afterAll(async () => {
  await anvil?.stop()
})

describe('verifyPayment — zero-address recovery guard', () => {
  it('never accepts a (mocked) zero-address recovery as matching a zero authorization.from', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const auth = {
      from: ZERO_ADDRESS,
      to: ESCROW_ADDRESS,
      value: '1000000',
      validAfter: String(nowSeconds - 60),
      validBefore: String(nowSeconds + 300),
      nonce: computeNonce(MERCHANT_EVM, PAYMENT_ID),
    }
    // A structurally well-formed signature (correct length, v=27, low-s) so
    // it clears every check BEFORE recovery. Its actual r/s content is
    // irrelevant: recoverAddress is mocked and never runs real ecrecover
    // math against it.
    const r = '11'.repeat(32)
    const s = `${'00'.repeat(31)}01`
    const v = '1b' // 27
    const signature = `0x${r}${s}${v}` as Hex

    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature, authorization: auth }),
      buildRequirements({ asset: anvil.tokenAddress, extra: { merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID } }),
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )

    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_signature')
  })
})
