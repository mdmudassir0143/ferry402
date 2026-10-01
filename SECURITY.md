# Security

`ferry402` moves real money (testnet USDC today; the same code would move
mainnet USDC if pointed at mainnet contracts). This document is the honest
account of what it protects against, what it doesn't, and what is simply
unproven. Where something hasn't been audited, tested against a real
adversary, or exercised outside this project's own test suite, that's
stated plainly — a security document that overclaims is worse than no
security document at all.

## Status

**Testnet only.** Every deployed contract, every live transaction, and every
HCS topic this project has exercised is on Base Sepolia and Hedera testnet
— see
`.superpowers/sdd/2026-09-23-anychain402-base-slice/verified-chain-facts.md`
for the verified addresses and transactions. **No third-party security
audit has been performed** on `Escrow.sol`, the SDK, or the facilitator.
Treat everything below as this project's own reasoning about its own
design, not an external guarantee.

## Trust model

Five parties touch a payment. Here is precisely what each one can and
cannot do.

### The payer

Controls their own private key and decides, unilaterally, whether to sign an
EIP-3009 `ReceiveWithAuthorization`. Nobody — not the merchant, not the
facilitator — can make the payer sign anything, or move the payer's funds
without a signature the payer actually produced. A payer can:

- Attempt to replay their own previous payment (blocked — see "Derived
  challenge, consumed-once nonce" below).
- Attempt to present a nonce derived for a different resource or merchant
  (blocked structurally — a mismatched nonce cannot be produced without
  knowing the merchant's `secret`).
- Sign an authorization for a merchant they don't trust and lose exactly
  what they signed, same as handing over cash — this system does not
  protect a payer from their own decision to pay.

A payer **cannot** be made to pay more than they signed, cannot have their
signature redirected to a merchant other than the one named in the 402 they
actually read (Amendment 1), and loses nothing if a facilitator simply
never submits their authorization — an authorization that's never
redeemed never moves funds.

### The merchant

Owns a per-chain `Escrow` balance row and can always call `withdraw()` —
there is no admin path, owner role, or pause switch in `Escrow.sol` that can
touch a merchant's own balance. A merchant:

- Must keep `config.secret` (the HMAC key behind challenge derivation)
  identical across every instance serving their traffic, and confidential —
  though see "Known limitations" below for why a leaked `secret` is lower
  severity than it sounds.
- **Depends on whichever facilitator they configured** (self-hosted or
  third-party) to actually submit settlements. Because this codebase is
  serve-then-settle (the resource is handed over the moment `/verify`
  passes, *before* `/settle` has redeemed anything on-chain), a facilitator
  that accepts a request at `/verify` and then never calls `/settle` — or
  fails to — leaves the merchant having given away a resource for nothing.
  This is a real, uncorrected risk a merchant takes on by choosing a
  facilitator; it costs the merchant, not the payer (who paid nothing, since
  nothing was ever redeemed) and not other merchants using a different
  facilitator instance.

### The facilitator

Holds `FACILITATOR_PRIVATE_KEY` and decides when, or whether, to submit a
given authorization to `Escrow.sol`. It sees every payer's signature and
payload in transit (never logged — see `packages/facilitator/src/server.ts`'s
and `chains/base.ts`'s own doc comments on this). **The central claim this
whole design rests on:**

> A facilitator can refuse service or fail to settle, but it cannot steal
> from escrow, and it cannot redirect a payment to a different merchant
> than the one the payer actually signed for.

This is enforced in two independent places, not just claimed: the
facilitator's own `/verify` recomputes the merchant-bound nonce and rejects
a mismatch before spending any gas, and `Escrow.settleAuthorization` does
the identical recomputation on-chain and reverts `MerchantNotBound`
regardless of what the facilitator submits. A facilitator cannot change
`Escrow.sol`'s logic (it's not upgradeable, has no admin function), cannot
call `withdraw()` on anyone else's balance, and cannot credit a merchant
more than the token actually transferred (Amendment 2 — credited amount is
measured, not merely requested).

**What a facilitator genuinely can do, within its limits:** decide not to
settle at all (refusal of service, hurting the merchant as above); submit a
settlement late or never (same); mis-journal to HCS, or not journal at all
(the journal is informational — it credits nobody; only `Escrow.settleAuthorization`'s
own `token.receiveWithAuthorization` call actually moves funds, so a bad
journal entry cannot fabricate a credit that never happened on-chain). None
of this lets a facilitator take funds it wasn't authorized to redeem, or
divert a redemption to an address the payer didn't sign for.

### The `Escrow` contract

The actual source of truth for custody. Non-upgradeable, no proxy, no owner,
no pause — read `packages/contracts/src/Escrow.sol` directly; there is no
function anywhere in it that can move a merchant's `_balances[merchant]`
except that merchant's own `withdraw()` call. Guarded against reentrancy on
both `settleAuthorization*` and `withdraw` (a single `_lock` flag). Not
audited by a third party. Whether its deployed bytecode is verified on
Basescan is **unknown** — verifying that needs an Etherscan v2 API key this
project doesn't currently have access to; the reproduction command is:

```bash
forge verify-contract <ESCROW_ADDRESS> src/Escrow.sol:Escrow \
  --chain base-sepolia --constructor-args $(cast abi-encode "constructor(address)" <USDC_ADDRESS>)
```

Don't assert verification status either way without actually running this.

### The HCS topic

An ordered, append-only, mirror-node-queryable log of settlements — but
**the live topic's `submit_key` is `null`**, meaning any Hedera account can
submit a message to it, including one shaped to look exactly like a
legitimate `payment` entry for a merchant it has no connection to. Its
`admin_key` is also `null`, so the topic's configuration can never be
changed or revoked by anyone, including this project — a permanence
guarantee, not a write-access one. **The journal is an ordered index that
must be cross-checked against on-chain state; it is never, by itself, proof
that a payment happened.** See "Known limitations" below for the full
reasoning and how this project's own demo reconciles it correctly.

## The security properties, and the attacks each one closes

### Merchant binding (Amendment 1)

The EIP-3009 authorization nonce commits to the merchant:
`nonce = keccak256(abi.encode(merchantEvm, paymentId))`, checked both
off-chain (`verifyPayment`) and on-chain (`Escrow._checkBinding`).

**The attack this closes:** EIP-3009's `ReceiveWithAuthorization` typehash
binds the payer's signature to exactly six fields — `from, to, value,
validAfter, validBefore, nonce` — and none of them name who gets *credited*
in a pooled-custody escrow, since `to` is the Escrow contract itself, the
same for every merchant. Before this fix, `merchant` was a plain,
caller-supplied argument to a permissionless `settleAuthorization`. Anyone
holding the signed tuple `(auth, v, r, s)` — which, in x402's own flow,
travels through the resource server and the facilitator, both of whom are
outside the payer's control — could call `settleAuthorization(attacker,
auth, v, r, s)` and have the credit land in `attacker`'s own balance row
instead of the merchant's. This silently converted "non-custodial escrow"
into "trust the resource server and the facilitator not to redirect your
payment", which is exactly the dependency escrow was supposed to remove.
Binding the merchant into the nonce means a payer's signature can only ever
settle to the one merchant it was actually signed for — changing the
merchant argument changes the nonce, which invalidates the signature.

### Observed-delta crediting (Amendment 2)

`Escrow` measures `token.balanceOf(address(this))` before and after the
`receiveWithAuthorization` call and credits the *difference*, never
`auth.value` directly, under the `nonReentrant` guard (the guard is
load-bearing here — a nested settle during that measurement window would
corrupt it).

**The attack this closes:** crediting the requested amount assumes the
token transfers exactly what was requested. Under a fee-on-transfer,
deflationary, or rebasing token, that assumption is false, and because
`Escrow` is pooled custody (many merchants' balances live against one
shared token balance), over-crediting against a token that delivers less
than requested is a real path to insolvency — first-come-first-served, once
withdrawals start outpacing what the contract actually holds. The
facilitator's own `/settle` re-checks this a second time (`settlePayment`'s
"Payer solvency"/observed-delta checks in `chains/base.ts`): a settlement
that reverts, or that mines successfully but credits less than
`maxAmountRequired`, is reported as a failure rather than silently accepted.
v1's "USDC only" is project policy, not a code-enforced guarantee — the
constructor accepts any ERC-20-shaped address — which is exactly why this
defense exists at the contract layer rather than being assumed away.

### Derived-challenge replay defense, and why it isn't an exhaustible store

A 402 challenge (`paymentId`/`nonce`) is derived, not minted and stored:
`HMAC-SHA256(secret, merchantEvm ‖ resource ‖ timeBucket)`. Issuing one
costs no memory at all — no per-request store entry, for any volume of
anonymous traffic.

**The attack this closes, and the one it reopens differently:** the
predecessor design stored every *issued* challenge in a bounded map. Roughly
5,000 anonymous, unpaid GETs (two entries each, against a 10,000-entry cap)
would evict every outstanding legitimate challenge, handing every in-flight
honest payer `payment_expired` — a cheap, total denial of service funded
entirely by free requests. Deriving the challenge removes that cost
entirely: resource binding and the time window fall out of the HMAC
preimage and `Date.now()` arithmetic, not a lookup anyone can exhaust by
asking for free. What derivation *cannot* prove is "never redeemed before"
— a statement about the past — so a `ConsumedNonceStore` still exists, but
it is written to only once a request reaches the point of actually
attempting payment (after every local check passes, immediately before
calling the facilitator), and released again if that attempt fails. This
narrows, but does not eliminate, the exhaustion surface: a concurrency-bound
attacker can still occupy slots transiently with locally-valid-looking but
ultimately bogus signed payloads up to `InMemoryConsumedNonceStore`'s
100,000-entry cap — see "Known limitations" for what this store does and
doesn't survive.

### Signature-malleability rejection

ECDSA signatures are checked for low-`s` and `v ∈ {27, 28}`
(`packages/facilitator/src/chains/base.ts`, `SECP256K1N_HALF`), matching
real USDC's own OpenZeppelin-`ECDSA`-based verification — the EVM's raw
`ecrecover` precompile does not reject a high-`s`/flipped-`v` signature on
its own, so a verifier that skipped this would accept signatures the token
itself would refuse at settlement, serving a resource for a payment that
can never actually redeem.

### `receiveWithAuthorization`, not `transferWithAuthorization`

`Escrow` calls the token's `receiveWithAuthorization`, which EIP-3009
additionally requires `msg.sender == to` for — meaning only the named
recipient contract (here, `Escrow` itself) can ever submit it.
`transferWithAuthorization` carries no such restriction: it is designed to
be relayable by *anyone* who observes the signed tuple, which is exactly
the property that let Amendment 1's attack exist in the first place (a
third party holding the signature submitting it on the payer's behalf,
crediting whoever that third party names). Choosing the `receiveWithAuthorization`
variant closes this at the token layer; Amendment 1 is the fix for where
the Escrow contract reintroduced an equivalent hole one layer up, at the
`merchant` argument.

### EIP-1271 handling

A payer whose `from` address has on-chain code (a smart-contract wallet)
takes a completely different signature-verification path, chosen *before*
looking at the signature's shape — `from`'s code presence is checked first,
unconditionally — mirroring real USDC's own `SignatureChecker.isValidSignatureNow`,
which both `receiveWithAuthorization` overloads collapse onto. The
facilitator calls `from.isValidSignature(digest, signature)` via a raw
`eth_call` and compares the **entire returned 32-byte word**, not a typed
`bytes4` ABI decode of just the leading 4 bytes — a typed decode would
silently accept the correct magic value followed by non-zero garbage
padding, which real USDC's own `SignatureChecker` rejects. A wallet
exploiting that gap would pass `/verify` and then fail at settlement,
serving a free resource with no payment ever landing — closing it at the
raw-bytes level matches the token's own strictness exactly, rather than
being independently stricter or looser.

## Known limitations — stated plainly

- **The default `InMemoryConsumedNonceStore` is per-process, and a restart
  loses it.** Replay protection for the still-open derivation window (up to
  `2 * TIME_BUCKET_SECONDS` = 10 minutes by default) is gone the moment a
  process restarts or a request lands on a different horizontally-scaled
  instance than the one that issued it — a nonce consumed on instance A will
  not be recognized as consumed by instance B. This is not a theoretical
  gap: it is the literal default every `ferry402(config)` call gets unless
  you pass your own `ConsumedNonceStore` (`ferry402(config,
  { consumedNonceStore })`) backed by something shared — Redis, a database.
  Any multi-instance or auto-restarting deployment needs this.
- **Serve-then-settle has a residual window.** The resource is served the
  moment `/verify` passes — a live signature and balance check — before
  `/settle` has actually redeemed anything on-chain. This matches x402's own
  trust assumption (a verified signature is treated as good as cash for a
  small payment), but it means a payer could, in principle, spend their
  balance elsewhere in the gap between the balance check and the actual
  on-chain redemption, or a transient RPC/chain issue could cause settlement
  to fail after the resource was already handed over. The facilitator
  re-verifies the authorization from scratch immediately before submitting
  it (`settlePayment`'s first step), which narrows this window as much as
  this architecture allows, but does not close it to zero. This risk lands
  on the merchant (a resource given away for nothing), not the payer and
  not other merchants.
- **The HCS topic has `submit_key: null`.** Read directly: any Hedera
  account can append a message to the live journal topic
  (`0.0.10719807`), including a fabricated one shaped like a legitimate
  `payment` entry for a merchant it has nothing to do with. `admin_key` is
  also `null`, so this can never be changed after the fact. **The journal
  must never be treated as standalone proof of payment.** It is an ordered,
  timestamped index — useful for cheaply finding candidate transactions —
  that has to be cross-checked against the real chain (matching each
  entry's `txHash` and `merchantEvm` against `Escrow`'s own ledger row and
  the token's real balance) before it means anything. This project's own
  demo (`examples/demo/src/run.ts`'s closing reconciliation step) does
  exactly that cross-check rather than trusting the journal sum alone.
- **A leaked `secret` is lower-severity than it looks, but not zero.** Since
  a 402 response already publishes `extra.paymentId` to any anonymous
  requester, knowing `secret` ahead of time doesn't let an attacker derive
  anything they couldn't already read off a live request. What it does
  expose: anyone holding a merchant's `secret` could stand up their own
  `ferry402()` instance that validates — and could be tricked into
  accepting payments against — that merchant's exact challenges, which
  matters if you're relying on `secret`'s confidentiality as an access
  boundary between instances rather than purely a derivation key.
- **No third-party audit, testnet only.** Stated in "Status" above; repeated
  here because it bears on every claim in this document — all of the above
  is this project's own reasoning about its own code, not independently
  verified.

## For integrators

- **Run your own facilitator.** `createFacilitatorApp` is self-hostable by
  design (`packages/facilitator`); nothing in this system requires trusting
  a hosted instance someone else operates.
- **Configure `escrows` with your own deployed address, always.**
  `/verify` and `/settle` are both unauthenticated HTTP endpoints that take
  `paymentRequirements.payTo` straight from the caller. `createFacilitatorApp`
  fails closed if `escrows` is missing or empty, and rejects any network
  with no matching entry — this is the allowlist that stops an anonymous
  caller from naming their own contract as the payment destination. Never
  rely on `payTo`-equals-`requirements.payTo` consistency checks alone; they
  only prove two caller-supplied values agree with each other, never that
  either one is real.
- **Use a shared `ConsumedNonceStore` the moment you run more than one
  facilitator/merchant process.** See "Known limitations" above — the
  default is explicitly not safe for that.
- **Key handling.** `FACILITATOR_PRIVATE_KEY` needs gas on every chain it
  settles on and is never logged anywhere in this codebase; treat it with
  the same care as a hot wallet, because it is one. `HEDERA_PRIVATE_KEY`
  from a fresh Hedera testnet account is typically ECDSA, DER-encoded — load
  it with `PrivateKey.fromStringDer()`, never `fromStringED25519()` (the
  ED25519 loader does not error on a mismatched key type; it silently
  derives a different, wrong key, and the resulting `INVALID_SIGNATURE` at
  submit time gives no indication why).
- **Verify the escrow you point at.** The facilitator already checks that
  `Escrow.token()` matches your configured asset before trusting a signing
  domain against it — but that only proves internal consistency of what you
  configured, not that the deployed bytecode at that address is actually
  `Escrow.sol`, unmodified. Reproduce the public reads yourself before
  trusting a third party's deployment:

  ```bash
  cast call <ESCROW_ADDRESS> "token()(address)" --rpc-url <RPC_URL>
  ```

  Confirm it returns the USDC address you expect, and see "The `Escrow`
  contract" above for the unresolved question of source verification.

## Reporting a vulnerability

Open a [GitHub Security Advisory](https://github.com/mdmudassir0143/ferry402/security/advisories/new)
on `github.com/mdmudassir0143/ferry402`. That's the channel — there is no
dedicated security email address and no PGP key published for this project,
so don't send reports anywhere else expecting confidentiality. This is a
small, unaudited, testnet-stage project maintained without a formal
security team; there is no committed response-time SLA. If you've found
something that could move funds incorrectly, please still report it
privately through the advisory rather than opening a public issue.
