import { describe, it, expect } from 'vitest'
import { computeNonce, normalizeNonce } from '../src/nonce.js'

/**
 * Golden vectors generated independently of this codebase, from the actual
 * EVM toolchain (Foundry's `cast`), not from `@noble/hashes` or any other
 * JS implementation:
 *
 *   cast keccak "$(cast abi-encode 'f(address,bytes32)' <merchantEvm> <paymentId>)"
 *
 * This is the exact three-way agreement `computeNonce`'s doc comment
 * describes: the payer's client, this SDK's challenge-store key, and a
 * facilitator's `/verify` must all compute the identical hash, which must in
 * turn match what `Escrow.settleAuthorization` computes on-chain via
 * `keccak256(abi.encode(merchant, paymentId))`. A one-nibble padding error
 * here makes every payment fail on-chain with `MerchantNotBound`, after gas
 * is spent, with nothing in the logs explaining why — these vectors are the
 * regression barrier for that class of bug.
 */
describe('computeNonce', () => {
  it('matches cast keccak/abi-encode for vector 1 (round addresses/ids)', () => {
    expect(
      computeNonce(
        '0x1111111111111111111111111111111111111111',
        '0x00000000000000000000000000000000000000000000000000000000000004d2',
      ),
    ).toBe('0xb6f7d82208db09a705e0a7e18d8c0326c05e7fc142836aa6572fa044d76f8b5f')
  })

  it('matches cast keccak/abi-encode for vector 2 (EIP-55 checksummed address)', () => {
    expect(
      computeNonce(
        '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      ),
    ).toBe('0xf7d46eb5d06246fdafa7920b77e432277a012c8ea3e1c6ec7f1b413719419056')
  })

  it('treats the checksummed and all-lowercase forms of the same address identically', () => {
    // abi.encode operates on the address's 20 raw bytes, not its string
    // casing - an implementation that hashed the hex STRING (rather than
    // decoding it to bytes first) would silently diverge here, since EIP-55
    // checksum casing is derived from the address's own hash and differs
    // from plain lowercase. That divergence would only ever surface against
    // a real chain (a wallet that returns checksummed addresses) - exactly
    // the kind of bug this vector exists to catch before it reaches one.
    const paymentId = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const checksummed = computeNonce('0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa', paymentId)
    const lowercase = computeNonce('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', paymentId)
    const uppercase = computeNonce('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', paymentId)
    expect(checksummed).toBe(lowercase)
    expect(checksummed).toBe(uppercase)
    // And pinned to the actual on-chain value, not just "some shared value".
    expect(checksummed).toBe('0xf7d46eb5d06246fdafa7920b77e432277a012c8ea3e1c6ec7f1b413719419056')
  })

  it('rejects a merchantEvm that is not a 20-byte 0x address', () => {
    expect(() =>
      computeNonce(
        '0xdead' as `0x${string}`,
        '0x00000000000000000000000000000000000000000000000000000000000004d2',
      ),
    ).toThrow(/merchantEvm/)
  })

  it('rejects a paymentId that is not a 32-byte 0x value', () => {
    expect(() =>
      computeNonce('0x1111111111111111111111111111111111111111', '0xdead' as `0x${string}`),
    ).toThrow(/paymentId/)
  })
})

/**
 * `normalizeNonce` is public API (exported from the package root) and is
 * exactly what stands between a `ChallengeStore` implementation and the I1
 * casing bug (review round 2/3) for any store that doesn't ALSO normalize
 * internally — which `ChallengeStore`'s own contract explicitly permits.
 * Unit-tested directly here, not just exercised indirectly through
 * `middleware.test.ts`'s end-to-end cases.
 */
describe('normalizeNonce', () => {
  const CANONICAL = '0xb6f7d82208db09a705e0a7e18d8c0326c05e7fc142836aa6572fa044d76f8b5f'

  it('lowercases an uppercase-hex nonce to the canonical form', () => {
    // Only the hex body is uppercased, not the "0x" prefix: x402's own
    // HexEncoded64ByteRegex (and normalizeNonce's) requires a literal
    // lowercase "0x" - "0X..." is not a valid nonce shape at all, on-chain
    // hex prefixes are conventionally lowercase and case-insensitivity
    // applies only to the hex digits themselves.
    const uppercase = `0x${CANONICAL.slice(2).toUpperCase()}` as `0x${string}`
    expect(normalizeNonce(uppercase)).toBe(CANONICAL)
  })

  it('lowercases a mixed-case nonce to the canonical form', () => {
    const mixed = '0xB6f7D82208db09a705E0a7e18d8c0326C05e7fc142836aa6572fa044d76f8b5f'
    expect(normalizeNonce(mixed as `0x${string}`)).toBe(CANONICAL)
  })

  it('leaves an already-lowercase nonce unchanged', () => {
    expect(normalizeNonce(CANONICAL as `0x${string}`)).toBe(CANONICAL)
  })

  it('rejects a value that is not a 32-byte 0x hex string', () => {
    expect(() => normalizeNonce('0xdead')).toThrow(/nonce/)
    expect(() => normalizeNonce('not-hex-at-all')).toThrow(/nonce/)
  })
})
