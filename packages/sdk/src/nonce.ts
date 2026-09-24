import { keccak_256 } from '@noble/hashes/sha3'

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_32_BYTE_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * Computes the EIP-3009 authorization `nonce` an anychain402 payer must sign
 * for a given `(merchantEvm, paymentId)` pair:
 *
 * ```
 * nonce = keccak256(abi.encode(merchantEvm, paymentId))
 * ```
 *
 * This is `Escrow.settleAuthorization`'s own binding
 * (`packages/contracts/src/Escrow.sol`) — the contract recomputes this exact
 * hash on-chain and reverts `MerchantNotBound` if the payer's signed nonce
 * doesn't match it. A facilitator's `/verify` is expected to recompute the
 * same hash off-chain before settling, and `anychain402`'s middleware
 * recomputes it to index its challenge store by the nonce a payer will
 * actually sign. All three call sites must agree byte-for-byte, which is why
 * this is one implementation exported from the SDK rather than three
 * independent ones.
 *
 * `abi.encode(address, bytes32)` for two static (non-dynamic) types is just
 * their 32-byte word representations concatenated in argument order — no
 * offset/length header, since dynamic-type encoding doesn't apply here. An
 * `address` is right-aligned in its word (12 zero bytes, then the 20 address
 * bytes); a `bytes32` fills its word exactly.
 *
 * Cross-checked against Foundry's `cast` (independent of this codebase and
 * of `@noble/hashes`): for `merchantEvm = 0xAaAa...Aa` (20 bytes, all `0xaa`)
 * and `paymentId = 0xaaaa...aa` (32 bytes, all `0xaa`),
 * `cast keccak "$(cast abi-encode 'f(address,bytes32)' <merchantEvm> <paymentId>)"`
 * prints `0xab58f0a4880ff9ec03623fed7722c345bc81dfd76797349ed85ba672c60c2719`,
 * byte-identical to what this function returns for the same inputs — see the
 * pinned vector in `nonce.test.ts`.
 */
export function computeNonce(merchantEvm: `0x${string}`, paymentId: `0x${string}`): `0x${string}` {
  if (!HEX_ADDRESS_RE.test(merchantEvm)) {
    throw new Error(`computeNonce: invalid merchantEvm, expected a 20-byte 0x address, got ${merchantEvm}`)
  }
  if (!HEX_32_BYTE_RE.test(paymentId)) {
    throw new Error(`computeNonce: invalid paymentId, expected a 32-byte 0x value, got ${paymentId}`)
  }
  const addressWord = Buffer.from(merchantEvm.slice(2).toLowerCase().padStart(64, '0'), 'hex')
  const paymentIdWord = Buffer.from(paymentId.slice(2).toLowerCase(), 'hex')
  const preimage = Buffer.concat([addressWord, paymentIdWord])
  return `0x${Buffer.from(keccak_256(preimage)).toString('hex')}`
}

/**
 * Normalizes a payer-supplied EIP-3009 nonce to the canonical lowercase form
 * `computeNonce` always produces, so a `ChallengeStore` lookup by nonce is
 * never defeated by casing alone.
 *
 * `bytes32` has no casing on-chain — `0xAB…` and `0xab…` are the identical
 * 32-byte value — but x402's own `PaymentPayloadSchema` validates
 * `authorization.nonce` against `HexEncoded64ByteRegex`
 * (`/^0x[0-9a-fA-F]{64}$/`), which accepts mixed and upper case. A store
 * keyed on the raw, un-normalized string would silently miss a perfectly
 * valid uppercase-hex nonce (the exact bug class the `computeNonce` golden
 * vectors — including the EIP-55 checksummed-address one — exist to catch,
 * one level lower in the same computation). Every nonce a `ChallengeStore`
 * is asked to `get`/`set`/`consume` MUST pass through this function first.
 */
export function normalizeNonce(nonce: string): `0x${string}` {
  if (!HEX_32_BYTE_RE.test(nonce)) {
    throw new Error(`normalizeNonce: invalid nonce, expected a 32-byte 0x value, got ${nonce}`)
  }
  return nonce.toLowerCase() as `0x${string}`
}
