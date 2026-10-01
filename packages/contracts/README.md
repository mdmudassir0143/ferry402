# Escrow.sol

`Escrow.sol` is the custody contract ferry402 settles x402 payments into. One
instance is deployed per source chain (Base, Base Sepolia, Polygon, …); each
instance pools one ERC-20/EIP-3009 token's balance and attributes it to
merchants through a private ledger (`_balances`). A payment settles in
through `settleAuthorization` or `settleAuthorizationWithSignature`; a
merchant pulls their own funds out through `withdraw`. That's the entire
surface — one struct, five external functions, six custom errors, no
upgradeability, no owner, no pause switch.

The security claim this contract exists to make is specific, and worth
stating precisely rather than gesturing at: **there is no admin path —
not for the facilitator, not for ferry402 itself — that can move a
merchant's credited funds anywhere the merchant didn't ask.** `withdraw`
only ever debits `_balances[msg.sender]`; nothing in this contract can debit
any other address's row. A facilitator can refuse to submit a payment, go
offline, or misbehave in every way its role allows — it cannot reach into
escrow and take what's already been credited. That property is enforced by
the absence of code, not by a role check: grep the contract for `onlyOwner`,
`Ownable`, or any `msg.sender`-gated path into `_balances` other than
`withdraw`'s own, and you will find none.

`token` is set once, as an immutable, in the constructor, and never changes.
The constructor does not validate it — passing the zero address or a
codeless address is accepted at deploy time, and the contract fails safe
rather than loud: the first `settleAuthorization*` call against such a
`token` reverts automatically (a Solidity call that expects a return value,
like `token.balanceOf(...)`, has an implicit `extcodesize` check baked in by
the compiler), just later than a constructor check would. `withdraw`'s own
codeless-token check in `_safeTransfer` exists for a different scenario —
a token that was valid at deploy time and later becomes codeless (e.g.
`selfdestruct`) after merchants have already accrued ledger balances.

## The merchant-binding nonce (Amendment 1)

EIP-3009's `ReceiveWithAuthorization` typehash commits a payer's signature to
exactly six fields: `from, to, value, validAfter, validBefore, nonce`. The
beneficiary of the escrow credit is not one of them — nothing in the signed
payload says who gets paid once the authorization is redeemed. An earlier
version of this design took `merchant` as a plain, separate argument to a
permissionless `settleAuthorization`, which meant the beneficiary was never
actually bound to what the payer signed: **anyone holding `(auth, v, r, s)`
could call `settleAuthorization(attacker, auth, v, r, s)` and have the
payment credited to `attacker`,** with a perfectly valid signature and no
forgery involved. In x402's flow this isn't a hypothetical — the signed
payload travels in an `X-PAYMENT` header through the resource server and the
facilitator, both of which are untrusted in this design's threat model. The
token's own `msg.sender == to` guard on `receiveWithAuthorization` doesn't
help either, since `Escrow` itself is always the caller regardless of which
merchant argument it was given.

The fix binds the beneficiary into the one 32 bytes EIP-3009 leaves free for
the application to use — the nonce:

```solidity
nonce == keccak256(abi.encode(merchant, paymentId))
```

The payer signs this nonce as part of the authorization. `_checkBinding`
recomputes it on-chain from the caller-supplied `merchant` and `paymentId`
and reverts `MerchantNotBound` on any mismatch. Changing the merchant
changes the nonce, which invalidates the payer's signature over the EIP-712
digest — there is no way to redirect a signed payment to a different
beneficiary without the payer re-signing. This costs no extra gas over
carrying an arbitrary nonce, requires no change to the token's typehash, and
introduces no privileged role that could have "fixed" the same hole by
narrowing who's allowed to call `settleAuthorization` instead of removing the
capability to redirect funds at all.

The off-chain half of this has to recompute the identical hash — the SDK's
nonce derivation and the facilitator's `/verify` both use
`keccak256(abi.encode(merchantEvm, paymentId))` against the same inputs.
`test/NonceGoldenVectors.t.sol` exists specifically because that symmetry is
easy to break silently: every *other* Solidity test builds its own expected
nonce with the same `abi.encode` expression the contract uses, which proves
internal self-consistency but would stay green even if `_checkBinding`'s
`abi.encode` were mutated to `abi.encodePacked` — every test's helper would
recompute the broken hash in lockstep with the contract and still match. The
golden-vector tests instead settle against two literal `bytes32` nonces
copied verbatim from the TypeScript SDK's own pinned vectors
(`packages/sdk/test/nonce.test.ts`), computed nowhere in this repo's
Solidity. If the contract's hashing scheme ever drifts from what the SDK
computes, these are the only tests that would catch it before a real payment
reverted `MerchantNotBound` on a live chain.

## Observed-delta crediting (Amendment 2)

`settleAuthorization` does not credit `auth.value`. It measures:

```solidity
uint256 before = token.balanceOf(address(this));
token.receiveWithAuthorization(/* ... */);
uint256 received = token.balanceOf(address(this)) - before;
_balances[merchant] += received;
```

Crediting the requested amount instead of the measured one is a real pooled-
custody bug waiting to happen, not a theoretical one: a fee-on-transfer or
deflationary token delivers strictly less than `auth.value` to the escrow,
and a rebasing token can deliver more or less depending on when the balance
is read. Credit the requested amount under either and the ledger row stops
being backed by real holdings — the merchant's balance now claims tokens the
contract never received, and because custody is pooled (one token balance
backs every merchant's row), the shortfall is first-come-first-served
insolvency the moment enough merchants try to withdraw. "This escrow only
ever holds USDC" is a deployment choice the facilitator operator makes when
picking `token`, not a guarantee the contract enforces — the constructor
accepts any ERC-20/EIP-3009 token, as described above. `test/mocks/
EscrowSecurityDoubles.t.sol`'s `LossyMockUSDC` is a fee-skimming token built
specifically to make this distinction observable: it proves
`settleAuthorization` and `settleAuthorizationWithSignature` both credit the
delta, not the request, and the invariant suite (below) runs its entire
128,000-call campaign against this same lossy token so the solvency property
holds even when every single settlement under-delivers.

The `before`/`after` measurement window is itself a reentrancy surface — a
token whose `receiveWithAuthorization` calls back into `settleAuthorization`
mid-call could otherwise manipulate what "observed" means — which is exactly
why both settlement entry points carry `nonReentrant` as well as the balance
delta.

## External functions

### `token`

```solidity
IEIP3009 public immutable token;
```

The token this escrow instance redeems authorizations against and pays out
in. Set once in the constructor, never changed. No admin function exists to
repoint it — doing so would require a new deployment.

### `balanceOf`

```solidity
function balanceOf(address merchant) external view returns (uint256)
```

Returns `merchant`'s current ledger balance — the amount they're entitled to
`withdraw`. Pure read, never reverts, not part of the token's own
`balanceOf` (which reports the pool's total holdings across every merchant).

### `settleAuthorization`

```solidity
function settleAuthorization(
    address merchant,
    bytes32 paymentId,
    Authorization calldata auth,
    uint8 v,
    bytes32 r,
    bytes32 s
) external
```

Redeems a plain-ECDSA EIP-3009 authorization and credits the observed
balance delta to `merchant`. `Authorization` is
`{ from, to, value, validAfter, validBefore, nonce }`, the same six fields
EIP-3009 signs.

Reverts:
- `ZeroMerchant()` — `merchant == address(0)`.
- `RecipientMismatch()` — `auth.to != address(this)`; the signed payload
  names some other recipient.
- `MerchantNotBound()` — `auth.nonce != keccak256(abi.encode(merchant,
  paymentId))`; see above.
- `Reentrancy()` — called reentrantly (via `nonReentrant`).
- Whatever the token's `receiveWithAuthorization` itself reverts with,
  unmodified — e.g. an authorization outside its `[validAfter, validBefore)`
  window, an already-used nonce, or a bad signature. `Escrow` does not
  duplicate any of the token's own authorization checks; it calls straight
  through and lets the token's revert propagate.

Emits `PaymentSettled(merchant, auth.from, received, auth.nonce)` on success,
where `received` is the measured delta, not `auth.value`.

### `settleAuthorizationWithSignature`

```solidity
function settleAuthorizationWithSignature(
    address merchant,
    bytes32 paymentId,
    Authorization calldata auth,
    bytes calldata signature
) external
```

Identical to `settleAuthorization` in every respect that matters here — same
merchant-binding check, same `nonReentrant` guard, same observed-delta
crediting — except it redeems through the token's `bytes signature` overload
instead of a `(v, r, s)` tuple. This is the path that lets a payer whose
`from` is a smart-contract wallet (EIP-1271) pay through this escrow at all:
a contract wallet holds no ECDSA private key, so `(v, r, s)` has no meaning
for it, and it can only ever produce an arbitrary-length signature blob that
some verifier checks on the wallet's own terms. Which verification path a
given `signature` takes is decided entirely by the token, not by `Escrow` —
a conforming token (see `test/mocks/MockUSDC.sol`, modeled on real USDC
v2.2's `SignatureChecker`) dispatches on whether `auth.from` has code, never
on the signature's length: a 65-byte blob against a codeless `from` is
parsed as plain ECDSA, while the exact same 65 bytes against a `from` with
code is routed to `from.isValidSignature(digest, signature)` and must return
precisely the ERC-1271 magic value `0x1626ba7e` as a full, cleanly-padded
32-byte word.

Reverts: identical set to `settleAuthorization` (`ZeroMerchant`,
`RecipientMismatch`, `MerchantNotBound`, `Reentrancy`), plus whatever the
token's `bytes`-overload `receiveWithAuthorization` reverts with for a bad
signature, a reverting wallet, or a wrong/malformed magic-value return.

Emits the same `PaymentSettled` event as `settleAuthorization`.

### `withdraw`

```solidity
function withdraw(uint256 amount, address to) external
```

Pays `amount` out of the caller's own ledger row to `to`. There is no
owner/admin override: `msg.sender` can only ever move `_balances[msg.sender]`.

Reverts:
- `InsufficientBalance()` — `amount > _balances[msg.sender]`.
- `Reentrancy()` — called reentrantly.
- `TransferFailed()` — the token transfer failed in a way that carries no
  revert reason of its own: a bare revert with empty return data, a codeless
  `token` address, a return shorter than one word, or an explicit `false`
  return. If the token's `transfer` instead reverts *with* data, that
  original revert reason is bubbled unchanged rather than being replaced by
  `TransferFailed()` — see `_safeTransfer` in Security notes.

Emits `Withdrawn(msg.sender, to, amount)` on success.

`to == address(this)` is accepted and is not a foot-gun: the ledger row is
still debited, but the token transfer just returns the funds to the same
pool, leaving an unattributed surplus in the pool's own token balance. The
contract's solvency invariant is `token.balanceOf(this) >= sum(_balances)`,
not equality, so this is harmless — and a merchant can only ever do it to
their own funds.

### Custom errors (summary)

| Error | Thrown by | When |
|---|---|---|
| `Reentrancy()` | `nonReentrant` modifier (both settle functions, `withdraw`) | A reentrant call is attempted while the lock is held. |
| `RecipientMismatch()` | `_checkBinding` | `auth.to != address(this)`. |
| `MerchantNotBound()` | `_checkBinding` | `auth.nonce != keccak256(abi.encode(merchant, paymentId))`. |
| `ZeroMerchant()` | `_checkBinding` | `merchant == address(0)`. |
| `InsufficientBalance()` | `withdraw` | `amount > _balances[msg.sender]`. |
| `TransferFailed()` | `_safeTransfer` | Token transfer returned `false`, returned fewer than 32 bytes, reverted with empty data, or `token` is codeless. |

## Gas costs

Measured live against the deployed Base Sepolia instance (see Deployment,
below) across its first seven real settlement transactions, all to the same
merchant:

| Settlement | Gas used |
|---|---|
| 1st (merchant's first-ever credit) | 141900 |
| 2nd | 107700 |
| 3rd | 107712 |
| 4th | 107676 |
| 5th | 107692 |
| 6th | 107712 |
| 7th | 107712 |

A merchant's **first** settlement costs roughly 34k gas more than every
later one. The mechanism is the SSTORE on `_balances[merchant]`: the first
credit writes that storage slot from zero to a nonzero value, which the EVM
prices as the expensive "set" case (plus the cold-access surcharge, since
every transaction starts with an empty access list regardless of what a
prior transaction touched). Every later settlement to the same merchant
updates an already-nonzero slot — the cheap "reset" case — so cost settles
to ~107.7k and stays flat regardless of the amount being settled. If you're
a facilitator operator budgeting gas per settlement, budget for the cold
case on a merchant's first payment and the warm case afterward; don't take
one number and multiply it by settlement count.

## Deployment

The worked example below is a real, currently-deployed instance on Base
Sepolia (chain id 84532), read live from a public node:

| Thing | Value |
|---|---|
| `Escrow` contract | `0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429` |
| `Escrow.token()` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Base Sepolia USDC, 6 decimals) |
| Deployment tx | `0xcbca16cf6820716b31f0e33ae68084f7d4835c0c80458da82d50f81293819f25` |
| Deployment block | 47300767 (2026-09-25T20:57:02Z) |
| Deployment gas | 1187384 |
| Deployer | `0x86eEa3B06E6994eaF8Ce3Fcfde6A2F8Fb2Ba947b` |

The constructor takes one argument — the token address to escrow — and
nothing else:

```bash
cd packages/contracts
forge create src/Escrow.sol:Escrow \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  --constructor-args 0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

`--constructor-args` must be the **last** flag. `forge create`'s argument
parser treats it as variadic, so a flag like `--broadcast` placed after it
gets swallowed into the constructor-args list and surfaces as a confusing
arg-count mismatch instead of a flag-ordering error.

To verify the deployed bytecode against this source on Basescan:

```bash
forge verify-contract \
  0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429 \
  src/Escrow.sol:Escrow \
  --chain-id 84532 \
  --constructor-args "$(cast abi-encode "constructor(address)" 0x036CbD53842c5426634e7929541eC2318f3dCF7e)" \
  --etherscan-api-key "$ETHERSCAN_API_KEY"
```

This repo does not currently have the Etherscan v2 API key needed to check
whether this specific deployment is already verified on Basescan, and this
README makes no claim either way — the command above is how you'd verify
it, not evidence that it has or hasn't been done. Check
`https://sepolia.basescan.org/address/0x99Cd564B21fa7fD8553Cf31F32E448C17BBcC429#code`
directly if you need to know the current state before relying on it.

## The test suite

```
forge test   # 39 tests, 6 suites, including a 128k-call invariant fuzz run
```

The suite is organized around proving the two design decisions above hold
under adversarial input, not just under the happy path, plus a baseline of
ordinary settlement/withdrawal correctness:

**`test/Escrow.t.sol`** (11 tests) is the core suite: a payment settles and
credits the right amount and emits the right event; a replayed `(auth, v, r,
s)` never credits twice (`testFuzz_authorizationCannotBeReplayed`); a
withdrawal moves funds to the requested recipient and never touches another
merchant's row even under direct attack
(`test_withdraw_attackerCannotDrainOtherMerchantsRow` actually attempts to
pull the whole pool, not just a well-behaved withdrawal); and
`test_noAdminCanMoveMerchantFunds` is the literal proof of this README's
headline claim — an unrelated caller with no ledger balance of their own
cannot withdraw anything, full stop. The merchant-binding property itself
gets both a hand-picked regression
(`test_settleAuthorization_revertsWhenMerchantNotBoundToSignature`) and a
full-address-space fuzz
(`testFuzz_settleAuthorization_merchantBindingRejectsMismatch`) — this is
the regression barrier for the exact flaw Amendment 1 describes: without the
on-chain nonce check, anyone holding a signed payload could redirect the
credit to themselves.

**`test/EscrowEip1271.t.sol`** (8 tests) covers the smart-contract-wallet
path end to end: a wallet that accepts settles like an EOA would; a wallet
that rejects, or reverts internally, is treated as a clean rejection rather
than an unhandled error; a codeless `from` can never satisfy EIP-1271 and is
rejected without even attempting the call. One test here exists because a
real bug was found during review: dispatching on signature *length* (65
bytes → ECDSA) rather than on whether `from` has code would misroute a
1-of-1 smart-contract wallet whose owner signs the raw digest — which
produces an incidentally-65-byte signature — to `ecrecover`, which recovers
the owner's address, not the wallet's, and reverts even though the wallet's
own `isValidSignature` would have accepted it.
`test_settleAuthorizationWithSignature_smartWalletWith65ByteSignature_stillUsesEip1271`
is the regression test for that specific failure mode. A second test,
`test_settleAuthorizationWithSignature_dirtyMagicValuePadding_rejects`,
proves the full 32-byte return word is checked, not just its leading 4
bytes — a wallet returning the correct magic value with non-zero trailing
padding (only reachable via raw assembly; no ordinary Solidity `return` can
produce it) must still be rejected.

**`test/NonceGoldenVectors.t.sol`** (2 tests) is described in detail above —
it settles against literal `bytes32` nonces lifted from the TypeScript SDK's
own pinned vectors, closing a gap no purely-Solidity test can close on its
own: proving the contract's hashing scheme actually matches what the
off-chain signer computes, not just that it's internally consistent with
itself.

**`test/mocks/EscrowSecurityDoubles.t.sol`** (8 tests) settles and withdraws
against a set of hostile or non-conforming token doubles: a fee-skimming
token proving observed-delta crediting (Amendment 2, above); a token whose
`receiveWithAuthorization` reenters `settleAuthorization`/
`settleAuthorizationWithSignature` mid-call, and one whose `transfer`
reenters `withdraw` mid-call, both of which must be rejected by the
`nonReentrant` guard; a USDT-style token that returns no data at all from
`transfer`, proving `_safeTransfer`'s no-return-data tolerance actually
*succeeds* a withdrawal correctly, not merely fails to revert; a token
returning an explicit `false`, proving that's treated as a failure; and a
token made codeless after a merchant has already accrued a balance,
proving `withdraw` rejects it rather than silently succeeding against
empty bytecode. Two tests here exist because reviewers found real gaps in
earlier versions of `settleAuthorizationWithSignature` specifically: one
reviewer mutated it to credit `auth.value` directly instead of the observed
delta, and another dropped its `nonReentrant` guard — both mutations passed
every other test in the suite at the time, because nothing had yet settled
a fee-skimming token or attempted reentrancy through that particular entry
point rather than the plain-ECDSA one.

**`test/mocks/MockUSDC.t.sol`** (9 tests) is a guardrail suite on the token
double itself, not on `Escrow` — it exists so that if `MockUSDC`'s own
checks are ever weakened to make an `Escrow` test pass more easily, CI
catches that here. This is where signature-malleability rejection lives:
`test_revertsOnMalleableSignature_highS` proves a high-`s` signature (the
"other" mathematically valid signature for the same message, producible
from any low-`s` one by flipping both `s` and `v`) is rejected, matching the
low-s convention real USDC enforces via OpenZeppelin's `ECDSA` library.
Worth being precise about *where* this lives: `Escrow.sol` itself never
calls `ecrecover` or validates a signature directly — it forwards `(v, r,
s)` or the raw `signature` bytes straight through to `token
.receiveWithAuthorization`. Signature verification, including malleability
rejection, is entirely the token's responsibility; `Escrow`'s own
contribution is the merchant-binding check that runs *before* the token is
ever called.

**`test/EscrowInvariant.t.sol`** (1 invariant test, configured in
`foundry.toml` for 256 runs × up to 500 calls each — 128,000 calls observed
in practice) runs long random campaigns of settlements and withdrawals
against a single pooled escrow backed by the same fee-skimming token used
above, with a handler that deliberately attempts bad operations alongside
legitimate ones: merchant-mismatched settlements, replayed nonces, and
over-withdrawals. The handler's job is only to *attempt* every one of these;
it's `Escrow`'s own checks, not any guard in the handler, that must reject
them — `fail_on_revert = true` in `foundry.toml` means an unexpected revert
from the handler itself is a hard failure, not a discarded call, so a future
silent ghost-accounting bug can't hide in a swallowed exception across
128,000 calls. Four properties are checked after every run: the pool's
actual token balance always covers every merchant's net ledger credits
(solvency, accounted from *observed* deltas on each merchant's own ledger
row — never from the pool's own token balance, which would make the
invariant compare a quantity to itself and could never fail); merchant
binding is never broken, even under a long campaign that deliberately
submits mismatched settlements; replay protection is never broken, even
under deliberately repeated nonces; and no over-withdrawal ever succeeds —
tracked as its own explicit property because pooled custody means a small
over-withdrawal by one actor can be fully absorbed by other actors' pooled
funds without the aggregate solvency check ever dipping below zero, which
would otherwise let real theft hide behind a healthy-looking total.
`afterInvariant` additionally asserts the campaign actually exercised all of
this (non-zero settles, withdrawals, mismatches, replays, over-withdrawals,
and credits across more than one distinct merchant) in every one of the 256
runs, so the suite can't pass vacuously by chance.

## Security notes

**Reentrancy and CEI.** `nonReentrant` guards all three state-mutating
functions (`settleAuthorization`, `settleAuthorizationWithSignature`,
`withdraw`) with a simple non-zero sentinel (`_lock`), not a `bool` — this
avoids the gas-refund asymmetry of repeatedly zeroing and setting a storage
slot. `withdraw` additionally follows checks-effects-interactions
explicitly: the ledger is decremented *before* the external token transfer,
so even setting aside the reentrancy guard, a reentrant call would observe
the post-decrement balance rather than a stale one.

**`_safeTransfer`.** `withdraw`'s token transfer goes through a low-level
`call` rather than a typed `IERC20.transfer` call, specifically to tolerate
non-standard tokens without pulling in a dependency: USDT-style tokens that
return no data at all, and ordinary tokens that return an explicit `false`
instead of reverting. On failure, it bubbles the callee's original revert
reason via inline assembly rather than masking it behind a generic error —
this matters for on-chain diagnosability, and because a caller further up
the stack may need the real reason, not a generic one. `TransferFailed()` is
reserved specifically for the cases that carry no reason of their own: an
empty-data revert, a codeless `token` (a low-level call against an address
with no code trivially "succeeds" with empty returndata, which a high-level
call would have caught automatically via the compiler's implicit
`extcodesize` check — the low-level call drops that check, so `_safeTransfer`
restores it explicitly), a return shorter than one word, and an explicit
`false`. The length check on the success path exists so `abi.decode` is
never called on malformed, non-word-sized data — which would itself produce
an unreasoned revert, the exact failure mode this helper exists to
eliminate.

**Pooled custody, not per-merchant escrow.** One token balance per chain
backs every merchant's ledger row on that chain. This is why the invariant
suite's solvency check is `>=`, not `==` (a merchant withdrawing to the
escrow's own address, see `withdraw` above, creates harmless unattributed
surplus), and why `test_withdraw_attackerCannotDrainOtherMerchantsRow`
exists as a real attack attempt rather than merely a well-behaved-withdrawal
test — a merchant requesting more than their own row but no more than the
pool's *total* physical balance is a genuinely different failure mode than
requesting more than the pool holds at all, and only the ledger check (not
the token's own balance check) can catch it.

**No admin path, structurally.** Worth repeating in this section because
it's the property most worth verifying yourself rather than taking on
faith: there is no `owner`, no `Ownable`, no pausable switch, and no
function other than `withdraw` that reads or writes `_balances` for any
address other than `msg.sender`.

## Building and testing

```bash
forge build
forge test
```

No test in this suite touches a real network or spends real funds — see the
root README's "Testing" section for how this package fits into the rest of
the monorepo (`packages/contracts` has no `package.json` and is not a pnpm
workspace member; `pnpm -r test` never runs these) and for the live
end-to-end run (`packages/facilitator/test/e2e.test.ts`) that exercises this
exact deployed contract against real Base Sepolia and Hedera testnet
networks.
