import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Address, Hex } from 'viem'
import { computeNonce } from '@ferry402/sdk'
import { verifyPayment } from '../src/chains/base.js'
import { startAnvilWithDomainToken, ANVIL_PAYER_PRIVATE_KEY, ANVIL_PAYER_ADDRESS, type AnvilFixture } from './support/anvil.js'
import { ESCROW_ADDRESS, DEFAULT_ESCROWS, buildRequirements, buildPayload, signAuthorization, type AuthorizationFields } from './support/fixtures.js'

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
      { rpcUrl: mismatched.rpcUrl, escrows: DEFAULT_ESCROWS },
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

  // Task 11 review round 1: this test used to assert the second call
  // SUCCEEDED after the RPC died, as proof that the client/domain cache
  // meant no further RPC traffic was needed at all. That's no longer true,
  // and can't be made true again without weakening `recoverSigner`:
  // dispatching ECDSA vs EIP-1271 correctly requires knowing whether `from`
  // has on-chain code (see `recoverSigner`'s doc comment for why this must
  // be checked up front, not skipped or inferred), which is a live
  // `eth_getCode` call EVERY verify now legitimately needs, cache or no
  // cache. EIP-1271 support genuinely invalidates the old "zero RPC calls
  // once warm" claim; this isn't something to design around.
  //
  // What the cache STILL buys, and what this test now actually proves:
  // execution reaches all the way to that NEW code-check step instead of
  // failing earlier at a stale/uncached domain read. If `getTokenDomain`'s
  // cache entry from the warm-up call below were NOT being reused, this
  // second call would fail at the domain read itself and report
  // `unexpected_verify_error` (see check 6's `getTokenDomain` guard) --
  // instead it fails specifically at the signature-dispatch step, reported
  // as `invalid_exact_evm_payload_signature`, which is only reachable AFTER
  // the (cached) domain was already resolved successfully.
  it('reuses the cached client/domain after the RPC becomes unreachable, failing only at the (now unavoidable) live code check', async () => {
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
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )
    expect(warmup.isValid).toBe(true)

    // Kill the RPC entirely.
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
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )
    expect(afterRpcDied.isValid).toBe(false)
    // NOT 'unexpected_verify_error' -- that would mean the domain read
    // itself failed, i.e. the cache from the warm-up call above was NOT
    // reused.
    expect(afterRpcDied.invalidReason).toBe('invalid_exact_evm_payload_signature')
  })
})

describe('verifyPayment — domain cache keyed by rpcUrl (task-8 review round 1, M-c)', () => {
  let chainA: AnvilFixture
  let chainB: AnvilFixture

  beforeAll(async () => {
    // Both `startAnvilWithDomainToken` calls use the SAME default deployer
    // (`ANVIL_DEPLOYER_PRIVATE_KEY`, account #0) and each deploys its
    // first-ever contract on a fresh, independent chain. A CREATE address
    // depends only on `(sender, nonce)`, never on chain id, so these two
    // otherwise-unrelated tokens land on the byte-IDENTICAL address despite
    // genuinely different domains (`name`/`version`) and independent RPC
    // endpoints — deliberately reproducing the exact collision a
    // `domainCache` keyed by `(chainId, asset)` ALONE would conflate: both
    // instances also share the identical `chainId` (84532, the shared
    // default), so `(chainId, asset)` is indistinguishable between them.
    // `rpcUrl` is the only thing that actually tells them apart.
    ;[chainA, chainB] = await Promise.all([
      startAnvilWithDomainToken({ name: 'Chain A Token', version: '1' }),
      startAnvilWithDomainToken({ name: 'Chain B Token', version: '2' }),
    ])
  }, 30_000)

  afterAll(async () => {
    await Promise.all([chainA?.stop(), chainB?.stop()])
  })

  it('reads each chain’s own domain even though both tokens share a (chainId, asset) identity', async () => {
    // Confirms the setup actually reproduces the collision this test exists
    // to guard against — if this ever stops holding (e.g. anvil changes its
    // CREATE nonce bookkeeping), the test below would pass VACUOUSLY.
    expect(chainA.tokenAddress).toBe(chainB.tokenAddress)
    expect(chainA.chainId).toBe(chainB.chainId)

    const authA = authFields()
    const signatureA = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: chainA.tokenAddress,
      tokenName: 'Chain A Token',
      tokenVersion: '1',
      chainId: chainA.chainId,
      authorization: authA,
    })
    const authB = authFields()
    const signatureB = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: chainB.tokenAddress,
      tokenName: 'Chain B Token',
      tokenVersion: '2',
      chainId: chainB.chainId,
      authorization: authB,
    })

    // Query chain A first — this is what populates the domain cache entry
    // for the shared (chainId, asset) pair. A cache keyed WITHOUT rpcUrl
    // would then silently serve chain A's {name: "Chain A Token", version:
    // "1"} domain for chain B's query below too, recovering the wrong
    // signer and failing signature verification for a perfectly valid,
    // correctly-signed chain-B payload.
    const resultA = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: signatureA, authorization: authA }),
      requirementsFor(chainA.tokenAddress),
      { rpcUrl: chainA.rpcUrl, escrows: DEFAULT_ESCROWS },
    )
    expect(resultA.isValid).toBe(true)
    expect(resultA.payer).toBe(ANVIL_PAYER_ADDRESS)

    const resultB = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: signatureB, authorization: authB }),
      requirementsFor(chainB.tokenAddress),
      { rpcUrl: chainB.rpcUrl, escrows: DEFAULT_ESCROWS },
    )
    expect(resultB.isValid).toBe(true)
    expect(resultB.payer).toBe(ANVIL_PAYER_ADDRESS)
  })
})
