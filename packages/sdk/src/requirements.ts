import { randomBytes } from 'node:crypto'
import type { Anychain402Config, PaymentRequirements, SupportedChain } from './types.js'

const USDC_DECIMALS = 6
const PAYMENT_ID_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * Converts a decimal-dollar price string (e.g. "$0.01") to 6-decimal USDC
 * atomic units. The leading "$" is optional — "0.01" and "$0.01" parse
 * identically; this is a deliberate, tested choice, not an accident of the
 * regex.
 *
 * Rejects (rather than rounds or truncates) a price with more than 6
 * fractional digits. USDC has 6 decimals, so anything past that cannot be
 * represented — silently flooring it would either charge a wrong amount or,
 * for any price under 0.000001, silently charge nothing at all. A payments
 * library must never invent a price the caller didn't write; it must say so
 * and let the caller fix their input.
 */
export function parsePrice(price: string): string {
  const cleaned = price.replace(/^\$/, '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`invalid price: ${price}`)
  const [whole, frac = ''] = cleaned.split('.')
  if (frac.length > USDC_DECIMALS) {
    throw new Error(
      `invalid price: ${price} has ${frac.length} fractional digits, but USDC ` +
        `supports at most ${USDC_DECIMALS}. Rounding would silently change the ` +
        `price, so this is rejected instead of rounded — use at most ` +
        `${USDC_DECIMALS} decimal places.`,
    )
  }
  const padded = frac.padEnd(USDC_DECIMALS, '0')
  return BigInt(whole + padded).toString()
}

/**
 * Generates a fresh, cryptographically random 32-byte payment id, hex-encoded
 * with a `0x` prefix (66 chars total).
 *
 * This becomes the `paymentId` half of the on-chain nonce binding
 * (`keccak256(abi.encode(merchantEvm, paymentId))`, see `Escrow.sol`). The
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
   * Injects a specific payment id instead of generating one, for tests that
   * need deterministic assertions. The name is deliberately loud: supplying
   * anything other than a fresh CSPRNG value breaks the per-(payer,
   * merchant) uniqueness the on-chain nonce binding depends on (see
   * `generatePaymentId`) and WILL collide with the token's nonce tracking —
   * a predictable value (e.g. a zero-padded counter) still satisfies the
   * shape check below but is not safe to use in production. Omit this in
   * production; the default path always generates a fresh random id. Must
   * be a `0x`-prefixed 32-byte (64 hex char) value.
   */
  unsafePaymentIdForTesting?: `0x${string}`
}

/**
 * Builds one `PaymentRequirements` entry per chain in `config.accept`, all
 * describing the same payment request (same `resource`, same price, same
 * `paymentId`) so a client can pay on whichever accepted chain it prefers.
 *
 * Each entry's `extra.merchantEvm` is that chain's address specifically
 * (`config.merchantEvm[network]`), not a single global value — a client
 * computing the nonce for e.g. `polygon-amoy` must hash the `polygon-amoy`
 * payout address, not `base-sepolia`'s. Mixing those up would make every
 * settlement attempt revert `MerchantNotBound`.
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
  const paymentId = options.unsafePaymentIdForTesting ?? generatePaymentId()
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
    extra: {
      settleTo: config.settleTo,
      merchant: config.merchant,
      merchantEvm: config.merchantEvm[network],
      paymentId,
    },
  }))
}
