import express, { type Express } from 'express'
import { VerifyRequestSchema, VerifyResponseSchema } from 'x402/types'
import { verifyPayment } from './chains/base.js'

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
}

/**
 * Builds the facilitator's Express app. Exported as a factory (rather than a
 * module-level singleton) so tests — and multi-tenant callers — can spin up
 * independent instances without sharing listener or configuration state.
 *
 * `POST /verify` is the facilitator's only route in this slice (Task 8 adds
 * `/settle`). The request body is parsed against x402's own
 * `VerifyRequestSchema` — not hand-rolled — because this endpoint is a
 * separate trust domain boundary: whoever is running `anychain402`'s
 * middleware is a caller we don't otherwise control, and a malformed or
 * malicious body must never reach `verifyPayment` un-typed.
 *
 * Never logs the request or response body: both carry a payer's EIP-3009
 * signature (`payload.signature`) and, on success, a `payer` address paired
 * with that signature. This module intentionally has no logging at all.
 */
export function createFacilitatorApp(options: FacilitatorAppOptions = {}): Express {
  const app = express()
  app.use(express.json())

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

  return app
}
