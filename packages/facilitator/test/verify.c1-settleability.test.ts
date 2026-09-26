import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Address, Hex } from 'viem'
import { computeNonce } from '@ferry402/sdk'
import { verifyPayment } from '../src/chains/base.js'
import { startAnvilWithDomainToken, ANVIL_PAYER_PRIVATE_KEY, ANVIL_PAYER_ADDRESS, type AnvilFixture } from './support/anvil.js'
import {
  UNREACHABLE_RPC_URL,
  ESCROW_ADDRESS,
  OTHER_ADDRESS,
  DEFAULT_ESCROWS,
  buildRequirements,
  buildPayload,
  signAuthorization,
  type AuthorizationFields,
} from './support/fixtures.js'

/**
 * Final whole-branch review, C1 (Critical): "`/verify` proves signature
 * validity, never settleability." This codebase's architecture is
 * serve-then-settle (the facilitator verifies, the resource is served, THEN
 * settlement is redeemed on-chain — see `packages/sdk/src/middleware.ts`),
 * so anything that passes `/verify` but cannot settle is a free resource.
 * Three independent, previously-unchecked mechanisms produced exactly that:
 *
 *   1. No payer balance read (`balanceOf(authorization.from)`).
 *   2. No settlement buffer on `validBefore` (accepted down to `now + 1`).
 *   3. No `requirements.asset` ↔ `escrow.token()` check.
 *
 * One `describe` block per mechanism, matching the review's own numbering.
 * Each test here was confirmed to go RED against a deliberate reversion of
 * its corresponding fix (mutation-checked) — see the branch's final-fix
 * report for the transcript.
 */

const MERCHANT_EVM: Address = '0x1111111111111111111111111111111111111111'
const PAYMENT_ID: Hex = '0x00000000000000000000000000000000000000000000000000000000000004d2'
const TOKEN_NAME = 'C1 Settleability Test Token'
const TOKEN_VERSION = '1'

function requirements(overrides: Partial<Parameters<typeof buildRequirements>[0]> = {}) {
  return buildRequirements({
    asset: OTHER_ADDRESS,
    extra: { merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID },
    ...overrides,
  })
}

// --- Mechanism 1: payer balance ------------------------------------------

describe('verifyPayment — payer balance (C1, mechanism 1)', () => {
  let anvil: AnvilFixture

  beforeAll(async () => {
    // `payerInitialBalance: 0n` -- the payer's signature below is otherwise
    // completely genuine; the ONLY thing wrong with this request is that
    // `authorization.from` holds none of `requirements.asset` at all. No
    // ETH, no USDC, no on-chain trace -- exactly the exploit the review
    // describes: a throwaway keypair signing a valid ReceiveWithAuthorization
    // from a zero-balance address.
    anvil = await startAnvilWithDomainToken({ name: TOKEN_NAME, version: TOKEN_VERSION, payerInitialBalance: 0n })
  }, 30_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  it('rejects a zero-balance payer with an otherwise perfectly valid signature as insufficient_funds', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const auth: AuthorizationFields = {
      from: ANVIL_PAYER_ADDRESS,
      to: ESCROW_ADDRESS,
      value: '1000000',
      validAfter: String(nowSeconds - 60),
      validBefore: String(nowSeconds + 300),
      nonce: computeNonce(MERCHANT_EVM, PAYMENT_ID),
    }
    const signature = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: anvil.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: anvil.chainId,
      authorization: auth,
    })

    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature, authorization: auth }),
      requirements({ asset: anvil.tokenAddress }),
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )

    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('insufficient_funds')
  })
})

// --- Mechanism 2: settlement buffer on validBefore -----------------------

describe('verifyPayment — settlement buffer on validBefore (C1, mechanism 2)', () => {
  let anvil: AnvilFixture

  beforeAll(async () => {
    anvil = await startAnvilWithDomainToken({ name: TOKEN_NAME, version: TOKEN_VERSION })
  }, 30_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  it('rejects an authorization that has not yet expired but expires inside the settlement buffer', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    // 5 seconds out: strictly in the future (the OLD bare `validBefore <=
    // now` check would have accepted this), but inside the 10-second
    // settlement buffer this fix adds.
    const auth = {
      from: ANVIL_PAYER_ADDRESS,
      to: ESCROW_ADDRESS,
      value: '1000000',
      validAfter: String(nowSeconds - 60),
      validBefore: String(nowSeconds + 5),
      nonce: computeNonce(MERCHANT_EVM, PAYMENT_ID),
    }
    // No real signature needed: the time-window check (check 5) runs before
    // any RPC call or signature-shape check, so an obviously-bogus
    // placeholder signature (matching the pattern verify.test.ts's own
    // checks 1-5 use) is enough — see UNREACHABLE_RPC_URL's own doc comment
    // for why that also proves this rejection needs no chain call at all.
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements({ asset: anvil.tokenAddress }),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )

    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_valid_before')
  })

  it('does not reject an authorization on time-window grounds once it clears the buffer', async () => {
    // Boundary control: proves the buffer is a small, fixed window (~10s),
    // not something drastically larger that would reject ordinary near-term
    // payments too. validBefore is comfortably outside the buffer here, and
    // this is signed for real against the live anvil chain, so a rejection
    // for the WRONG reason (e.g. the buffer swallowing this window too)
    // would surface as `isValid` being false for the valid_before reason
    // instead of the request succeeding.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const auth: AuthorizationFields = {
      from: ANVIL_PAYER_ADDRESS,
      to: ESCROW_ADDRESS,
      value: '1000000',
      validAfter: String(nowSeconds - 60),
      validBefore: String(nowSeconds + 60),
      nonce: computeNonce(MERCHANT_EVM, PAYMENT_ID),
    }
    const signature = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: anvil.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: anvil.chainId,
      authorization: auth,
    })

    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature, authorization: auth }),
      requirements({ asset: anvil.tokenAddress }),
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )

    expect(result.invalidReason).not.toBe('invalid_exact_evm_payload_authorization_valid_before')
    expect(result.isValid).toBe(true)
  })
})

// --- Mechanism 3: requirements.asset ↔ escrow.token() binding ------------

describe('verifyPayment — escrow ↔ asset binding (C1, mechanism 3)', () => {
  let anvil: AnvilFixture

  beforeAll(async () => {
    anvil = await startAnvilWithDomainToken({ name: TOKEN_NAME, version: TOKEN_VERSION })
  }, 30_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  it("rejects a requirements.asset that is not the trusted escrow's own bound token", async () => {
    // ESCROW_ADDRESS (via DEFAULT_ESCROWS) is a REAL, deployed Escrow bound
    // to `anvil.tokenAddress` (see startAnvilWithDomainToken's doc comment).
    // `requirements.asset` here names a DIFFERENT address entirely
    // (OTHER_ADDRESS, this file's default) -- exactly a mistyped
    // `config.assets[chain]`: escrow.token() resolves fine (it's a real,
    // deployed contract), but disagrees with what this request claims the
    // asset is.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const auth = {
      from: ANVIL_PAYER_ADDRESS,
      to: ESCROW_ADDRESS,
      value: '1000000',
      validAfter: String(nowSeconds - 60),
      validBefore: String(nowSeconds + 300),
      nonce: computeNonce(MERCHANT_EVM, PAYMENT_ID),
    }
    // No real signature needed: this must be rejected before signature
    // recovery is ever attempted (see this module's own check ordering) --
    // a bogus-but-well-formed placeholder is enough, and a REAL rpcUrl is
    // used specifically so the escrow.token() read actually happens.
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(), // asset: OTHER_ADDRESS -- mismatched
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )

    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_payment_requirements')
  })

  it("accepts a requirements.asset that IS the trusted escrow's own bound token (control)", async () => {
    // Same escrow, same chain, the ONLY difference from the test above is
    // that `asset` now correctly names `anvil.tokenAddress` -- proving the
    // rejection above is actually about the mismatch, not e.g. the escrow
    // being unreachable or misconfigured in some other way.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const auth: AuthorizationFields = {
      from: ANVIL_PAYER_ADDRESS,
      to: ESCROW_ADDRESS,
      value: '1000000',
      validAfter: String(nowSeconds - 60),
      validBefore: String(nowSeconds + 300),
      nonce: computeNonce(MERCHANT_EVM, PAYMENT_ID),
    }
    const signature = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: anvil.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: anvil.chainId,
      authorization: auth,
    })

    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature, authorization: auth }),
      requirements({ asset: anvil.tokenAddress }),
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )

    expect(result.isValid).toBe(true)
  })
})
