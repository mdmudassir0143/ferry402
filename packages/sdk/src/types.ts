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
 * Chains anychain402 can advertise as payment options.
 *
 * This is intentionally a subset of upstream x402's `Network` enum, verified
 * against x402@1.2.0's own schema (`PaymentRequirementsSchema.network`):
 *   "abstract" | "abstract-testnet" | "base-sepolia" | "base" |
 *   "avalanche-fuji" | "avalanche" | "iotex" | "solana-devnet" | "solana" |
 *   "sei" | "sei-testnet" | "polygon" | "polygon-amoy" | "peaq" | "story" |
 *   "educhain" | "skale-base-sepolia"
 *
 * `base`, `base-sepolia`, `polygon`, and `polygon-amoy` are the only chains
 * anychain402 v1 has an `Escrow` deployment story for. Do not add Arbitrum,
 * Ethereum, Optimism, or Hedera here: none of those appear in upstream's
 * enum, so a `PaymentRequirements` entry naming them would fail upstream
 * validation.
 */
export type SupportedChain = 'base' | 'base-sepolia' | 'polygon' | 'polygon-amoy'

/**
 * One merchant's multi-chain acceptance config. `buildRequirements` turns
 * this into the array of `PaymentRequirements` a 402 response advertises.
 */
export type Anychain402Config = {
  /** Price as a decimal-dollar string, e.g. "$0.01". USDC only in v1. */
  price: string
  /** Chains this merchant is willing to accept payment on. */
  accept: SupportedChain[]
  /** anychain402 v1 always settles to Hedera. */
  settleTo: 'hedera'
  /** Merchant identity the facilitator credits once a payment settles. */
  merchant: string
  /** Base URL of the facilitator that verifies/settles payments. */
  facilitator: string
  /** Per-chain `Escrow` contract address funds are paid into. */
  escrows: Record<SupportedChain, `0x${string}`>
  /** Per-chain USDC (or other v1-supported asset) contract address. */
  assets: Record<SupportedChain, `0x${string}`>
}
