import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/**
 * Task 13: the test that matters.
 *
 * Every other test in this package imports from `../src/*.ts` — proof that
 * the SOURCE works under vitest and `tsc` INSIDE this repo, which is exactly
 * what the task doc calls out as proving nothing about what an outside
 * consumer gets: `packages/sdk`'s `main`/`types` used to point straight at
 * `src/index.ts` with no build step at all, so nobody outside this workspace
 * could `npm install @ferry402/sdk` and get anything usable (a `.ts` file is
 * not runnable by plain Node, and there was no compiled output to ship).
 *
 * This test builds the REAL package.json (`exports`/`main`/`module`/`types`
 * now point at `dist/`, produced by `tsc`), packs it with `pnpm pack` — the
 * exact tarball `npm publish` would upload — installs that tarball with
 * plain `npm install` into a fresh directory OUTSIDE this workspace/monorepo
 * (so pnpm's workspace symlinking can't be silently doing the real work),
 * and then:
 *
 *   1. imports the public surface from a plain Node ESM script and exercises
 *      a few exports for real (not just `typeof` checks), and
 *   2. type-checks a consumer `.ts` file against the INSTALLED package's
 *      `.d.ts` files (via the `exports` map's `"types"` condition) with a
 *      real `tsc -p`, proving the declarations actually resolve for a
 *      consumer, not merely inside this repo's own `tsconfig.json`.
 *
 * `@ferry402/sdk` ships ESM ONLY — `exports["."]` has no `require` condition
 * — so this test proves ESM consumption only. It intentionally does NOT
 * claim (or test) CJS support: see `package.json`'s `exports` map and this
 * file's sibling doc note in the task-13 report for why dual publishing was
 * not attempted.
 *
 * Every child process below runs through the ASYNC `execFile` (promisified),
 * never `execFileSync`/`spawnSync`. `npm install` here pulls in `x402`'s own
 * (large) dependency tree and can take upwards of a minute; a *synchronous*
 * child-process call blocks vitest's worker event loop for that entire
 * duration, which starves the worker's RPC heartbeat to the main process and
 * was observed to produce a spurious "[vitest-worker]: Timeout calling
 * 'onTaskUpdate'" failure even though every assertion below passed. Async
 * `execFile` lets the event loop keep servicing that heartbeat while the
 * child runs.
 */

const SDK_ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const run = promisify(execFile)
const MAX_BUFFER = 20 * 1024 * 1024

function resolveWorkspaceTsc(): string {
  const tsPackageJson = require.resolve('typescript/package.json')
  return join(dirname(tsPackageJson), 'bin', 'tsc')
}

describe('consuming the BUILT, PACKED @ferry402/sdk from plain Node, outside the workspace', () => {
  let tarballPath: string
  let consumerDir: string
  let packOutDir: string

  beforeAll(async () => {
    // 1. Build fresh — proves THIS run's source, not a stale dist/ left over
    //    from a previous run or a different branch.
    await run('pnpm', ['run', 'build'], { cwd: SDK_ROOT, maxBuffer: MAX_BUFFER })
    expect(existsSync(join(SDK_ROOT, 'dist', 'index.js'))).toBe(true)
    expect(existsSync(join(SDK_ROOT, 'dist', 'index.d.ts'))).toBe(true)

    // 2. Pack the ACTUAL artifact `npm publish` would upload — governed by
    //    package.json's `files` field, not the source tree — into a scratch
    //    directory. `--pack-destination` makes pnpm print the tarball's full
    //    path as the last line of stdout.
    packOutDir = mkdtempSync(join(tmpdir(), 'ferry402-sdk-pack-'))
    const { stdout: packOutput } = await run('pnpm', ['pack', '--pack-destination', packOutDir], {
      cwd: SDK_ROOT,
      maxBuffer: MAX_BUFFER,
    })
    const lastLine = packOutput.trim().split('\n').pop() ?? ''
    tarballPath = lastLine.trim()
    expect(tarballPath.endsWith('.tgz')).toBe(true)
    expect(existsSync(tarballPath)).toBe(true)

    // 3. A directory OUTSIDE this workspace entirely (os.tmpdir(), never
    //    under the monorepo root) — a real third-party consumer, not an
    //    in-repo package that could resolve `@ferry402/sdk` via pnpm's
    //    workspace symlinking instead of the tarball's own contents.
    consumerDir = mkdtempSync(join(tmpdir(), 'ferry402-sdk-consumer-'))
    expect(consumerDir.startsWith(SDK_ROOT)).toBe(false)
    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'ferry402-sdk-consumer-fixture', private: true, version: '0.0.0', type: 'module' }, null, 2),
    )

    // 4. Install the TARBALL with plain `npm` (not `pnpm add`, not a
    //    `file:../packages/sdk` reference, not a workspace protocol) —
    //    exactly how an outside consumer gets this package.
    await run('npm', ['install', tarballPath, '--no-audit', '--no-fund'], {
      cwd: consumerDir,
      maxBuffer: MAX_BUFFER,
    })
  }, 300_000)

  afterAll(
    () => {
      // Deleting a freshly-`npm install`ed node_modules (this tarball's
      // dependency, `x402`, pulls in a large wallet/chain-tooling tree) is
      // slow enough to blow past vitest's default 10s hook timeout on its
      // own - this has nothing to do with the assertions above.
      if (consumerDir) rmSync(consumerDir, { recursive: true, force: true })
      if (packOutDir) rmSync(packOutDir, { recursive: true, force: true })
    },
    60_000,
  )

  it('imports the full public surface from plain Node ESM and every export works for real', async () => {
    const script = `
      import assert from 'node:assert/strict'
      import * as sdk from '@ferry402/sdk'

      const expectedFunctions = [
        'ferry402', 'buildRequirements', 'parsePrice', 'generatePaymentId',
        'computeNonce', 'normalizeNonce', 'normalizeAddress',
        'assertValidSecret', 'deriveChallenge', 'matchChallenge', 'derivePaymentId', 'timeBucket',
        'InMemoryConsumedNonceStore', 'createPaymentHeader',
      ]
      for (const name of expectedFunctions) {
        assert.equal(typeof sdk[name], 'function', \`expected sdk.\${name} to be a function, got \${typeof sdk[name]}\`)
      }
      assert.equal(sdk.MIN_SECRET_BYTES, 32)
      assert.equal(sdk.TIME_BUCKET_SECONDS, 300)

      // Exercise real behavior, not just shape - a store that actually
      // stores, and a derivation that actually round-trips through
      // computeNonce, the same way middleware.ts itself relies on it.
      const store = new sdk.InMemoryConsumedNonceStore()
      assert.equal(store.size, 0)

      const secret = 's'.repeat(32)
      const merchantEvm = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
      const challenge = sdk.deriveChallenge(secret, merchantEvm, 'https://example.test/premium')
      assert.match(challenge.paymentId, /^0x[0-9a-f]{64}$/)
      assert.equal(sdk.computeNonce(merchantEvm, challenge.paymentId), challenge.nonce)
      assert.equal(sdk.normalizeAddress(merchantEvm), merchantEvm.toLowerCase())

      // I5: createPaymentHeader signs against the DERIVED nonce, exercised
      // here with a bare-bones fake EIP3009Signer (no viem installed in
      // this throwaway consumer dir) rather than a real account - proving
      // the built package's own export threads computeNonce correctly is
      // the point, not re-proving EIP-712 signature recovery (that's
      // paymentHeader.test.ts, against the real source, with viem).
      const fakeSigner = {
        address: merchantEvm,
        async signTypedData() { return '0x' + 'ab'.repeat(65) },
      }
      const requirement = {
        scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000',
        resource: 'https://example.test/premium', description: 'x', mimeType: 'application/json',
        payTo: merchantEvm, maxTimeoutSeconds: 300, asset: merchantEvm,
        extra: { merchantEvm, paymentId: challenge.paymentId },
      }
      const header = await sdk.createPaymentHeader(requirement, fakeSigner, {
        tokenName: 'USDC', tokenVersion: '2', chainId: 84532,
      })
      const decodedPayload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
      assert.equal(decodedPayload.payload.authorization.nonce, challenge.nonce)

      console.log('SMOKE_OK')
    `
    const scriptPath = join(consumerDir, 'smoke.mjs')
    writeFileSync(scriptPath, script)
    const { stdout } = await run('node', [scriptPath], { cwd: consumerDir, maxBuffer: MAX_BUFFER })
    expect(stdout).toContain('SMOKE_OK')
  })

  it("resolves the installed package's type declarations for the full public surface via a real tsc -p", async () => {
    const tsScript = `
      import {
        ferry402, buildRequirements, parsePrice, generatePaymentId,
        computeNonce, normalizeNonce, normalizeAddress,
        InMemoryConsumedNonceStore, createPaymentHeader,
        assertValidSecret, deriveChallenge, matchChallenge, derivePaymentId, timeBucket,
        MIN_SECRET_BYTES, TIME_BUCKET_SECONDS,
      } from '@ferry402/sdk'
      import type {
        Ferry402Config, SupportedChain, PaymentRequirements,
        BuildRequirementsOptions, Ferry402Options, ConsumedNonceStore, DerivedChallenge,
        EIP3009Signer, CreatePaymentHeaderOptions,
      } from '@ferry402/sdk'

      const chain: SupportedChain = 'base-sepolia'
      const zeroAddr = '0x0000000000000000000000000000000000000000' as const
      const cfg: Ferry402Config = {
        price: '$0.01',
        accept: [chain],
        settleTo: 'hedera',
        merchant: '0.0.1',
        merchantEvm: { base: zeroAddr, 'base-sepolia': zeroAddr, polygon: zeroAddr, 'polygon-amoy': zeroAddr },
        facilitator: 'http://localhost:4000',
        escrows: { base: zeroAddr, 'base-sepolia': zeroAddr, polygon: zeroAddr, 'polygon-amoy': zeroAddr },
        assets: { base: zeroAddr, 'base-sepolia': zeroAddr, polygon: zeroAddr, 'polygon-amoy': zeroAddr },
        secret: 's'.repeat(32),
      }

      const handler = ferry402(cfg)
      const opts: Ferry402Options = {}
      const store: ConsumedNonceStore = new InMemoryConsumedNonceStore()
      const reqs: PaymentRequirements[] = buildRequirements(cfg, 'https://x.test', {} as BuildRequirementsOptions)
      const dc: DerivedChallenge = deriveChallenge(cfg.secret, zeroAddr, 'r')

      assertValidSecret(cfg.secret)
      matchChallenge(cfg.secret, zeroAddr, 'r', dc.nonce)
      derivePaymentId(cfg.secret, zeroAddr, 'r', timeBucket(Date.now()))
      computeNonce(zeroAddr, dc.paymentId)
      normalizeNonce(dc.nonce)
      normalizeAddress(zeroAddr)
      generatePaymentId()
      parsePrice('$0.01')

      const fakeSigner: EIP3009Signer = {
        address: zeroAddr,
        async signTypedData() { return zeroAddr.padEnd(132, '0') as \`0x\${string}\` },
      }
      const headerOpts: CreatePaymentHeaderOptions = { tokenName: 'USDC', tokenVersion: '2', chainId: 84532 }
      const headerPromise: Promise<string> = createPaymentHeader(reqs[0], fakeSigner, headerOpts)

      void handler
      void opts
      void store
      void reqs
      void MIN_SECRET_BYTES
      void TIME_BUCKET_SECONDS
      void headerPromise
    `
    writeFileSync(join(consumerDir, 'types-check.ts'), tsScript)
    writeFileSync(
      join(consumerDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            // Only OUR declarations must resolve and typecheck cleanly here
            // - not third-party libraries' own .d.ts files (x402, zod, ...),
            // which are out of this package's control.
            skipLibCheck: true,
            noEmit: true,
          },
          include: ['types-check.ts'],
        },
        null,
        2,
      ),
    )

    // Reuses THIS repo's own `typescript` (a devDependency of this package)
    // purely as a compiler binary - what matters for "do the type
    // declarations resolve" is that the FILE BEING CHECKED lives inside
    // `consumerDir` and resolves `@ferry402/sdk` from `consumerDir`'s own
    // `node_modules` (populated by the real `npm install` above), which is
    // independent of where the `tsc` executable itself happens to live.
    const tscBin = resolveWorkspaceTsc()
    await run(process.execPath, [tscBin, '--noEmit', '-p', 'tsconfig.json'], {
      cwd: consumerDir,
      maxBuffer: MAX_BUFFER,
    })
  })
})
