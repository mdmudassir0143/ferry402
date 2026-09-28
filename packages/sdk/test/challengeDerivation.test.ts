import { describe, it, expect, vi, afterEach } from 'vitest'
import { computeNonce } from '../src/nonce.js'
import {
  MIN_SECRET_BYTES,
  TIME_BUCKET_SECONDS,
  assertValidSecret,
  timeBucket,
  derivePaymentId,
  deriveChallenge,
  matchChallenge,
} from '../src/challengeDerivation.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('assertValidSecret (Task 12: throw at construction, never silently generate)', () => {
  it('throws when secret is undefined', () => {
    expect(() => assertValidSecret(undefined)).toThrow(/secret/i)
  })

  it('throws when secret is null', () => {
    expect(() => assertValidSecret(null)).toThrow(/secret/i)
  })

  it('throws when secret is not a string', () => {
    expect(() => assertValidSecret(12345)).toThrow(/secret/i)
  })

  it('throws when secret is an empty string', () => {
    expect(() => assertValidSecret('')).toThrow(/secret/i)
  })

  it(`throws when secret is ${MIN_SECRET_BYTES - 1} bytes (one short of the minimum)`, () => {
    expect(() => assertValidSecret('a'.repeat(MIN_SECRET_BYTES - 1))).toThrow(new RegExp(String(MIN_SECRET_BYTES)))
  })

  it(`does not throw at exactly ${MIN_SECRET_BYTES} bytes`, () => {
    expect(() => assertValidSecret('a'.repeat(MIN_SECRET_BYTES))).not.toThrow()
  })

  it('does not throw for a secret longer than the minimum', () => {
    expect(() => assertValidSecret('a'.repeat(MIN_SECRET_BYTES + 100))).not.toThrow()
  })

  it('counts UTF-8 BYTES, not JS string length (.length) - a 16-character multi-byte string can still be 32 bytes', () => {
    // 'é' (U+00E9) is ONE UTF-16 code unit (.length counts it as 1) but TWO
    // UTF-8 bytes. A length-based (rather than byte-based) check would
    // wrongly REJECT this as "16 bytes, too short" even though it is
    // genuinely 32 bytes of key material.
    const secret = 'é'.repeat(16)
    expect(secret.length).toBe(16)
    expect(Buffer.byteLength(secret, 'utf8')).toBe(32)
    expect(() => assertValidSecret(secret)).not.toThrow()
  })
})

describe('timeBucket', () => {
  it('is 0 for nowMs === 0', () => {
    expect(timeBucket(0)).toBe(0)
  })

  it('stays in the same bucket for the entire width of TIME_BUCKET_SECONDS', () => {
    expect(timeBucket(TIME_BUCKET_SECONDS * 1000 - 1)).toBe(0)
  })

  it('increments by exactly 1 at the bucket boundary', () => {
    expect(timeBucket(TIME_BUCKET_SECONDS * 1000)).toBe(1)
  })

  it('accepts a custom bucket width', () => {
    expect(timeBucket(59_999, 60)).toBe(0)
    expect(timeBucket(60_000, 60)).toBe(1)
  })

  it('is monotonic non-decreasing as time advances', () => {
    let previous = timeBucket(0)
    for (const ms of [1, 1000, 100_000, TIME_BUCKET_SECONDS * 1000, TIME_BUCKET_SECONDS * 1000 * 10]) {
      const bucket = timeBucket(ms)
      expect(bucket).toBeGreaterThanOrEqual(previous)
      previous = bucket
    }
  })
})

/**
 * Golden vector generated independently of this codebase's implementation,
 * from a separate tool (`openssl dgst -sha256 -hmac`, not Node's `crypto`
 * module used by `derivePaymentId` itself, and not any JS library):
 *
 *   printf '%s' '0x1111111111111111111111111111111111111111|https://api.test/premium|12345' \
 *     | openssl dgst -sha256 -hmac 'ssssssssssssssssssssssssssssssss'
 *   => 8610776396bcd1942a8c4c8dc0f2846015933b6f0d90253b7894d8bfac7153a1
 *
 * Pins the EXACT preimage format
 * (`${merchantEvm.toLowerCase()}|${resource}|${bucket}`) — a one-character
 * change to the separator or field order would silently desynchronize every
 * process sharing `secret` from every other, and this vector is the
 * regression barrier for that class of bug (the same rigor `nonce.test.ts`
 * applies to `computeNonce` via `cast`).
 */
describe('derivePaymentId', () => {
  const SECRET = 's'.repeat(32)
  const MERCHANT_EVM = '0x1111111111111111111111111111111111111111' as const
  const RESOURCE = 'https://api.test/premium'
  const BUCKET = 12345

  it('matches the independent openssl HMAC-SHA256 vector', () => {
    expect(derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET)).toBe(
      '0x8610776396bcd1942a8c4c8dc0f2846015933b6f0d90253b7894d8bfac7153a1',
    )
  })

  it('is deterministic: identical inputs always derive the identical output', () => {
    const a = derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET)
    const b = derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET)
    expect(a).toBe(b)
  })

  it('produces a 0x-prefixed 32-byte (64 hex char) value', () => {
    const id = derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('changes when the secret changes', () => {
    const other = derivePaymentId('t'.repeat(32), MERCHANT_EVM, RESOURCE, BUCKET)
    expect(other).not.toBe(derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET))
  })

  it('changes when merchantEvm changes', () => {
    const other = derivePaymentId(SECRET, '0x2222222222222222222222222222222222222222', RESOURCE, BUCKET)
    expect(other).not.toBe(derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET))
  })

  it('changes when resource changes', () => {
    const other = derivePaymentId(SECRET, MERCHANT_EVM, 'https://api.test/other', BUCKET)
    expect(other).not.toBe(derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET))
  })

  it('changes when the bucket changes', () => {
    const other = derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET + 1)
    expect(other).not.toBe(derivePaymentId(SECRET, MERCHANT_EVM, RESOURCE, BUCKET))
  })

  it('treats the checksummed and all-lowercase forms of merchantEvm identically (same posture as computeNonce)', () => {
    const checksummed = derivePaymentId(SECRET, '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa', RESOURCE, BUCKET)
    const lowercase = derivePaymentId(SECRET, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', RESOURCE, BUCKET)
    expect(checksummed).toBe(lowercase)
  })
})

describe('deriveChallenge', () => {
  const SECRET = 's'.repeat(32)
  const MERCHANT_EVM = '0x1111111111111111111111111111111111111111' as const
  const RESOURCE = 'https://api.test/premium'

  it('returns a nonce equal to computeNonce(merchantEvm, paymentId)', () => {
    const challenge = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, 123_000)
    expect(challenge.nonce).toBe(computeNonce(MERCHANT_EVM, challenge.paymentId))
  })

  it('returns the bucket matching timeBucket(nowMs)', () => {
    const nowMs = 7 * TIME_BUCKET_SECONDS * 1000 + 42
    const challenge = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, nowMs)
    expect(challenge.bucket).toBe(timeBucket(nowMs))
  })

  it('is deterministic within the same bucket - two calls at different instants in the SAME bucket derive identically', () => {
    const a = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, 0)
    const b = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, TIME_BUCKET_SECONDS * 1000 - 1)
    expect(a.paymentId).toBe(b.paymentId)
    expect(a.nonce).toBe(b.nonce)
  })

  it('derives differently once the bucket advances', () => {
    const a = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, 0)
    const b = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, TIME_BUCKET_SECONDS * 1000)
    expect(a.paymentId).not.toBe(b.paymentId)
  })

  it('defaults nowMs to Date.now() when omitted', () => {
    vi.spyOn(Date, 'now').mockReturnValue(999 * TIME_BUCKET_SECONDS * 1000 + 5)
    const explicit = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, 999 * TIME_BUCKET_SECONDS * 1000 + 5)
    const defaulted = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE)
    expect(defaulted).toEqual(explicit)
  })
})

describe('matchChallenge (the structural resource-binding + TTL check)', () => {
  const SECRET = 's'.repeat(32)
  const OTHER_SECRET = 't'.repeat(32)
  const MERCHANT_EVM = '0x1111111111111111111111111111111111111111' as const
  const OTHER_MERCHANT_EVM = '0x2222222222222222222222222222222222222222' as const
  const RESOURCE = 'https://api.test/cheap'
  const OTHER_RESOURCE = 'https://api.test/expensive'
  const boundaryMs = 42 * TIME_BUCKET_SECONDS * 1000

  it('matches a nonce derived for the CURRENT bucket', () => {
    const current = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, boundaryMs)
    const matched = matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, current.nonce, boundaryMs)
    expect(matched?.paymentId).toBe(current.paymentId)
    expect(matched?.bucket).toBe(current.bucket)
  })

  it('matches a nonce derived for the PREVIOUS bucket', () => {
    const previous = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, boundaryMs - TIME_BUCKET_SECONDS * 1000)
    const matched = matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, previous.nonce, boundaryMs)
    expect(matched?.paymentId).toBe(previous.paymentId)
  })

  it('does NOT match a nonce derived two buckets ago - the window is exactly current+previous', () => {
    const twoAgo = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, boundaryMs - 2 * TIME_BUCKET_SECONDS * 1000)
    const matched = matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, twoAgo.nonce, boundaryMs)
    expect(matched).toBeUndefined()
  })

  it('does NOT match a nonce derived for a DIFFERENT resource - cross-resource substitution is structurally impossible', () => {
    const forOther = deriveChallenge(SECRET, MERCHANT_EVM, OTHER_RESOURCE, boundaryMs)
    const matched = matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, forOther.nonce, boundaryMs)
    expect(matched).toBeUndefined()
  })

  it('does NOT match a nonce derived for a DIFFERENT merchantEvm', () => {
    const forOtherMerchant = deriveChallenge(SECRET, OTHER_MERCHANT_EVM, RESOURCE, boundaryMs)
    const matched = matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, forOtherMerchant.nonce, boundaryMs)
    expect(matched).toBeUndefined()
  })

  it('does NOT match a nonce derived with a DIFFERENT secret', () => {
    const forOtherSecret = deriveChallenge(OTHER_SECRET, MERCHANT_EVM, RESOURCE, boundaryMs)
    const matched = matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, forOtherSecret.nonce, boundaryMs)
    expect(matched).toBeUndefined()
  })

  it('DOES match across two independent calls sharing the same secret (the multi-instance property)', () => {
    // No shared object between these two calls whatsoever - only the string
    // value of `secret` is common, exactly like two separate processes.
    const issuedElsewhere = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, boundaryMs)
    const matchedHere = matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, issuedElsewhere.nonce, boundaryMs)
    expect(matchedHere?.paymentId).toBe(issuedElsewhere.paymentId)
  })

  it('returns undefined (not a throw) for a garbage nonce of the correct length', () => {
    const garbage = `0x${'11'.repeat(32)}` as const
    expect(matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, garbage, boundaryMs)).toBeUndefined()
  })

  it('returns undefined (not a throw) for a presented nonce of the WRONG byte length', () => {
    // timingSafeEqual throws on mismatched buffer lengths; matchChallenge
    // must guard that itself rather than let it escape as an unhandled
    // exception on attacker-controlled input length.
    const shortNonce = '0x1234' as `0x${string}`
    expect(() => matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, shortNonce, boundaryMs)).not.toThrow()
    expect(matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, shortNonce, boundaryMs)).toBeUndefined()
  })

  it('defaults nowMs to Date.now() when omitted', () => {
    vi.spyOn(Date, 'now').mockReturnValue(boundaryMs)
    const current = deriveChallenge(SECRET, MERCHANT_EVM, RESOURCE, boundaryMs)
    const matched = matchChallenge(SECRET, MERCHANT_EVM, RESOURCE, current.nonce)
    expect(matched?.paymentId).toBe(current.paymentId)
  })
})
