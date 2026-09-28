// `PaymentRequirements` is deliberately NOT hand-defined here. It is imported
// from the upstream `x402` package (the canonical spec) and re-exported so
// the rest of this SDK — and anyone consuming it — depends on one shape.
//
// Note: x402@1.2.0's package.json `exports` map has no root (".") entry, so
// `import ... from 'x402'` does not resolve under Node's `exports`-aware
// resolution (which this workspace uses via `moduleResolution: "NodeNext"`).
// The type lives at the `x402/types` subpath instead; that's the entry point
// this file re-exports through.
export type { PaymentRequirements } from 'x402/types'

/**
 * Chains ferry402 can advertise as payment options.
 *
 * This is intentionally a subset of upstream x402's `Network` enum, verified
 * against x402@1.2.0's own schema (`PaymentRequirementsSchema.network`):
 *   "abstract" | "abstract-testnet" | "base-sepolia" | "base" |
 *   "avalanche-fuji" | "avalanche" | "iotex" | "solana-devnet" | "solana" |
 *   "sei" | "sei-testnet" | "polygon" | "polygon-amoy" | "peaq" | "story" |
 *   "educhain" | "skale-base-sepolia"
 *
 * `base`, `base-sepolia`, `polygon`, and `polygon-amoy` are the only chains
 * ferry402 v1 has an `Escrow` deployment story for. Do not add Arbitrum,
 * Ethereum, Optimism, or Hedera here: none of those appear in upstream's
 * enum, so a `PaymentRequirements` entry naming them would fail upstream
 * validation.
 */
export type SupportedChain = 'base' | 'base-sepolia' | 'polygon' | 'polygon-amoy'

/**
 * One merchant's multi-chain acceptance config. `buildRequirements` turns
 * this into the array of `PaymentRequirements` a 402 response advertises.
 */
export type Ferry402Config = {
  /** Price as a decimal-dollar string, e.g. "$0.01". USDC only in v1. */
  price: string
  /** Chains this merchant is willing to accept payment on. */
  accept: SupportedChain[]
  /** ferry402 v1 always settles to Hedera. */
  settleTo: 'hedera'
  /**
   * Merchant identity on the clearing layer: a Hedera account id (e.g.
   * "0.0.123456"). The HCS journal and settlement ledger key on this — it is
   * NOT what the `Escrow` contract binds into the authorization nonce (see
   * `merchantEvm`), because it isn't an EVM address.
   */
  merchant: string
  /**
   * Per-chain EVM address for this merchant. This is the `Escrow` ledger row
   * key, the account allowed to call `withdraw`, and (together with
   * `paymentId`) one of the two preimages of the on-chain nonce:
   * `keccak256(abi.encode(merchantEvm[network], paymentId))`. Per-chain
   * rather than a single global address because a merchant may control a
   * different payout address on each chain — the settlement ledger maps one
   * Hedera account id to several per-chain payout addresses.
   */
  merchantEvm: Record<SupportedChain, `0x${string}`>
  /** Base URL of the facilitator that verifies/settles payments. */
  facilitator: string
  /** Per-chain `Escrow` contract address funds are paid into. */
  escrows: Record<SupportedChain, `0x${string}`>
  /** Per-chain USDC (or other v1-supported asset) contract address. */
  assets: Record<SupportedChain, `0x${string}`>
  /**
   * The HMAC key `ferry402` derives every challenge's `paymentId`/`nonce`
   * from (Task 12: stateless challenge derivation — see
   * `challengeDerivation.ts`):
   *
   * ```
   * paymentId = HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)
   * nonce     = keccak256(abi.encode(merchantEvm, paymentId))
   * ```
   *
   * **Required. Minimum 32 bytes (UTF-8). `ferry402(config)` THROWS at
   * construction if this is missing or short** — see
   * `challengeDerivation.assertValidSecret`. There is deliberately no
   * fallback to a randomly-generated secret: a per-process random value
   * would make every derived nonce process-specific, so a payment routed to
   * a different instance than the one whose 402 the payer saw would never
   * verify — silently breaking every horizontally-scaled or
   * rolling-restarted deployment, in a way that only appears under load.
   *
   * MUST be the exact same value on every process/instance serving this
   * merchant's traffic (that is precisely what lets two independent
   * `ferry402` instances validate each other's challenges with no shared
   * store at all). Generate it once with real CSPRNG randomness (e.g.
   * `openssl rand -hex 32`) and load it from a secret store / environment
   * variable — never commit it, never derive it from anything guessable.
   */
  secret: string
}
