import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  recoverAddress,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { ErrorReasons } from 'x402/types'
import type { PaymentPayload, PaymentRequirements } from 'x402/types'
import { computeNonce } from '@anychain402/sdk'

/**
 * The subset of x402's `ErrorReasons` this verifier can actually produce.
 * Still a hand-written literal union (a plain `Extract<AllReasons, ...>`
 * would silently DROP a misspelled or renamed member instead of erroring —
 * `Extract` filters, it doesn't assert), but checked below by
 * `AssertSubtype` against x402's own `ErrorReasons` enum, so a typo here or
 * an upstream rename/removal of one of these members is a TYPE ERROR at
 * compile time, instead of a silent drift the day x402 ships a breaking
 * change.
 */
export type VerifyInvalidReason =
  | 'invalid_exact_evm_payload_recipient_mismatch'
  | 'invalid_payload'
  | 'invalid_exact_evm_payload_authorization_value'
  | 'invalid_exact_evm_payload_authorization_valid_after'
  | 'invalid_exact_evm_payload_authorization_valid_before'
  | 'invalid_exact_evm_payload_signature'
  | 'invalid_network'
  | 'unexpected_verify_error'

/**
 * `Sub`'s only use is as a compile-time assertion that `Sub` is a subtype of
 * (assignable to) `Super` — instantiating this with a `Sub` that has a
 * member outside `Super` is a type error at the instantiation site below,
 * not here. Deliberately NOT a distributive conditional type
 * (`Sub extends Super ? true : never`) checked against `never`: TypeScript
 * distributes a conditional type over a naked union type parameter, so a
 * union with even one bad member alongside good ones collapses to
 * `true | never` = `true`, silently hiding the bad member. A generic
 * constraint check (this form) checks the union as a whole instead, which
 * is what a "does every member belong" assertion actually needs.
 */
type AssertSubtype<Sub extends Super, Super> = Sub

// Referenced only for this compile-time check — see `AssertSubtype`'s doc
// comment. If x402 ever renames/removes one of `VerifyInvalidReason`'s
// members, this line fails to typecheck.
type _VerifyInvalidReasonIsSubsetOfX402ErrorReasons = AssertSubtype<VerifyInvalidReason, (typeof ErrorReasons)[number]>

export interface VerifyResult {
  isValid: boolean
  invalidReason?: VerifyInvalidReason
  payer?: string
}

export interface VerifyOptions {
  /**
   * Overrides the RPC endpoint used to read the token's EIP-712 domain.
   * Defaults to the chain's own public RPC (via viem's `base`/`baseSepolia`
   * chain presets). Tests point this at a local anvil instance instead of a
   * live network call — see test/support/anvil.ts.
   */
  rpcUrl?: string
}

/**
 * secp256k1's order, n — the ONE place this codebase's TypeScript side
 * defines it. `SECP256K1N_HALF` is derived from it (`/ 2n`), not duplicated
 * as a second literal: an earlier version of this file hardcoded the half
 * value directly and mistyped it (94 hex digits instead of 64), which
 * silently disabled the malleability check entirely — see the task-7 report.
 * A too-*large* half bound is caught deterministically by the malleable-flip
 * test; a too-*small* one is caught only probabilistically by the happy path
 * (since `s` varies per run), which is the failure mode that matters here.
 * Pinned in `test/secp256k1n.test.ts` against `@noble/curves`'s own
 * `secp256k1.CURVE.n`, independent of this literal.
 */
export const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SECP256K1N_HALF = SECP256K1N / 2n

/**
 * The maximum value a Solidity `uint256` can hold. `authorization.value`,
 * `requirements.maxAmountRequired`, `validAfter`, and `validBefore` are all
 * encoded as `uint256` in the EIP-712 struct hashed below (via
 * `hashTypedData`) — a decimal string that parses to a `bigint` LARGER than
 * this throws viem's `IntegerOutOfRangeError` there, which (pre-fix) was the
 * only call in `verifyPayment` not wrapped in a `try`/`catch`. x402 caps
 * `value` at 18 characters but puts no length cap on `validBefore`/
 * `validAfter`, and a huge `validBefore` isn't caught by any earlier check
 * (unlike a huge `validAfter`, which check 4 already rejects as "not yet
 * valid" against any real `now`) — so an unauthenticated caller could reach
 * `hashTypedData` with an out-of-range value. See `parseDecimalBigInt`.
 */
const MAX_UINT256 = 2n ** 256n - 1n

const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const DOMAIN_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

const SUPPORTED_CHAINS = { base, 'base-sepolia': baseSepolia } as const
type Task7Network = keyof typeof SUPPORTED_CHAINS

const DECIMAL_STRING_RE = /^\d+$/
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/

/**
 * Parses a decimal-digits-only string to a `bigint` no larger than a
 * `uint256` can hold, or returns `undefined` otherwise.
 *
 * Two independent guards, for two independent bugs:
 *
 * 1. Shape: deliberately stricter than a bare `BigInt(...)` or x402's own
 *    upstream validators (`Number.isInteger(Number(v))`), which operate on
 *    the `Number()` coercion rather than the string's actual shape and so
 *    admit JS exponent notation: `"1e30"` is short and `Number("1e30")` is
 *    an integer, so it can pass a length/integer check — but
 *    `BigInt("1e30")` throws a `SyntaxError`. That divergence caused an
 *    unauthenticated remote crash (task 6).
 * 2. Range: even a purely decimal string can encode a value no `uint256`
 *    can hold (e.g. a 100-digit `validBefore`) — x402 puts no length cap on
 *    `validBefore`/`validAfter` (only `value` has one, at 18 characters).
 *    `BigInt(...)` itself has no problem with an arbitrarily large decimal
 *    string, but `hashTypedData` later encodes this as a `uint256` and
 *    throws if it doesn't fit — see `MAX_UINT256`'s doc comment. Task-7
 *    review round 1 (I1) found this reachable over the wire.
 *
 * Every untrusted decimal-string field in this module — value,
 * maxAmountRequired, validAfter, validBefore — is routed through this
 * before any `BigInt` arithmetic, regardless of what upstream schemas
 * already claim to have checked.
 */
function parseDecimalBigInt(value: string): bigint | undefined {
  if (!DECIMAL_STRING_RE.test(value)) return undefined
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    return undefined
  }
  if (parsed > MAX_UINT256) return undefined
  return parsed
}

function addressesEqual(a: string, b: string): boolean {
  return isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && a.toLowerCase() === b.toLowerCase()
}

// --- Client + domain caching (task-7 review round 1, I2/I3) ---------------
//
// Every `/verify` call previously paid for THREE uncached RPC calls
// (`name`, `version`, `eth_chainId`) against a freshly-constructed
// `PublicClient`, and used the LIVE `eth_chainId` result — not the
// declared network's own chain id — to build the signing domain. Both are
// fixed together here:
//
// - The signing domain's `chainId` is now always `chain.id`, the STATIC id
//   viem's own `base`/`baseSepolia` preset declares for the DECLARED
//   `requirements.network` — never a live RPC value. A misconfigured
//   `rpcUrls` entry pointing `base-sepolia` at some other chain's node can
//   therefore never make `/verify` approve a signature bound to a
//   different chain id than Task 8's settlement will use: the worst case
//   is a signature-domain mismatch (a safe, closed failure), not a silent
//   accept under the wrong chain id.
// - That RPC-vs-declared-chain mismatch is still worth catching explicitly
//   (it means the operator's config is broken, and every call against it
//   is reading token data from the wrong network) — so it's asserted
//   once, the first time a given `(network, rpcUrl)` pair is used, and the
//   result is memoized. Later calls reuse the cached verdict instead of
//   repeating the `eth_chainId` round trip.
// - `{name, version}` is memoized per `(chainId, rpcUrl, asset)`: a token's EIP-712
//   domain fields are immutable for the life of the contract, so there is
//   no reason to re-read them on every call.
//
//   `rpcUrl` is part of that key (task-8 review round 1, M-c) — it was NOT,
//   originally, and `clientCacheKey` below already included it, which left
//   the two caches disagreeing about what identifies "a chain": `chainId`
//   ALONE is caller-declared and not globally unique in practice (any two
//   independent chains that happen to declare the same id — e.g. two
//   separate local/test networks both started as `base-sepolia`'s `84532` —
//   collide here). Since a CREATE address depends only on `(sender, nonce)`,
//   never chain id, two such chains can easily hold DIFFERENT tokens at the
//   IDENTICAL address, and without `rpcUrl` in the key this cache would
//   silently serve one token's `{name, version}` for the other — building a
//   signing domain against the wrong token and failing every signature
//   recovery with no indication why. This is exactly how a test-fixture bug
//   surfaced during Task 8 (see `settle.fork.test.ts`'s history); fixing the
//   cache key here removes the underlying hazard for any future caller,
//   rather than leaving it to every fixture's choice of deployer key.
//
// Both caches are process-lifetime, unbounded maps. That's acceptable here:
// keys are bounded by the number of (network, rpcUrl) pairs this process is
// ever configured with (effectively a handful) crossed with the number of
// distinct token addresses it ever sees (one per configured asset in
// practice) — not attacker-controlled growth.

// Deliberately NOT annotated with viem's `PublicClient`/`Chain` types: this
// workspace currently resolves more than one physically-distinct install of
// `viem`/`ox` (visible as multiple `zod@...`-suffixed variants under
// node_modules/.pnpm — a pnpm peer-dependency fork, not a version
// mismatch). Naming one of those types explicitly forces TypeScript to
// check assignability against whichever copy — or whichever generic
// overload of `createPublicClient` — that reference happened to resolve
// to, which can differ from the one actually instantiated below, producing
// a spurious "two different types with this name exist, but they are
// unrelated" error despite both being the identical published type. Every
// client this module ever creates flows through this ONE function, and
// every other function that needs a client's type derives it from THIS
// function specifically (`ReturnType<typeof createChainClient>`, not the
// more general `ReturnType<typeof createPublicClient>`) — one concrete
// instantiation, referenced consistently, sidesteps the hazard entirely
// rather than papering over it with `any`.
/**
 * `/verify`'s own transport tuning: short timeout, no retries. `/verify` is
 * on the hot path of an unauthenticated HTTP endpoint (`paymentRequirements`
 * is caller-supplied and satisfies checks 1-4 trivially — see I3 in the
 * task-7 review), so a stalled upstream RPC must fail fast rather than hold
 * the request for anywhere near viem's defaults (10s timeout * 3 retries ≈
 * 40s), especially since `anychain402`'s own middleware already gives up on
 * `/verify` at 5s.
 */
const VERIFY_TRANSPORT_OPTIONS = { timeout: 2_000, retryCount: 1 } as const

/**
 * `/settle`'s own transport tuning (task-8 review round 1, I2) — deliberately
 * NOT `VERIFY_TRANSPORT_OPTIONS`. `settlePayment` reuses this same client for
 * `waitForTransactionReceipt`, which polls this transport for up to its own,
 * much longer timeout (default 180s) while a real transaction gets mined —
 * there is no hot-path reason to keep verify's aggressive 2s cutoff here, and
 * keeping it would be actively harmful: in viem 2.56.8, `waitForTransactionReceipt`
 * treats any transport error OTHER than "not found yet" as fatal to the
 * whole wait (`done(() => emit.reject(err))` — it does not retry the poll,
 * it abandons waiting entirely). A single slow round trip against a live RPC
 * — likely, not a tail case, across the ~45 polls a real settlement can take
 * — would report an already-settled payment as `success: false`. These
 * values are simply viem's OWN `http()` defaults, spelled out explicitly
 * rather than left implicit, since settle has no latency pressure that would
 * justify overriding them the way `/verify` does.
 */
const SETTLE_TRANSPORT_OPTIONS = { timeout: 10_000, retryCount: 3 } as const

type ClientProfile = 'verify' | 'settle'

// Deliberately NOT annotated with viem's `PublicClient`/`Chain` types: this
// workspace currently resolves more than one physically-distinct install of
// `viem`/`ox` (visible as multiple `zod@...`-suffixed variants under
// node_modules/.pnpm — a pnpm peer-dependency fork, not a version
// mismatch). Naming one of those types explicitly forces TypeScript to
// check assignability against whichever copy — or whichever generic
// overload of `createPublicClient` — that reference happened to resolve
// to, which can differ from the one actually instantiated below, producing
// a spurious "two different types with this name exist, but they are
// unrelated" error despite both being the identical published type. Every
// client this module ever creates flows through this ONE function, and
// every other function that needs a client's type derives it from THIS
// function specifically (`ReturnType<typeof createChainClient>`, not the
// more general `ReturnType<typeof createPublicClient>`) — one concrete
// instantiation, referenced consistently, sidesteps the hazard entirely
// rather than papering over it with `any`.
function createChainClient(
  chain: (typeof SUPPORTED_CHAINS)[Task7Network],
  rpcUrl: string | undefined,
  transportOptions: { timeout: number; retryCount: number },
) {
  return createPublicClient({ chain, transport: http(rpcUrl, transportOptions) })
}

interface CachedClient {
  client: ReturnType<typeof createChainClient>
  /** Resolves once — the first time this (network, rpcUrl, profile) triple is
   *  used — to whether the RPC's actual chain id matches `chain.id`. Awaited
   *  on every call, but the underlying `eth_chainId` request only ever fires
   *  once per triple. */
  chainIdVerified: Promise<boolean>
}

const clientCache = new Map<string, CachedClient>()
const domainCache = new Map<string, { name: string; version: string }>()

// `profile` is part of the key: `/verify` and `/settle` deliberately use
// DIFFERENT transport tuning (see `VERIFY_TRANSPORT_OPTIONS`/
// `SETTLE_TRANSPORT_OPTIONS` above) against the very same `(network, rpcUrl)`
// pair, and a shared cache entry would silently hand settle's long-lived
// receipt wait the same 2-second, no-retry transport verify's hot path
// needs — reintroducing I2 through the cache instead of the constructor.
function clientCacheKey(network: string, rpcUrl: string | undefined, profile: ClientProfile): string {
  return `${network}::${rpcUrl ?? ''}::${profile}`
}

function domainCacheKey(chainId: number, rpcUrl: string | undefined, asset: Address): string {
  return `${chainId}::${rpcUrl ?? ''}::${asset.toLowerCase()}`
}

async function getVerifiedClient(
  network: Task7Network,
  chain: (typeof SUPPORTED_CHAINS)[Task7Network],
  rpcUrl: string | undefined,
  profile: ClientProfile,
) {
  const key = clientCacheKey(network, rpcUrl, profile)
  const existing = clientCache.get(key)
  const entry: CachedClient =
    existing ??
    (() => {
      const transportOptions = profile === 'verify' ? VERIFY_TRANSPORT_OPTIONS : SETTLE_TRANSPORT_OPTIONS
      const client = createChainClient(chain, rpcUrl, transportOptions)
      const chainIdVerified = client
        .getChainId()
        .then((liveChainId) => liveChainId === chain.id)
        .catch(() => false)
      const created: CachedClient = { client, chainIdVerified }
      clientCache.set(key, created)
      return created
    })()

  const ok = await entry.chainIdVerified
  if (!ok) {
    // Don't poison the cache forever on what might be a transient RPC
    // hiccup at startup; let a later call retry the check.
    clientCache.delete(key)
    return undefined
  }
  return entry.client
}

async function getTokenDomain(
  client: ReturnType<typeof createChainClient>,
  chainId: number,
  rpcUrl: string | undefined,
  asset: Address,
): Promise<{ name: string; version: string } | undefined> {
  const key = domainCacheKey(chainId, rpcUrl, asset)
  const cached = domainCache.get(key)
  if (cached) return cached
  try {
    // This is the one part of the spec that is NOT safe to hardcode: real
    // USDC's domain `version` differs between deployments (e.g. "2" on
    // Base, but not guaranteed everywhere, and third-party EIP-3009 tokens
    // vary further). A hardcoded guess doesn't error — it just silently
    // recovers the WRONG signer for every valid payment. Reading it from
    // the token contract itself is the only way to get this right for
    // whichever token `requirements.asset` actually names.
    const [name, version] = await Promise.all([
      client.readContract({ address: asset, abi: DOMAIN_ABI, functionName: 'name' }),
      client.readContract({ address: asset, abi: DOMAIN_ABI, functionName: 'version' }),
    ])
    const domain = { name, version }
    domainCache.set(key, domain)
    return domain
  } catch {
    return undefined
  }
}

/** Splits a 65-byte `0x`-prefixed hex signature into its raw `r`/`s`/`v` parts. */
function splitEcdsaSignature(signature: string): { r: Hex; s: Hex; v: number } | undefined {
  if (!HEX_SIGNATURE_RE.test(signature)) return undefined
  const r = `0x${signature.slice(2, 66)}` as Hex
  const s = `0x${signature.slice(66, 130)}` as Hex
  const v = Number.parseInt(signature.slice(130, 132), 16)
  return { r, s, v }
}

/**
 * Recovers and validates the signer of a 65-byte ECDSA signature over
 * `digest`, enforcing the same non-malleability rule real USDC's
 * OpenZeppelin-`ECDSA`-based verification does (low-`s`, `v` in {27,28}) —
 * see `SECP256K1N_HALF`'s doc comment. Returns the recovered address, or
 * `undefined` if the signature is malformed, malleable, or recovers to the
 * zero address.
 *
 * Deliberately isolated from `verifyPayment`'s signature-length branch
 * (currently the only branch: every non-65-byte signature is rejected
 * before this is ever called) so a future smart-contract-wallet signature
 * path (EIP-1271 `isValidSignature`, a separate task) can be added as a
 * sibling branch keyed on signature shape, without restructuring this
 * function or the ECDSA checks it performs.
 */
async function recoverEcdsaSigner(signature: Hex, digest: Hex): Promise<Address | undefined> {
  const split = splitEcdsaSignature(signature)
  if (!split) return undefined
  if (split.v !== 27 && split.v !== 28) return undefined
  if (BigInt(split.s) > SECP256K1N_HALF) return undefined

  let recovered: Address
  try {
    recovered = await recoverAddress({ hash: digest, signature })
  } catch {
    return undefined
  }
  // Explicit zero-address guard: never let a botched recovery (which some
  // ecrecover implementations surface as `address(0)` rather than
  // throwing) be treated as a valid signer.
  if (isAddressEqual(recovered, zeroAddress)) return undefined
  return recovered
}

/**
 * Verifies a signed EIP-3009 `ReceiveWithAuthorization` payment authorization
 * against a `PaymentRequirements` entry, deciding whether the facilitator
 * should treat it as genuine.
 *
 * Checks run in a fixed order and return on the first failure — see this
 * function's inline comments for why each one is placed where it is. The
 * merchant-binding check (2) is the off-chain half of `Escrow.sol`'s
 * `MerchantNotBound` guard: without it, a redirect attempt (a valid
 * signature whose nonce was computed against a DIFFERENT merchant address)
 * only fails on-chain, after the facilitator has already spent gas trying
 * to settle it.
 */
export async function verifyPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  if (!('authorization' in payload.payload)) {
    // The exact-svm variant ({ transaction }) carries no EIP-3009
    // authorization at all — this verifier is exact-evm (Base) only.
    return { isValid: false, invalidReason: 'invalid_payload' }
  }
  const authorization = payload.payload.authorization

  // 1. Recipient: the signed authorization must name OUR escrow, not some
  // other address the payload happens to carry. Checked first because
  // every later check assumes this payload is even trying to pay this
  // requirement's escrow.
  //
  // `isAddress(..., { strict: false })` (via `addressesEqual`) rather than
  // strict-mode `isAddress`: strict mode additionally enforces EIP-55
  // checksum casing, which would reject an all-uppercase or all-lowercase
  // address x402's own schema accepts outright (`EvmAddressRegex` is a
  // plain case-insensitive hex check). `to`/`from`/`payTo` are compared
  // case-insensitively everywhere in this module; the address-validity
  // check must be exactly as lenient, or a technically-x402-valid address
  // would be rejected here for a reason x402 itself doesn't recognize.
  if (!addressesEqual(authorization.to, requirements.payTo)) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_recipient_mismatch' }
  }

  // 2. Merchant binding — THE most important check here. `Escrow.sol`
  // enforces `auth.nonce == keccak256(abi.encode(merchant, paymentId))`
  // on-chain (see `settleAuthorization`'s `MerchantNotBound` guard); this
  // recomputes the identical hash off-chain and rejects a mismatch before
  // any gas is spent. A payload signed for a different merchant/paymentId
  // pair — e.g. an attacker who intercepted a legitimate challenge and
  // tried to redirect it to their own merchant address — has some other
  // (still validly-signed-by-the-real-payer) nonce here, which will never
  // equal the nonce this specific `requirements` entry expects.
  const merchantEvm = requirements.extra?.merchantEvm as `0x${string}` | undefined
  const paymentId = requirements.extra?.paymentId as `0x${string}` | undefined
  if (!merchantEvm || !paymentId) {
    return { isValid: false, invalidReason: 'invalid_payload' }
  }
  let expectedNonce: `0x${string}`
  try {
    expectedNonce = computeNonce(merchantEvm, paymentId)
  } catch {
    return { isValid: false, invalidReason: 'invalid_payload' }
  }
  if (expectedNonce.toLowerCase() !== authorization.nonce.toLowerCase()) {
    return { isValid: false, invalidReason: 'invalid_payload' }
  }

  // 3. Amount — both sides are untrusted decimal strings; see
  // `parseDecimalBigInt`'s doc comment for why a bare `BigInt(...)` (or
  // trusting an upstream schema's own numeric-string check) is not safe
  // here.
  const authorizedValue = parseDecimalBigInt(authorization.value)
  const requiredValue = parseDecimalBigInt(requirements.maxAmountRequired)
  if (authorizedValue === undefined || requiredValue === undefined || authorizedValue < requiredValue) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_value' }
  }

  // 4. Time window — same untrusted-decimal-string treatment as `value`,
  // range bound included (see `parseDecimalBigInt`'s doc comment, point 2:
  // an oversized `validBefore` is not caught by any earlier check the way
  // an oversized `validAfter` incidentally is by the "not yet valid"
  // comparison below).
  const validAfter = parseDecimalBigInt(authorization.validAfter)
  const validBefore = parseDecimalBigInt(authorization.validBefore)
  if (validAfter === undefined) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_after' }
  }
  if (validBefore === undefined) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_before' }
  }
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  if (validAfter > nowSeconds) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_after' }
  }
  if (validBefore <= nowSeconds) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_before' }
  }

  // 5. Signature — recovered over the EIP-712 `ReceiveWithAuthorization`
  // struct, using a domain read live from the token contract, and rejected
  // outright if malleable even before recovery is attempted: the EVM's
  // `ecrecover` precompile (and viem's recovery, which uses the same math)
  // does NOT itself reject a high-`s`/wrong-`v` signature the way
  // OpenZeppelin's `ECDSA.recover` (which real USDC uses) does. A verifier
  // that skipped this would accept signatures the token itself would
  // refuse at settlement.
  //
  // The signature's byte length is the branch point for WHICH signature
  // scheme this is: 65 bytes is a plain ECDSA signature (the only scheme
  // implemented here); anything else is reserved for a future EIP-1271
  // smart-contract-wallet path (`isValidSignature`, out of scope for this
  // task) rather than being a malformed-ECDSA-signature error as such.
  if (!HEX_ADDRESS_RE.test(authorization.from) || !HEX_ADDRESS_RE.test(authorization.to)) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }
  }
  if (!isAddress(requirements.asset, { strict: false })) {
    return { isValid: false, invalidReason: 'invalid_payload' }
  }
  // `getAddress` both narrows to `Address` and normalizes to EIP-55
  // checksum casing — needed because `requirements.asset` may be
  // all-lowercase or all-uppercase (see the strict:false note above), and
  // this value is used as a cache key and as `verifyingContract` below.
  const assetAddress: Address = getAddress(requirements.asset)
  if (!HEX_SIGNATURE_RE.test(payload.payload.signature)) {
    // Not a 65-byte ECDSA signature. (Reserved: EIP-1271 branch goes here.)
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }
  }

  const chain = SUPPORTED_CHAINS[requirements.network as Task7Network]
  if (!chain) {
    return { isValid: false, invalidReason: 'invalid_network' }
  }
  const client = await getVerifiedClient(requirements.network as Task7Network, chain, options.rpcUrl, 'verify')
  if (!client) {
    // Either the RPC was unreachable, or it reported a chain id that
    // doesn't match `chain.id` — see `getVerifiedClient`'s doc comment.
    // Both are operator-side configuration/infra problems, not something
    // the payer's payload caused.
    return { isValid: false, invalidReason: 'unexpected_verify_error' }
  }

  const tokenDomain = await getTokenDomain(client, chain.id, options.rpcUrl, assetAddress)
  if (!tokenDomain) {
    return { isValid: false, invalidReason: 'unexpected_verify_error' }
  }

  const digest = hashTypedData({
    domain: {
      name: tokenDomain.name,
      version: tokenDomain.version,
      // `chain.id`: the STATIC id declared for `requirements.network`, never
      // a live RPC value — see the caching section's doc comment for why.
      chainId: chain.id,
      verifyingContract: assetAddress,
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: authorization.from as Address,
      to: authorization.to as Address,
      value: authorizedValue,
      validAfter,
      validBefore,
      nonce: authorization.nonce as Hex,
    },
  })
  const recovered = await recoverEcdsaSigner(payload.payload.signature as Hex, digest)
  if (!recovered) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }
  }
  if (!addressesEqual(recovered, authorization.from)) {
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }
  }

  return { isValid: true, payer: recovered }
}

// --- Task 8: /settle -------------------------------------------------------

/**
 * The minimal ABI `settlePayment` needs against `Escrow.sol`: the one
 * function it calls, the `PaymentSettled` event it must observe to prove that
 * call actually credited a merchant (see requirement C1 in the task-8 review,
 * and `settlePayment`'s own doc comment), plus every custom error
 * `Escrow.sol` can revert with (see `packages/contracts/src/Escrow.sol`).
 * Hand-written rather than imported from a build artifact — this facilitator
 * has exactly one contract it ever calls, and hand-writing the handful of
 * entries it actually uses avoids a build-time dependency from
 * `@anychain402/facilitator` on `@anychain402/contracts`' compiled output.
 * Declaring the errors here (not just the function) matters for more than
 * documentation: viem's own revert decoding (`decodeErrorResult`, used
 * internally by `ContractFunctionRevertedError`) only recognizes a custom
 * error if its signature is present in the ABI passed to the call that
 * reverted — see `decodeSettleRevert`'s doc comment.
 */
const ESCROW_SETTLE_ABI = [
  {
    type: 'function',
    name: 'settleAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'paymentId', type: 'bytes32' },
      {
        name: 'auth',
        type: 'tuple',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'PaymentSettled',
    anonymous: false,
    inputs: [
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'bytes32', indexed: false },
    ],
  },
  { type: 'error', name: 'Reentrancy', inputs: [] },
  { type: 'error', name: 'RecipientMismatch', inputs: [] },
  { type: 'error', name: 'MerchantNotBound', inputs: [] },
  { type: 'error', name: 'ZeroMerchant', inputs: [] },
  { type: 'error', name: 'InsufficientBalance', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
] as const

/**
 * A conservative fixed gas limit for `settleAuthorization`, passed
 * explicitly on every settlement submission — see `settlePayment`'s doc
 * comment for why this is load-bearing, not just an optimization: it is what
 * makes `receipt.status === 'reverted'` (rather than a thrown error from
 * client-side gas estimation) the path every on-chain revert actually takes.
 * `settleAuthorization` does one external call (`receiveWithAuthorization`)
 * plus a couple of cold `SSTORE`s; real USDC's own implementation (a proxy
 * delegatecall plus its own EIP-712/nonce bookkeeping) is heavier than
 * `MockUSDC`'s, so this leaves several times the headroom real mainnet USDC
 * transfers typically consume, while staying far below any Base block's gas
 * limit.
 */
const SETTLE_GAS_LIMIT = 500_000n

/**
 * `settlePayment`'s own additions to `VerifyInvalidReason`'s vocabulary —
 * see that type's doc comment for the same `AssertSubtype` discipline this
 * union is checked against below.
 */
export type SettleInvalidReason =
  | VerifyInvalidReason
  | 'unexpected_settle_error'
  | 'insufficient_funds'
  | 'duplicate_settlement'

// See `_VerifyInvalidReasonIsSubsetOfX402ErrorReasons` above for why this
// check exists and why it is written this specific (non-distributive) way.
type _SettleInvalidReasonIsSubsetOfX402ErrorReasons = AssertSubtype<SettleInvalidReason, (typeof ErrorReasons)[number]>

export interface SettleOptions extends VerifyOptions {
  /**
   * Overrides the facilitator's signing key for this call. Defaults to
   * `process.env.FACILITATOR_PRIVATE_KEY`. Tests pass one of anvil's
   * well-known dev keys here instead of mutating `process.env` (which would
   * leak across other tests sharing the same worker) — see
   * `test/support/anvil.ts`.
   *
   * Never logged, here or anywhere downstream of this module.
   */
  facilitatorPrivateKey?: Hex
}

export interface SettleResult {
  success: boolean
  errorReason?: SettleInvalidReason
  /**
   * Best-effort even on failure: the signer `authorization.from` claims to
   * be, independent of whether that claim actually checked out. Matches
   * x402's own reference exact-evm `settle` (see its `settle2`), which
   * likewise reports `payload.authorization.from` in its failure responses.
   */
  payer: string
  /** A 32-byte transaction hash once one was actually submitted; `''` when
   *  settlement never reached the chain (verify failed, or submission threw
   *  before a hash existed). */
  transaction: string
  network: string
  /**
   * The OBSERVED on-chain credit — `Escrow.sol`'s own `PaymentSettled.value`,
   * i.e. `balanceOf(after) - balanceOf(before)` on the token, never
   * `auth.value` (see `Escrow.sol`'s doc comment on `settleAuthorization`,
   * and this task's requirement C1) — and the nonce it was recorded against.
   * Present only when `success` is true.
   *
   * Deliberately an IN-PROCESS-ONLY field (task-8 review round 1, I1):
   * `SettleResponseSchema` is a fixed x402 wire contract this facilitator
   * must not extend, and it is `.strip()`-validated in `server.ts`, so
   * `POST /settle`'s HTTP response never carries this even though it is
   * present on the value `settlePayment` returns. A future in-process caller
   * within this SAME facilitator (e.g. an HCS journal writer, per Amendment
   * 2's fee-on-transfer-token scope) can read the observed delta directly
   * here instead of re-fetching this receipt by hash over RPC — a second,
   * avoidable failure point for data this call already has.
   */
  settledAmount?: bigint
  nonce?: Hex
}

/** Best-effort label for an on-chain revert or submission failure, used only
 *  for the operator-facing log line `settlePayment` emits — never part of
 *  the `SettleResult` returned to a caller. Contains no payer-supplied data
 *  beyond a revert's OWN error name/args (which the payer doesn't control)
 *  and the escrow/network context; never the signature or the private key. */
interface DecodedSettleFailure {
  errorReason: SettleInvalidReason
  label: string
}

/** Computes a raw 4-byte error/function selector from its canonical Solidity
 *  signature string (`"Name(type,type,...)"`) — the first 4 bytes of
 *  `keccak256` of the signature, identical for both functions and errors
 *  (Solidity derives both the same way). Used, not guessed: every selector
 *  this module recognizes is computed from an explicit signature string
 *  right next to its use, so it is independently verifiable rather than a
 *  bare hex literal someone has to trust. */
function computeErrorSelector(signature: string): Hex {
  return keccak256(toBytes(signature)).slice(0, 10) as Hex
}

/**
 * A deliberately small, best-effort registry of raw 4-byte selectors for
 * "this authorization/nonce was already used" CUSTOM errors used by common
 * EIP-3009 implementations that are NOT decodable via the standard
 * `Error(string)` tier (see `decodeSettleRevert`'s tier 2) — real USDC
 * (`FiatTokenV2`) reverts with a plain STRING
 * ("FiatTokenV2: authorization is used or canceled"), decoded there instead;
 * this table exists only for tokens that use a genuine custom error instead,
 * as this project's own `MockUSDC.sol`/`SettleToken.sol` test fixtures do
 * (`AuthorizationAlreadyUsed()`). This module carries no ABI for any
 * third-party token, so such an error can only be recognized by raw selector
 * bytes, never by name — extend this list, never replace the string-based
 * check above it, if another common implementation's error name becomes
 * relevant.
 */
const KNOWN_ALREADY_USED_SELECTORS: readonly Hex[] = [computeErrorSelector('AuthorizationAlreadyUsed()')]

/**
 * Best-effort decoding of a revert or submission failure into an x402
 * `errorReason` plus a human-readable label for logging.
 *
 * Four tiers, in order:
 *
 * 1. One of `Escrow.sol`'s own custom errors (`MerchantNotBound`,
 *    `Reentrancy`, `ZeroMerchant`, `InsufficientBalance`, `TransferFailed`)
 *    — decodable because `ESCROW_SETTLE_ABI` declares them. These are
 *    facilitator/contract-level problems, not something a payer's payload
 *    caused, so they map to the generic `unexpected_settle_error` — except
 *    `RecipientMismatch`, which is exactly x402's own
 *    `invalid_exact_evm_payload_recipient_mismatch` (the escrow's own
 *    on-chain re-check of the same condition `verifyPayment`'s check 1
 *    already performs off-chain) and is reported as such.
 * 2. A plain Solidity `require`/`revert("...")` string reason — decodable
 *    for ANY contract, regardless of the ABI passed in, because viem always
 *    additionally checks the standard `Error(string)` selector (see
 *    `decodeErrorResult`). This is how a real EIP-3009 token's OWN revert
 *    reasons surface (e.g. real USDC is older Solidity and reverts with
 *    strings, not custom errors) even though this module has no ABI for
 *    whatever token `requirements.asset` names. A reason that reads as an
 *    already-used/nonce-reuse complaint is reported as x402's
 *    `duplicate_settlement` — the single most common real settle failure
 *    (a replay), and the one case a caller most needs distinguished from a
 *    generic error (a payer polling "was I charged?" needs to know "yes,
 *    already settled" from "something broke, retry" are different answers).
 *    A reason that reads as an insufficient-balance complaint is reported as
 *    `insufficient_funds`; anything else falls back to `unexpected_settle_error`.
 * 3. A custom error this ABI doesn't declare, but whose raw 4-byte selector
 *    matches `KNOWN_ALREADY_USED_SELECTORS` — also `duplicate_settlement`.
 * 4. Anything else — an unrecognized custom error, a `Panic(uint256)`, or a
 *    non-revert failure (RPC/network error). Reported as
 *    `unexpected_settle_error`, with whatever raw signature/message viem
 *    could still surface included in the label — an unresolved 4-byte
 *    selector is still far more debuggable than nothing.
 */
function decodeSettleRevert(err: unknown): DecodedSettleFailure {
  const reverted =
    err instanceof BaseError ? (err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null

  if (reverted) {
    const errorName = reverted.data?.errorName
    if (errorName === 'RecipientMismatch') {
      return { errorReason: 'invalid_exact_evm_payload_recipient_mismatch', label: 'Escrow.RecipientMismatch' }
    }
    if (
      errorName === 'MerchantNotBound' ||
      errorName === 'Reentrancy' ||
      errorName === 'ZeroMerchant' ||
      errorName === 'InsufficientBalance' ||
      errorName === 'TransferFailed'
    ) {
      return { errorReason: 'unexpected_settle_error', label: `Escrow.${errorName}` }
    }
    if (errorName === 'Error' && typeof reverted.reason === 'string') {
      const reason = reverted.reason
      const looksLikeAlreadyUsed = /already used|used or (?:cancell?ed)|nonce.*(?:used|reuse)/i.test(reason)
      const looksLikeInsufficientFunds = /insufficient|exceeds balance/i.test(reason)
      const errorReason = looksLikeAlreadyUsed ? 'duplicate_settlement' : looksLikeInsufficientFunds ? 'insufficient_funds' : 'unexpected_settle_error'
      return { errorReason, label: `token revert: "${reason}"` }
    }
    if (errorName === 'Panic') {
      return { errorReason: 'unexpected_settle_error', label: `Panic(${String(reverted.reason ?? 'unknown')})` }
    }
    if (reverted.signature) {
      if (KNOWN_ALREADY_USED_SELECTORS.some((selector) => selector === reverted.signature?.toLowerCase())) {
        return { errorReason: 'duplicate_settlement', label: `token revert: known already-used selector ${reverted.signature}` }
      }
      return { errorReason: 'unexpected_settle_error', label: `unrecognized revert selector ${reverted.signature}` }
    }
    return { errorReason: 'unexpected_settle_error', label: 'revert with no decodable reason' }
  }

  const message = err instanceof Error ? err.message : String(err)
  return { errorReason: 'unexpected_settle_error', label: `non-revert failure: ${message}` }
}

/**
 * Best-effort re-decoding of an ALREADY-MINED, reverted transaction (see
 * check 6 in `settlePayment`'s doc comment for why this path exists at all).
 * A mined receipt carries no revert data of its own, so this replays the
 * identical call via `eth_call` against current chain state to recover a
 * decodable reason. Current state is not guaranteed to be byte-identical to
 * the state the original transaction actually executed against (another
 * transaction could have landed in between), so this is inherently
 * best-effort — if the replay no longer fails the same way (or at all), that
 * itself is reported rather than guessed at.
 */
async function decodeMinedRevert(
  publicClient: ReturnType<typeof createChainClient>,
  call: {
    address: Address
    account: Address
    args: readonly [Address, Hex, { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }, number, Hex, Hex]
  },
): Promise<DecodedSettleFailure> {
  try {
    await publicClient.simulateContract({
      address: call.address,
      abi: ESCROW_SETTLE_ABI,
      functionName: 'settleAuthorization',
      args: call.args,
      account: call.account,
    })
    return {
      errorReason: 'unexpected_settle_error',
      label: 're-simulation succeeded against current state; mined revert reason unavailable',
    }
  } catch (err) {
    return decodeSettleRevert(err)
  }
}

/**
 * Redeems a verified EIP-3009 authorization on-chain: submits
 * `Escrow.settleAuthorization` from the facilitator's own wallet, waits for
 * the receipt, and reports the x402 `SettleResponse` shape.
 *
 * Two correctness properties matter more than the rest here:
 *
 * 1. **Never submit an unverified authorization.** `verifyPayment` is
 *    re-run, from scratch, as this function's very first step, and any
 *    failure returns immediately — before a wallet client is even
 *    constructed, let alone before any RPC call that could submit a
 *    transaction. Gas is real money and a revert is a worse failure mode
 *    than a same-latency rejection; there is no scenario where trusting a
 *    caller's own prior `/verify` call (rather than re-checking) is worth
 *    that risk. This is also why the unverified-payload test in
 *    `settle.fork.test.ts` asserts NO transaction was sent, not merely that
 *    `success` came back `false`.
 * 2. **A mined-but-reverted transaction is a failure**, even though
 *    `writeContract` itself did not throw. This function deliberately passes
 *    an explicit `gas` (`SETTLE_GAS_LIMIT`) on every submission specifically
 *    so this path is reachable at all: viem's wallet actions only run
 *    client-side gas estimation (which itself simulates the call, and would
 *    throw synchronously for a call that reverts) when `gas` is left
 *    unspecified. With `gas` fixed, a reverting call is broadcast and mined
 *    like any other transaction, and the ONLY signal that it failed is
 *    `receipt.status`. Real facilitators (and the `MerchantNotBound` /
 *    double-settlement tests here) go through exactly this path, not a
 *    thrown exception — a facilitator that checked `success` and forgot to
 *    ALSO check `receipt.status` would report a reverted payment as settled.
 *
 * The merchant identity passed to the contract is
 * `requirements.extra.merchantEvm` — the per-chain EVM address the payer's
 * nonce is bound to (see `computeNonce`'s doc comment) — never
 * `requirements.extra.merchant`, the Hedera clearing-layer account id. The
 * two are easy to confuse (this project has already done so once); only
 * `merchantEvm` means anything to `Escrow.sol`, and submitting the wrong one
 * doesn't silently miscredit anyone — it reverts `MerchantNotBound`, since
 * the payer's signed nonce is bound to `merchantEvm` specifically.
 */
export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const network = requirements.network
  const payerBestEffort = 'authorization' in payload.payload ? payload.payload.authorization.from : ''

  // 1. Re-verify from scratch. See this function's doc comment, point 1 —
  // nothing below this block may run on a payload that didn't just pass.
  const verifyResult = await verifyPayment(payload, requirements, { rpcUrl: options.rpcUrl })
  if (!verifyResult.isValid) {
    return {
      success: false,
      errorReason: verifyResult.invalidReason ?? 'unexpected_settle_error',
      payer: verifyResult.payer ?? payerBestEffort,
      transaction: '',
      network,
    }
  }

  // verifyPayment only returns isValid:true for the exact-evm
  // { signature, authorization } payload shape (see its first check) — this
  // re-narrows for TypeScript and, cheaply, for defense-in-depth against a
  // future change that decoupled the two.
  if (!('authorization' in payload.payload)) {
    return { success: false, errorReason: 'unexpected_settle_error', payer: payerBestEffort, transaction: '', network }
  }
  const authorization = payload.payload.authorization
  const payer = verifyResult.payer ?? authorization.from

  // 2 & 3. The contract's `merchant` argument and `paymentId` — see this
  // function's doc comment for why `merchantEvm` specifically (never
  // `extra.merchant`). Both are re-extracted (not just trusted from the
  // verify call above) as defense-in-depth: `verifyPayment` already requires
  // both to be present and shaped correctly for a valid result, so this
  // cannot actually fail here today, but a future refactor decoupling that
  // requirement from this one must not turn into a silent `undefined` reaching
  // `computeNonce`/the contract call below.
  const merchantEvm = requirements.extra?.merchantEvm as Address | undefined
  const paymentId = requirements.extra?.paymentId as Hex | undefined
  if (!merchantEvm || !paymentId) {
    return { success: false, errorReason: 'unexpected_settle_error', payer, transaction: '', network }
  }

  const chain = SUPPORTED_CHAINS[network as Task7Network]
  if (!chain) {
    return { success: false, errorReason: 'invalid_network', payer, transaction: '', network }
  }

  const split = splitEcdsaSignature(payload.payload.signature)
  if (!split) {
    // verifyPayment's check 5 already requires a well-formed 65-byte ECDSA
    // signature for isValid:true; unreachable in practice.
    return { success: false, errorReason: 'unexpected_settle_error', payer, transaction: '', network }
  }

  const facilitatorPrivateKey = options.facilitatorPrivateKey ?? (process.env.FACILITATOR_PRIVATE_KEY as Hex | undefined)
  if (!facilitatorPrivateKey) {
    console.error('settlePayment: FACILITATOR_PRIVATE_KEY is not configured (checked options and process.env)')
    return { success: false, errorReason: 'unexpected_settle_error', payer, transaction: '', network }
  }

  // Prepare every value the contract call needs. Wrapped in one try/catch:
  // every input here already passed verifyPayment's own validation (address
  // shape, decimal-string range via parseDecimalBigInt, etc.), so none of
  // this is expected to throw — this exists purely so an unanticipated
  // future edge case fails closed (an `unexpected_settle_error`) rather than
  // crashing the facilitator process, matching this codebase's existing
  // "verifyPayment is written to never throw" discipline (see server.ts).
  let account: ReturnType<typeof privateKeyToAccount>
  let escrowAddress: Address
  let merchantEvmAddress: Address
  let authTuple: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }
  try {
    account = privateKeyToAccount(facilitatorPrivateKey)
    escrowAddress = getAddress(requirements.payTo)
    merchantEvmAddress = getAddress(merchantEvm)
    const value = parseDecimalBigInt(authorization.value)
    const validAfter = parseDecimalBigInt(authorization.validAfter)
    const validBefore = parseDecimalBigInt(authorization.validBefore)
    if (value === undefined || validAfter === undefined || validBefore === undefined) {
      throw new Error('authorization field failed re-validation after verifyPayment reported it valid')
    }
    authTuple = {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value,
      validAfter,
      validBefore,
      nonce: authorization.nonce as Hex,
    }
  } catch (err) {
    console.error(`settlePayment: failed to prepare settlement inputs: ${err instanceof Error ? err.message : String(err)}`)
    return { success: false, errorReason: 'unexpected_settle_error', payer, transaction: '', network }
  }

  // A DIFFERENT cache entry than `verifyPayment`'s own call moments ago for
  // this same (network, rpcUrl) — same underlying cache and chain-id-verified
  // mechanism (see `getVerifiedClient`'s doc comment), but keyed by the
  // `'settle'` profile, which gets its own, much less aggressive transport
  // tuning (`SETTLE_TRANSPORT_OPTIONS`) than `/verify`'s hot-path `'verify'`
  // profile — see that constant's doc comment for why sharing verify's 2s/
  // no-retry transport here would be actively dangerous, not just slow.
  // Deliberately NOT a fresh `createPublicClient({ chain, transport })` call:
  // this file's own multi-viem-install hazard (see `createChainClient`'s doc
  // comment) means every client instantiation must flow through that one
  // function, or TypeScript can spuriously reject assigning one client to a
  // differently-inferred-but-identical type elsewhere (`decodeMinedRevert`'s
  // parameter, in this case).
  const publicClient = await getVerifiedClient(network as Task7Network, chain, options.rpcUrl, 'settle')
  if (!publicClient) {
    return { success: false, errorReason: 'unexpected_settle_error', payer, transaction: '', network }
  }
  const walletClient = createWalletClient({ account, chain, transport: http(options.rpcUrl, SETTLE_TRANSPORT_OPTIONS) })

  const callArgs = [merchantEvmAddress, paymentId, authTuple, split.v, split.r, split.s] as const

  // 4. Submit, funded from the facilitator's own wallet. `gas` is always
  // explicit — see this function's doc comment, point 2.
  let hash: Hex
  try {
    hash = await walletClient.writeContract({
      address: escrowAddress,
      abi: ESCROW_SETTLE_ABI,
      functionName: 'settleAuthorization',
      args: callArgs,
      gas: SETTLE_GAS_LIMIT,
    })
  } catch (err) {
    const decoded = decodeSettleRevert(err)
    console.error(`settlePayment: submission to escrow ${escrowAddress} on ${network} failed: ${decoded.label}`)
    return { success: false, errorReason: decoded.errorReason, payer, transaction: '', network }
  }

  let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash })
  } catch (err) {
    console.error(`settlePayment: never got a receipt for ${hash} on ${network}: ${err instanceof Error ? err.message : String(err)}`)
    return { success: false, errorReason: 'unexpected_settle_error', payer, transaction: hash, network }
  }

  // 6. A mined-but-reverted transaction is a failure — see this function's
  // doc comment, point 2.
  if (receipt.status !== 'success') {
    const decoded = await decodeMinedRevert(publicClient, { address: escrowAddress, account: account.address, args: callArgs })
    console.error(`settlePayment: transaction ${hash} on ${network} was mined but reverted: ${decoded.label}`)
    return { success: false, errorReason: decoded.errorReason, payer, transaction: hash, network }
  }

  // 7 (task-8 review round 1, C1). `receipt.status === 'success'` proves only
  // that the CALL didn't revert — it does NOT prove `Escrow.settleAuthorization`
  // actually ran the code path that credits a merchant. A codeless address
  // (or any no-op/EOA "escrow") at `escrowAddress` mines a clean, cheap
  // success receipt and moves nothing; `Escrow._safeTransfer` already
  // defends exactly this class of hazard one layer down (see its own doc
  // comment on `payTo`/`token` codelessness) — trusting `receipt.status`
  // alone here would reintroduce that same hazard one layer up. Requiring a
  // `PaymentSettled` log actually emitted BY `escrowAddress` is the only
  // receipt-level proof that real contract code ran.
  //
  // Requiring its `value` to meet `maxAmountRequired` additionally catches a
  // fee-on-transfer token crediting LESS than what the authorization implied:
  // `Escrow` credits the OBSERVED balance delta, never `auth.value` (see
  // `Escrow.sol`'s own doc comment on `settleAuthorization`), and Amendment 2
  // puts fee-taking tokens explicitly in scope — a real, not hypothetical,
  // way for `received < maxAmountRequired` even though the call succeeded.
  const settledLogs = parseEventLogs({ abi: ESCROW_SETTLE_ABI, eventName: 'PaymentSettled', logs: receipt.logs }).filter((log) =>
    isAddressEqual(log.address, escrowAddress),
  )
  const settled = settledLogs[0]
  if (!settled) {
    console.error(
      `settlePayment: transaction ${hash} on ${network} mined 'success' but emitted no PaymentSettled log from ${escrowAddress} — treating as a no-op (codeless address, wrong contract, or a no-op escrow)`,
    )
    return { success: false, errorReason: 'unexpected_settle_error', payer, transaction: hash, network }
  }
  const requiredValue = parseDecimalBigInt(requirements.maxAmountRequired)
  if (requiredValue === undefined || settled.args.value < requiredValue) {
    console.error(
      `settlePayment: transaction ${hash} on ${network} settled only ${settled.args.value} of a required ${requirements.maxAmountRequired} (fee-on-transfer token, or a misconfigured requirement)`,
    )
    return { success: false, errorReason: 'unexpected_settle_error', payer, transaction: hash, network }
  }

  return { success: true, payer, transaction: hash, network, settledAmount: settled.args.value, nonce: settled.args.nonce }
}
