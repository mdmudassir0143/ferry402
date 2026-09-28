import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPublicClient, createWalletClient, http, BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { computeNonce } from '@ferry402/sdk'
import { settlePayment, type SettleOptions } from '../src/chains/base.js'
import {
  startAnvilWithEscrow,
  ANVIL_DEPLOYER_PRIVATE_KEY,
  ANVIL_PAYER_PRIVATE_KEY,
  ANVIL_PAYER_ADDRESS,
  type EscrowAnvilFixture,
} from './support/anvil.js'
import { escrowAbi, escrowBytecode } from './fixtures/Escrow.abi.js'
import { hostileEscrowAbi, hostileEscrowBytecode } from './fixtures/HostileEscrow.abi.js'
import { stringRevertTokenAbi, stringRevertTokenBytecode } from './fixtures/StringRevertToken.abi.js'
import { buildRequirements, buildPayload, signAuthorization, type AuthorizationFields } from './support/fixtures.js'

// The facilitator's own signing key for every settlePayment call in this
// file, passed via `options.facilitatorPrivateKey` rather than
// `process.env.FACILITATOR_PRIVATE_KEY` -- see SettleOptions's doc comment
// for why (mutating process.env would leak across other test files sharing
// a vitest worker). anvil account #0 -- already the deployer, and pre-funded
// with a huge ETH balance by anvil's default genesis.
const FACILITATOR_PRIVATE_KEY = ANVIL_DEPLOYER_PRIVATE_KEY
const FACILITATOR_ADDRESS = privateKeyToAccount(FACILITATOR_PRIVATE_KEY).address

const MERCHANT_EVM: Address = '0x1111111111111111111111111111111111111111'
const TOKEN_NAME = 'SettleToken'
const TOKEN_VERSION = '1' // SettleToken.sol hardcodes both as public constants.

let anvil: EscrowAnvilFixture
let publicClient: ReturnType<typeof createPublicClient>
let nextPaymentIdSeed = 1

beforeAll(async () => {
  anvil = await startAnvilWithEscrow()
  publicClient = createPublicClient({ chain: foundry, transport: http(anvil.rpcUrl) })
}, 30_000)

afterAll(async () => {
  await anvil?.stop()
})

/** A fresh bytes32 paymentId per call, so tests that each perform their own
 *  independent (first) settlement never collide on the merchant-bound nonce
 *  -- mirrors Escrow.t.sol's own `_nextPaymentId` counter. */
function freshPaymentId(): Hex {
  const seed = nextPaymentIdSeed++
  return `0x${seed.toString(16).padStart(64, '0')}` as Hex
}

function authFields(paymentId: Hex, overrides: Partial<AuthorizationFields> = {}): AuthorizationFields {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    from: ANVIL_PAYER_ADDRESS,
    to: anvil.escrowAddress,
    value: '10000',
    validAfter: String(nowSeconds - 60),
    validBefore: String(nowSeconds + 300),
    nonce: computeNonce(MERCHANT_EVM, paymentId),
    ...overrides,
  }
}

function requirements(paymentId: Hex, overrides: Partial<Parameters<typeof buildRequirements>[0]> = {}) {
  return buildRequirements({
    asset: anvil.tokenAddress,
    payTo: anvil.escrowAddress,
    maxAmountRequired: '10000',
    extra: { merchantEvm: MERCHANT_EVM, paymentId },
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

/**
 * `escrows` defaults to trusting the REAL, deployed `anvil.escrowAddress` —
 * required since task-8 review round 2 (`settlePayment`/`verifyPayment` both
 * fail closed on a network with no configured trusted escrow). Tests that
 * need to exercise a DIFFERENT escrow configuration (a misconfigured
 * allowlist, or a second token/escrow pair) pass `overrides.escrows`
 * explicitly.
 */
async function settle(
  payload: ReturnType<typeof buildPayload>,
  reqs: ReturnType<typeof buildRequirements>,
  overrides: Partial<SettleOptions> = {},
) {
  return settlePayment(payload, reqs, {
    rpcUrl: anvil.rpcUrl,
    facilitatorPrivateKey: FACILITATOR_PRIVATE_KEY,
    escrows: { 'base-sepolia': anvil.escrowAddress },
    ...overrides,
  })
}

async function merchantBalance(merchant: Address = MERCHANT_EVM): Promise<bigint> {
  return publicClient.readContract({
    address: anvil.escrowAddress,
    abi: escrowAbi,
    functionName: 'balanceOf',
    args: [merchant],
  })
}

describe('settlePayment', () => {
  it('redeems the authorization and credits the merchant', async () => {
    const paymentId = freshPaymentId()
    const auth = authFields(paymentId)
    const signature = await sign(auth)
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId)

    const balanceBefore = await merchantBalance()
    const result = await settle(payload, reqs)

    expect(result.success).toBe(true)
    expect(result.errorReason).toBeUndefined()
    expect(result.payer).toBe(ANVIL_PAYER_ADDRESS)
    expect(result.network).toBe('base-sepolia')
    expect(result.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/)

    const receipt = await publicClient.getTransactionReceipt({ hash: result.transaction as Hex })
    expect(receipt.status).toBe('success')

    const balanceAfter = await merchantBalance()
    expect(balanceAfter - balanceBefore).toBe(10_000n)

    // task-8 review round 1, I1: the observed delta (Escrow's own
    // `PaymentSettled.value`) and its nonce are kept on the in-process
    // result, not discarded -- a future in-process caller (e.g. an HCS
    // journal writer) can read them directly instead of re-fetching this
    // same receipt by hash.
    expect(result.settledAmount).toBe(10_000n)
    expect(result.nonce).toBe(auth.nonce)
  })

  it('rejects an unverified payload without ever sending a transaction', async () => {
    const paymentId = freshPaymentId()
    // Authorized value (1) is below maxAmountRequired (10000) -- verifyPayment's
    // check 3 rejects this before any chain call.
    const auth = authFields(paymentId, { value: '1' })
    const signature = await sign(auth)
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId)

    const nonceBefore = await publicClient.getTransactionCount({ address: FACILITATOR_ADDRESS })
    const result = await settle(payload, reqs)
    const nonceAfter = await publicClient.getTransactionCount({ address: FACILITATOR_ADDRESS })

    expect(result.success).toBe(false)
    expect(result.errorReason).toBe('invalid_exact_evm_payload_authorization_value')
    expect(result.transaction).toBe('')
    // The load-bearing assertion: not just success:false, but that the
    // facilitator's own account never submitted anything -- its nonce is
    // untouched. A regression that settled BEFORE re-verifying would
    // increment this.
    expect(nonceAfter).toBe(nonceBefore)
  })

  // task-8 review round 1, C1: `receipt.status === 'success'` proves only
  // that the CALL didn't revert, not that `Escrow.settleAuthorization`
  // actually ran. A call to a CODELESS address is a no-op at the EVM level --
  // it mines cleanly, with `status: 'success'` and no logs at all -- and
  // moves nothing. `Escrow._safeTransfer` already defends this exact hazard
  // one layer down for `withdraw`'s token address; this originally proved
  // `settlePayment`'s OWN receipt-log check caught it too, as a second-layer
  // defense exercised AFTER a transaction was actually mined.
  //
  // Final whole-branch review, C1, mechanism 3 supersedes that mechanism for
  // this specific fixture: `verifyPayment` now reads `escrow.token()` before
  // a wallet client is even constructed, and a codeless address has no
  // `token()` to read -- so this exact scenario is now rejected at
  // `/verify`, before a transaction is ever built, let alone sent. That is a
  // STRICTLY earlier and cheaper rejection than the original receipt-log
  // check (no gas spent at all, versus a mined-but-inert transaction). The
  // receipt-log check itself is still live -- it still covers the residual
  // case a codeless address cannot: a hostile contract that DOES implement
  // `token()` correctly but still forges or omits its settlement (see
  // "rejects a forged PaymentSettled log..." below, whose fixture now
  // constructs `HostileEscrow` with a matching `token()` specifically so it
  // still reaches that deeper check).
  it('never reports success for an authorization sent to a codeless address', async () => {
    const paymentId = freshPaymentId()
    const codelessAddress: Address = '0xc0dec0dec0dec0dec0dec0dec0dec0dec0dec0de'
    const auth = authFields(paymentId, { to: codelessAddress })
    const signature = await sign(auth)
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId, { payTo: codelessAddress })

    const nonceBefore = await publicClient.getTransactionCount({ address: FACILITATOR_ADDRESS })
    // Escrows overridden to TRUST the codeless address itself (task-8 review
    // round 2): simulates an operator who has (mistakenly) configured their
    // trusted escrow to be a codeless address.
    const result = await settle(payload, reqs, { escrows: { 'base-sepolia': codelessAddress } })
    const nonceAfter = await publicClient.getTransactionCount({ address: FACILITATOR_ADDRESS })

    expect(result.success).toBe(false)
    // Not `unexpected_settle_error` any more: `verifyPayment`'s own
    // escrow↔asset check (C1) rejects a codeless escrow before `settlePayment`
    // ever gets far enough to construct, let alone submit, a transaction.
    expect(result.errorReason).toBe('unexpected_verify_error')
    expect(result.transaction).toBe('')
    // The load-bearing assertion: no transaction was EVER sent -- strictly
    // stronger than the original "sent, mined, but correctly recognized as a
    // no-op" guarantee this test used to check.
    expect(nonceAfter).toBe(nonceBefore)
  })

  it('reverts MerchantNotBound on-chain for an authorization submitted against the wrong merchant', async () => {
    // verifyPayment's own check 2 recomputes the identical
    // keccak256(abi.encode(merchant, paymentId)) hash off-chain and rejects a
    // mismatch BEFORE any gas is spent (see base.ts's doc comment on that
    // check, and the "rejects a redirect attempt" test in verify.test.ts) --
    // so a mismatched merchant can never reach the chain through
    // settlePayment's own public API when the implementation is correct.
    // This test instead proves the on-chain guard `Escrow.sol` itself
    // enforces (the second, independent layer of the same defense, and the
    // one `decodeSettleRevert`'s `MerchantNotBound` branch exists to
    // recognize): it submits `settleAuthorization` directly, the same way
    // `settlePayment` does internally, with a `merchant` argument that does
    // NOT match the signed nonce, and asserts the contract rejects it.
    const paymentId = freshPaymentId()
    const auth = authFields(paymentId) // nonce bound to MERCHANT_EVM
    const signature = await sign(auth)
    const { r, s, v } = (() => {
      const sig = signature
      return {
        r: `0x${sig.slice(2, 66)}` as Hex,
        s: `0x${sig.slice(66, 130)}` as Hex,
        v: Number.parseInt(sig.slice(130, 132), 16),
      }
    })()

    const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY)
    const walletClient = createWalletClient({ account: facilitatorAccount, chain: foundry, transport: http(anvil.rpcUrl) })

    const wrongMerchant: Address = '0x9999999999999999999999999999999999999999'
    // Captured before the attempt, not asserted as an absolute 0 afterward --
    // MERCHANT_EVM is shared across every test in this file (it's the nonce
    // the signed authorization is bound to), so other tests may have already
    // credited it. The property under test is that THIS mismatched attempt
    // changes nothing, which a before/after delta proves regardless of
    // what other tests did.
    const merchantBalanceBefore = await merchantBalance(MERCHANT_EVM)
    let thrown: unknown
    try {
      await walletClient.writeContract({
        address: anvil.escrowAddress,
        abi: escrowAbi,
        functionName: 'settleAuthorization',
        args: [
          wrongMerchant,
          paymentId,
          { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
          v,
          r,
          s,
        ],
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(BaseError)
    const reverted = (thrown as BaseError).walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    expect(reverted?.data?.errorName).toBe('MerchantNotBound')

    // The mismatch was rejected -- neither merchant's balance moved.
    expect(await merchantBalance(MERCHANT_EVM)).toBe(merchantBalanceBefore)
    expect(await merchantBalance(wrongMerchant)).toBe(0n)

    // And settlePayment's own off-chain guard independently blocks the same
    // redirect attempt, without spending any gas: submitting the identical
    // signed payload under `requirements.extra.merchantEvm = wrongMerchant`
    // never reaches the chain at all.
    const redirectedReqs = requirements(paymentId, { extra: { merchantEvm: wrongMerchant, paymentId } })
    const redirectedPayload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const redirectResult = await settle(redirectedPayload, redirectedReqs)
    expect(redirectResult.success).toBe(false)
    expect(redirectResult.transaction).toBe('')
  })

  it('reports success:false for a mined-but-reverted transaction, not just a thrown error', async () => {
    const paymentId = freshPaymentId()
    const auth = authFields(paymentId)
    const signature = await sign(auth)
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId)

    const first = await settle(payload, reqs)
    expect(first.success).toBe(true)

    // Resubmitting the IDENTICAL (already-consumed) authorization: every
    // off-chain check in verifyPayment passes again unchanged (nothing about
    // the signed payload or the clock has changed), so settlePayment
    // proceeds to submit -- and MockUSDC's own single-use-nonce guard
    // (`AuthorizationAlreadyUsed`) reverts it on-chain. Because
    // `settlePayment` always passes an explicit `gas` (see `SETTLE_GAS_LIMIT`'s
    // doc comment), this reverts by being MINED, not by `writeContract`
    // throwing -- exactly the failure mode requirement 6 exists to guard.
    const second = await settle(payload, reqs)

    expect(second.success).toBe(false)
    expect(second.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(second.transaction).not.toBe(first.transaction)
    // task-8 review round 1: the most common real settle failure (a replay)
    // must be distinguishable from a generic error -- a caller needs to know
    // "already settled, release the resource" from "something broke, retry".
    expect(second.errorReason).toBe('duplicate_settlement')

    const receipt = await publicClient.getTransactionReceipt({ hash: second.transaction as Hex })
    expect(receipt.status).toBe('reverted')
  })

  it('fails a second settlement of the same authorization (single-use nonce), without double-crediting', async () => {
    const paymentId = freshPaymentId()
    const auth = authFields(paymentId)
    const signature = await sign(auth)
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId)

    // Delta-based, like every other balance assertion in this file:
    // MERCHANT_EVM is shared across every test (it's what the signed nonce is
    // bound to), so an earlier test's credit is still on the books here.
    const balanceBefore = await merchantBalance()
    const first = await settle(payload, reqs)
    expect(first.success).toBe(true)
    const balanceAfterFirst = await merchantBalance()
    expect(balanceAfterFirst - balanceBefore).toBe(10_000n)

    const second = await settle(payload, reqs)
    expect(second.success).toBe(false)
    expect(second.errorReason).toBe('duplicate_settlement')

    const balanceAfterSecond = await merchantBalance()
    expect(balanceAfterSecond).toBe(balanceAfterFirst)
  })

  // --- task-8 review round 2: trusted-escrow allowlist ----------------------
  //
  // The round-1 `PaymentSettled` emitter check (C1) proves CODE ran at
  // `payTo` -- it does not prove that code was genuinely this facilitator's
  // own `Escrow.sol`. A hostile contract deployed AT `payTo` can emit its own
  // `PaymentSettled` and pass that check trivially. The fix is to never trust
  // a caller-supplied `payTo` at all: `requirements.payTo` must match a
  // trusted escrow address configured by the facilitator OPERATOR
  // (`options.escrows`), checked before any chain interaction.
  it('rejects a hostile contract at payTo before ever sending a transaction', async () => {
    // A REAL contract, not just an arbitrary address -- it implements
    // Escrow.settleAuthorization's exact calldata shape and, if ever
    // actually called, would emit a fully-formed (forged) PaymentSettled
    // log. The allowlist must reject it WITHOUT ever finding that out.
    const deployer = privateKeyToAccount(FACILITATOR_PRIVATE_KEY)
    const walletClient = createWalletClient({ account: deployer, chain: foundry, transport: http(anvil.rpcUrl) })
    // `args: [anvil.tokenAddress]` -- HostileEscrow's `token()` getter (C1)
    // now needs to match `requirements.asset` so `verifyPayment`'s escrow↔asset
    // check doesn't reject this fixture before the scenario under test even
    // gets a chance to run.
    const deployHash = await walletClient.deployContract({ abi: hostileEscrowAbi, bytecode: hostileEscrowBytecode, args: [anvil.tokenAddress] })
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
    if (!deployReceipt.contractAddress) throw new Error('HostileEscrow deployment produced no contract address')
    const hostileAddress = deployReceipt.contractAddress

    const paymentId = freshPaymentId()
    const auth = authFields(paymentId, { to: hostileAddress })
    const signature = await sign(auth)
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId, { payTo: hostileAddress })

    const nonceBefore = await publicClient.getTransactionCount({ address: FACILITATOR_ADDRESS })
    // Uses settle()'s DEFAULT escrows (trusting the REAL anvil.escrowAddress)
    // -- hostileAddress is not in it.
    const result = await settle(payload, reqs)
    const nonceAfter = await publicClient.getTransactionCount({ address: FACILITATOR_ADDRESS })

    expect(result.success).toBe(false)
    expect(result.errorReason).toBe('invalid_payment_requirements')
    expect(result.transaction).toBe('')
    // The load-bearing assertion, per the review: not just success:false --
    // the facilitator never submitted anything at all, so the hostile
    // contract's forged PaymentSettled log was never even a possibility.
    expect(nonceAfter).toBe(nonceBefore)
  }, 15_000)

  it('rejects settlement when no escrow is configured for the network at all (fails closed)', async () => {
    const paymentId = freshPaymentId()
    const auth = authFields(paymentId)
    const signature = await sign(auth)
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId)

    const nonceBefore = await publicClient.getTransactionCount({ address: FACILITATOR_ADDRESS })
    // No `escrows` entry for 'base-sepolia' at all -- must reject, never fall
    // back to trusting requirements.payTo just because nothing was configured.
    const result = await settle(payload, reqs, { escrows: {} })
    const nonceAfter = await publicClient.getTransactionCount({ address: FACILITATOR_ADDRESS })

    expect(result.success).toBe(false)
    expect(result.errorReason).toBe('invalid_payment_requirements')
    expect(result.transaction).toBe('')
    expect(nonceAfter).toBe(nonceBefore)
  })

  it('rejects a forged PaymentSettled log even if the trusted-escrow allowlist is itself misconfigured to point at a hostile contract', async () => {
    // Defense in depth, not redundancy: the merchant/nonce cross-check on the
    // PaymentSettled log exists for exactly this scenario -- an operator
    // error (or a compromised config) that puts the WRONG address in
    // `escrows` still must not let a forged log be reported as a genuine
    // settlement. Unlike the allowlist tests above, this attempt DOES reach
    // the chain and DOES mine successfully (the misconfigured allowlist
    // trusts it); the cross-check catches it from the log's contents.
    const deployer = privateKeyToAccount(FACILITATOR_PRIVATE_KEY)
    const walletClient = createWalletClient({ account: deployer, chain: foundry, transport: http(anvil.rpcUrl) })
    // `args: [anvil.tokenAddress]` -- HostileEscrow's `token()` getter (C1)
    // now needs to match `requirements.asset` so `verifyPayment`'s escrow↔asset
    // check doesn't reject this fixture before the scenario under test even
    // gets a chance to run.
    const deployHash = await walletClient.deployContract({ abi: hostileEscrowAbi, bytecode: hostileEscrowBytecode, args: [anvil.tokenAddress] })
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
    if (!deployReceipt.contractAddress) throw new Error('HostileEscrow deployment produced no contract address')
    const hostileAddress = deployReceipt.contractAddress

    const paymentId = freshPaymentId()
    const auth = authFields(paymentId, { to: hostileAddress })
    const signature = await sign(auth)
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId, { payTo: hostileAddress })

    const result = await settle(payload, reqs, { escrows: { 'base-sepolia': hostileAddress } })

    expect(result.success).toBe(false)
    expect(result.errorReason).toBe('unexpected_settle_error')
    expect(result.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/)
  }, 15_000)

  // --- task-8 review round 2: duplicate_settlement, Error(string) tier -----
  describe('duplicate_settlement classification against a plain string revert', () => {
    let stringTokenAddress: Address
    let stringEscrowAddress: Address

    beforeAll(async () => {
      // Deployed onto the SAME already-running anvil instance (not a fresh
      // one) -- just two more contracts, no need to pay anvil's startup cost
      // twice.
      const deployer = privateKeyToAccount(FACILITATOR_PRIVATE_KEY)
      const walletClient = createWalletClient({ account: deployer, chain: foundry, transport: http(anvil.rpcUrl) })

      const tokenDeployHash = await walletClient.deployContract({ abi: stringRevertTokenAbi, bytecode: stringRevertTokenBytecode, args: [] })
      const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenDeployHash })
      if (!tokenReceipt.contractAddress) throw new Error('StringRevertToken deployment produced no contract address')
      stringTokenAddress = tokenReceipt.contractAddress

      const escrowDeployHash = await walletClient.deployContract({ abi: escrowAbi, bytecode: escrowBytecode, args: [stringTokenAddress] })
      const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowDeployHash })
      if (!escrowReceipt.contractAddress) throw new Error('Escrow (string-revert token) deployment produced no contract address')
      stringEscrowAddress = escrowReceipt.contractAddress

      const mintHash = await walletClient.writeContract({
        address: stringTokenAddress,
        abi: stringRevertTokenAbi,
        functionName: 'mint',
        args: [ANVIL_PAYER_ADDRESS, 1_000_000_000n],
      })
      await publicClient.waitForTransactionReceipt({ hash: mintHash })
    }, 30_000)

    it('classifies a real Error(string) "authorization is used or canceled" revert as duplicate_settlement', async () => {
      // Real Circle USDC (FiatTokenV2) rejects nonce reuse with exactly this
      // kind of plain string revert, not a custom error -- SettleToken.sol's
      // own AuthorizationAlreadyUsed() (exercised by the tests above) only
      // covers decodeSettleRevert's OTHER tier (a raw selector match). This
      // proves the Error(string) heuristic tier actually fires against a
      // real revert, not just a probe.
      const paymentId = freshPaymentId()
      const auth = authFields(paymentId, { to: stringEscrowAddress })
      const signature = await signAuthorization({
        privateKey: ANVIL_PAYER_PRIVATE_KEY,
        tokenAddress: stringTokenAddress,
        tokenName: 'StringRevertToken',
        tokenVersion: '1',
        chainId: anvil.chainId,
        authorization: auth,
      })
      const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
      const reqs = requirements(paymentId, { asset: stringTokenAddress, payTo: stringEscrowAddress })
      const escrows = { 'base-sepolia': stringEscrowAddress } as const

      const first = await settle(payload, reqs, { escrows })
      expect(first.success).toBe(true)

      const second = await settle(payload, reqs, { escrows })
      expect(second.success).toBe(false)
      expect(second.errorReason).toBe('duplicate_settlement')

      const receipt = await publicClient.getTransactionReceipt({ hash: second.transaction as Hex })
      expect(receipt.status).toBe('reverted')
    })
  })
})
