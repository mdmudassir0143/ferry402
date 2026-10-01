# Deployments

This is the transaction reference for `ferry402`'s live Base Sepolia +
Hedera testnet deployment. Every address, hash, block, gas figure, and
timestamp below was read directly from a public node on 2026-10-01 — see
`.superpowers/sdd/2026-09-23-anychain402-base-slice/verified-chain-facts.md`,
the source of record this document is built from. Nothing here is rounded,
estimated, or invented; where the source data marks something as unknown, this
document says so explicitly rather than guessing.

See [`docs/architecture.md`](architecture.md) for how these pieces fit
together, and the root [`README.md`](../README.md) for how to run the system
yourself.

## Deployed addresses (Base Sepolia, chain id 84532)

| Role | Address | Basescan |
|---|---|---|
| `Escrow` contract | `0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429` | [View](https://sepolia.basescan.org/address/0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429) |
| USDC (`Escrow.token()`) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | [View](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |
| Merchant EVM (`merchantEvm`) | `0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b` | [View](https://sepolia.basescan.org/address/0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b) |
| Facilitator settlement wallet | `0x80A45730ed0aEAEE88440331042B3c1b8b1c8Add` | [View](https://sepolia.basescan.org/address/0x80A45730ed0aEAEE88440331042B3c1b8b1c8Add) |
| Payer wallet | `0x829D4AF30f590a89611fa211c6cE24A50925922B` | [View](https://sepolia.basescan.org/address/0x829D4AF30f590a89611fa211c6cE24A50925922B) |

The deployer and the merchant EVM address are the same address
(`0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b`) in this deployment — the
deployer's own key was reused as the merchant's payout address, the same
convention `packages/facilitator/test/e2e.test.ts` and `examples/demo/src/run.ts`
both use. `Escrow.sol` has no constructor argument naming a merchant — the
contract is merchant-agnostic; any EVM address can be credited via
`settleAuthorization`'s own `merchant` argument, bound into the nonce (see
[`docs/architecture.md`](architecture.md#design-decisions-the-three-amendments)).

## The `Escrow` deployment record

| Field | Value |
|---|---|
| Transaction | [`0xcbca16cf6820716b31f0e33ae68084f7d4835c0c80458da82d50f81293819f25`](https://sepolia.basescan.org/tx/0xcbca16cf6820716b31f0e33ae68084f7d4835c0c80458da82d50f81293819f25) |
| Block | 47300767 |
| Timestamp | 2026-09-25T20:57:02Z (UTC) |
| Gas used | 1187384 |
| Deployer | [`0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b`](https://sepolia.basescan.org/address/0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b) |
| Constructor argument (`token_`) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle USDC, Base Sepolia, 6 decimals) |

**Source verification status: unknown.** Whether this `Escrow` deployment's
source is verified on Basescan has not been checked — confirming it needs an
Etherscan v2 API key this project does not currently have. Don't assume
either way. To verify it yourself:

```bash
cd packages/contracts
forge verify-contract \
  --chain-id 84532 \
  --constructor-args "$(cast abi-encode 'constructor(address)' 0x036CbD53842c5426634e7929541eC2318f3dCF7e)" \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 \
  src/Escrow.sol:Escrow
```

## The Hedera record

| Field | Value |
|---|---|
| HCS topic | [`0.0.10719807`](https://hashscan.io/testnet/topic/0.0.10719807) |
| Topic memo | `ferry402 journal (Task 10, live testnet)` |
| Created | consensus timestamp `1790369919.088242104` |
| Operator / auto-renew account | `0.0.9823488` |
| `admin_key` | `null` |
| `submit_key` | `null` |
| Entries | 7, sequence 1–7, 10000 atomic USDC each |

**Read `admin_key: null` / `submit_key: null` honestly, not as a feature.**
`admin_key: null` means the topic can never be deleted or reconfigured — that
part is a genuine permanence guarantee. But `submit_key: null` means there is
no gate on who can *write* to this topic: anyone with a Hedera account can
submit a `ConsensusSubmitMessage` naming this topic id, including a message
that looks exactly like a `ferry402` journal entry but was never produced by
a real settlement. **A reader cannot treat a message on this topic as proof
of payment on its own.** The only honest way to use this journal is the way
the reconciliation below uses it: filter by `merchantEvm`, then cross-check
each entry's `txHash` against the chain it claims. The journal is an ordered,
timestamped *index* a reader must verify against Base Sepolia — it is not
standalone, tamper-proof evidence of payment, and this document does not
describe it that way.

## Settlement transactions (all 7)

Every one of the seven settlements this deployment has processed, in order.
Every Base Sepolia transaction has `status: 1` (succeeded) and was sent from
the facilitator wallet above. Consensus timestamps link to Hashscan's
transaction view (`/testnet/transaction/<consensus_timestamp>`).

| HCS seq | Base Sepolia tx | Block | Gas used | Amount (atomic USDC) | Consensus timestamp |
|---|---|---|---|---|---|
| 1 | [`0xf8bee6c8b4d3e63ed772f912896fd7a9d2aa37e9b64dc0054bcce2736d6dc988`](https://sepolia.basescan.org/tx/0xf8bee6c8b4d3e63ed772f912896fd7a9d2aa37e9b64dc0054bcce2736d6dc988) | 47301076 | 141900 | 10000 | [`1790370439.097091821`](https://hashscan.io/testnet/transaction/1790370439.097091821) |
| 2 | [`0xa83f8ab070d85680379b143de6f57c3f852539a9decefba41b55e86d6b04e390`](https://sepolia.basescan.org/tx/0xa83f8ab070d85680379b143de6f57c3f852539a9decefba41b55e86d6b04e390) | 47301120 | 107700 | 10000 | [`1790370528.554012167`](https://hashscan.io/testnet/transaction/1790370528.554012167) |
| 3 | [`0x2961061318d479160c90f85e2eae9a5bc0a5f568104df77ec393064c7888c780`](https://sepolia.basescan.org/tx/0x2961061318d479160c90f85e2eae9a5bc0a5f568104df77ec393064c7888c780) | 47301417 | 107712 | 10000 | [`1790371121.483280892`](https://hashscan.io/testnet/transaction/1790371121.483280892) |
| 4 | [`0x58bd24c094b2560b239ae1038202f3c87c71c66aff290cd16764e7db8075b0d0`](https://sepolia.basescan.org/tx/0x58bd24c094b2560b239ae1038202f3c87c71c66aff290cd16764e7db8075b0d0) | 47537977 | 107676 | 10000 | [`1790844241.900431238`](https://hashscan.io/testnet/transaction/1790844241.900431238) |
| 5 | [`0x41ecfac0ce0d2f64bfcdb857da1eae684a887cbaa01b4c0be8569de5f418f3e9`](https://sepolia.basescan.org/tx/0x41ecfac0ce0d2f64bfcdb857da1eae684a887cbaa01b4c0be8569de5f418f3e9) | 47537997 | 107692 | 10000 | [`1790844282.881707249`](https://hashscan.io/testnet/transaction/1790844282.881707249) |
| 6 | [`0xc985d5cf0ae37d0dcf00fb8d44544bf1ec789e39d8a28f050e0efee561fd00ee`](https://sepolia.basescan.org/tx/0xc985d5cf0ae37d0dcf00fb8d44544bf1ec789e39d8a28f050e0efee561fd00ee) | 47538073 | 107712 | 10000 | [`1790844434.665917104`](https://hashscan.io/testnet/transaction/1790844434.665917104) |
| 7 | [`0x02f82398c8ddedc1d93246081c5d92719772e990b76e50ff3b219bdb7c381ffe`](https://sepolia.basescan.org/tx/0x02f82398c8ddedc1d93246081c5d92719772e990b76e50ff3b219bdb7c381ffe) | 47538498 | 107712 | 10000 | [`1790845284.566487104`](https://hashscan.io/testnet/transaction/1790845284.566487104) |

### The gas observation

Settlement 1 cost **141900 gas**; every settlement after it cost **~107700
gas** (107700, 107712, 107676, 107692, 107712, 107712 — a few hundred gas of
natural variance, not a different code path). The difference is the cold
`SSTORE` on `Escrow._balances[merchant]`: the EVM charges extra gas the first
time a storage slot is written from its zero value (a cold write), and every
write after that touches an already-nonzero slot (a warm write). A merchant's
*first* settlement against this `Escrow` deployment costs ~141.9k gas; every
subsequent settlement to the same merchant address costs ~107.7k gas, for as
long as that balance slot stays nonzero.

## The three-way reconciliation

Read live on 2026-10-01, from three independent sources:

| Source | Value (atomic USDC) |
|---|---|
| HCS journal total for this merchant (sum of all 7 `payment` entries) | 70000 |
| `Escrow.balanceOf(merchantEvm)` on Base Sepolia | 70000 |
| `USDC.balanceOf(escrow)` on Base Sepolia | 70000 |

70000 atomic units = 0.07 USDC across the seven 0.01 USDC payments above. All
three agree. The second and third numbers agreeing — the ledger row and the
token's real balance — is the **solvency property**: the merchant's credited
balance is fully backed by USDC the escrow contract actually holds, nothing
is credited that isn't there. The first number agreeing with the other two is
what makes the journal trustworthy *for this merchant, at this point in
time* — exactly the kind of cross-check [the Hedera record](#the-hedera-record)
above says is required, not optional.

Reproduce every number yourself, with no credentials — these are all public
reads:

```bash
cast call 0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 "balanceOf(address)(uint256)" \
  0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b --rpc-url https://sepolia.base.org
cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "balanceOf(address)(uint256)" \
  0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 --rpc-url https://sepolia.base.org
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10719807/messages?limit=25&order=asc"
```

The first `cast call` reads the escrow's internal ledger row for the merchant
address. The second reads the escrow contract's real on-chain USDC balance.
The third pages through every message on the journal topic — filter the
decoded (base64, then JSON) entries by `merchantEvm` and sum each matching
entry's `amount` to reproduce the journal total; `examples/demo/src/run.ts`'s
`sumJournalForMerchant` does exactly this.

Two other balances were observed at the same time, for context — **these will
have drifted by the time you read this**, since both wallets are live and
used for ongoing testing, so treat them as "at time of writing," not current
fact:

- Payer USDC remaining: 19930000 atomic (19.93 USDC)
- Facilitator ETH: 49994081322917796 wei (~0.049994 ETH)

## Deploy your own

Deploying your own `Escrow` and HCS topic gives you full control over the
trusted-escrow allowlist and the journal — nothing above is a shared or
hosted dependency.

### 1. Deploy `Escrow.sol`

```bash
cd packages/contracts
forge create src/Escrow.sol:Escrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --constructor-args <USDC_ADDRESS>
```

`--constructor-args` must be the **last** flag — `forge create`'s variadic
argument parser otherwise swallows a following flag (like `--broadcast`) into
the constructor-args list and reports a bogus argument-count mismatch. On
Base Sepolia, `<USDC_ADDRESS>` is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
(Circle's official USDC).

This produces one env var: `ESCROW_ADDRESS_BASE_SEPOLIA`, read from the
`forge create` output's deployed-address line. It is **not a secret** — it's
the allowlist entry you pass explicitly to
`createFacilitatorApp({ escrows: { 'base-sepolia': process.env.ESCROW_ADDRESS_BASE_SEPOLIA } })`;
nothing reads it automatically.

### 2. Create an HCS topic

```bash
pnpm --filter @ferry402/facilitator exec tsx scripts/create-topic.ts
```

Reads `HEDERA_ACCOUNT_ID` / `HEDERA_PRIVATE_KEY` from your environment and
creates a new topic with no `admin_key`/`submit_key` — the same shape as
[the one documented above](#the-hedera-record), and the same caveat applies
to whatever you create. The script prints the new topic id (e.g.
`0.0.10719807`) and a Hashscan link.

This produces one env var: `HCS_TOPIC_ID`. It is **not a secret** — it's the
topic the journal writer (`packages/facilitator/src/journal.ts`) submits
every entry to, and what a reader queries the mirror node by.

`HEDERA_PRIVATE_KEY` for a fresh testnet account from the Hedera portal is
typically **ECDSA, DER-encoded** — load it with `PrivateKey.fromStringDer()`
or `fromStringECDSA()`. See
[`docs/troubleshooting.md`](troubleshooting.md#a-hedera-private-key-fails-to-load)
for what goes wrong if you load it the wrong way.
