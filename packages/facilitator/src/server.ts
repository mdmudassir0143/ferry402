import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { SettleRequestSchema, SettleResponseSchema, VerifyRequestSchema, VerifyResponseSchema } from 'x402/types'
import { settlePayment, verifyPayment } from './chains/base.js'
import type { Address, Hex } from 'viem'

/**
 * Request body size cap for `POST /verify`. A well-formed `VerifyRequest` —
 * two addresses, a signature, a handful of decimal strings, and a small
 * `extra` record — is well under 1KB; this leaves generous headroom without
 * leaving the JSON body parser accepting arbitrarily large uploads from an
 * unauthenticated caller.
 */
const MAX_REQUEST_BODY_SIZE = '16kb'

/**
 * A syntactically valid member of `SettleResponseSchema`'s `network` enum,
 * used ONLY as a last-resort placeholder in an error response when a
 * genuinely malformed request gives no way to know which network the caller
 * actually meant (task-8 review round 1, M-a). Not a claim about which chain
 * was actually involved — there is no way to make that claim honestly for a
 * body that failed to parse at all — just the least-arbitrary choice
 * available: this facilitator's own real deployment target in this slice.
 */
const UNKNOWN_NETWORK_PLACEHOLDER = 'base-sepolia'

/**
 * Best-effort recovery of the caller's intended `network` for an error
 * response, without ever echoing unvalidated caller JSON back to them
 * (task-8 review round 1, M-a): a bare `req.body?.paymentPayload?.network ??
 * ''` both fails `SettleResponseSchema`'s strict network enum (so a strict
 * client parsing our own error response would itself reject it) AND echoes
 * whatever the caller put there verbatim — including an object, an array, or
 * a script-bearing string, none of which `SettleRequestSchema` has
 * necessarily rejected yet at the point this runs. Checking `candidate`
 * against `SettleResponseSchema`'s OWN `network` sub-schema means only one of
 * the finite, known-safe enum values can ever come back from this function.
 */
function safeNetworkOrPlaceholder(candidate: unknown): string {
  const parsed = SettleResponseSchema.shape.network.safeParse(candidate)
  return parsed.success ? parsed.data : UNKNOWN_NETWORK_PLACEHOLDER
}

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

  /**
   * The facilitator operator's own, trusted `Escrow` contract address per
   * network — see `VerifyOptions.escrows`'s doc comment in `chains/base.ts`
   * for why this exists at all (task-8 review round 2). `POST /verify` and
   * `POST /settle` are both unauthenticated and take `paymentRequirements`
   * straight from the caller, so `requirements.payTo` must be checked
   * against something the OPERATOR configured, never merely trusted.
   *
   * Configured the same shape as `rpcUrls`, for the same reason: a
   * facilitator operator already has to know its RPC endpoints, and a
   * self-hosting merchant knows its own deployed escrow address. A network
   * with no entry here is REJECTED, not silently trusted — see
   * `VerifyOptions.escrows` for the fail-closed behavior this threads
   * through to.
   */
  escrows?: Partial<Record<'base' | 'base-sepolia', Address>>
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
      result = await verifyPayment(paymentPayload, paymentRequirements, { rpcUrl, escrows: options.escrows })
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
      const network = safeNetworkOrPlaceholder((req.body as { paymentPayload?: { network?: unknown } } | undefined)?.paymentPayload?.network)
      res.status(400).json({ success: false, errorReason: 'invalid_payload', transaction: '', network })
      return
    }

    const { paymentPayload, paymentRequirements } = parsedRequest.data
    const rpcUrl = options.rpcUrls?.[paymentRequirements.network as 'base' | 'base-sepolia']

    let result
    try {
      result = await settlePayment(paymentPayload, paymentRequirements, {
        rpcUrl,
        facilitatorPrivateKey: options.facilitatorPrivateKey,
        escrows: options.escrows,
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
  // The error's `status`/`statusCode` is read (see below), but it is
  // deliberately never LOGGED, and no other field of it is inspected: for a
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
  //
  // The match is a case-insensitive, trailing-slash-tolerant REGEX, not a
  // bare `===` (task-8 review round 1, M-b): Express's own route matching is
  // case-insensitive and trailing-slash-tolerant by default (`caseSensitive:
  // false`, `strict: false`), so `/settle/` and `/SETTLE` are both routed to
  // the `/settle` handler above — but a JSON-parse failure never reaches that
  // handler (body-parser's error skips straight to this middleware via
  // `next(err)`), and `req.path` here is the RAW inbound path, unnormalized.
  // A strict `===` would send `/verify`'s shape for those two variants,
  // which x402's own client rejects outright for `/settle`.
  //
  // `err.status`/`err.statusCode` is honored, not hardcoded to 400
  // (task-8 review round 1, M-b): `body-parser`'s own `PayloadTooLargeError`
  // (a body over `MAX_REQUEST_BODY_SIZE`) carries `status`/`statusCode: 413`;
  // flattening that to 400 would misreport a size-limit rejection as a
  // generic bad-request to any caller that branches on status code.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (() => {
      const candidate = (err as { status?: unknown; statusCode?: unknown } | undefined)?.status ?? (err as { statusCode?: unknown } | undefined)?.statusCode
      return typeof candidate === 'number' && candidate >= 400 && candidate < 600 ? candidate : 400
    })()
    if (/^\/settle\/?$/i.test(req.path)) {
      const network = safeNetworkOrPlaceholder((req.body as { paymentPayload?: { network?: unknown } } | undefined)?.paymentPayload?.network)
      res.status(status).json({ success: false, errorReason: 'invalid_payload', transaction: '', network })
      return
    }
    res.status(status).json({ isValid: false, invalidReason: 'invalid_payload' })
  })

  return app
}
