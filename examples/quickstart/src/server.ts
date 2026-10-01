/**
 * The smallest useful ferry402 integration.
 *
 * Run it, curl the route, and you get an HTTP 402 carrying a machine-readable
 * bill: which chain, which token, how much, and where to send it. No wallet,
 * no funded account, no facilitator, no blockchain connection of any kind --
 * issuing a challenge is pure computation (an HMAC), which is the point.
 *
 * What this does NOT do is complete a payment. That needs a facilitator to
 * verify the signature and submit the settlement on-chain. See
 * `examples/demo` (terminal) or `examples/demo-ui` (browser) for the whole
 * flow running against live Base Sepolia and Hedera testnet.
 */
import { randomBytes } from 'node:crypto'
import express from 'express'
import { ferry402 } from '@ferry402/sdk'
import type { Ferry402Config } from '@ferry402/sdk'

// These are this project's real Base Sepolia deployments, so the 402 you get
// back names a genuine escrow and a genuine token rather than placeholders.
// Swap in your own once you have deployed `Escrow.sol` -- see the root
// README's "Deploying your own".
const config: Ferry402Config = {
  price: '$0.01',
  accept: ['base-sepolia'],
  settleTo: 'hedera',

  // Two different identifiers, deliberately: `merchant` is who you are on
  // Hedera (the clearing ledger), `merchantEvm` is where you get paid on each
  // EVM chain. The nonce binding hashes the EVM address, so mixing these up
  // makes every settlement revert.
  merchant: process.env.HEDERA_ACCOUNT_ID ?? '0.0.9823488',
  merchantEvm: { 'base-sepolia': '0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b' },

  escrows: { 'base-sepolia': '0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429' },
  assets: { 'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },

  facilitator: process.env.FERRY402_FACILITATOR ?? 'http://localhost:4000',

  // Generated per process ONLY because this example never completes a payment
  // and never runs as more than one instance. In production this must be a
  // stable value shared by every process serving the merchant -- a random one
  // would not throw, it would silently reject legitimate payments whenever a
  // payer's retry reached a different instance than the one that issued their
  // 402. Generate with `openssl rand -hex 32` and load it from a secret store.
  secret: process.env.FERRY402_SECRET ?? randomBytes(32).toString('hex'),
}

const app = express()

// The entire integration: one middleware. Your handler is ordinary Express and
// runs only once payment verifies.
app.get('/quote', ferry402(config), (_req, res) => {
  res.json({ pair: 'HBAR/USD', price: '0.0734', asOf: new Date().toISOString() })
})

const port = Number(process.env.PORT ?? 3000)
app.listen(port, () => {
  console.log(`\nferry402 quickstart — http://localhost:${port}`)
  console.log(`\n  curl -s http://localhost:${port}/quote | jq\n`)
  console.log('Expect HTTP 402 and an `accepts` array. That is the bill.')
  if (!process.env.FERRY402_SECRET) {
    console.log('\n[note] FERRY402_SECRET not set — generated one for this process.')
    console.log('       Fine here; never do this in production (see src/server.ts).')
  }
})
