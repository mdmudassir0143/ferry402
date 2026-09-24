import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { domainTokenAbi, domainTokenBytecode } from '../fixtures/DomainToken.abi.js'
import { escrowAbi, escrowBytecode } from '../fixtures/Escrow.abi.js'
import { settleTokenAbi, settleTokenBytecode } from '../fixtures/SettleToken.abi.js'

/**
 * anvil's well-known default account #0/#1/#2 private keys, derived from its
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
/**
 * Account #2 -- used as `startAnvilWithEscrow`'s DEFAULT deployer, distinct
 * from `ANVIL_DEPLOYER_PRIVATE_KEY` (account #0, `startAnvilWithDomainToken`'s
 * deployer). A CREATE address depends only on (sender, nonce) -- never on
 * chain id -- so two INDEPENDENT anvil instances that both deploy their
 * first-ever contract from the SAME sender key end up with byte-IDENTICAL
 * contract addresses despite being unrelated tokens on unrelated chains. A
 * test file that boots both fixtures (see `server.test.ts`) shares ONE
 * process, and therefore `chains/base.ts`'s process-lifetime `domainCache`
 * (keyed by `(chainId, asset)`, and both fixtures default to the same
 * `BASE_SEPOLIA_CHAIN_ID`): an address collision there is not cosmetic, it
 * silently serves one token's cached EIP-712 domain for the other, and every
 * signature recovered against the wrong domain fails. Using a different
 * default deployer for each fixture avoids this entirely, independent of
 * deployment order or nonce bookkeeping.
 */
export const ANVIL_ESCROW_DEPLOYER_PRIVATE_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

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

/**
 * Base Sepolia's real, declared chain id (viem's `baseSepolia.id`). Since
 * task-7 review round 1 (I2), `verifyPayment` builds its signing domain from
 * this STATIC id for `network: 'base-sepolia'`, never from a live RPC call —
 * so every test anvil instance must actually report this chain id, or every
 * signature test would fail on a domain mismatch that has nothing to do
 * with what's actually under test. This is also what let I2 be tested at
 * all: a fixture at any OTHER chain id is exactly the "misconfigured RPC"
 * scenario `verifyPayment` must now refuse outright.
 */
export const BASE_SEPOLIA_CHAIN_ID = 84532

export interface AnvilFixture {
  rpcUrl: string
  tokenAddress: Address
  /** The chain id anvil actually reports over RPC — `BASE_SEPOLIA_CHAIN_ID`
   *  unless a different `chainId` was requested. Read live rather than
   *  assumed, so a test can tell whether anvil actually honored the
   *  requested `--chain-id`. */
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
 *
 * `chainId` defaults to `BASE_SEPOLIA_CHAIN_ID` (84532) — matching what
 * `verifyPayment` declares for `network: 'base-sepolia'` — since that's the
 * network every other test in this suite uses. Pass a different value only
 * to deliberately construct a chain-id MISMATCH (see the I2 review-fix
 * tests), which is the one case that needs anything else.
 */
export async function startAnvilWithDomainToken(params: {
  name: string
  version: string
  chainId?: number
}): Promise<AnvilFixture> {
  const requestedChainId = params.chainId ?? BASE_SEPOLIA_CHAIN_ID
  const port = await getFreePort()
  const rpcUrl = `http://127.0.0.1:${port}`

  const child = spawn('anvil', ['--port', String(port), '--chain-id', String(requestedChainId), '--silent'], {
    stdio: 'ignore',
  })
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

export interface EscrowAnvilFixture {
  rpcUrl: string
  /** The chain id anvil actually reports over RPC -- see `AnvilFixture.chainId`'s doc comment. */
  chainId: number
  /** The deployed `MockUSDC` (EIP-3009 + ERC20-ish) token address. */
  tokenAddress: Address
  /** The deployed `Escrow` address -- also `requirements.payTo` in every
   *  settle.fork.test.ts fixture, since `Escrow.settleAuthorization` requires
   *  `auth.to == address(this)`. */
  escrowAddress: Address
  /** Pre-funded with `payerInitialBalance` MockUSDC (default 1_000e6). */
  payerAddress: Address
  stop: () => Promise<void>
}

/**
 * Spins up a local, freshly-genesis'd anvil chain and deploys `SettleToken` +
 * `Escrow` to it -- Task 8's settlement fixture.
 *
 * Unlike `startAnvilWithDomainToken` (which deploys a token that only
 * exposes `name()`/`version()`, deliberately incapable of executing a real
 * transfer -- see DomainToken.sol's doc comment), `settlePayment` actually
 * submits `Escrow.settleAuthorization`, which calls the token's
 * `receiveWithAuthorization`. That needs a token that can both EXECUTE an
 * EIP-3009 authorization end-to-end (single-use nonces, time windows,
 * non-malleable signatures enforced) AND expose a public `version()` getter
 * for `verifyPayment` to read the EIP-712 domain from chain (Task 7's own
 * requirement) -- see `SettleToken.sol`'s doc comment for why neither
 * `DomainToken.sol` nor `packages/contracts/test/mocks/MockUSDC.sol` alone
 * has both properties at once.
 */
export async function startAnvilWithEscrow(
  params: { payerInitialBalance?: bigint; deployerPrivateKey?: Hex } = {},
): Promise<EscrowAnvilFixture> {
  const port = await getFreePort()
  const rpcUrl = `http://127.0.0.1:${port}`

  const child = spawn(
    'anvil',
    ['--port', String(port), '--chain-id', String(BASE_SEPOLIA_CHAIN_ID), '--silent'],
    { stdio: 'ignore' },
  )
  let spawnError: Error | undefined
  child.once('error', (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err))
  })

  await waitForRpcReady(rpcUrl, 15_000)
  if (spawnError) throw spawnError

  // Defaults to a DIFFERENT account than `startAnvilWithDomainToken`'s own
  // deployer -- see `ANVIL_ESCROW_DEPLOYER_PRIVATE_KEY`'s doc comment for why
  // that matters. A caller that boots only this ONE fixture in a given test
  // file (i.e. every current caller except `server.test.ts`) never observes
  // any difference from using account #0 here too.
  const account = privateKeyToAccount(params.deployerPrivateKey ?? ANVIL_ESCROW_DEPLOYER_PRIVATE_KEY)
  const walletClient = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) })
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) })

  const tokenDeployHash = await walletClient.deployContract({
    abi: settleTokenAbi,
    bytecode: settleTokenBytecode,
    args: [],
  })
  const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenDeployHash })
  if (!tokenReceipt.contractAddress) {
    await stopChild(child)
    throw new Error('SettleToken deployment produced no contract address')
  }
  const tokenAddress = tokenReceipt.contractAddress

  const escrowDeployHash = await walletClient.deployContract({
    abi: escrowAbi,
    bytecode: escrowBytecode,
    args: [tokenAddress],
  })
  const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowDeployHash })
  if (!escrowReceipt.contractAddress) {
    await stopChild(child)
    throw new Error('Escrow deployment produced no contract address')
  }
  const escrowAddress = escrowReceipt.contractAddress

  // 1_000 USDC at 6 decimals, matching Escrow.t.sol's own payer funding.
  const payerInitialBalance = params.payerInitialBalance ?? 1_000_000_000n
  const mintHash = await walletClient.writeContract({
    address: tokenAddress,
    abi: settleTokenAbi,
    functionName: 'mint',
    args: [ANVIL_PAYER_ADDRESS, payerInitialBalance],
  })
  await publicClient.waitForTransactionReceipt({ hash: mintHash })

  const chainId = await publicClient.getChainId()

  return {
    rpcUrl,
    chainId,
    tokenAddress,
    escrowAddress,
    payerAddress: ANVIL_PAYER_ADDRESS,
    stop: () => stopChild(child),
  }
}
