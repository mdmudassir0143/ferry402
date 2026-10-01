/**
 * ferry402 demo-ui — a local Express app that runs the REAL ferry402
 * payment flow (same facilitator + merchant, same live Base Sepolia +
 * Hedera testnet, no mocks) and streams every step to a browser over
 * Server-Sent Events, for screen recording.
 *
 * Every actual network/SDK action — standing up the facilitator + merchant,
 * signing, paying, reading the escrow ledger and HCS journal back — comes
 * straight from `examples/demo/src/lib/*`, the exact same code
 * `examples/demo`'s CLI (`run.ts`) runs. This file only adds a web layer on
 * top: HTTP endpoints, SSE event framing, and static file serving. See that
 * package's README for why the logic lives there instead of being
 * reimplemented here.
 *
 * Uses the PUBLISHED `@ferry402/sdk@0.2.1` from npm and the unpublished
 * `@ferry402/facilitator` straight from this monorepo's source, exactly
 * like `examples/demo` — see this package's own README.
 *
 * HARD RULE: no private key, and nothing derived from one beyond a public
 * address, is ever written into an SSE event, a log line, or an HTTP
 * response. Grep this file (and `./lib` imports) before adding a new event
 * field if that's ever in doubt.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Request, type Response } from 'express'
import { loadEnv, readDemoFlowEnv } from '../../demo/src/lib/env.js'
import { createDemoFlow, PRIMARY_ROUTE, SECONDARY_ROUTE, type DemoFlow, type PaidSuccessBody } from '../../demo/src/lib/flow.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.resolve(here, '../public')

function loadDemoUiEnv(): void {
  // Same lookup order `examples/demo` uses: this example's own .env first
  // (fully self-contained), then the repo root's .env (already configured
  // for this project).
  const loaded = loadEnv([
    path.resolve(here, '../.env'), // examples/demo-ui/.env
    path.resolve(here, '../../../.env'), // the monorepo root .env
  ])
  if (loaded) {
    console.log(`[env] loaded ${loaded}`)
  } else {
    console.log('[env] no .env file found at examples/demo-ui/.env or the repo root — relying on the shell environment')
  }
}

type StageStatus = 'running' | 'done' | 'failed'
interface StageEvent {
  stage: string
  status: StageStatus
  durationMs?: number
  data?: Record<string, unknown>
}

function sseHeaders(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // A comment line opens the stream immediately so the browser's fetch
  // reader resolves right away instead of waiting on the first real event.
  res.write(': connected\n\n')
}

function makeSender(res: Response): (event: StageEvent) => void {
  return (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}

async function main(): Promise<void> {
  loadDemoUiEnv()
  const env = readDemoFlowEnv()

  let flow: DemoFlow | null = null
  async function getFlow(): Promise<DemoFlow> {
    if (!flow) {
      flow = await createDemoFlow(env)
      console.log(`[flow] facilitator @ ${flow.facilitatorBaseUrl}, merchant @ ${flow.merchantBaseUrl}`)
      console.log(`[flow] payer: ${flow.payerAccount.address}`)
      console.log(`[flow] merchant EVM: ${flow.merchantEvm}`)
    }
    return flow
  }

  // Keeps payments sequential: only one /api/run or /api/check/:kind may be
  // in flight at a time, across the whole process — the task's own
  // constraint, enforced server-side (the UI also disables its buttons, but
  // that alone would not stop a second request fired some other way).
  let running = false

  // The last header that was actually used to pay `PRIMARY_ROUTE` — reused
  // by the replay check so clicking it twice in a row doesn't spend a
  // second real payment just to prove the same point. Cleared for nothing;
  // it is fine to reuse forever, since a consumed nonce stays consumed for
  // this process's lifetime.
  let lastPayment: { header: string; routePath: string } | null = null

  const app = express()
  app.use(express.json())

  app.get('/api/state', async (_req: Request, res: Response) => {
    try {
      const f = await getFlow()
      const reconciliation = await f.reconcile()
      res.json({
        merchantEvm: f.merchantEvm,
        escrowAddress: f.escrowAddress,
        topicId: f.topicId,
        journalTotal: reconciliation.journalTotal.toString(),
        escrowLedgerRow: reconciliation.escrowLedgerRow.toString(),
        escrowRealUsdcBalance: reconciliation.escrowRealUsdcBalance.toString(),
        matches: reconciliation.matches,
        running,
      })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/run', async (_req: Request, res: Response) => {
    if (running) {
      res.status(409).json({ error: 'already_running', message: 'A payment is already in progress — wait for it to finish.' })
      return
    }
    running = true
    sseHeaders(res)
    const send = makeSender(res)
    const runStart = Date.now()
    try {
      const f = await getFlow()

      // STEP 1 — challenge
      send({ stage: 'challenge', status: 'running' })
      let t = Date.now()
      // cacheBust: true — without it, a second "Run payment" click within
      // the same ~5-minute derivation window would sign against the exact
      // nonce the first click already consumed and fail with
      // invalid_payment; see RequestChallengeOptions's doc comment.
      const challenge = await f.requestChallenge(PRIMARY_ROUTE, { cacheBust: true })
      send({
        stage: 'challenge',
        status: 'done',
        durationMs: Date.now() - t,
        data: {
          httpStatus: challenge.status,
          // The ACTUAL path requested, not the bare route. Each run appends a
          // unique query string (see cacheBust above), and the nonce is derived
          // from the full resource URL — so showing `/api/quote` here would
          // misreport what was actually signed against, on the one screen whose
          // whole job is to show what really happened.
          resource: challenge.requestPath,
          resourceNote:
            'each run uses a distinct URL — the nonce is derived from the resource, ' +
            'and the same payer cannot buy the identical resource twice in one 5-minute window',
          network: challenge.requirement.network,
          maxAmountRequired: challenge.requirement.maxAmountRequired,
          payTo: challenge.requirement.payTo,
          asset: challenge.requirement.asset,
          paymentId: challenge.paymentId,
          nonce: challenge.nonce,
        },
      })

      // STEP 2 — signed (never send the header itself — length only, per
      // this file's hard rule; a signature isn't a private key, but the
      // spec only asks for the length, so there's no reason to send more)
      send({ stage: 'signed', status: 'running' })
      t = Date.now()
      const header = await f.signPayment(challenge.requirement)
      send({
        stage: 'signed',
        status: 'done',
        durationMs: Date.now() - t,
        data: { signer: f.payerAccount.address, headerLength: header.length },
      })

      // STEP 3 — served (verify + settle + journal all happen inside this
      // one HTTP round trip, exactly like a real merchant request — see
      // ./lib/flow.ts's makePaidRoute)
      send({ stage: 'served', status: 'running' })
      t = Date.now()
      const balanceBefore = await f.getEscrowLedgerRow()
      const paid = await f.payWithHeader(challenge.requestPath, header)
      if (!paid.ok) {
        const errBody = paid.body as { error?: string }
        send({ stage: 'served', status: 'failed', durationMs: Date.now() - t, data: { httpStatus: paid.status, error: errBody.error ?? 'unknown_error' } })
        throw new Error(`payment failed: HTTP ${paid.status} ${errBody.error ?? ''}`.trim())
      }
      const paidBody = paid.body as PaidSuccessBody
      send({
        stage: 'served',
        status: 'done',
        durationMs: Date.now() - t,
        data: { httpStatus: paid.status, resource: paidBody.resource, quote: paidBody.quote },
      })

      // STEP 4 — settled (reporting what the same call above already did)
      send({ stage: 'settled', status: 'running' })
      t = Date.now()
      const { transaction, gasUsed, settledAmount, network } = paidBody.settlement
      send({
        stage: 'settled',
        status: 'done',
        durationMs: Date.now() - t,
        data: {
          transaction,
          gasUsed,
          settledAmount,
          network,
          basescanUrl: `https://sepolia.basescan.org/tx/${transaction}`,
        },
      })

      // STEP 5 — ledger before/after
      send({ stage: 'ledger', status: 'running' })
      t = Date.now()
      const { value: balanceAfter, attempts } = await f.pollEscrowLedgerRow(balanceBefore + BigInt(settledAmount))
      send({
        stage: 'ledger',
        status: 'done',
        durationMs: Date.now() - t,
        data: {
          before: balanceBefore.toString(),
          after: balanceAfter.toString(),
          delta: (balanceAfter - balanceBefore).toString(),
          attempts,
          rpcUrl: f.rpcUrl,
        },
      })

      // STEP 6 — HCS journal entry, read back from the mirror node
      send({ stage: 'journal', status: 'running' })
      t = Date.now()
      const mirrorMessage = await f.fetchJournalEntry(paidBody.journal.sequenceNumber)
      const decodedEntry = JSON.parse(Buffer.from(mirrorMessage.message, 'base64').toString('utf8')) as Record<string, unknown>
      send({
        stage: 'journal',
        status: 'done',
        durationMs: Date.now() - t,
        data: {
          sequenceNumber: mirrorMessage.sequence_number,
          consensusTimestamp: mirrorMessage.consensus_timestamp,
          entry: decodedEntry,
          topicId: f.topicId,
          hashscanTxUrl: `https://hashscan.io/testnet/transaction/${mirrorMessage.consensus_timestamp}`,
          hashscanTopicUrl: `https://hashscan.io/testnet/topic/${f.topicId}`,
        },
      })

      // STEP 7 — the climax: reconciliation
      send({ stage: 'reconciled', status: 'running' })
      t = Date.now()
      const reconciliation = await f.reconcile()
      send({
        stage: 'reconciled',
        status: 'done',
        durationMs: Date.now() - t,
        data: {
          journalTotal: reconciliation.journalTotal.toString(),
          escrowLedgerRow: reconciliation.escrowLedgerRow.toString(),
          escrowRealUsdcBalance: reconciliation.escrowRealUsdcBalance.toString(),
          matches: reconciliation.matches,
        },
      })

      lastPayment = { header, routePath: challenge.requestPath }

      send({ stage: 'complete', status: 'done', durationMs: Date.now() - runStart })
    } catch (err) {
      send({ stage: 'error', status: 'failed', data: { message: err instanceof Error ? err.message : String(err) } })
    } finally {
      res.end()
      running = false
    }
  })

  app.post('/api/check/:kind', async (req: Request, res: Response) => {
    const kind = req.params.kind
    if (kind !== 'replay' && kind !== 'cross-route' && kind !== 'zero-balance') {
      res.status(404).json({ error: 'unknown_check', message: 'kind must be one of: replay, cross-route, zero-balance' })
      return
    }
    if (running) {
      res.status(409).json({ error: 'already_running', message: 'A payment is already in progress — wait for it to finish.' })
      return
    }
    running = true
    sseHeaders(res)
    const send = makeSender(res)
    const t0 = Date.now()
    try {
      const f = await getFlow()
      send({ stage: 'check', status: 'running', data: { kind } })

      if (kind === 'zero-balance') {
        // Free: rejected at /verify on a real balance read, never settles.
        const challenge = await f.requestChallenge(PRIMARY_ROUTE)
        const throwaway = f.createThrowawayAccount()
        const zbHeader = await f.signPayment(challenge.requirement, throwaway)
        const attempt = await f.payWithHeader(PRIMARY_ROUTE, zbHeader)
        const body = attempt.body as { error?: string }
        const correct = attempt.status === 402 && body.error === 'insufficient_funds'
        send({
          stage: 'check',
          status: correct ? 'done' : 'failed',
          durationMs: Date.now() - t0,
          data: {
            kind,
            rejected: attempt.status === 402,
            reasonCode: body.error ?? null,
            httpStatus: attempt.status,
            expectedReasonCode: 'insufficient_funds',
            correct,
            signer: throwaway.address,
            note: 'a brand-new, never-funded key signed a valid-looking authorization; the facilitator\'s own balance check rejected it before anything was served',
          },
        })
        return
      }

      if (kind === 'cross-route') {
        // Free: the nonce is bound to /api/quote's own derivation; it is
        // rejected by local resource-binding check before any facilitator
        // call, so this never needs to actually be paid first.
        const challenge = await f.requestChallenge(PRIMARY_ROUTE)
        const crHeader = await f.signPayment(challenge.requirement)
        const attempt = await f.payWithHeader(SECONDARY_ROUTE, crHeader)
        const body = attempt.body as { error?: string }
        const correct = attempt.status === 402 && body.error === 'invalid_payment'
        send({
          stage: 'check',
          status: correct ? 'done' : 'failed',
          durationMs: Date.now() - t0,
          data: {
            kind,
            rejected: attempt.status === 402,
            reasonCode: body.error ?? null,
            httpStatus: attempt.status,
            expectedReasonCode: 'invalid_payment',
            correct,
            fromRoute: PRIMARY_ROUTE,
            toRoute: SECONDARY_ROUTE,
            note: 'a header signed for /api/quote was presented at /api/quote/premium — nonce derivation is resource-bound, so it can never match',
          },
        })
        return
      }

      // kind === 'replay': needs a header that has ALREADY been consumed by
      // one real, successful payment. Reuses the last one this server made
      // (from a prior /api/run or replay check) if there is one; otherwise
      // performs one real payment first so there is something to replay.
      let fundedFresh = false
      let header: string
      let routePath: string
      if (lastPayment) {
        ;({ header, routePath } = lastPayment)
      } else {
        fundedFresh = true
        send({ stage: 'check', status: 'running', data: { kind, note: 'no prior payment yet — making one real payment first so there is a consumed nonce to replay' } })
        const challenge = await f.requestChallenge(PRIMARY_ROUTE, { cacheBust: true })
        header = await f.signPayment(challenge.requirement)
        const setupPaid = await f.payWithHeader(challenge.requestPath, header)
        if (!setupPaid.ok) {
          const errBody = setupPaid.body as { error?: string }
          throw new Error(`setup payment for the replay check failed: HTTP ${setupPaid.status} ${errBody.error ?? ''}`.trim())
        }
        routePath = challenge.requestPath
        lastPayment = { header, routePath }
      }
      const attempt = await f.payWithHeader(routePath, header)
      const body = attempt.body as { error?: string }
      const correct = attempt.status === 402 && body.error === 'invalid_payment'
      send({
        stage: 'check',
        status: correct ? 'done' : 'failed',
        durationMs: Date.now() - t0,
        data: {
          kind,
          rejected: attempt.status === 402,
          reasonCode: body.error ?? null,
          httpStatus: attempt.status,
          expectedReasonCode: 'invalid_payment',
          correct,
          fundedFresh,
          note: 'the identical X-PAYMENT header was presented a second time — the consumed-nonce store already saw this (payer, nonce) pair',
        },
      })
    } catch (err) {
      send({ stage: 'error', status: 'failed', data: { message: err instanceof Error ? err.message : String(err) } })
    } finally {
      res.end()
      running = false
    }
  })

  // Static UI last, so the API routes above always take precedence.
  app.use(express.static(PUBLIC_DIR))
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
  })

  const port = Number(process.env.PORT ?? 4402)
  const server = app.listen(port, () => {
    console.log(`\nferry402 demo-ui — http://localhost:${port}\n`)
  })

  const shutdown = async (): Promise<void> => {
    server.close()
    if (flow) await flow.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((err) => {
  console.error('\ndemo-ui FAILED to start:')
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exitCode = 1
})
