# ferry402 quickstart

The smallest useful integration: **one Express route, charged per call.**

```bash
npm install
npm start
```

Then, in another terminal:

```bash
curl -s http://localhost:3000/quote | jq
```

You get an HTTP **402** with a machine-readable bill — which chain, which
token, how much, and where to send it:

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "10000",
      "resource": "http://localhost:3000/quote",
      "payTo": "0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": {
        "settleTo": "hedera",
        "merchant": "0.0.9823488",
        "merchantEvm": "0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b",
        "paymentId": "0xb020fa759c949d9cfc8558204ad1f8a1165afcdd0af0fbe403ad26de45bc5350"
      }
    }
  ]
}
```

## What makes this interesting

**No wallet. No funded account. No blockchain connection.** Issuing a
challenge is pure computation — an HMAC over
`(merchantEvm, resource, 5-minute time bucket)` — so a 402 costs no storage
and no network call, however many anonymous requests you get. That is the
whole reason there is no challenge database to exhaust.

The integration is the middleware and nothing else:

```ts
app.get('/quote', ferry402(config), (_req, res) => {
  res.json({ pair: 'HBAR/USD', price: '0.0734' })
})
```

Your handler is ordinary Express and runs only once payment verifies.

## What this does *not* do

**It cannot complete a payment.** Settling needs a facilitator to verify the
signature and submit the transaction on-chain. This example deliberately has
neither, so that it runs with zero setup.

For the whole flow against live Base Sepolia and Hedera testnet:

| | |
|---|---|
| [`examples/demo`](../demo) | The full flow in the terminal, narrated |
| [`examples/demo-ui`](../demo-ui) | The same flow in a browser, step by step |

Both settle real USDC and write a real Hedera journal entry, so both need a
funded `.env`.

## Two things to change before you use this for real

**Deploy your own escrow.** The addresses above are this project's Base
Sepolia deployments, used so the 402 names something genuine rather than a
placeholder. See the root README's "Deploying your own".

**Set a stable `FERRY402_SECRET`.** This example generates one per process,
which is fine only because it never completes a payment and never runs as
more than one instance. In production every process serving a merchant must
share the same secret — a random one wouldn't throw, it would silently reject
legitimate payments whenever a payer's retry landed on a different instance
than the one that issued their 402.

```bash
FERRY402_SECRET=$(openssl rand -hex 32) npm start
```

## Overrides

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `FERRY402_SECRET` | generated per process |
| `FERRY402_FACILITATOR` | `http://localhost:4000` |
| `HEDERA_ACCOUNT_ID` | `0.0.9823488` |

## Licence

MIT — see [LICENSE](../../LICENSE).
