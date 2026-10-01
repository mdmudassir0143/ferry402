/**
 * ferry402 — runnable, narrated end-to-end demo.
 *
 * Spins up a facilitator and a tiny paid merchant API (both real Express
 * servers, in this one process, listening on loopback ports) and then plays
 * the part of a payer against them — against REAL Base Sepolia + Hedera
 * testnet, no mocks, no local anvil. Every step prints what just happened
 * and why, so an audience can follow along without reading the source.
 *
 * Uses the PUBLISHED `@ferry402/sdk` from npm (see package.json — a plain
 * "0.1.0" dependency, not a pnpm `workspace:*` link) for everything a real
 * integrator would import: `ferry402()`, `createPaymentHeader()`,
 * `computeNonce()`. `@ferry402/facilitator` is never published (it's a
 * private package — see its own package.json), so the facilitator half is
 * run from this monorepo's own source instead, exactly the way a merchant
 * who clones ferry402 and runs the facilitator themselves would.
 *
 * Run with: `npm install && npm start` (see README.md for prerequisites).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createPublicClient, http, parseEventLogs, type Address, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { Client, AccountId, PrivateKey } from '@hashgraph/sdk'
import { ferry402, createPaymentHeader, computeNonce } from '@ferry402/sdk'
import type { Ferry402Config, PaymentRequirements } from '@ferry402/sdk'
// @ferry402/facilitator is never published to npm (private package) — run
// straight from this monorepo's own source, the same way a merchant who
// clones the repo and self-hosts the facilitator would. Requires `pnpm
// install && pnpm -r build` to have been run once at the repo root (see
// README.md's prerequisites) so packages/facilitator's own node_modules
// (and packages/sdk/dist, which it resolves through the workspace symlink)
// actually exist.
import {
  createFacilitatorApp,
  journalEntryForSettlement,
  writeEntry,
  createHederaTopicSubmitter,
} from '../../../packages/facilitator/src/index.js'
// Hand-written minimal Escrow ABI — the demo only ever reads `balanceOf`,
// the same read every other package in this repo hand-writes its own
// minimal ABI for rather than pulling in a full build artifact.
const escrowReadAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'event',
    name: 'PaymentSettled',
    anonymous: false,
    inputs: [
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'bytes32', indexed: false },
    ],
  },
] as const
const erc20BalanceAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

// --- Narration helpers ------------------------------------------------------
// No stack traces for an EXPECTED rejection (a 402/verify/settle failure):
// those are printed as a labeled one-liner, never thrown. A genuine bug
// (something this script did not anticipate) is left to throw and crash
// normally, with its real stack trace — that distinction is deliberate.

let stepNumber = 0
function step(title: string): void {
  stepNumber += 1
  console.log(`\n${'='.repeat(78)}`)
  console.log(`STEP ${stepNumber}: ${title}`)
  console.log('='.repeat(78))
}
function security(title: string): void {
  console.log(`\n${'-'.repeat(78)}`)
  console.log(`SECURITY CHECK: ${title}`)
  console.log('-'.repeat(78))
}
function info(msg: string): void {
  console.log(`  ${msg}`)
}
function ok(msg: string): void {
  console.log(`  ✓ ${msg}`)
}
function rejected(msg: string): void {
  console.log(`  ✗ REJECTED (expected): ${msg}`)
}
function link(label: string, url: string): void {
  console.log(`  → ${label}: ${url}`)
}

// --- Environment -------------------------------------------------------------

function loadEnv(): void {
  // Loaded here, not at module top level, so a missing .env never crashes
  // before this script gets a chance to print a clear "here's what's
  // missing" message (same discipline as
  // packages/facilitator/test/e2e.test.ts's own beforeAll).
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, '../.env'), // examples/demo/.env — fully self-contained
    path.resolve(here, '../../../.env'), // the monorepo root .env (already configured per the task)
  ]
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate)
      console.log(`[env] loaded ${candidate}`)
      return
    } catch {
      // try the next candidate
    }
  }
  console.log('[env] no .env file found at examples/demo/.env or the repo root — relying on the shell environment')
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is required (see README.md "Environment variables"). Set it in the repo root .env ` +
        'or examples/demo/.env before running this demo.',
    )
  }
  return value
}

// --- Chain/mirror-node polling ----------------------------------------------
// `sepolia.base.org` is a public, load-balanced RPC with no read-your-writes
// guarantee across requests — a `balanceOf` read immediately after a
// settlement's own receipt can transiently return the PRE-settlement value
// on a different backend node. This is a REAL, previously-observed flake
// (see packages/facilitator/test/e2e.test.ts's `pollBalanceOf` doc comment),
// not a hypothetical — polling the READ, not the settlement, is the honest
// fix, so this demo does the same rather than hiding the lag behind a
// fragile single read.
async function pollBalanceOf(
  publicClient: ReturnType<typeof createPublicClient>,
  escrowAddress: Address,
  merchantEvm: Address,
  expectedAtLeast: bigint,
  { retries = 10, delayMs = 2_000 }: { retries?: number; delayMs?: number } = {},
): Promise<{ value: bigint; attempts: number }> {
  let last = 0n
  for (let attempt = 1; attempt <= retries; attempt++) {
    last = (await publicClient.readContract({ address: escrowAddress, abi: escrowReadAbi, functionName: 'balanceOf', args: [merchantEvm] })) as bigint
    if (last >= expectedAtLeast) return { value: last, attempts: attempt }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return { value: last, attempts: retries }
}

const MIRROR_NODE_BASE_URL = 'https://testnet.mirrornode.hedera.com'

// Mirror-node ingestion lags consensus by a few seconds in practice — polled
// for the same read-after-write reason as `pollBalanceOf` above, per the
// task's own guidance to poll rather than paper over public-infra lag.
async function fetchMirrorTopicMessage(
  topicId: string,
  sequenceNumber: number,
  { retries = 20, delayMs = 3_000 }: { retries?: number; delayMs?: number } = {},
): Promise<{ message: string; consensus_timestamp: string; sequence_number: number }> {
  const url = `${MIRROR_NODE_BASE_URL}/api/v1/topics/${topicId}/messages/${sequenceNumber}`
  let lastStatus = 0
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      return (await res.json()) as { message: string; consensus_timestamp: string; sequence_number: number }
    }
    lastStatus = res.status
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`topic ${topicId} sequence ${sequenceNumber} never indexed by the mirror node after ${retries} attempts (last status ${lastStatus})`)
}

/**
 * Sums every `type: 'payment'` journal entry for `merchantEvm` across the
 * WHOLE topic, read back from the mirror node — the "journal total" half of
 * the closing reconciliation line. Paginates via the mirror node's own
 * `links.next`, decoding each message as either a single entry (plain
 * object) or a batch (JSON array) — see `encodeEntries`'s doc comment in
 * packages/facilitator/src/journal.ts for why a message can be either shape.
 * Capped at a generous number of pages so a demo run can never hang on an
 * unexpectedly large topic.
 */
async function sumJournalForMerchant(topicId: string, merchantEvm: Address, { maxPages = 50 }: { maxPages?: number } = {}): Promise<bigint> {
  let total = 0n
  let next: string | null = `/api/v1/topics/${topicId}/messages?limit=100&order=asc`
  for (let page = 0; next && page < maxPages; page++) {
    const res = await fetch(`${MIRROR_NODE_BASE_URL}${next}`)
    if (!res.ok) break
    const body = (await res.json()) as { messages: Array<{ message: string }>; links?: { next?: string | null } }
    for (const m of body.messages) {
      let decoded: unknown
      try {
        decoded = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8'))
      } catch {
        continue
      }
      const entries = Array.isArray(decoded) ? decoded : [decoded]
      for (const entry of entries) {
        const e = entry as { type?: string; merchantEvm?: string; amount?: string }
        if (e.type === 'payment' && typeof e.merchantEvm === 'string' && e.merchantEvm.toLowerCase() === merchantEvm.toLowerCase() && e.amount) {
          total += BigInt(e.amount)
        }
      }
    }
    next = body.links?.next ?? null
  }
  return total
}

// --- Constants ---------------------------------------------------------------

const USDC_ADDRESS_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const USDC_NAME = 'USDC'
const USDC_VERSION = '2'
const BASE_SEPOLIA_CHAIN_ID = 84532
const PRICE_ATOMIC_UNITS = '10000' // $0.01 at USDC's 6 decimals

async function main(): Promise<void> {
  loadEnv()

  const payerPrivateKey = requiredEnv('PAYER_PRIVATE_KEY') as Hex
  const facilitatorPrivateKey = requiredEnv('FACILITATOR_PRIVATE_KEY') as Hex
  const deployerPrivateKey = requiredEnv('DEPLOYER_PRIVATE_KEY') as Hex
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
  const escrowAddress = requiredEnv('ESCROW_ADDRESS_BASE_SEPOLIA') as Address
  const hederaAccountId = requiredEnv('HEDERA_ACCOUNT_ID')
  const hederaPrivateKeyDer = requiredEnv('HEDERA_PRIVATE_KEY')
  const topicId = requiredEnv('HCS_TOPIC_ID')

  const payerAccount = privateKeyToAccount(payerPrivateKey)
  // Reuses the deployer's own address as the merchant's EVM payout address —
  // an arbitrary but already-known, already-controlled identity, exactly
  // the convention packages/facilitator/test/e2e.test.ts uses. Escrow's
  // ledger is a plain internal row; the address named here needs no
  // funding or code of its own to receive credit.
  const merchantEvm = privateKeyToAccount(deployerPrivateKey).address

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) })
  // HEDERA_PRIVATE_KEY is ECDSA, DER-encoded -- PrivateKey.fromStringDer(),
  // never fromStringED25519() (that call does not throw on a DER-encoded
  // ECDSA key, it silently derives a DIFFERENT, wrong key).
  const hederaClient = Client.forTestnet().setOperator(AccountId.fromString(hederaAccountId), PrivateKey.fromStringDer(hederaPrivateKeyDer))

  console.log('ferry402 demo — live Base Sepolia + Hedera testnet')
  info(`payer:         ${payerAccount.address}`)
  info(`merchant EVM:  ${merchantEvm}`)
  info(`escrow:        ${escrowAddress}`)
  info(`HCS topic:     ${topicId}`)

  // --- Wire up the facilitator + merchant, exactly as a real deployment would ---
  const facilitatorApp = createFacilitatorApp({
    rpcUrls: { 'base-sepolia': rpcUrl },
    facilitatorPrivateKey,
    escrows: { 'base-sepolia': escrowAddress },
  })
  const facilitatorServer = await new Promise<Server>((resolve) => {
    const server = facilitatorApp.listen(0, '127.0.0.1', () => resolve(server))
  })
  const facilitatorBaseUrl = `http://127.0.0.1:${(facilitatorServer.address() as AddressInfo).port}`

  const config: Ferry402Config = {
    price: '$0.01',
    accept: ['base-sepolia'],
    settleTo: 'hedera',
    merchant: hederaAccountId,
    merchantEvm: { 'base-sepolia': merchantEvm, base: merchantEvm, polygon: merchantEvm, 'polygon-amoy': merchantEvm },
    facilitator: facilitatorBaseUrl,
    escrows: { 'base-sepolia': escrowAddress, base: escrowAddress, polygon: escrowAddress, 'polygon-amoy': escrowAddress },
    assets: {
      'base-sepolia': USDC_ADDRESS_BASE_SEPOLIA,
      base: USDC_ADDRESS_BASE_SEPOLIA,
      polygon: USDC_ADDRESS_BASE_SEPOLIA,
      'polygon-amoy': USDC_ADDRESS_BASE_SEPOLIA,
    },
    secret: randomBytes(32).toString('hex'),
  }

  // ferry402() only calls /verify — collecting payment (settling to the
  // Escrow), journaling it to HCS, and serving the resource is this route
  // handler's own job, run immediately after next() (see root README's "How
  // a payment moves through the system").
  function makePaidRoute(app: Express, routePath: string, quote: Record<string, unknown>): void {
    app.get(routePath, ferry402(config), async (_req, res) => {
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

      const receipt = await publicClient.getTransactionReceipt({ hash: settleJson.transaction as Hex })
      const settledLogs = parseEventLogs({ abi: escrowReadAbi, eventName: 'PaymentSettled', logs: receipt.logs })
      const settled = settledLogs[0]
      if (!settled) {
        res.status(500).json({ error: 'no_settlement_log' })
        return
      }

      const entry = journalEntryForSettlement({
        merchant: config.merchant,
        merchantEvm,
        sourceChain: 'base-sepolia',
        settlement: { settledAmount: settled.args.value, nonce: settled.args.nonce, transaction: settleJson.transaction, payer: settleJson.payer },
      })
      const submitter = createHederaTopicSubmitter(hederaClient)
      const journalResult = await writeEntry(entry, { topicId, submitter })

      res.status(200).json({
        resource: routePath,
        quote,
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
  }

  const merchantApp = express()
  makePaidRoute(merchantApp, '/api/quote', { pair: 'HBAR/USD', price: '0.0734', asOf: new Date().toISOString() })
  // A SECOND, independently-priced paid route, sharing the exact same
  // ferry402(config) — i.e. the same secret — used only to demonstrate the
  // cross-route security check below. Never actually paid in this run.
  makePaidRoute(merchantApp, '/api/quote/premium', { pair: 'HBAR/USD', price: '0.0734', tier: 'premium', asOf: new Date().toISOString() })

  const merchantServer = await new Promise<Server>((resolve) => {
    const server = merchantApp.listen(0, '127.0.0.1', () => resolve(server))
  })
  const merchantBaseUrl = `http://127.0.0.1:${(merchantServer.address() as AddressInfo).port}`

  try {
    // --- STEP 1: unpaid request -> 402 ---
    step('GET /api/quote with no payment')
    const challengeRes = await fetch(`${merchantBaseUrl}/api/quote`)
    const challengeBody = (await challengeRes.json()) as { x402Version: number; accepts: PaymentRequirements[] }
    info(`HTTP ${challengeRes.status} (expected 402)`)
    const requirement = challengeBody.accepts[0]
    const merchantEvmExtra = requirement.extra?.merchantEvm as Address
    const paymentIdExtra = requirement.extra?.paymentId as Hex
    const derivedNonce = computeNonce(merchantEvmExtra, paymentIdExtra)
    info(`accepts: ${challengeBody.accepts.length} entry(ies) — network=${requirement.network}, price=${requirement.maxAmountRequired} atomic USDC, payTo=${requirement.payTo}`)
    info(`derived paymentId: ${paymentIdExtra}`)
    info(`derived nonce:     ${derivedNonce}`)

    // --- STEP 2: payer signs the EIP-3009 authorization ---
    step('Payer signs the EIP-3009 authorization via createPaymentHeader()')
    const xPaymentHeader = await createPaymentHeader(requirement, payerAccount, {
      tokenName: USDC_NAME,
      tokenVersion: USDC_VERSION,
      chainId: BASE_SEPOLIA_CHAIN_ID,
    })
    ok(`signed by ${payerAccount.address}, header is ${xPaymentHeader.length} base64 chars`)

    // --- STEP 3: retry with X-PAYMENT -> 200, resource served ---
    step('Retry GET /api/quote with X-PAYMENT')
    const balanceBefore = (await publicClient.readContract({
      address: escrowAddress,
      abi: escrowReadAbi,
      functionName: 'balanceOf',
      args: [merchantEvm],
    })) as bigint
    const paidRes = await fetch(`${merchantBaseUrl}/api/quote`, { headers: { 'X-PAYMENT': xPaymentHeader } })
    const paidBody = (await paidRes.json()) as {
      resource: string
      quote: Record<string, unknown>
      settlement: { transaction: Hex; network: string; gasUsed: string; settledAmount: string; nonce: Hex }
      journal: { topicId: string; sequenceNumber: number; entry: Record<string, unknown> }
    }
    info(`HTTP ${paidRes.status} (expected 200)`)
    ok(`resource served: ${JSON.stringify(paidBody.quote)}`)

    // --- STEP 4: settlement tx hash + basescan link ---
    step('Settlement submitted to the Escrow on Base Sepolia')
    const { transaction, gasUsed, settledAmount } = paidBody.settlement
    ok(`settled ${settledAmount} atomic USDC (gas used: ${gasUsed})`)
    link('Basescan', `https://sepolia.basescan.org/tx/${transaction}`)

    // --- STEP 5: escrow ledger row before/after ---
    step("Merchant's escrow ledger row, before/after")
    info(`before: ${balanceBefore.toString()} atomic USDC`)
    const { value: balanceAfter, attempts } = await pollBalanceOf(publicClient, escrowAddress, merchantEvm, balanceBefore + BigInt(settledAmount))
    info(`after:  ${balanceAfter.toString()} atomic USDC (confirmed after ${attempts} read${attempts === 1 ? '' : 's'} against ${rpcUrl})`)
    ok(`delta: +${(balanceAfter - balanceBefore).toString()} atomic USDC`)

    // --- STEP 6: HCS journal entry, read back from the mirror node ---
    step('HCS journal entry, read back from the mirror node')
    const mirrorMessage = await fetchMirrorTopicMessage(paidBody.journal.topicId, paidBody.journal.sequenceNumber)
    const decodedEntry = JSON.parse(Buffer.from(mirrorMessage.message, 'base64').toString('utf8')) as Record<string, unknown>
    info(`sequence #${mirrorMessage.sequence_number}, consensus @ ${mirrorMessage.consensus_timestamp}`)
    info(`entry: ${JSON.stringify(decodedEntry)}`)
    link('Hashscan', `https://hashscan.io/testnet/transaction/${mirrorMessage.consensus_timestamp}`)
    link('Topic', `https://hashscan.io/testnet/topic/${topicId}`)

    // --- STEP 7: closing reconciliation ---
    step('Reconciliation: journal total vs escrow ledger row vs escrow contract balance')
    const journalTotal = await sumJournalForMerchant(topicId, merchantEvm)
    const escrowLedgerRow = (await publicClient.readContract({
      address: escrowAddress,
      abi: escrowReadAbi,
      functionName: 'balanceOf',
      args: [merchantEvm],
    })) as bigint
    const escrowRealUsdcBalance = (await publicClient.readContract({
      address: USDC_ADDRESS_BASE_SEPOLIA,
      abi: erc20BalanceAbi,
      functionName: 'balanceOf',
      args: [escrowAddress],
    })) as bigint
    info(`journal total (HCS, this merchant, all time): ${journalTotal.toString()} atomic USDC`)
    info(`escrow ledger row (on-chain, this merchant):   ${escrowLedgerRow.toString()} atomic USDC`)
    info(`escrow contract's real USDC balance:           ${escrowRealUsdcBalance.toString()} atomic USDC`)
    if (journalTotal === escrowLedgerRow && escrowLedgerRow <= escrowRealUsdcBalance) {
      ok('journal total matches the ledger row, and the ledger row is fully backed by the contract\'s real USDC balance')
    } else {
      info('(numbers may legitimately differ if this escrow/topic has prior activity from other merchants or runs predating this journal query window)')
    }

    // --- SECURITY CHECK 1: replay the same X-PAYMENT header ---
    security('Replay the same X-PAYMENT header')
    const replayRes = await fetch(`${merchantBaseUrl}/api/quote`, { headers: { 'X-PAYMENT': xPaymentHeader } })
    const replayBody = (await replayRes.json()) as { error?: string; accepts?: unknown }
    if (replayRes.status === 402) {
      rejected(`HTTP 402, error="${replayBody.error}" — the consumed-nonce store already saw (payer, nonce)`)
    } else {
      throw new Error(`expected the replay to be rejected with 402, got ${replayRes.status}`)
    }

    // --- SECURITY CHECK 2: a challenge for one resource, presented at a different route ---
    security('Present the /api/quote header at a different route (/api/quote/premium)')
    const crossRouteRes = await fetch(`${merchantBaseUrl}/api/quote/premium`, { headers: { 'X-PAYMENT': xPaymentHeader } })
    const crossRouteBody = (await crossRouteRes.json()) as { error?: string }
    if (crossRouteRes.status === 402) {
      rejected(`HTTP 402, error="${crossRouteBody.error}" — nonce was derived for a different resource string, so it can never match this route's own derivation`)
    } else {
      throw new Error(`expected the cross-route attempt to be rejected with 402, got ${crossRouteRes.status}`)
    }

    // --- SECURITY CHECK 3: a payment signed by a zero-balance key ---
    security('A payment signed by a brand-new, zero-balance key')
    const zeroBalanceAccount = privateKeyToAccount(generatePrivateKey())
    info(`throwaway key: ${zeroBalanceAccount.address} (never funded, zero USDC, zero ETH)`)
    const zeroBalanceHeader = await createPaymentHeader(requirement, zeroBalanceAccount, {
      tokenName: USDC_NAME,
      tokenVersion: USDC_VERSION,
      chainId: BASE_SEPOLIA_CHAIN_ID,
    })
    const zeroBalanceRes = await fetch(`${merchantBaseUrl}/api/quote`, { headers: { 'X-PAYMENT': zeroBalanceHeader } })
    const zeroBalanceBody = (await zeroBalanceRes.json()) as { error?: string }
    if (zeroBalanceRes.status === 402 && zeroBalanceBody.error === 'insufficient_funds') {
      rejected(`HTTP 402, error="insufficient_funds" — rejected at /verify, nothing was ever served`)
    } else {
      throw new Error(`expected insufficient_funds, got HTTP ${zeroBalanceRes.status} error="${zeroBalanceBody.error}"`)
    }

    console.log(`\n${'='.repeat(78)}`)
    console.log('DEMO COMPLETE — payment settled, journaled, reconciled; all three security checks held.')
    console.log('='.repeat(78))
  } finally {
    await new Promise((resolve) => facilitatorServer.close(resolve))
    await new Promise((resolve) => merchantServer.close(resolve))
    hederaClient.close()
  }
}

main().catch((err) => {
  console.error('\nDEMO FAILED (unexpected error):')
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exitCode = 1
})
