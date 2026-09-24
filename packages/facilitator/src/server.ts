import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { SettleRequestSchema, SettleResponseSchema, VerifyRequestSchema, VerifyResponseSchema } from 'x402/types'
import { settlePayment, verifyPayment } from './chains/base.js'
import type { Hex } from 'viem'

/**
 * Request body size cap for `POST /verify`. A well-formed `VerifyRequest` —
 * two addresses, a signature, a handful of decimal strings, and a small
 * `extra` record — is well under 1KB; this leaves generous headroom without
 * leaving the JSON body parser accepting arbitrarily large uploads from an
 * unauthenticated caller.
 */
const MAX_REQUEST_BODY_SIZE = '16kb'

export interface FacilitatorAppOptions {
  /**
   * Per-network RPC endpoint overrides, used to read each token's EIP-712
   * domain (see `chains/base.ts`'s `verifyPayment` doc comment). Omitted
   * networks fall back to that chain's own public RPC (viem's
   * `base`/`baseSepolia` presets).
   *
   * This matters beyond tests (which point it at a local anvil instance):
   * a real deployment should almost always point this at a private RPC
   * provider rather than relying on a public endpoint's rate limits and
   * availability for the request path that gates whether a payment is
   * accepted.
   */
  rpcUrls?: Partial<Record<'base' | 'base-sepolia', string>>

  /**
   * Overrides the facilitator's signing key used by `POST /settle`. Defaults
   * to `process.env.FACILITATOR_PRIVATE_KEY` (see `SettleOptions`'s doc
   * comment in `chains/base.ts`). Tests pass one of anvil's well-known dev
   * keys here instead of mutating `process.env`.
   *
   * Never logged.
   */
  facilitatorPrivateKey?: Hex
}

/**
 * Builds the facilitator's Express app. Exported as a factory (rather than a
 * module-level singleton) so tests — and multi-tenant callers — can spin up
 * independent instances without sharing listener or configuration state.
 *
 * `POST /verify` and `POST /settle` are the facilitator's only routes. Both
 * request bodies are parsed against x402's own schemas (`VerifyRequestSchema`
 * / `SettleRequestSchema`) — not hand-rolled — because this endpoint is a
 * separate trust domain boundary: whoever is running `anychain402`'s
 * middleware is a caller we don't otherwise control, and a malformed or
 * malicious body must never reach `verifyPayment`/`settlePayment` un-typed.
 *
 * Never logs the request or response body: both carry a payer's EIP-3009
 * signature (`payload.signature`) and, on success, a `payer` address paired
 * with that signature. This module itself has no logging; `settlePayment`
 * (see `chains/base.ts`) does log operator-facing revert diagnostics on
 * settlement failure, but never the signature, the payload, or the
 * facilitator's private key — see its own doc comments.
 */
export function createFacilitatorApp(options: FacilitatorAppOptions = {}): Express {
  const app = express()
  app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }))

  app.post('/verify', async (req, res) => {
    const parsedRequest = VerifyRequestSchema.safeParse(req.body)
    if (!parsedRequest.success) {
      res.status(400).json({ isValid: false, invalidReason: 'invalid_payload' })
      return
    }

    const { paymentPayload, paymentRequirements } = parsedRequest.data
    const rpcUrl = options.rpcUrls?.[paymentRequirements.network as 'base' | 'base-sepolia']

    let result
    try {
      result = await verifyPayment(paymentPayload, paymentRequirements, { rpcUrl })
    } catch {
      // verifyPayment is written to never throw, but a facilitator endpoint
      // must not crash the process even if that invariant is ever broken by
      // a future change — see the task-6 review's lesson on unguarded
      // throws killing the process outright.
      res.status(200).json({ isValid: false, invalidReason: 'unexpected_verify_error' })
      return
    }

    // Validate our own outgoing shape against x402's schema before sending —
    // the same "parse, don't hand-roll" discipline applied to the response
    // side, and cheap insurance against a future change to `VerifyResult`
    // drifting from what `anychain402`'s middleware expects to parse back.
    const parsedResponse = VerifyResponseSchema.safeParse(result)
    if (!parsedResponse.success) {
      res.status(200).json({ isValid: false, invalidReason: 'unexpected_verify_error' })
      return
    }
    res.status(200).json(parsedResponse.data)
  })

  app.post('/settle', async (req, res) => {
    const parsedRequest = SettleRequestSchema.safeParse(req.body)
    if (!parsedRequest.success) {
      res.status(400).json({ success: false, errorReason: 'invalid_payload', transaction: '', network: req.body?.paymentPayload?.network ?? '' })
      return
    }

    const { paymentPayload, paymentRequirements } = parsedRequest.data
    const rpcUrl = options.rpcUrls?.[paymentRequirements.network as 'base' | 'base-sepolia']

    let result
    try {
      result = await settlePayment(paymentPayload, paymentRequirements, {
        rpcUrl,
        facilitatorPrivateKey: options.facilitatorPrivateKey,
      })
    } catch {
      // settlePayment is written to never throw (every fallible step inside
      // it is its own try/catch — see chains/base.ts), but this endpoint
      // must not crash the process even if that invariant is ever broken by
      // a future change — see the task-6 review's lesson on unguarded
      // throws killing the process outright, and /verify's identical guard
      // above.
      res.status(200).json({
        success: false,
        errorReason: 'unexpected_settle_error',
        transaction: '',
        network: paymentRequirements.network,
      })
      return
    }

    // Same "parse, don't hand-roll" discipline as /verify's outgoing shape.
    const parsedResponse = SettleResponseSchema.safeParse(result)
    if (!parsedResponse.success) {
      res.status(200).json({
        success: false,
        errorReason: 'unexpected_settle_error',
        transaction: '',
        network: paymentRequirements.network,
      })
      return
    }
    res.status(200).json(parsedResponse.data)
  })

  // Error-handling middleware — MUST be registered after every route/other
  // middleware; Express identifies an error handler specifically by its
  // 4-argument signature. Without this, a malformed JSON body (or a body
  // over MAX_REQUEST_BODY_SIZE) reaches Express's own default error
  // handler, which responds with an HTML page containing a full stack
  // trace and absolute filesystem paths — never this module's
  // `{isValid, invalidReason}` shape, and a needless information leak to
  // an unauthenticated caller.
  //
  // The error itself is deliberately never inspected or logged: for a
  // malformed-JSON body specifically, `body-parser` (which `express.json`
  // wraps) attaches the raw request body to `err.body` — the same payload
  // this module's "never log the payload" rule exists to protect — so
  // logging `err` here would be one line away from violating that rule for
  // exactly the requests most likely to be probing for issues.
  //
  // Branches on `req.path` only to pick the right RESPONSE SHAPE
  // (`{isValid,...}` vs `{success,...}`) for whichever route the malformed
  // body was sent to — `/settle`'s `SettleResponseSchema` requires
  // `transaction`/`network` fields `/verify`'s shape doesn't have, so a
  // single hardcoded shape here would itself fail `/settle` callers'
  // parsing of a legitimate error response.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((_err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (req.path === '/settle') {
      res.status(400).json({ success: false, errorReason: 'invalid_payload', transaction: '', network: '' })
      return
    }
    res.status(400).json({ isValid: false, invalidReason: 'invalid_payload' })
  })

  return app
}
