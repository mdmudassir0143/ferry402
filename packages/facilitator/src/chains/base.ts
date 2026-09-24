import {
  createPublicClient,
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
import type { PaymentPayload, PaymentRequirements } from 'x402/types'
import { computeNonce } from '@anychain402/sdk'

/**
 * The subset of x402's `ErrorReasons` this verifier can actually produce.
 * Deliberately narrower than the full union (which also carries exact-svm
 * and settlement-only reasons that can never come out of an exact-evm
 * `verifyPayment`) so a caller can exhaustively switch over it.
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
 * secp256k1's curve order, n. Real USDC (and any OpenZeppelin-`ECDSA`-based
 * token) rejects a signature whose `s` exceeds n/2 as malleable — see
 * EIP-2/OpenZeppelin's ECDSA library. A verifier that is more permissive
 * than the token itself would approve a payment that then reverts (or is
 * simply a different, attacker-crafted signature over the same message) at
 * settlement. This is the exact value from the task brief, matching
 * `MockUSDC.sol`'s `_SECP256K1N_HALF`.
 */
const SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

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
 * Parses a decimal-digits-only string to a `bigint`, or returns `undefined`
 * if it isn't one.
 *
 * Deliberately stricter than a bare `BigInt(...)` or x402's own upstream
 * validators (`Number.isInteger(Number(v))`), which operate on the
 * `Number()` coercion rather than the string's actual shape and so admit JS
 * exponent notation: `"1e30"` is short and `Number("1e30")` is an integer,
 * so it can pass a length/integer check — but `BigInt("1e30")` throws a
 * `SyntaxError`. That divergence caused an unauthenticated remote crash
 * (task 6); every untrusted decimal-string field in this module — value,
 * maxAmountRequired, validAfter, validBefore — is routed through this
 * before any `BigInt` arithmetic, regardless of what upstream schemas
 * already claim to have checked.
 */
function parseDecimalBigInt(value: string): bigint | undefined {
  if (!DECIMAL_STRING_RE.test(value)) return undefined
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

function addressesEqual(a: string, b: string): boolean {
  return HEX_ADDRESS_RE.test(a) && HEX_ADDRESS_RE.test(b) && a.toLowerCase() === b.toLowerCase()
}

// Deliberately NOT annotated with viem's `PublicClient` type: this
// workspace currently resolves more than one physically-distinct install of
// `viem`/`ox` (visible as multiple `zod@...`-suffixed variants under
// node_modules/.pnpm — a pnpm peer-dependency fork, not a version
// mismatch). Naming `PublicClient` as an explicit return/parameter type
// forces TypeScript to check assignability against whichever copy that
// import happened to resolve to, which can be a DIFFERENT physical copy
// than the one `createPublicClient` below was instantiated from, producing
// a spurious "two different types with this name exist, but they are
// unrelated" error despite both copies being the identical published
// version. Leaving the type inferred (flowing from this one call site)
// sidesteps the hazard entirely rather than papering over it with `any`.
function getPublicClient(network: string, rpcUrl?: string) {
  const chain = SUPPORTED_CHAINS[network as Task7Network]
  if (!chain) return undefined
  return createPublicClient({ chain, transport: http(rpcUrl) })
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

  // 4. Time window — same untrusted-decimal-string treatment as `value`.
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
  if (!isAddress(requirements.asset)) {
    return { isValid: false, invalidReason: 'invalid_payload' }
  }
  // Narrowed to `Address` by the `isAddress` guard above; hoisted into a
  // local so that narrowing survives the `await` boundaries below (TS's
  // control-flow narrowing of a dotted property access is not guaranteed to
  // survive an intervening `await`).
  const assetAddress: Address = requirements.asset
  if (!HEX_SIGNATURE_RE.test(payload.payload.signature)) {
    // Not a 65-byte ECDSA signature. (Reserved: EIP-1271 branch goes here.)
    return { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }
  }

  const client = getPublicClient(requirements.network, options.rpcUrl)
  if (!client) {
    return { isValid: false, invalidReason: 'invalid_network' }
  }

  let domain: { name: string; version: string; chainId: number }
  try {
    // This is the one part of the spec that is NOT safe to hardcode: real
    // USDC's domain `version` differs between deployments (e.g. "2" on
    // Base, but not guaranteed everywhere, and third-party EIP-3009 tokens
    // vary further). A hardcoded guess doesn't error — it just silently
    // recovers the WRONG signer for every valid payment. Reading it from
    // the token contract itself is the only way to get this right for
    // whichever token `requirements.asset` actually names.
    const [name, version, chainId] = await Promise.all([
      client.readContract({ address: assetAddress, abi: DOMAIN_ABI, functionName: 'name' }),
      client.readContract({ address: assetAddress, abi: DOMAIN_ABI, functionName: 'version' }),
      client.getChainId(),
    ])
    domain = { name, version, chainId }
  } catch {
    return { isValid: false, invalidReason: 'unexpected_verify_error' }
  }

  const digest = hashTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
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
