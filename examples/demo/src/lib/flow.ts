/**
 * The real ferry402 payment flow, factored out of `run.ts` so both the CLI
 * (`examples/demo`) and the browser UI (`examples/demo-ui`) run the exact
 * same logic against the exact same live networks — narration/presentation
 * stays in each caller, every actual network/SDK action lives here.
 *
 * This is a straight extraction of `run.ts`'s own setup and per-step logic
 * (see that file's history before this refactor) — nothing here reinvents
 * what it already did correctly.
 */
import express, { type Express } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createPublicClient, http, parseEventLogs, type Address, type Hex } from 'viem'
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { Client, AccountId, PrivateKey } from '@hashgraph/sdk'
import { ferry402, createPaymentHeader, computeNonce } from '@ferry402/sdk'
import type { Ferry402Config, Ferry402Locals, PaymentRequirements } from '@ferry402/sdk'
// @ferry402/facilitator is never published to npm (private package) — run
// straight from this monorepo's own source, the same way a merchant who
// clones the repo and self-hosts the facilitator would. Requires `pnpm
// install && pnpm -r build` to have been run once at the repo root so
// packages/facilitator's own node_modules (and packages/sdk/dist, which it
// resolves through the workspace symlink) actually exist.
import {
  createFacilitatorApp,
  journalEntryForSettlement,
  writeEntry,
  createHederaTopicSubmitter,
} from '../../../../packages/facilitator/src/index.js'
import type { DemoFlowEnv } from './env.js'
import { escrowReadAbi, erc20BalanceAbi, USDC_ADDRESS_BASE_SEPOLIA, USDC_NAME, USDC_VERSION, BASE_SEPOLIA_CHAIN_ID } from './constants.js'
import { pollBalanceOf, readBalanceOf } from './chain.js'
import { fetchMirrorTopicMessage, sumJournalForMerchant } from './mirror.js'

export const PRIMARY_ROUTE = '/api/quote'
export const SECONDARY_ROUTE = '/api/quote/premium' // cross-route security-check target only; never actually paid

export interface ChallengeResult {
  status: number
  accepts: PaymentRequirements[]
  requirement: PaymentRequirements
  paymentId: Hex
  nonce: Hex
  /** The exact path (+ query, if `cacheBust` was used) this challenge was
   *  requested against. `paymentId`/`nonce` are derived from
   *  `(merchantEvm, resource, timeBucket)` — the full request URL is part
   *  of `resource` (see `packages/sdk/src/middleware.ts`) — so a follow-up
   *  `payWithHeader` call MUST target this exact path, not just the route's
   *  bare name, or its own `resource` recomputation won't match what the
   *  payer signed against. */
  requestPath: string
}

export interface RequestChallengeOptions {
  /**
   * Appends a unique query string to the request so its derived `resource`
   * — and therefore its `paymentId`/nonce — is guaranteed fresh, regardless
   * of the current `TIME_BUCKET_SECONDS` window. Without this, two
   * requests for the identical route within the same ~5-minute bucket
   * derive the IDENTICAL nonce (paymentId depends only on `(merchantEvm,
   * resource, timeBucket)`, never on a random draw per request) — fine for
   * `examples/demo`'s CLI, which only ever makes one real payment per
   * process, but a real problem for a UI whose whole point is to let an
   * operator click "Run payment" repeatedly for re-takes: the second click
   * within the same bucket would sign a payment against an already-
   * consumed (payer, nonce) pair and fail with `invalid_payment` — not a
   * bug in settlement, just the stateless derivation design working
   * exactly as documented, surfacing a UX trap for repeat live demos.
   * `examples/demo-ui` passes this for every FRESH real payment it makes;
   * `examples/demo` never needs it and never sets it, so its behavior is
   * unchanged byte-for-byte.
   */
  cacheBust?: boolean
}

export interface PaidSuccessBody {
  resource: string
  quote: Record<string, unknown>
  settlement: { transaction: Hex; network: string; gasUsed: string; settledAmount: string; nonce: Hex }
  journal: { topicId: string; sequenceNumber: number; entry: Record<string, unknown> }
}

export interface PaidErrorBody {
  error?: string
}

export interface PayAttemptResult {
  status: number
  ok: boolean
  body: PaidSuccessBody | PaidErrorBody
}

export interface ReconciliationResult {
  journalTotal: bigint
  escrowLedgerRow: bigint
  escrowRealUsdcBalance: bigint
  matches: boolean
}

/**
 * A live handle on the running facilitator + merchant (both real Express
 * servers on loopback ports, in this one process) plus every action a
 * caller can perform against them. One instance == one `config.secret`, one
 * pair of listening servers — call `close()` when done.
 */
export interface DemoFlow {
  readonly payerAccount: PrivateKeyAccount
  readonly merchantEvm: Address
  readonly escrowAddress: Address
  readonly topicId: string
  readonly rpcUrl: string
  readonly publicClient: ReturnType<typeof createPublicClient>
  readonly facilitatorBaseUrl: string
  readonly merchantBaseUrl: string

  /** STEP 1 — GET a paid route with no payment: the 402 challenge. */
  requestChallenge(routePath?: string, options?: RequestChallengeOptions): Promise<ChallengeResult>
  /** STEP 2 — sign the EIP-3009 authorization. Defaults to the flow's own
   *  funded payer; pass a throwaway account for the zero-balance check. */
  signPayment(requirement: PaymentRequirements, account?: PrivateKeyAccount): Promise<string>
  /** STEPS 3+4 (bundled, same as the real route handler) — retry with
   *  X-PAYMENT. On success the response body already carries the settlement
   *  tx hash/gas/amount AND the HCS journal sequence number: verify, settle,
   *  and journal all happen inside this one HTTP round trip, exactly like a
   *  real merchant request. */
  payWithHeader(routePath: string, header: string): Promise<PayAttemptResult>
  /** A brand-new, never-funded signer — the zero-balance security check. */
  createThrowawayAccount(): PrivateKeyAccount
  /** Current escrow ledger row for this flow's own merchant. */
  getEscrowLedgerRow(): Promise<bigint>
  /** STEP 5 — poll until the ledger row reflects a just-settled payment. */
  pollEscrowLedgerRow(expectedAtLeast: bigint, options?: { retries?: number; delayMs?: number }): Promise<{ value: bigint; attempts: number }>
  /** STEP 6 — read the journal entry back from the Hedera mirror node. */
  fetchJournalEntry(sequenceNumber: number): Promise<{ message: string; consensus_timestamp: string; sequence_number: number }>
  /** STEP 7 — journal total vs. ledger row vs. real USDC balance. */
  reconcile(): Promise<ReconciliationResult>
  /** Shuts down both servers and the Hedera client. Idempotent-ish: safe to
   *  call once at the end of a run. */
  close(): Promise<void>
}

/**
 * Wires up the facilitator + merchant exactly as a real deployment would
 * (same code `run.ts` always ran), listening on loopback with OS-assigned
 * ports, and returns a `DemoFlow` handle to drive it.
 */
export async function createDemoFlow(env: DemoFlowEnv): Promise<DemoFlow> {
  const payerAccount = privateKeyToAccount(env.payerPrivateKey)
  // Reuses the deployer's own address as the merchant's EVM payout address —
  // an arbitrary but already-known, already-controlled identity, exactly
  // the convention packages/facilitator/test/e2e.test.ts uses. Escrow's
  // ledger is a plain internal row; the address named here needs no
  // funding or code of its own to receive credit.
  const merchantEvm = privateKeyToAccount(env.deployerPrivateKey).address

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(env.rpcUrl) })
  // HEDERA_PRIVATE_KEY is ECDSA, DER-encoded -- PrivateKey.fromStringDer(),
  // never fromStringED25519() (that call does not throw on a DER-encoded
  // ECDSA key, it silently derives a DIFFERENT, wrong key).
  const hederaClient = Client.forTestnet().setOperator(AccountId.fromString(env.hederaAccountId), PrivateKey.fromStringDer(env.hederaPrivateKeyDer))

  const facilitatorApp = createFacilitatorApp({
    rpcUrls: { 'base-sepolia': env.rpcUrl },
    facilitatorPrivateKey: env.facilitatorPrivateKey,
    escrows: { 'base-sepolia': env.escrowAddress },
  })
  const facilitatorServer = await new Promise<Server>((resolve) => {
    const server = facilitatorApp.listen(0, '127.0.0.1', () => resolve(server))
  })
  const facilitatorBaseUrl = `http://127.0.0.1:${(facilitatorServer.address() as AddressInfo).port}`

  // `merchantEvm`/`escrows`/`assets` are `Partial<Record<SupportedChain,
  // ...>>` (0.2.x) — this demo only ever accepts `base-sepolia`, so that's
  // the only entry each map needs.
  const config: Ferry402Config = {
    price: '$0.01',
    accept: ['base-sepolia'],
    settleTo: 'hedera',
    merchant: env.hederaAccountId,
    merchantEvm: { 'base-sepolia': merchantEvm },
    facilitator: facilitatorBaseUrl,
    escrows: { 'base-sepolia': env.escrowAddress },
    assets: { 'base-sepolia': USDC_ADDRESS_BASE_SEPOLIA },
    secret: randomBytes(32).toString('hex'),
  }

  // ferry402() only calls /verify — collecting payment (settling to the
  // Escrow), journaling it to HCS, and serving the resource is this route
  // handler's own job, run immediately after next() (see root README's "How
  // a payment moves through the system").
  function makePaidRoute(app: Express, routePath: string, quote: Record<string, unknown>): void {
    app.get(routePath, ferry402(config), async (_req, res) => {
      // `Ferry402Locals` — the typed shape of res.locals.x402.
      const { payload, requirements, release } = res.locals.x402 as Ferry402Locals

      const settleRes = await fetch(`${facilitatorBaseUrl}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
      })
      const settleJson = (await settleRes.json()) as { success: boolean; errorReason?: string; transaction: string; network: string; payer: string }
      if (!settleJson.success) {
        // `release()` — the middleware consumed this (payer, nonce) pair
        // BEFORE handing off to us, so a concurrent duplicate could not slip
        // through while /verify was in flight. Settlement just failed,
        // which means no payment happened; without releasing it, this payer
        // would be locked out of retrying for the rest of the derivation
        // window (up to 10 minutes) over a payment that never completed.
        await release()
        res.status(402).json({ error: settleJson.errorReason ?? 'settlement_failed' })
        return
      }

      const receipt = await publicClient.getTransactionReceipt({ hash: settleJson.transaction as Hex })
      const settledLogs = parseEventLogs({ abi: escrowReadAbi, eventName: 'PaymentSettled', logs: receipt.logs })
      const settled = settledLogs[0]
      if (!settled) {
        // Same reasoning as the branch above: the settlement call reported
        // success but produced no PaymentSettled log, so nothing was credited.
        await release()
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
      const journalResult = await writeEntry(entry, { topicId: env.topicId, submitter })

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
        journal: { topicId: env.topicId, sequenceNumber: journalResult.sequenceNumber, entry },
      } satisfies PaidSuccessBody)
    })
  }

  const merchantApp = express()
  makePaidRoute(merchantApp, PRIMARY_ROUTE, { pair: 'HBAR/USD', price: '0.0734', asOf: new Date().toISOString() })
  // A SECOND, independently-priced paid route, sharing the exact same
  // ferry402(config) — i.e. the same secret — used only to demonstrate the
  // cross-route security check. Never actually paid.
  makePaidRoute(merchantApp, SECONDARY_ROUTE, { pair: 'HBAR/USD', price: '0.0734', tier: 'premium', asOf: new Date().toISOString() })

  const merchantServer = await new Promise<Server>((resolve) => {
    const server = merchantApp.listen(0, '127.0.0.1', () => resolve(server))
  })
  const merchantBaseUrl = `http://127.0.0.1:${(merchantServer.address() as AddressInfo).port}`

  async function requestChallenge(routePath: string = PRIMARY_ROUTE, options: RequestChallengeOptions = {}): Promise<ChallengeResult> {
    const requestPath = options.cacheBust
      ? `${routePath}${routePath.includes('?') ? '&' : '?'}t=${Date.now()}-${Math.random().toString(36).slice(2)}`
      : routePath
    const res = await fetch(`${merchantBaseUrl}${requestPath}`)
    const body = (await res.json()) as { x402Version: number; accepts: PaymentRequirements[] }
    const requirement = body.accepts[0]
    const merchantEvmExtra = requirement.extra?.merchantEvm as Address
    const paymentIdExtra = requirement.extra?.paymentId as Hex
    const nonce = computeNonce(merchantEvmExtra, paymentIdExtra)
    return { status: res.status, accepts: body.accepts, requirement, paymentId: paymentIdExtra, nonce, requestPath }
  }

  async function signPayment(requirement: PaymentRequirements, account: PrivateKeyAccount = payerAccount): Promise<string> {
    return createPaymentHeader(requirement, account, {
      tokenName: USDC_NAME,
      tokenVersion: USDC_VERSION,
      chainId: BASE_SEPOLIA_CHAIN_ID,
    })
  }

  async function payWithHeader(routePath: string, header: string): Promise<PayAttemptResult> {
    const res = await fetch(`${merchantBaseUrl}${routePath}`, { headers: { 'X-PAYMENT': header } })
    const body = (await res.json()) as PaidSuccessBody | PaidErrorBody
    return { status: res.status, ok: res.ok, body }
  }

  function createThrowawayAccount(): PrivateKeyAccount {
    return privateKeyToAccount(generatePrivateKey())
  }

  async function getEscrowLedgerRow(): Promise<bigint> {
    return readBalanceOf(publicClient, env.escrowAddress, escrowReadAbi, merchantEvm)
  }

  async function pollEscrowLedgerRow(
    expectedAtLeast: bigint,
    options?: { retries?: number; delayMs?: number },
  ): Promise<{ value: bigint; attempts: number }> {
    return pollBalanceOf(publicClient, env.escrowAddress, merchantEvm, expectedAtLeast, options)
  }

  async function fetchJournalEntry(sequenceNumber: number) {
    return fetchMirrorTopicMessage(env.topicId, sequenceNumber)
  }

  async function reconcile(): Promise<ReconciliationResult> {
    const journalTotal = await sumJournalForMerchant(env.topicId, merchantEvm)
    const escrowLedgerRow = await readBalanceOf(publicClient, env.escrowAddress, escrowReadAbi, merchantEvm)
    const escrowRealUsdcBalance = await readBalanceOf(publicClient, USDC_ADDRESS_BASE_SEPOLIA, erc20BalanceAbi, env.escrowAddress)
    return {
      journalTotal,
      escrowLedgerRow,
      escrowRealUsdcBalance,
      matches: journalTotal === escrowLedgerRow && escrowLedgerRow <= escrowRealUsdcBalance,
    }
  }

  async function close(): Promise<void> {
    await new Promise((resolve) => facilitatorServer.close(resolve))
    await new Promise((resolve) => merchantServer.close(resolve))
    hederaClient.close()
  }

  return {
    payerAccount,
    merchantEvm,
    escrowAddress: env.escrowAddress,
    topicId: env.topicId,
    rpcUrl: env.rpcUrl,
    publicClient,
    facilitatorBaseUrl,
    merchantBaseUrl,
    requestChallenge,
    signPayment,
    payWithHeader,
    createThrowawayAccount,
    getEscrowLedgerRow,
    pollEscrowLedgerRow,
    fetchJournalEntry,
    reconcile,
    close,
  }
}
