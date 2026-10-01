/**
 * Shared `.env` loading for both `examples/demo` (the CLI) and
 * `examples/demo-ui` (the browser-facing version of the same flow).
 *
 * Factored out of `run.ts` so both entry points load config the exact same
 * way instead of two copies drifting apart — see `examples/demo-ui`'s
 * `server.ts` for the other caller.
 */
import type { Address, Hex } from 'viem'

/** Loads the first `.env` file that exists among `candidates`, in order.
 *  Returns the path that was actually loaded, or `null` if none were found
 *  (relying on whatever is already in the shell environment). Never throws
 *  on a missing file — only a required variable missing afterward should. */
export function loadEnv(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate)
      return candidate
    } catch {
      // try the next candidate
    }
  }
  return null
}

export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is required (see README.md "Environment variables"). Set it in the repo root .env ` +
        'or this example\'s own .env before running it.',
    )
  }
  return value
}

/** Every credential/address the demo flow needs — identical shape for the
 *  CLI and the UI server, read from the same repo-root `.env`. */
export interface DemoFlowEnv {
  payerPrivateKey: Hex
  facilitatorPrivateKey: Hex
  deployerPrivateKey: Hex
  rpcUrl: string
  escrowAddress: Address
  hederaAccountId: string
  hederaPrivateKeyDer: string
  topicId: string
}

/** Reads the `DemoFlowEnv` shape from `process.env`. Call `loadEnv()` first
 *  so a `.env` file has had a chance to populate `process.env`. Throws with
 *  a clear message naming the missing variable — never a partial/undefined
 *  config silently passed on. */
export function readDemoFlowEnv(): DemoFlowEnv {
  return {
    payerPrivateKey: requiredEnv('PAYER_PRIVATE_KEY') as Hex,
    facilitatorPrivateKey: requiredEnv('FACILITATOR_PRIVATE_KEY') as Hex,
    deployerPrivateKey: requiredEnv('DEPLOYER_PRIVATE_KEY') as Hex,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
    escrowAddress: requiredEnv('ESCROW_ADDRESS_BASE_SEPOLIA') as Address,
    hederaAccountId: requiredEnv('HEDERA_ACCOUNT_ID'),
    hederaPrivateKeyDer: requiredEnv('HEDERA_PRIVATE_KEY'),
    topicId: requiredEnv('HCS_TOPIC_ID'),
  }
}
