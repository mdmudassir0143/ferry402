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
  flipToMalleable,
  withVByte,
  type AuthorizationFields,
} from './support/fixtures.js'

// Golden vector 1, verbatim from the task-7 brief / packages/sdk/test/nonce.test.ts,
// cross-checked independently against Foundry's `cast keccak`/`cast abi-encode`.
const MERCHANT_EVM: Address = '0x1111111111111111111111111111111111111111'
const PAYMENT_ID: Hex = '0x00000000000000000000000000000000000000000000000000000000000004d2'
const GOLDEN_NONCE_1 = '0xb6f7d82208db09a705e0a7e18d8c0326c05e7fc142836aa6572fa044d76f8b5f'

// DomainToken is deployed with a name/version pair that matches NEITHER real
// USDC's Base mainnet domain ("USD Coin"/"2") NOR the common "version 1"
// guess. If `verifyPayment` ever hardcoded either field instead of reading
// it live from the token contract, every signature test below would fail to
// recover the correct signer -- proving the "read from chain, don't
// hardcode" requirement, not just asserting it in a comment.
const TOKEN_NAME = 'Definitely Not USDC'
const TOKEN_VERSION = '7'

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

function requirements(overrides: Partial<Parameters<typeof buildRequirements>[0]> = {}) {
  return buildRequirements({
    asset: anvil.tokenAddress,
    extra: { merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID },
    ...overrides,
  })
}

async function sign(authorization: AuthorizationFields): Promise<Hex> {
  return signAuthorization({
    privateKey: ANVIL_PAYER_PRIVATE_KEY,
    tokenAddress: anvil.tokenAddress,
    tokenName: TOKEN_NAME,
    tokenVersion: TOKEN_VERSION,
    chainId: anvil.chainId,
    authorization,
  })
}

describe('verifyPayment', () => {
  // --- check 1 (task-8 review round 2): trusted-escrow allowlist ----------
  //
  // Every OTHER test in this file passes `escrows: DEFAULT_ESCROWS`, whose
  // one entry happens to match `buildRequirements`'s own default `payTo`
  // (`ESCROW_ADDRESS`) -- so none of them can tell this check apart from "no
  // allowlist check exists at all". A reviewer proved exactly that: deleting
  // `verifyPayment`'s check 1 entirely left all pre-existing tests green,
  // because `settlePayment`'s own re-check (defense-in-depth, not a
  // substitute) masks the gap for anything that goes through `/settle`. This
  // test is the one place `payTo` and the configured allowlist actually
  // disagree, so it can only pass if check 1 itself rejects the mismatch.
  it("rejects a payTo that is not the configured trusted escrow, before any other check", async () => {
    const auth = authFields()
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(), // payTo: ESCROW_ADDRESS (buildRequirements' default)
      // The configured allowlist maps 'base-sepolia' to a DIFFERENT address
      // than `requirements().payTo` -- a real operator misconfiguration, or
      // (the actual threat this check defends against) a caller-supplied
      // `payTo` this facilitator does not operate.
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: { 'base-sepolia': OTHER_ADDRESS } },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_payment_requirements')
  })

  it('rejects every request for a network with no configured escrow at all (fails closed, not open)', async () => {
    const auth = authFields()
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(),
      // No `escrows` entry for 'base-sepolia' whatsoever -- must be rejected,
      // never treated as "no allowlist configured, so trust the caller".
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: {} },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_payment_requirements')
  })

  // --- check 2: recipient -------------------------------------------------
  it('rejects an authorization whose recipient is not our escrow', async () => {
    const auth = authFields({ to: OTHER_ADDRESS })
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_recipient_mismatch')
  })

  // --- check 3: merchant binding (THE critical check) ---------------------
  it('rejects a redirect attempt: a signature whose nonce is not bound to this merchant/paymentId', async () => {
    // Same recipient, same value, same window -- everything an on-chain-only
    // check would see as fine. Only the nonce disagrees with what THIS
    // requirements entry's (merchantEvm, paymentId) actually binds to; this
    // is exactly the "observer redirects the credit" attack Escrow.sol's
    // MerchantNotBound guard exists to stop on-chain, caught here first.
    const wrongMerchant: Address = '0x333333333333333333333333333333333333333d'
    const wrongNonce = computeNonce(wrongMerchant, PAYMENT_ID)
    const auth = authFields({ nonce: wrongNonce })
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_payload')
  })

  it('binds the exact nonce the SDK computeNonce golden vector predicts, not merely "a" nonce', async () => {
    // Pins computeNonce's own output for this (merchantEvm, paymentId) pair
    // to the golden vector from nonce.test.ts / the task-7 brief, THEN
    // proves verifyPayment's internal binding check accepts precisely that
    // value (by forcing a later, unrelated check -- amount -- to fail
    // instead, which is only reachable if the binding check passed).
    expect(computeNonce(MERCHANT_EVM, PAYMENT_ID)).toBe(GOLDEN_NONCE_1)
    const auth = authFields({ value: '1' }) // below maxAmountRequired
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_value')
  })

  it('is case-insensitive when comparing the signed nonce to the recomputed one', async () => {
    const nonce = computeNonce(MERCHANT_EVM, PAYMENT_ID)
    const upperNonce = (`0x${nonce.slice(2).toUpperCase()}`) as Hex
    const auth = authFields({ nonce: upperNonce, value: '1' })
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )
    // Reaches the (deliberately failing) amount check, i.e. binding passed.
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_value')
  })

  // --- check 4: amount -----------------------------------------------------
  it('rejects an authorization whose value is below maxAmountRequired', async () => {
    const auth = authFields({ value: '999999' })
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements({ extra: { merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID }, maxAmountRequired: '1000000' }),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_value')
  })

  it('rejects (rather than crashes on) a value in JS exponent notation', async () => {
    // The exact task-6 regression: x402's own upstream validator
    // (Number.isInteger(Number(v))) accepts "1e30", but BigInt("1e30")
    // throws a SyntaxError. This must resolve cleanly, never reject/throw.
    const auth = authFields({ value: '1e30' })
    await expect(
      verifyPayment(
        buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
        requirements(),
        { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
      ),
    ).resolves.toEqual({ isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_value' })
  })

  it('rejects (rather than crashes on) a maxAmountRequired in JS exponent notation', async () => {
    // Same bug class, but on the requirements side. paymentRequirements
    // reaches this facilitator over the wire (POST /verify) from a caller
    // this process does not control, so it gets the identical treatment as
    // the payer-controlled `value` field.
    const auth = authFields()
    await expect(
      verifyPayment(
        buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
        requirements({ maxAmountRequired: '1e30' }),
        { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
      ),
    ).resolves.toEqual({ isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_value' })
  })

  // --- check 5: time window -------------------------------------------------
  it('rejects an expired authorization', async () => {
    const auth = authFields({ validBefore: String(Math.floor(Date.now() / 1000) - 10) })
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_valid_before')
  })

  it('rejects an authorization that is not yet valid', async () => {
    const auth = authFields({ validAfter: String(Math.floor(Date.now() / 1000) + 3600) })
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
      requirements(),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_valid_after')
  })

  it('rejects (rather than crashes on) a validBefore too large for a uint256, reached over the wire', async () => {
    // Task-7 review round 1, I1: x402 caps `value` at 18 characters, but
    // puts NO length cap on `validBefore`/`validAfter`, and
    // Number.isInteger(Number('9'.repeat(100))) is true -- so a 100-digit
    // validBefore passes VerifyRequestSchema at the HTTP boundary. Unlike an
    // oversized validAfter (caught incidentally by the "not yet valid"
    // comparison against any real `now`), an oversized validBefore reaches
    // no earlier check. Pre-fix, this value would flow unrejected into
    // hashTypedData's `uint256` encoding and throw IntegerOutOfRangeError --
    // the one call in verifyPayment that wasn't wrapped in a try/catch --
    // so this must resolve cleanly, never reject.
    //
    // Uses the REAL anvil RPC (not UNREACHABLE_RPC_URL, unlike this file's
    // other check-3/4 tests): the point is to actually reach the unguarded
    // hashTypedData call downstream, not merely fail earlier for an
    // unrelated (network) reason that would mask whether the range guard
    // itself is doing anything.
    const auth = authFields({ validBefore: '9'.repeat(100) })
    await expect(
      verifyPayment(
        buildPayload({ network: 'base-sepolia', signature: `0x${'ab'.repeat(65)}`, authorization: auth }),
        requirements(),
        { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
      ),
    ).resolves.toEqual({ isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_before' })
  })

  // --- check 6: signature ----------------------------------------------------
  it('accepts a well-formed authorization signed by the payer', async () => {
    const auth = authFields()
    const signature = await sign(auth)
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature, authorization: auth }),
      requirements(),
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )
    expect(result.isValid).toBe(true)
    expect(result.payer).toBe(ANVIL_PAYER_ADDRESS)
    expect(result.invalidReason).toBeUndefined()
  })

  it('rejects a signature produced by a different key than authorization.from claims', async () => {
    const auth = authFields() // from: ANVIL_PAYER_ADDRESS
    // Signed by the DEPLOYER key instead of the payer key -- a structurally
    // valid, non-malleable signature, just not by the claimed `from`.
    const signature = await signAuthorization({
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      tokenAddress: anvil.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: anvil.chainId,
      authorization: auth,
    })
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature, authorization: auth }),
      requirements(),
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_signature')
  })

  // Task 11: a merely-SHORT (but well-formed) hex signature is no longer
  // rejectable on shape alone — it's a legitimate EIP-1271 blob shape, and
  // deciding whether it's valid needs a live RPC round trip against
  // `authorization.from` (see eip1271.test.ts for that path, exercised
  // against a real anvil instance). This test now covers what genuinely
  // CAN still be rejected on shape alone, with no RPC involved at all: not
  // even a well-formed hex byte string.
  it('rejects a malformed (non-hex) signature without ever reaching the RPC', async () => {
    const auth = authFields()
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: '0xzz', authorization: auth }),
      requirements(),
      { rpcUrl: UNREACHABLE_RPC_URL, escrows: DEFAULT_ESCROWS },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_signature')
  })

  it('rejects a malleable (high-s) signature even though it recovers via raw ecrecover math', async () => {
    const auth = authFields()
    const validSignature = await sign(auth)
    const malleable = flipToMalleable(validSignature)
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: malleable, authorization: auth }),
      requirements(),
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_signature')
  })

  it('rejects a signature whose recovery id (v) is a raw yParity (0/1) instead of {27,28}', async () => {
    const auth = authFields()
    const validSignature = await sign(auth)
    const originalV = Number.parseInt(validSignature.slice(130, 132), 16)
    const yParity = originalV - 27 // 0 or 1
    const rewritten = withVByte(validSignature, yParity)
    const result = await verifyPayment(
      buildPayload({ network: 'base-sepolia', signature: rewritten, authorization: auth }),
      requirements(),
      { rpcUrl: anvil.rpcUrl, escrows: DEFAULT_ESCROWS },
    )
    expect(result.isValid).toBe(false)
    expect(result.invalidReason).toBe('invalid_exact_evm_payload_signature')
  })
})
