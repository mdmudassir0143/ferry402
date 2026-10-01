import { randomBytes } from 'node:crypto'
import type { Ferry402Config, PaymentRequirements, SupportedChain } from './types.js'

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

  /**
   * Skips generating a random `paymentId` entirely and fills every entry's
   * `extra.paymentId` with a fixed all-zero placeholder instead — for a
   * caller that immediately overwrites EVERY entry's `extra.paymentId`
   * itself right after this call returns and would otherwise pay for a
   * `randomBytes(32)` draw whose output is computed and then thrown away,
   * unread, on every single call.
   *
   * As of this writing the only such caller is `ferry402`'s stateless
   * challenge derivation (Task 12, `middleware.ts`'s `issueChallenge`):
   * since Task 12, `paymentId` is DERIVED
   * (`HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)`,
   * `challengeDerivation.ts`) rather than randomly minted, so the default
   * CSPRNG path here is dead weight on that call site specifically — a
   * `crypto.randomBytes` draw is not free, and it runs on every single HTTP
   * request `ferry402` handles, discarded immediately.
   *
   * NEVER combine this with relying on the RETURNED `paymentId` being real:
   * a caller that sets this and then does NOT overwrite every entry
   * publishes an all-zero, trivially-guessable paymentId. Ignored if
   * `unsafePaymentIdForTesting` is also supplied (that one wins).
   */
  skipPaymentIdGeneration?: boolean
}

/** The fixed placeholder `skipPaymentIdGeneration` fills every entry with.
 *  Never meant to reach a real 402 response — see that option's doc comment. */
const ZERO_PAYMENT_ID_PLACEHOLDER: `0x${string}` = `0x${'0'.repeat(64)}`

/**
 * Every chain listed in `config.accept` must have an entry in all three
 * per-chain maps. Enforced here rather than by the type system because
 * `merchantEvm`/`escrows`/`assets` are `Partial` as of 0.2.0 (see
 * `types.ts`) — a merchant accepting only `base-sepolia` should not have to
 * invent placeholder addresses for chains it never serves.
 *
 * Without this check a missing entry fails silently and late: the map lookup
 * below yields `undefined`, that flows into the returned
 * `PaymentRequirements`, `JSON.stringify` drops the key from the 402 body
 * entirely, and a payer who gets that far fails the facilitator's schema
 * parse with a generic rejection that never names the merchant's actual
 * mistake.
 *
 * Called from two places on purpose. `ferry402()` calls it once at
 * construction, so a misconfigured merchant finds out at boot rather than on
 * first traffic. `buildRequirements` calls it per invocation, because it is a
 * public export documented for callers issuing their own 402s — they bypass
 * the constructor entirely, and the casts below would otherwise hand them a
 * silent `undefined` typed as `0x${string}`. The per-request cost is three
 * property lookups per accepted chain, against the HMACs this same path
 * already computes.
 */
export function assertChainsConfigured(config: Ferry402Config): void {
  for (const chain of config.accept) {
    const missing = (['merchantEvm', 'escrows', 'assets'] as const).filter((field) => !config[field][chain])
    if (missing.length === 0) continue
    throw new Error(
      `ferry402: config.accept includes "${chain}", but ${missing.join(', ')} ` +
        `${missing.length > 1 ? 'have' : 'has'} no entry for it. Every chain listed in "accept" needs ` +
        'an entry in merchantEvm, escrows, AND assets - a chain your merchant does not accept can ' +
        'simply be left out of all three. Example:\n\n' +
        '  ferry402({\n' +
        `    accept: ['${chain}'],\n` +
        `    merchantEvm: { '${chain}': '0xYourPayoutAddress' },\n` +
        `    escrows: { '${chain}': '0xYourDeployedEscrowAddress' },\n` +
        `    assets: { '${chain}': '0xUSDCAddress' },\n` +
        '    ...\n' +
        '  })\n',
    )
  }
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
  config: Ferry402Config,
  resource: string,
  options: BuildRequirementsOptions = {},
): PaymentRequirements[] {
  const maxAmountRequired = parsePrice(config.price)
  const paymentId =
    options.unsafePaymentIdForTesting ??
    (options.skipPaymentIdGeneration ? ZERO_PAYMENT_ID_PLACEHOLDER : generatePaymentId())
  if (!PAYMENT_ID_RE.test(paymentId)) {
    throw new Error(`invalid paymentId: expected 0x-prefixed 32-byte hex, got ${paymentId}`)
  }
  assertChainsConfigured(config)

  return config.accept.map((network: SupportedChain) => ({
    scheme: 'exact' as const,
    network,
    maxAmountRequired,
    resource,
    description: `Payment for ${resource}`,
    mimeType: 'application/json',
    payTo: config.escrows[network] as `0x${string}`,
    maxTimeoutSeconds: 300,
    asset: config.assets[network] as `0x${string}`,
    extra: {
      settleTo: config.settleTo,
      merchant: config.merchant,
      merchantEvm: config.merchantEvm[network],
      paymentId,
    },
  }))
}
