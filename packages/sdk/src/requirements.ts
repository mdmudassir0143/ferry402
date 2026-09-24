import { randomBytes } from 'node:crypto'
import type { Anychain402Config, PaymentRequirements, SupportedChain } from './types.js'

const USDC_DECIMALS = 6
const PAYMENT_ID_RE = /^0x[0-9a-fA-F]{64}$/

/** Converts a decimal-dollar price string (e.g. "$0.01") to 6-decimal USDC atomic units. */
export function parsePrice(price: string): string {
  const cleaned = price.replace(/^\$/, '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`invalid price: ${price}`)
  const [whole, frac = ''] = cleaned.split('.')
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS)
  return BigInt(whole + padded).toString()
}

/**
 * Generates a fresh, cryptographically random 32-byte payment id, hex-encoded
 * with a `0x` prefix (66 chars total).
 *
 * This becomes the `paymentId` half of the on-chain nonce binding
 * (`keccak256(abi.encode(merchant, paymentId))`, see `Escrow.sol`). The
 * contract's own doc comment on `settleAuthorization` is explicit that the
 * nonce omits the payer, so `paymentId` must be unique per (payer, merchant)
 * pair — a counter or timestamp could collide across concurrent processes or
 * be guessed/replayed by an observer. 32 bytes of CSPRNG output makes
 * collision probability negligible regardless of who is calling this or how
 * many times, which is what "unique per (payer, merchant) pair" requires in
 * practice: generate fresh, unpredictable randomness on every call.
 */
export function generatePaymentId(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}`
}

export interface BuildRequirementsOptions {
  /**
   * Injects a specific payment id instead of generating one. Intended for
   * tests that need deterministic assertions; the default (omitted) path
   * always generates a fresh random id and is the secure choice for
   * production use. Must be a `0x`-prefixed 32-byte (64 hex char) value.
   */
  paymentId?: `0x${string}`
}

/**
 * Builds one `PaymentRequirements` entry per chain in `config.accept`, all
 * describing the same payment request (same `resource`, same price, same
 * `paymentId`) so a client can pay on whichever accepted chain it prefers.
 *
 * Pure function: no network calls, no chain reads. Every value comes from
 * `config`, `resource`, and (by default) a fresh CSPRNG draw for
 * `paymentId` — nothing here is looked up or awaited.
 */
export function buildRequirements(
  config: Anychain402Config,
  resource: string,
  options: BuildRequirementsOptions = {},
): PaymentRequirements[] {
  const maxAmountRequired = parsePrice(config.price)
  const paymentId = options.paymentId ?? generatePaymentId()
  if (!PAYMENT_ID_RE.test(paymentId)) {
    throw new Error(`invalid paymentId: expected 0x-prefixed 32-byte hex, got ${paymentId}`)
  }

  return config.accept.map((network: SupportedChain) => ({
    scheme: 'exact' as const,
    network,
    maxAmountRequired,
    resource,
    description: `Payment for ${resource}`,
    mimeType: 'application/json',
    payTo: config.escrows[network],
    maxTimeoutSeconds: 300,
    asset: config.assets[network],
    extra: { settleTo: config.settleTo, merchant: config.merchant, paymentId },
  }))
}
