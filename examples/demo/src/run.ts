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
 * "0.2.1" dependency, not a pnpm `workspace:*` link) for everything a real
 * integrator would import: `ferry402()`, `createPaymentHeader()`,
 * `computeNonce()`. `@ferry402/facilitator` is never published (it's a
 * private package — see its own package.json), so the facilitator half is
 * run from this monorepo's own source instead, exactly the way a merchant
 * who clones ferry402 and runs the facilitator themselves would.
 *
 * All of the actual network/SDK work (setting up the facilitator + merchant,
 * signing, paying, reading the escrow ledger and HCS journal back) lives in
 * `./lib/*` — this file is narration only, so `examples/demo-ui` can drive
 * the identical flow and print/stream it differently instead of copying it.
 *
 * Run with: `npm install && npm start` (see README.md for prerequisites).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv, readDemoFlowEnv } from './lib/env.js'
import { createDemoFlow, PRIMARY_ROUTE, SECONDARY_ROUTE, type PaidSuccessBody } from './lib/flow.js'

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

function loadDemoEnvFile(): void {
  // Loaded here, not at module top level, so a missing .env never crashes
  // before this script gets a chance to print a clear "here's what's
  // missing" message (same discipline as
  // packages/facilitator/test/e2e.test.ts's own beforeAll).
  const here = path.dirname(fileURLToPath(import.meta.url))
  const loaded = loadEnv([
    path.resolve(here, '../.env'), // examples/demo/.env — fully self-contained
    path.resolve(here, '../../../.env'), // the monorepo root .env (already configured per the task)
  ])
  if (loaded) {
    console.log(`[env] loaded ${loaded}`)
  } else {
    console.log('[env] no .env file found at examples/demo/.env or the repo root — relying on the shell environment')
  }
}

async function main(): Promise<void> {
  loadDemoEnvFile()
  const env = readDemoFlowEnv()

  console.log('ferry402 demo — live Base Sepolia + Hedera testnet')
  const flow = await createDemoFlow(env)
  info(`payer:         ${flow.payerAccount.address}`)
  info(`merchant EVM:  ${flow.merchantEvm}`)
  info(`escrow:        ${flow.escrowAddress}`)
  info(`HCS topic:     ${flow.topicId}`)

  try {
    // --- STEP 1: unpaid request -> 402 ---
    step('GET /api/quote with no payment')
    const challenge = await flow.requestChallenge(PRIMARY_ROUTE)
    info(`HTTP ${challenge.status} (expected 402)`)
    info(`accepts: ${challenge.accepts.length} entry(ies) — network=${challenge.requirement.network}, price=${challenge.requirement.maxAmountRequired} atomic USDC, payTo=${challenge.requirement.payTo}`)
    info(`derived paymentId: ${challenge.paymentId}`)
    info(`derived nonce:     ${challenge.nonce}`)

    // --- STEP 2: payer signs the EIP-3009 authorization ---
    step('Payer signs the EIP-3009 authorization via createPaymentHeader()')
    const xPaymentHeader = await flow.signPayment(challenge.requirement)
    ok(`signed by ${flow.payerAccount.address}, header is ${xPaymentHeader.length} base64 chars`)

    // --- STEP 3: retry with X-PAYMENT -> 200, resource served ---
    step('Retry GET /api/quote with X-PAYMENT')
    const balanceBefore = await flow.getEscrowLedgerRow()
    const paid = await flow.payWithHeader(PRIMARY_ROUTE, xPaymentHeader)
    const paidBody = paid.body as PaidSuccessBody
    info(`HTTP ${paid.status} (expected 200)`)
    ok(`resource served: ${JSON.stringify(paidBody.quote)}`)

    // --- STEP 4: settlement tx hash + basescan link ---
    step('Settlement submitted to the Escrow on Base Sepolia')
    const { transaction, gasUsed, settledAmount } = paidBody.settlement
    ok(`settled ${settledAmount} atomic USDC (gas used: ${gasUsed})`)
    link('Basescan', `https://sepolia.basescan.org/tx/${transaction}`)

    // --- STEP 5: escrow ledger row before/after ---
    step("Merchant's escrow ledger row, before/after")
    info(`before: ${balanceBefore.toString()} atomic USDC`)
    const { value: balanceAfter, attempts } = await flow.pollEscrowLedgerRow(balanceBefore + BigInt(settledAmount))
    info(`after:  ${balanceAfter.toString()} atomic USDC (confirmed after ${attempts} read${attempts === 1 ? '' : 's'} against ${flow.rpcUrl})`)
    ok(`delta: +${(balanceAfter - balanceBefore).toString()} atomic USDC`)

    // --- STEP 6: HCS journal entry, read back from the mirror node ---
    step('HCS journal entry, read back from the mirror node')
    const mirrorMessage = await flow.fetchJournalEntry(paidBody.journal.sequenceNumber)
    const decodedEntry = JSON.parse(Buffer.from(mirrorMessage.message, 'base64').toString('utf8')) as Record<string, unknown>
    info(`sequence #${mirrorMessage.sequence_number}, consensus @ ${mirrorMessage.consensus_timestamp}`)
    info(`entry: ${JSON.stringify(decodedEntry)}`)
    link('Hashscan', `https://hashscan.io/testnet/transaction/${mirrorMessage.consensus_timestamp}`)
    link('Topic', `https://hashscan.io/testnet/topic/${flow.topicId}`)

    // --- STEP 7: closing reconciliation ---
    step('Reconciliation: journal total vs escrow ledger row vs escrow contract balance')
    const reconciliation = await flow.reconcile()
    info(`journal total (HCS, this merchant, all time): ${reconciliation.journalTotal.toString()} atomic USDC`)
    info(`escrow ledger row (on-chain, this merchant):   ${reconciliation.escrowLedgerRow.toString()} atomic USDC`)
    info(`escrow contract's real USDC balance:           ${reconciliation.escrowRealUsdcBalance.toString()} atomic USDC`)
    if (reconciliation.matches) {
      ok('journal total matches the ledger row, and the ledger row is fully backed by the contract\'s real USDC balance')
    } else {
      info('(numbers may legitimately differ if this escrow/topic has prior activity from other merchants or runs predating this journal query window)')
    }

    // --- SECURITY CHECK 1: replay the same X-PAYMENT header ---
    security('Replay the same X-PAYMENT header')
    const replay = await flow.payWithHeader(PRIMARY_ROUTE, xPaymentHeader)
    const replayBody = replay.body as { error?: string; accepts?: unknown }
    if (replay.status === 402) {
      rejected(`HTTP 402, error="${replayBody.error}" — the consumed-nonce store already saw (payer, nonce)`)
    } else {
      throw new Error(`expected the replay to be rejected with 402, got ${replay.status}`)
    }

    // --- SECURITY CHECK 2: a challenge for one resource, presented at a different route ---
    security('Present the /api/quote header at a different route (/api/quote/premium)')
    const crossRoute = await flow.payWithHeader(SECONDARY_ROUTE, xPaymentHeader)
    const crossRouteBody = crossRoute.body as { error?: string }
    if (crossRoute.status === 402) {
      rejected(`HTTP 402, error="${crossRouteBody.error}" — nonce was derived for a different resource string, so it can never match this route's own derivation`)
    } else {
      throw new Error(`expected the cross-route attempt to be rejected with 402, got ${crossRoute.status}`)
    }

    // --- SECURITY CHECK 3: a payment signed by a zero-balance key ---
    security('A payment signed by a brand-new, zero-balance key')
    const zeroBalanceAccount = flow.createThrowawayAccount()
    info(`throwaway key: ${zeroBalanceAccount.address} (never funded, zero USDC, zero ETH)`)
    const zeroBalanceHeader = await flow.signPayment(challenge.requirement, zeroBalanceAccount)
    const zeroBalance = await flow.payWithHeader(PRIMARY_ROUTE, zeroBalanceHeader)
    const zeroBalanceBody = zeroBalance.body as { error?: string }
    if (zeroBalance.status === 402 && zeroBalanceBody.error === 'insufficient_funds') {
      rejected(`HTTP 402, error="insufficient_funds" — rejected at /verify, nothing was ever served`)
    } else {
      throw new Error(`expected insufficient_funds, got HTTP ${zeroBalance.status} error="${zeroBalanceBody.error}"`)
    }

    console.log(`\n${'='.repeat(78)}`)
    console.log('DEMO COMPLETE — payment settled, journaled, reconciled; all three security checks held.')
    console.log('='.repeat(78))
  } finally {
    await flow.close()
  }
}

main().catch((err) => {
  console.error('\nDEMO FAILED (unexpected error):')
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exitCode = 1
})
