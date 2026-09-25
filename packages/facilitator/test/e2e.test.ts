import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createPublicClient, http, parseEventLogs, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { Client, AccountId, PrivateKey } from '@hashgraph/sdk'
import { ferry402, computeNonce } from '@ferry402/sdk'
import type { Ferry402Config } from '@ferry402/sdk'
import { createFacilitatorApp, journalEntryForSettlement, writeEntry, createHederaTopicSubmitter } from '../src/index.js'
import { escrowAbi } from './fixtures/Escrow.abi.js'
import { signAuthorization } from './support/fixtures.js'

/**
 * Task 10 — the live end-to-end run.
 *
 * This is the ONLY test file in this package that talks to real networks: a
 * real Base Sepolia RPC, a real deployed `Escrow`, real USDC, and a real
 * Hedera testnet topic. It spends real (testnet) funds on every run — a
 * facilitator-paid gas fee for at least one settlement transaction, and one
 * `ConsensusSubmitMessage` (~$0.0008) per HCS journal entry.
 *
 * **Gated behind `RUN_E2E=1`, deliberately not part of the default
 * `pnpm test`** (see the package.json `test:e2e` script and the root
 * README's "Live end-to-end run" section). `describe.skipIf` below means
 * this file is still collected by a bare `vitest run` — so it shows up as
 * SKIPPED, not silently absent — but neither its `beforeAll` nor its `it`
 * bodies execute unless `RUN_E2E=1` is set. This matters beyond convenience:
 * every credential this file needs (`PAYER_PRIVATE_KEY`,
 * `FACILITATOR_PRIVATE_KEY`, `HEDERA_PRIVATE_KEY`, ...) is read INSIDE
 * `beforeAll`, never at module top level, specifically so importing this
 * file in an environment with no `.env` at all (a fresh clone, CI) can never
 * throw during test collection and take the other 82 (real, offline)
 * facilitator tests down with it.
 */
const RUN_E2E = process.env.RUN_E2E === '1'

const USDC_ADDRESS_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const USDC_NAME = 'USDC'
const USDC_VERSION = '2'
const BASE_SEPOLIA_CHAIN_ID = 84532
/** $0.01 in USDC's 6-decimal atomic units. Kept deliberately tiny — this
 *  suite runs against a real, faucet-funded payer balance, not a mint. */
const PRICE_ATOMIC_UNITS = '10000'
const MIRROR_NODE_BASE_URL = 'https://testnet.mirrornode.hedera.com'

/**
 * This workspace resolves more than one physically-distinct install of
 * `viem`/`ox` (see `chains/base.ts`'s own doc comment on `createChainClient`
 * for the full explanation — a pnpm peer-dependency fork, not a version
 * mismatch). Naming `ReturnType<typeof createPublicClient>` directly at more
 * than one call site can therefore make TypeScript check assignability against two
 * DIFFERENT generic instantiations of the identical published type,
 * producing a spurious "two different types with this name exist" error.
 * Exactly one function creates this test's public client; every other
 * function that needs its type derives it from THIS function specifically,
 * matching `chains/base.ts`'s own established convention.
 */
function createTestPublicClient(rpcUrl: string) {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `e2e.test.ts: ${name} is required when RUN_E2E=1 (see .env.example). ` +
        'This test talks to real networks and cannot proceed without real credentials.',
    )
  }
  return value
}

/**
 * Polls `Escrow.balanceOf(address)` until it reaches at least
 * `expectedAtLeast`, or gives up and returns whatever it last read.
 *
 * `https://sepolia.base.org` is a public, load-balanced endpoint with no
 * read-your-writes guarantee across requests: `waitForTransactionReceipt`
 * (inside `settlePayment`) can get its receipt from one backend node the
 * instant a block lands, while this test's own very next `readContract` call
 * round-robins to a DIFFERENT node that has not yet indexed that same block.
 * Observed directly during this task's own live run — a `balanceOf` read
 * immediately after a successful settlement transiently returned the
 * PRE-settlement balance, then returned the correct post-settlement balance
 * moments later with no code change and no retry of the settlement itself.
 * Retrying the READ (not the settlement) is the correct fix for that kind of
 * eventual-consistency lag, as opposed to a real balance discrepancy.
 */
async function pollBalanceOf(
  publicClient: ReturnType<typeof createTestPublicClient>,
  escrowAddress: Address,
  merchantEvm: Address,
  expectedAtLeast: bigint,
  { retries = 10, delayMs = 2_000 }: { retries?: number; delayMs?: number } = {},
): Promise<bigint> {
  let last = 0n
  for (let attempt = 0; attempt < retries; attempt++) {
    last = (await publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: 'balanceOf', args: [merchantEvm] })) as bigint
    if (last >= expectedAtLeast) return last
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return last
}

/** Polls the Hedera testnet mirror node for a specific topic message by
 *  sequence number. Mirror-node ingestion lags consensus by a few seconds in
 *  practice; this retries rather than assuming the message is indexed the
 *  instant `writeEntry`'s receipt comes back. */
async function fetchMirrorTopicMessage(
  topicId: string,
  sequenceNumber: number,
  { retries = 20, delayMs = 3_000 }: { retries?: number; delayMs?: number } = {},
): Promise<{ message: string; consensus_timestamp: string; sequence_number: number }> {
  const url = `${MIRROR_NODE_BASE_URL}/api/v1/topics/${topicId}/messages/${sequenceNumber}`
  let lastStatus = 0
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      return (await res.json()) as { message: string; consensus_timestamp: string; sequence_number: number }
    }
    lastStatus = res.status
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`fetchMirrorTopicMessage: topic ${topicId} sequence ${sequenceNumber} never indexed after ${retries} attempts (last status ${lastStatus})`)
}

describe.skipIf(!RUN_E2E)('Task 10: live end-to-end run (Base Sepolia + Hedera testnet)', () => {
  let facilitatorServer: Server
  let merchantServer: Server
  let facilitatorBaseUrl: string
  let merchantBaseUrl: string
  let hederaClient: Client
  let publicClient: ReturnType<typeof createTestPublicClient>
  let config: Ferry402Config
  let merchantEvm: Address
  let payerAddress: Address
  let escrowAddress: Address
  let topicId: string

  beforeAll(async () => {
    // Loaded here (not at module top level) so the rest of this file's
    // module-scope evaluation is safe even with no .env present at all —
    // see this file's own doc comment.
    try {
      const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env')
      process.loadEnvFile(envPath)
    } catch {
      // No .env on disk — fall back to whatever the shell already exported.
      // requiredEnv() below still throws a clear error if something's missing.
    }

    const payerPrivateKey = requiredEnv('PAYER_PRIVATE_KEY') as Hex
    const facilitatorPrivateKey = requiredEnv('FACILITATOR_PRIVATE_KEY') as Hex
    const deployerPrivateKey = requiredEnv('DEPLOYER_PRIVATE_KEY') as Hex
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
    escrowAddress = requiredEnv('ESCROW_ADDRESS_BASE_SEPOLIA') as Address
    const hederaAccountId = requiredEnv('HEDERA_ACCOUNT_ID')
    const hederaPrivateKeyDer = requiredEnv('HEDERA_PRIVATE_KEY')
    topicId = requiredEnv('HCS_TOPIC_ID')

    payerAddress = privateKeyToAccount(payerPrivateKey).address
    // Reuses the deployer's own address as the merchant's EVM payout
    // address — an arbitrary, but already-known and already-controlled,
    // identity for this demo. `Escrow.balanceOf` is a plain internal ledger
    // row; the address named here needs no funding or code of its own to
    // receive credit.
    merchantEvm = privateKeyToAccount(deployerPrivateKey).address

    publicClient = createTestPublicClient(rpcUrl)
    hederaClient = Client.forTestnet().setOperator(AccountId.fromString(hederaAccountId), PrivateKey.fromStringDer(hederaPrivateKeyDer))

    // --- The facilitator: a real HTTP server, backed by real Base Sepolia RPC ---
    const facilitatorApp = createFacilitatorApp({
      rpcUrls: { 'base-sepolia': rpcUrl },
      facilitatorPrivateKey,
      escrows: { 'base-sepolia': escrowAddress },
    })
    facilitatorServer = await new Promise<Server>((resolve) => {
      const server = facilitatorApp.listen(0, '127.0.0.1', () => resolve(server))
    })
    const facilitatorPort = (facilitatorServer.address() as AddressInfo).port
    facilitatorBaseUrl = `http://127.0.0.1:${facilitatorPort}`

    // --- The merchant: a demo app using ferry402() exactly as an integrator would ---
    config = {
      price: '$0.01',
      accept: ['base-sepolia'],
      settleTo: 'hedera',
      merchant: hederaAccountId,
      // Type requires an entry per SupportedChain; only 'base-sepolia' is
      // ever read (config.accept lists only that chain) — the rest are
      // unused placeholders for this single-chain demo.
      merchantEvm: { 'base-sepolia': merchantEvm, base: merchantEvm, polygon: merchantEvm, 'polygon-amoy': merchantEvm },
      facilitator: facilitatorBaseUrl,
      escrows: { 'base-sepolia': escrowAddress, base: escrowAddress, polygon: escrowAddress, 'polygon-amoy': escrowAddress },
      assets: {
        'base-sepolia': USDC_ADDRESS_BASE_SEPOLIA,
        base: USDC_ADDRESS_BASE_SEPOLIA,
        polygon: USDC_ADDRESS_BASE_SEPOLIA,
        'polygon-amoy': USDC_ADDRESS_BASE_SEPOLIA,
      },
      // Test-scoped random secret — 64 bytes of hex, well over the 32-byte
      // minimum `ferry402()` enforces at construction.
      secret: randomBytes(32).toString('hex'),
    }

    const merchantApp = express()
    // The one-line integration (README / Task 6): `ferry402(config)` guards
    // the route, then the merchant's own handler runs after `next()`.
    // ferry402's middleware only calls /verify (see its own doc comment on
    // why /settle is deliberately out of scope for it) — actually collecting
    // payment, journaling it, and serving the resource is this handler's job,
    // exactly as packages/facilitator/README.md's "Typical wiring" documents.
    merchantApp.get('/paid-resource', ferry402(config), async (_req, res) => {
      const { payload, requirements } = res.locals.x402 as { payload: unknown; requirements: unknown }

      const settleRes = await fetch(`${facilitatorBaseUrl}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
      })
      const settleJson = (await settleRes.json()) as { success: boolean; errorReason?: string; transaction: string; network: string; payer: string }

      if (!settleJson.success) {
        res.status(402).json({ error: settleJson.errorReason ?? 'settlement_failed' })
        return
      }

      // The OBSERVED on-chain credit (Amendment 2) — read back from the
      // settlement transaction's own PaymentSettled log, not trusted from
      // the requested amount. A real (HTTP-only) merchant server has no
      // in-process access to settlePayment's SettleResult, so this is how it
      // would actually have to reconstruct it.
      const receipt = await publicClient.getTransactionReceipt({ hash: settleJson.transaction as Hex })
      const settledLogs = parseEventLogs({ abi: escrowAbi, eventName: 'PaymentSettled', logs: receipt.logs })
      const settled = settledLogs[0]
      if (!settled) {
        res.status(500).json({ error: 'no_settlement_log' })
        return
      }

      const entry = journalEntryForSettlement({
        merchant: config.merchant,
        merchantEvm,
        sourceChain: 'base-sepolia',
        settlement: {
          settledAmount: settled.args.value,
          nonce: settled.args.nonce,
          transaction: settleJson.transaction,
          payer: settleJson.payer,
        },
      })

      const submitter = createHederaTopicSubmitter(hederaClient)
      const journalResult = await writeEntry(entry, { topicId, submitter })

      res.status(200).json({
        resource: 'ferry402 e2e secret payload',
        settlement: {
          transaction: settleJson.transaction,
          network: settleJson.network,
          gasUsed: receipt.gasUsed.toString(),
          settledAmount: settled.args.value.toString(),
          nonce: settled.args.nonce,
        },
        journal: { topicId, sequenceNumber: journalResult.sequenceNumber, entry },
      })
    })

    merchantServer = await new Promise<Server>((resolve) => {
      const server = merchantApp.listen(0, '127.0.0.1', () => resolve(server))
    })
    const merchantPort = (merchantServer.address() as AddressInfo).port
    merchantBaseUrl = `http://127.0.0.1:${merchantPort}`
  }, 30_000)

  afterAll(async () => {
    await new Promise((resolve) => facilitatorServer?.close(resolve))
    await new Promise((resolve) => merchantServer?.close(resolve))
    hederaClient?.close()
  })

  it(
    'serves a 402 challenge, settles a real EIP-3009 payment on Base Sepolia, and journals it to HCS',
    async () => {
      // --- Step 1: no payment -> 402 with the full accepts array ---
      const challengeRes = await fetch(`${merchantBaseUrl}/paid-resource`)
      expect(challengeRes.status).toBe(402)
      const challengeBody = (await challengeRes.json()) as { x402Version: number; accepts: Array<Record<string, unknown>> }
      expect(challengeBody.x402Version).toBe(1)
      expect(challengeBody.accepts).toHaveLength(1)
      const requirement = challengeBody.accepts[0] as {
        network: string
        maxAmountRequired: string
        payTo: Address
        asset: Address
        extra: { merchantEvm: Address; paymentId: Hex }
      }
      expect(requirement.network).toBe('base-sepolia')
      expect(requirement.maxAmountRequired).toBe(PRICE_ATOMIC_UNITS)
      expect(requirement.payTo.toLowerCase()).toBe(escrowAddress.toLowerCase())

      // --- Step 2: sign a real EIP-3009 ReceiveWithAuthorization over real USDC ---
      const nonce = computeNonce(requirement.extra.merchantEvm, requirement.extra.paymentId)
      const nowSeconds = Math.floor(Date.now() / 1000)
      const authorization = {
        from: payerAddress,
        to: requirement.payTo,
        value: requirement.maxAmountRequired,
        validAfter: String(nowSeconds - 60),
        validBefore: String(nowSeconds + 600),
        nonce,
      }
      const signature = await signAuthorization({
        privateKey: requiredEnv('PAYER_PRIVATE_KEY') as Hex,
        tokenAddress: requirement.asset,
        tokenName: USDC_NAME,
        tokenVersion: USDC_VERSION,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        authorization,
      })

      const paymentPayload = {
        x402Version: 1,
        scheme: 'exact',
        network: 'base-sepolia',
        payload: { signature, authorization },
      }
      const xPaymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')

      const balanceBefore = (await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi,
        functionName: 'balanceOf',
        args: [merchantEvm],
      })) as bigint

      // --- Step 3: retry with X-PAYMENT -> 200 and the resource served ---
      const paidRes = await fetch(`${merchantBaseUrl}/paid-resource`, { headers: { 'X-PAYMENT': xPaymentHeader } })
      const paidBody = (await paidRes.json()) as {
        resource: string
        settlement: { transaction: Hex; network: string; gasUsed: string; settledAmount: string; nonce: Hex }
        journal: { topicId: string; sequenceNumber: number; entry: Record<string, unknown> }
      }
      // eslint-disable-next-line no-console
      console.log('[e2e] paid response:', JSON.stringify(paidBody, null, 2))
      expect(paidRes.status).toBe(200)
      expect(paidBody.resource).toBe('ferry402 e2e secret payload')

      const { transaction, gasUsed, settledAmount } = paidBody.settlement
      expect(settledAmount).toBe(PRICE_ATOMIC_UNITS)

      // eslint-disable-next-line no-console
      console.log(`[e2e] Base Sepolia settlement tx: https://sepolia.basescan.org/tx/${transaction}`)
      // eslint-disable-next-line no-console
      console.log(`[e2e] settlement gasUsed: ${gasUsed} (SETTLE_GAS_LIMIT is 500000)`)

      // --- Step 4: settlement landed on-chain -> escrow.balanceOf(merchantEvm) increased by the observed delta ---
      // Polled, not a single read -- see pollBalanceOf's doc comment for the
      // real eventual-consistency lag this observed against the public RPC.
      const balanceAfter = await pollBalanceOf(publicClient, escrowAddress, merchantEvm, balanceBefore + BigInt(settledAmount))
      expect(balanceAfter - balanceBefore).toBe(BigInt(settledAmount))

      // --- Step 5: read the journal entry back from the mirror node ---
      const mirrorMessage = await fetchMirrorTopicMessage(paidBody.journal.topicId, paidBody.journal.sequenceNumber)
      const decoded = JSON.parse(Buffer.from(mirrorMessage.message, 'base64').toString('utf8')) as Record<string, unknown>
      // eslint-disable-next-line no-console
      console.log(`[e2e] Hashscan HCS message: https://hashscan.io/testnet/transaction/${mirrorMessage.consensus_timestamp}`)
      // eslint-disable-next-line no-console
      console.log('[e2e] mirror-node journal entry:', JSON.stringify(decoded, null, 2))

      expect(decoded).toEqual(paidBody.journal.entry)
      expect(decoded.txHash).toBe(transaction)
      expect(decoded.amount).toBe(settledAmount)

      // --- Judgement item 2: attempt a second settlement of the SAME authorization ---
      // Real USDC (FiatTokenV2) reverts with the plain string
      // "FiatTokenV2: authorization is used or canceled" for an
      // already-consumed nonce -- decodeSettleRevert's tier-2 regex
      // (`/already used|used or (?:cancell?ed)|.../i`) is only ever exercised
      // against purpose-built fixtures elsewhere in this suite. This is the
      // one place it meets the real token.
      const duplicateRes = await fetch(`${facilitatorBaseUrl}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentPayload, paymentRequirements: requirement }),
      })
      const duplicateBody = (await duplicateRes.json()) as { success: boolean; errorReason?: string }
      // eslint-disable-next-line no-console
      console.log('[e2e] duplicate settlement attempt result:', JSON.stringify(duplicateBody))
      expect(duplicateBody.success).toBe(false)
      expect(duplicateBody.errorReason).toBe('duplicate_settlement')
    },
    180_000,
  )
})
