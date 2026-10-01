/**
 * Base Sepolia read helpers, factored out of `run.ts` so `examples/demo` and
 * `examples/demo-ui` poll the escrow balance identically.
 */
import type { Address, createPublicClient } from 'viem'
import { escrowReadAbi } from './constants.js'

/**
 * `sepolia.base.org` is a public, load-balanced RPC with no read-your-writes
 * guarantee across requests — a `balanceOf` read immediately after a
 * settlement's own receipt can transiently return the PRE-settlement value
 * on a different backend node. This is a REAL, previously-observed flake
 * (see packages/facilitator/test/e2e.test.ts's `pollBalanceOf` doc comment),
 * not a hypothetical — polling the READ, not the settlement, is the honest
 * fix, so every caller of this does the same rather than hiding the lag
 * behind a fragile single read.
 */
export async function pollBalanceOf(
  publicClient: ReturnType<typeof createPublicClient>,
  escrowAddress: Address,
  merchantEvm: Address,
  expectedAtLeast: bigint,
  { retries = 10, delayMs = 2_000 }: { retries?: number; delayMs?: number } = {},
): Promise<{ value: bigint; attempts: number }> {
  let last = 0n
  for (let attempt = 1; attempt <= retries; attempt++) {
    last = (await publicClient.readContract({ address: escrowAddress, abi: escrowReadAbi, functionName: 'balanceOf', args: [merchantEvm] })) as bigint
    if (last >= expectedAtLeast) return { value: last, attempts: attempt }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return { value: last, attempts: retries }
}

export async function readBalanceOf(
  publicClient: ReturnType<typeof createPublicClient>,
  address: Address,
  abi: typeof escrowReadAbi,
  account: Address,
): Promise<bigint> {
  return (await publicClient.readContract({ address, abi, functionName: 'balanceOf', args: [account] })) as bigint
}
