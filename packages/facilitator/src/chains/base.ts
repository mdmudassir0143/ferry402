import {
  createPublicClient,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  isAddressEqual,
  recoverAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
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
// - `{name, version}` is memoized per `(chainId, asset)`: a token's EIP-712
//   domain fields are immutable for the life of the contract, so there is
//   no reason to re-read them on every call.
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
function createChainClient(chain: (typeof SUPPORTED_CHAINS)[Task7Network], rpcUrl: string | undefined) {
  // Short timeout/no retries: `/verify` is on the hot path of an
  // unauthenticated HTTP endpoint (`paymentRequirements` is caller-supplied
  // and satisfies checks 1-4 trivially — see I3 in the task-7 review), so a
  // stalled upstream RPC must fail fast rather than hold the request for
  // anywhere near viem's defaults (10s timeout * 3 retries ≈ 40s),
  // especially since `anychain402`'s own middleware already gives up on
  // `/verify` at 5s.
  return createPublicClient({ chain, transport: http(rpcUrl, { timeout: 2_000, retryCount: 1 }) })
}

interface CachedClient {
  client: ReturnType<typeof createChainClient>
  /** Resolves once — the first time this (network, rpcUrl) pair is used —
   *  to whether the RPC's actual chain id matches `chain.id`. Awaited on
   *  every call, but the underlying `eth_chainId` request only ever fires
   *  once per pair. */
  chainIdVerified: Promise<boolean>
}

const clientCache = new Map<string, CachedClient>()
const domainCache = new Map<string, { name: string; version: string }>()

function clientCacheKey(network: string, rpcUrl: string | undefined): string {
  return `${network}::${rpcUrl ?? ''}`
}

function domainCacheKey(chainId: number, asset: Address): string {
  return `${chainId}::${asset.toLowerCase()}`
}

async function getVerifiedClient(
  network: Task7Network,
  chain: (typeof SUPPORTED_CHAINS)[Task7Network],
  rpcUrl: string | undefined,
) {
  const key = clientCacheKey(network, rpcUrl)
  const existing = clientCache.get(key)
  const entry: CachedClient =
    existing ??
    (() => {
      const client = createChainClient(chain, rpcUrl)
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
  asset: Address,
): Promise<{ name: string; version: string } | undefined> {
  const key = domainCacheKey(chainId, asset)
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
  const client = await getVerifiedClient(requirements.network as Task7Network, chain, options.rpcUrl)
  if (!client) {
    // Either the RPC was unreachable, or it reported a chain id that
    // doesn't match `chain.id` — see `getVerifiedClient`'s doc comment.
    // Both are operator-side configuration/infra problems, not something
    // the payer's payload caused.
    return { isValid: false, invalidReason: 'unexpected_verify_error' }
  }

  const tokenDomain = await getTokenDomain(client, chain.id, assetAddress)
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
