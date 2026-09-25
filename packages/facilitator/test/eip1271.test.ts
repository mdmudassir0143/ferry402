import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { computeNonce } from '@anychain402/sdk'
import { verifyPayment, settlePayment, type SettleOptions } from '../src/chains/base.js'
import { startAnvilWithEscrow, ANVIL_DEPLOYER_PRIVATE_KEY, ANVIL_PAYER_PRIVATE_KEY, ANVIL_PAYER_ADDRESS, type EscrowAnvilFixture } from './support/anvil.js'
import { escrowAbi } from './fixtures/Escrow.abi.js'
import { settleTokenAbi } from './fixtures/SettleToken.abi.js'
import { smartWalletAbi, smartWalletBytecode } from './fixtures/SmartWallet.abi.js'
import { buildRequirements, buildPayload, signAuthorization, type AuthorizationFields } from './support/fixtures.js'

/**
 * Task 11: EIP-1271 smart-contract-wallet signatures, exercised against a
 * REAL anvil instance end to end — `verifyPayment` AND `settlePayment`, not
 * just the pure-function dispatch logic — so this proves the whole chain:
 * `/verify`'s live `eth_getCode`/`isValidSignature` calls, AND
 * `settlePayment` picking `Escrow.settleAuthorizationWithSignature` (not the
 * `(v, r, s)` overload) and it actually crediting the merchant on-chain.
 *
 * `SmartWallet.sol` (see its own doc comment) is a pure test double: its
 * verdict is entirely controlled by `setAccepts`/`setReverts`, independent
 * of the actual signature bytes, because the property under test is whether
 * THIS FACILITATOR treats the wallet's verdict correctly — not whether a
 * smart wallet can implement its own signature scheme.
 */

const FACILITATOR_PRIVATE_KEY = ANVIL_DEPLOYER_PRIVATE_KEY
const MERCHANT_EVM: Address = '0x1111111111111111111111111111111111111111'
const TOKEN_NAME = 'SettleToken'
const TOKEN_VERSION = '1'

let anvil: EscrowAnvilFixture
let publicClient: ReturnType<typeof createPublicClient>
let walletClient: ReturnType<typeof createWalletClient>
let nextPaymentIdSeed = 1

beforeAll(async () => {
  anvil = await startAnvilWithEscrow()
  publicClient = createPublicClient({ chain: foundry, transport: http(anvil.rpcUrl) })
  walletClient = createWalletClient({ account: privateKeyToAccount(FACILITATOR_PRIVATE_KEY), chain: foundry, transport: http(anvil.rpcUrl) })
}, 30_000)

afterAll(async () => {
  await anvil?.stop()
})

function freshPaymentId(): Hex {
  const seed = nextPaymentIdSeed++
  return `0x${seed.toString(16).padStart(64, '0')}` as Hex
}

function authFields(from: Address, paymentId: Hex, overrides: Partial<AuthorizationFields> = {}): AuthorizationFields {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return {
    from,
    to: anvil.escrowAddress,
    value: '10000',
    validAfter: String(nowSeconds - 60),
    validBefore: String(nowSeconds + 300),
    nonce: computeNonce(MERCHANT_EVM, paymentId),
    ...overrides,
  }
}

function requirements(paymentId: Hex) {
  return buildRequirements({
    asset: anvil.tokenAddress,
    payTo: anvil.escrowAddress,
    maxAmountRequired: '10000',
    extra: { merchantEvm: MERCHANT_EVM, paymentId },
  })
}

async function mintTo(to: Address, amount: bigint): Promise<void> {
  const hash = await walletClient.writeContract({
    address: anvil.tokenAddress,
    abi: settleTokenAbi,
    functionName: 'mint',
    args: [to, amount],
    chain: foundry,
    account: walletClient.account!,
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

/** Deploys a fresh `SmartWallet` on the shared anvil instance, pre-funded
 *  with 1_000e-ish token units so a successful settlement has something to
 *  actually move. */
async function deploySmartWallet(accepts: boolean): Promise<Address> {
  const deployHash = await walletClient.deployContract({
    abi: smartWalletAbi,
    bytecode: smartWalletBytecode,
    args: [accepts],
    chain: foundry,
    account: walletClient.account!,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
  if (!receipt.contractAddress) throw new Error('SmartWallet deployment produced no contract address')
  await mintTo(receipt.contractAddress, 1_000_000n)
  return receipt.contractAddress
}

async function merchantBalance(): Promise<bigint> {
  return publicClient.readContract({ address: anvil.escrowAddress, abi: escrowAbi, functionName: 'balanceOf', args: [MERCHANT_EVM] })
}

async function verify(payload: ReturnType<typeof buildPayload>, reqs: ReturnType<typeof buildRequirements>) {
  return verifyPayment(payload, reqs, { rpcUrl: anvil.rpcUrl, escrows: { 'base-sepolia': anvil.escrowAddress } })
}

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

// An arbitrary, non-65-byte signature blob. SmartWallet ignores its content
// entirely (see its doc comment); its length (anything but 65) is what
// routes `recoverSigner` to the EIP-1271 branch at all.
const ARBITRARY_SIGNATURE: Hex = '0xdeadbeef'

describe('EIP-1271 smart-contract wallet signatures', () => {
  it('a smart wallet that accepts settles and credits the merchant, exactly like an EOA', async () => {
    const wallet = await deploySmartWallet(true)
    const paymentId = freshPaymentId()
    const auth = authFields(wallet, paymentId)
    const payload = buildPayload({ network: 'base-sepolia', signature: ARBITRARY_SIGNATURE, authorization: auth })
    const reqs = requirements(paymentId)

    const verifyResult = await verify(payload, reqs)
    expect(verifyResult.isValid).toBe(true)
    expect(verifyResult.payer).toBe(wallet)

    const before = await merchantBalance()
    const result = await settle(payload, reqs)
    expect(result.success).toBe(true)
    expect(result.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/)
    const after = await merchantBalance()
    expect(after - before).toBe(10000n)
  }, 20_000)

  it('a smart wallet returning the wrong magic value is rejected', async () => {
    const wallet = await deploySmartWallet(false)
    const paymentId = freshPaymentId()
    const auth = authFields(wallet, paymentId)
    const payload = buildPayload({ network: 'base-sepolia', signature: ARBITRARY_SIGNATURE, authorization: auth })
    const reqs = requirements(paymentId)

    const verifyResult = await verify(payload, reqs)
    expect(verifyResult.isValid).toBe(false)
    expect(verifyResult.invalidReason).toBe('invalid_exact_evm_payload_signature')

    const result = await settle(payload, reqs)
    expect(result.success).toBe(false)
    expect(result.transaction).toBe('')
  }, 20_000)

  it('a smart wallet whose isValidSignature reverts is rejected, not an unhandled error', async () => {
    const wallet = await deploySmartWallet(true)
    const setRevertsHash = await walletClient.writeContract({
      address: wallet,
      abi: smartWalletAbi,
      functionName: 'setReverts',
      args: [true],
      chain: foundry,
      account: walletClient.account!,
    })
    await publicClient.waitForTransactionReceipt({ hash: setRevertsHash })

    const paymentId = freshPaymentId()
    const auth = authFields(wallet, paymentId)
    const payload = buildPayload({ network: 'base-sepolia', signature: ARBITRARY_SIGNATURE, authorization: auth })
    const reqs = requirements(paymentId)

    // The whole point: verifyPayment must return a normal {isValid:false}
    // result, never throw / reject the promise.
    await expect(verify(payload, reqs)).resolves.toMatchObject({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_signature',
    })

    await expect(settle(payload, reqs)).resolves.toMatchObject({ success: false, transaction: '' })
  }, 20_000)

  it('a codeless `from` with a non-65-byte signature is rejected', async () => {
    const codelessFrom: Address = '0xc0dec0dec0dec0dec0dec0dec0dec0dec0dec0de'
    const paymentId = freshPaymentId()
    const auth = authFields(codelessFrom, paymentId)
    const payload = buildPayload({ network: 'base-sepolia', signature: ARBITRARY_SIGNATURE, authorization: auth })
    const reqs = requirements(paymentId)

    const verifyResult = await verify(payload, reqs)
    expect(verifyResult.isValid).toBe(false)
    expect(verifyResult.invalidReason).toBe('invalid_exact_evm_payload_signature')

    const result = await settle(payload, reqs)
    expect(result.success).toBe(false)
  }, 20_000)

  it('the plain-EOA ECDSA path is unchanged', async () => {
    const paymentId = freshPaymentId()
    const auth = authFields(ANVIL_PAYER_ADDRESS, paymentId)
    const signature = await signAuthorization({
      privateKey: ANVIL_PAYER_PRIVATE_KEY,
      tokenAddress: anvil.tokenAddress,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      chainId: anvil.chainId,
      authorization: auth,
    })
    const payload = buildPayload({ network: 'base-sepolia', signature, authorization: auth })
    const reqs = requirements(paymentId)

    const verifyResult = await verify(payload, reqs)
    expect(verifyResult.isValid).toBe(true)
    expect(verifyResult.payer).toBe(ANVIL_PAYER_ADDRESS)

    const before = await merchantBalance()
    const result = await settle(payload, reqs)
    expect(result.success).toBe(true)
    const after = await merchantBalance()
    expect(after - before).toBe(10000n)
  }, 20_000)
})
