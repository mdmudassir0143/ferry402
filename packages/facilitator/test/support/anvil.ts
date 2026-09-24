import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { domainTokenAbi, domainTokenBytecode } from '../fixtures/DomainToken.abi.js'

/**
 * anvil's well-known default account #0/#1 private keys, derived from its
 * default mnemonic ("test test test test test test test test test test
 * test junk"). Confirmed directly against a locally-run `anvil`'s own
 * stdout ("Private Keys" section) while building this test harness — not
 * copied from memory. These fund no real network and are safe to commit;
 * every anvil instance anyone runs without `--mnemonic`/`--accounts`
 * overrides starts with the exact same keys.
 */
export const ANVIL_DEPLOYER_PRIVATE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const ANVIL_PAYER_PRIVATE_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
export const ANVIL_PAYER_ADDRESS: Address = privateKeyToAccount(ANVIL_PAYER_PRIVATE_KEY).address

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address && typeof address === 'object') {
        const { port } = address
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error('failed to allocate a free port for anvil'))
      }
    })
  })
}

async function waitForRpcReady(rpcUrl: string, deadlineMs: number): Promise<void> {
  const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) })
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      await client.getChainId()
      return
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`anvil RPC at ${rpcUrl} never became ready: ${String(err)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve()
      return
    }
    child.once('exit', () => resolve())
    child.kill()
    setTimeout(resolve, 2_000)
  })
}

export interface AnvilFixture {
  rpcUrl: string
  tokenAddress: Address
  /** The chain id anvil actually reports over RPC (default 31337). Read
   *  live rather than assumed, mirroring what `verifyPayment` itself does. */
  chainId: number
  stop: () => Promise<void>
}

/**
 * Spins up a local, freshly-genesis'd anvil chain — NOT a fork of live Base
 * Sepolia — and deploys the `DomainToken` test fixture to it.
 *
 * A plain local chain is all `verifyPayment`'s chain-dependent path needs:
 * standard EIP-712/ecrecover semantics and a contract exposing
 * `name()`/`version()` are identical between a local anvil and a real Base
 * Sepolia RPC. Forking would add a real network dependency (and flakiness)
 * for no behavioral difference this test cares about, so a plain chain is
 * preferred per the task's own guidance ("prefer a local anvil fork of Base
 * Sepolia over live calls" — read as: prefer local anvil over live network
 * calls at all).
 *
 * Deploys `DomainToken` with the given (deliberately non-standard, in
 * callers) `name`/`version` — see DomainToken.sol's doc comment for why
 * that specific choice matters for what this proves.
 */
export async function startAnvilWithDomainToken(params: { name: string; version: string }): Promise<AnvilFixture> {
  const port = await getFreePort()
  const rpcUrl = `http://127.0.0.1:${port}`

  const child = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' })
  let spawnError: Error | undefined
  child.once('error', (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err))
  })

  await waitForRpcReady(rpcUrl, 15_000)
  if (spawnError) throw spawnError

  const account = privateKeyToAccount(ANVIL_DEPLOYER_PRIVATE_KEY)
  const walletClient = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) })
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) })

  const deployHash = await walletClient.deployContract({
    abi: domainTokenAbi,
    bytecode: domainTokenBytecode,
    args: [params.name, params.version],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
  if (!receipt.contractAddress) {
    await stopChild(child)
    throw new Error('DomainToken deployment produced no contract address')
  }
  const chainId = await publicClient.getChainId()

  return {
    rpcUrl,
    tokenAddress: receipt.contractAddress,
    chainId,
    stop: () => stopChild(child),
  }
}
