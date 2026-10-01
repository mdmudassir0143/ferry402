import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Address, Hex } from 'viem'
import { computeNonce } from '@ferry402/sdk'
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
import { ESCROW_ADDRESS, DEFAULT_ESCROWS, buildRequirements, buildPayload, signAuthorization, type AuthorizationFields } from './support/fixtures.js'

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
    // token that only exists on this test's local anvil instance. `escrows`
    // is required too (task-8 review round 2) -- without it every request
    // for this network is rejected fail-closed, before reaching verifyPayment's
    // other checks.
    const app = createFacilitatorApp({ rpcUrls: { 'base-sepolia': anvil.rpcUrl }, escrows: DEFAULT_ESCROWS })
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

  // A reviewer proved `verifyPayment`'s trusted-escrow allowlist check (task-8
  // review round 2) could be DELETED entirely with the whole suite still
  // green: no test anywhere exercised `/verify` -- the actual HTTP entry
  // point an unauthenticated caller reaches -- with a `payTo` outside the
  // configured allowlist. `/settle`'s equivalent test (below) can only assert
  // the generic `unexpected_settle_error` fallback, because `SettleResponseSchema`
  // rejects an empty `transaction` and masks the precise reason; `/verify`'s
  // response schema carries no such constraint, so this test can assert the
  // EXACT reason `verifyPayment` itself returns.
  it('returns invalid_payment_requirements when payTo is not the configured trusted escrow', async () => {
    const app = createFacilitatorApp({ rpcUrls: { 'base-sepolia': anvil.rpcUrl }, escrows: DEFAULT_ESCROWS })
    const untrustedPayTo: Address = '0x9999999999999999999999999999999999999999'
    const auth = authFields({ to: untrustedPayTo })
    const paymentPayload = buildPayload({
      network: 'base-sepolia',
      signature: `0x${'ab'.repeat(65)}`,
      authorization: auth,
    })
    const paymentRequirements = buildRequirements({
      asset: anvil.tokenAddress,
      payTo: untrustedPayTo,
      extra: { merchantEvm: MERCHANT_EVM, paymentId: PAYMENT_ID },
    })

    const res = await request(app).post('/verify').send({ paymentPayload, paymentRequirements })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ isValid: false, invalidReason: 'invalid_payment_requirements' })
  })

  it('returns 400 with invalid_payload for a body that does not match VerifyRequestSchema', async () => {
    // `escrows` is required at construction (demo fix 2 -- see
    // `assertHasTrustedEscrows` in src/server.ts) even though none of these
    // requests ever reach verifyPayment/settlePayment far enough to care
    // what it contains: a malformed/oversized/schema-invalid body is
    // rejected before either function is ever called. `DEFAULT_ESCROWS` is
    // passed purely to satisfy that constructor guard.
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
    const res = await request(app).post('/verify').send({ nonsense: true })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ isValid: false, invalidReason: 'invalid_payload' })
  })

  it('never crashes the process on a malformed authorization.value inside an otherwise well-shaped body', async () => {
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
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
    // `escrows` is required at construction (demo fix 2 -- see
    // `assertHasTrustedEscrows` in src/server.ts) even though none of these
    // requests ever reach verifyPayment/settlePayment far enough to care
    // what it contains: a malformed/oversized/schema-invalid body is
    // rejected before either function is ever called. `DEFAULT_ESCROWS` is
    // passed purely to satisfy that constructor guard.
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
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
  //
  // Status 413, not 400 (task-8 review round 1, M-b): the error-handling
  // middleware now honors `err.status`/`err.statusCode` instead of
  // hardcoding 400, so a size-limit rejection is reported as the size-limit
  // status a caller might actually branch on, not flattened to a generic
  // bad-request.
  it('returns JSON (not an HTML stack trace) for a body over the size limit', async () => {
    // `escrows` is required at construction (demo fix 2 -- see
    // `assertHasTrustedEscrows` in src/server.ts) even though none of these
    // requests ever reach verifyPayment/settlePayment far enough to care
    // what it contains: a malformed/oversized/schema-invalid body is
    // rejected before either function is ever called. `DEFAULT_ESCROWS` is
    // passed purely to satisfy that constructor guard.
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
    const oversized = 'a'.repeat(20_000)
    const res = await request(app)
      .post('/verify')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ paymentPayload: oversized }))

    expect(res.status).toBe(413)
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
      // task-8 review round 2: the REAL, deployed escrow -- not
      // ESCROW_ADDRESS (a fake placeholder used by the /verify tests above).
      escrows: { 'base-sepolia': escrowAnvil.escrowAddress },
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

  // task-8 review round 2: /settle is unauthenticated and takes
  // `paymentRequirements` (including `payTo`) straight from the caller. This
  // proves the HTTP layer actually rejects an untrusted `payTo` rather than
  // trusting whatever the caller sent, matching settle.fork.test.ts's own
  // "rejects a hostile contract at payTo" coverage at the unit level (which
  // asserts the PRECISE `invalid_payment_requirements` reason and the
  // no-transaction-sent property directly against `settlePayment`).
  //
  // `errorReason` here is the pre-existing, separately-recorded
  // `SettleResponseSchema` limitation (task-8 review round 2's "recorded,
  // not for this round" item): the schema's `transaction` field is
  // regex-validated and rejects `''`, so `SettleResponseSchema.safeParse`
  // in server.ts fails for ANY settle failure that never reached the chain,
  // and the generic `unexpected_settle_error` fallback is what actually
  // reaches an HTTP caller -- confirmed directly:
  // `SettleResponseSchema.safeParse({..., transaction: ''})` fails with a
  // regex `ZodError` on `transaction`. This test asserts today's real HTTP
  // behavior, not the more specific reason `settlePayment` itself returns.
  it('rejects settlement when payTo is not the configured trusted escrow', async () => {
    const app = createFacilitatorApp({
      rpcUrls: { 'base-sepolia': escrowAnvil.rpcUrl },
      facilitatorPrivateKey: ANVIL_DEPLOYER_PRIVATE_KEY,
      escrows: { 'base-sepolia': escrowAnvil.escrowAddress },
    })
    const merchant = merchantEvm(0xbbbb)
    const paymentId = PAYMENT_ID
    const untrustedPayTo: Address = '0x9999999999999999999999999999999999999999'
    const nowSeconds = Math.floor(Date.now() / 1000)
    const auth: AuthorizationFields = {
      from: ANVIL_PAYER_ADDRESS,
      to: untrustedPayTo,
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
      payTo: untrustedPayTo,
      maxAmountRequired: '10000',
      extra: { merchantEvm: merchant, paymentId },
    })

    const res = await request(app).post('/settle').send({ paymentPayload, paymentRequirements })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(false)
    expect(res.body.errorReason).toBe('unexpected_settle_error')
    expect(res.body.transaction).toBe('')
  })

  it('returns 400 with success:false for a body that does not match SettleRequestSchema', async () => {
    // `escrows` is required at construction (demo fix 2 -- see
    // `assertHasTrustedEscrows` in src/server.ts) even though none of these
    // requests ever reach verifyPayment/settlePayment far enough to care
    // what it contains: a malformed/oversized/schema-invalid body is
    // rejected before either function is ever called. `DEFAULT_ESCROWS` is
    // passed purely to satisfy that constructor guard.
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
    const res = await request(app).post('/settle').send({ nonsense: true })

    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.errorReason).toBe('invalid_payload')
  })

  // Same Task 7 regression as /verify's, proven separately here because
  // `/settle`'s error response has a DIFFERENT shape (`success`/`transaction`/
  // `network`, not `isValid`) -- the shared error-handling middleware branches
  // on `req.path` specifically so this route doesn't get /verify's shape.
  //
  // `network` is the placeholder, not `''` (task-8 review round 1, M-a): a
  // body that fails to parse as JSON at all carries no recoverable network,
  // and `''` is not a member of `SettleResponseSchema`'s network enum -- see
  // `safeNetworkOrPlaceholder`'s doc comment in server.ts.
  it('returns JSON (not an HTML stack trace) for a malformed JSON body', async () => {
    // `escrows` is required at construction (demo fix 2 -- see
    // `assertHasTrustedEscrows` in src/server.ts) even though none of these
    // requests ever reach verifyPayment/settlePayment far enough to care
    // what it contains: a malformed/oversized/schema-invalid body is
    // rejected before either function is ever called. `DEFAULT_ESCROWS` is
    // passed purely to satisfy that constructor guard.
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
    const res = await request(app)
      .post('/settle')
      .set('Content-Type', 'application/json')
      .send('{"paymentPayload": not-valid-json')

    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(res.body).toEqual({ success: false, errorReason: 'invalid_payload', transaction: '', network: 'base-sepolia' })
    expect(res.text).not.toMatch(/<html/i)
  })

  // task-8 review round 1, M-b: the error-handling middleware's route check
  // must survive Express's own case-insensitive, trailing-slash-tolerant
  // routing (`caseSensitive: false`, `strict: false` are Express defaults),
  // since a malformed-JSON body never reaches the named route handler at all
  // (body-parser's error skips straight past it) -- only `req.path`, exactly
  // as the caller sent it, is available to decide which response shape to
  // use.
  it.each(['/settle/', '/SETTLE'])('recognizes %s as the settle route for a malformed JSON body', async (path) => {
    // `escrows` is required at construction (demo fix 2 -- see
    // `assertHasTrustedEscrows` in src/server.ts) even though none of these
    // requests ever reach verifyPayment/settlePayment far enough to care
    // what it contains: a malformed/oversized/schema-invalid body is
    // rejected before either function is ever called. `DEFAULT_ESCROWS` is
    // passed purely to satisfy that constructor guard.
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
    const res = await request(app).post(path).set('Content-Type', 'application/json').send('{not valid json')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ success: false, errorReason: 'invalid_payload', transaction: '', network: 'base-sepolia' })
  })

  // task-8 review round 1, M-a: a body that fails `SettleRequestSchema` (here,
  // missing `paymentRequirements` entirely) but carries a validly-typed
  // `paymentPayload.network` string should still echo THAT network in the
  // error response, recovered via `SettleResponseSchema`'s own enum check --
  // not silently discarded just because some OTHER field was missing.
  it('recovers a valid network from a body that otherwise fails SettleRequestSchema', async () => {
    // `escrows` is required at construction (demo fix 2 -- see
    // `assertHasTrustedEscrows` in src/server.ts) even though none of these
    // requests ever reach verifyPayment/settlePayment far enough to care
    // what it contains: a malformed/oversized/schema-invalid body is
    // rejected before either function is ever called. `DEFAULT_ESCROWS` is
    // passed purely to satisfy that constructor guard.
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
    const res = await request(app)
      .post('/settle')
      .send({ paymentPayload: { network: 'base', scheme: 'exact' } })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ success: false, errorReason: 'invalid_payload', transaction: '', network: 'base' })
  })

  // task-8 review round 1, M-a: an attacker-controlled, non-string
  // `paymentPayload.network` (here, an object) must never be echoed back
  // verbatim -- only a value that is ITSELF a valid member of
  // `SettleResponseSchema`'s network enum may ever appear in the response.
  it('never echoes an attacker-controlled non-string network back in an error response', async () => {
    // `escrows` is required at construction (demo fix 2 -- see
    // `assertHasTrustedEscrows` in src/server.ts) even though none of these
    // requests ever reach verifyPayment/settlePayment far enough to care
    // what it contains: a malformed/oversized/schema-invalid body is
    // rejected before either function is ever called. `DEFAULT_ESCROWS` is
    // passed purely to satisfy that constructor guard.
    const app = createFacilitatorApp({ escrows: DEFAULT_ESCROWS })
    const res = await request(app)
      .post('/settle')
      .send({ paymentPayload: { network: { injected: '<script>evil()</script>' } } })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ success: false, errorReason: 'invalid_payload', transaction: '', network: 'base-sepolia' })
  })
})

// Demo fix 2: a facilitator built with `escrows` missing entirely used to
// construct successfully and then reject EVERY /verify and /settle request,
// forever, with the same generic `invalid_payment_requirements` a caller
// also sees for a genuinely wrong `payTo` -- correct (fail-closed), but
// indistinguishable from a broken install from the outside, and exactly the
// kind of thing that burns five minutes in front of a demo audience. These
// tests pin the loud, synchronous, construction-time failure that replaces
// that silent full-rejection mode -- see `assertHasTrustedEscrows` in
// src/server.ts. The per-request fail-closed check itself is untouched and
// still covered by `verify.test.ts`'s `escrows: {}` tests and
// `settle.fork.test.ts`'s "rejects settlement when no escrow is configured
// for the network at all" test, both of which call `verifyPayment`/
// `settlePayment` directly rather than through `createFacilitatorApp` --
// this constructor guard is additional, not a replacement.
describe('createFacilitatorApp construction', () => {
  it('throws when escrows is omitted entirely', () => {
    expect(() => createFacilitatorApp()).toThrow(/escrows/i)
  })

  it('throws when escrows is an empty object', () => {
    expect(() => createFacilitatorApp({ escrows: {} })).toThrow(/escrows/i)
  })

  it('names the option and shows the expected shape in the thrown message', () => {
    expect(() => createFacilitatorApp()).toThrow(/createFacilitatorApp\({\s*\n\s*escrows: \{ 'base-sepolia'/)
  })

  it('does not throw when escrows has at least one entry', () => {
    expect(() => createFacilitatorApp({ escrows: DEFAULT_ESCROWS })).not.toThrow()
  })
})
