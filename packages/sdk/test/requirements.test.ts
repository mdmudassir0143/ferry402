import { describe, it, expect } from 'vitest'
import { buildRequirements, parsePrice } from '../src/requirements.js'
import type { Ferry402Config } from '../src/types.js'

const config: Ferry402Config = {
  price: '$0.01',
  accept: ['base-sepolia', 'polygon-amoy'],
  settleTo: 'hedera',
  merchant: '0.0.123456',
  // Deliberately distinct per chain: a test that only checked "some address
  // is present" would miss a cross-chain mix-up (e.g. every entry getting
  // base-sepolia's address). These must differ so such a bug fails loudly.
  merchantEvm: {
    base: '0x333333333333333333333333333333333333333d',
    'base-sepolia': '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
    polygon: '0x444444444444444444444444444444444444444e',
    'polygon-amoy': '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb',
  },
  facilitator: 'http://localhost:4000',
  escrows: {
    base: '0x0000000000000000000000000000000000000000',
    'base-sepolia': '0x1111111111111111111111111111111111111111',
    polygon: '0x0000000000000000000000000000000000000000',
    'polygon-amoy': '0x2222222222222222222222222222222222222222',
  },
  assets: {
    base: '0x0000000000000000000000000000000000000000',
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    polygon: '0x0000000000000000000000000000000000000000',
    'polygon-amoy': '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  },
}

const PAYMENT_ID_RE = /^0x[0-9a-fA-F]{64}$/
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

describe('buildRequirements', () => {
  it('emits one entry per accepted chain', () => {
    const reqs = buildRequirements(config, 'https://api.test/premium')
    expect(reqs).toHaveLength(2)
    expect(reqs.map(r => r.network)).toEqual(['base-sepolia', 'polygon-amoy'])
  })

  it('points payTo at that chain escrow', () => {
    const [base] = buildRequirements(config, 'https://api.test/premium')
    expect(base.payTo).toBe('0x1111111111111111111111111111111111111111')
    expect(base.scheme).toBe('exact')
  })

  it('converts a dollar price to 6-decimal atomic units', () => {
    const [base] = buildRequirements(config, 'https://api.test/premium')
    expect(base.maxAmountRequired).toBe('10000')
  })

  it('carries merchant and paymentId in extra for every chain option', () => {
    const reqs = buildRequirements(config, 'https://api.test/premium', {
      unsafePaymentIdForTesting:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    for (const r of reqs) {
      expect(r.extra?.merchant).toBe('0.0.123456')
      expect(r.extra?.paymentId).toBe(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      )
    }
  })

  it("carries this chain's merchantEvm address, not another chain's", () => {
    const reqs = buildRequirements(config, 'https://api.test/premium')
    for (const r of reqs) {
      expect(r.extra?.merchantEvm).toMatch(EVM_ADDRESS_RE)
      // Must equal config.merchantEvm for r's OWN network specifically — a
      // buggy implementation that hard-codes or reuses one chain's address
      // across every entry would fail this, even though each entry does
      // carry *some* well-formed address.
      expect(r.extra?.merchantEvm).toBe(config.merchantEvm[r.network as keyof typeof config.merchantEvm])
    }
    // Guard the fixture itself: if the two accepted chains' addresses ever
    // collapsed to the same value, the assertion above couldn't distinguish
    // "correct per-chain lookup" from "always returns the same address".
    const [baseSepolia, polygonAmoy] = reqs
    expect(baseSepolia.extra?.merchantEvm).toBe(config.merchantEvm['base-sepolia'])
    expect(polygonAmoy.extra?.merchantEvm).toBe(config.merchantEvm['polygon-amoy'])
    expect(baseSepolia.extra?.merchantEvm).not.toBe(polygonAmoy.extra?.merchantEvm)
  })

  it('shares one paymentId across all chain options in a single call', () => {
    const reqs = buildRequirements(config, 'https://api.test/premium')
    const ids = new Set(reqs.map(r => r.extra?.paymentId))
    expect(ids.size).toBe(1)
  })

  it('defaults to a cryptographically random 32-byte paymentId', () => {
    const [req] = buildRequirements(config, 'https://api.test/premium')
    expect(req.extra?.paymentId).toMatch(PAYMENT_ID_RE)
  })

  it('generates a fresh paymentId on every call (never reused)', () => {
    const first = buildRequirements(config, 'https://api.test/premium')[0]
    const second = buildRequirements(config, 'https://api.test/premium')[0]
    expect(first.extra?.paymentId).not.toBe(second.extra?.paymentId)
  })

  it('rejects a malformed injected paymentId rather than binding a bad nonce', () => {
    expect(() =>
      buildRequirements(config, 'https://api.test/premium', {
        // not 32 bytes
        unsafePaymentIdForTesting: '0xdead' as `0x${string}`,
      }),
    ).toThrow(/paymentId/)
  })

  describe('skipPaymentIdGeneration (Task 12 round 1: avoid a wasted CSPRNG draw for callers that overwrite paymentId themselves)', () => {
    it('fills every entry with the fixed zero placeholder instead of a random id', () => {
      const reqs = buildRequirements(config, 'https://api.test/premium', { skipPaymentIdGeneration: true })
      for (const r of reqs) {
        expect(r.extra?.paymentId).toBe(`0x${'0'.repeat(64)}`)
      }
    })

    it('is identical across repeated calls, unlike the CSPRNG default - proving no randomness is drawn', () => {
      // vitest/ESM cannot spy on node:crypto's named export directly
      // (module namespace properties are non-configurable in ESM), so this
      // asserts the OBSERVABLE consequence of skipping the CSPRNG draw
      // instead: the default path never repeats (see "generates a fresh
      // paymentId on every call" above), while this path always returns the
      // same fixed placeholder.
      const first = buildRequirements(config, 'https://api.test/premium', { skipPaymentIdGeneration: true })[0]
      const second = buildRequirements(config, 'https://api.test/premium', { skipPaymentIdGeneration: true })[0]
      expect(first.extra?.paymentId).toBe(second.extra?.paymentId)
    })

    it('unsafePaymentIdForTesting still wins if both options are supplied', () => {
      const injected = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
      const [req] = buildRequirements(config, 'https://api.test/premium', {
        skipPaymentIdGeneration: true,
        unsafePaymentIdForTesting: injected,
      })
      expect(req.extra?.paymentId).toBe(injected)
    })
  })

  it('only ever emits networks from the supported set', () => {
    const reqs = buildRequirements(config, 'https://api.test/premium')
    const allowed = new Set(['base', 'base-sepolia', 'polygon', 'polygon-amoy'])
    for (const r of reqs) {
      expect(allowed.has(r.network)).toBe(true)
    }
  })
})

describe('config fixture integrity', () => {
  // Guards Minor 2 from review: the merchantEvm placeholders for the two
  // unaccepted chains (base, polygon) were previously 38 hex chars, not 40 -
  // not a valid 20-byte address. buildRequirements never touched them (it
  // only iterates config.accept), so nothing caught it. Pin the whole fixture
  // to valid addresses so extending `accept` later doesn't hit that trap.
  it('every configured address is a valid 20-byte 0x address', () => {
    const maps = [config.merchantEvm, config.escrows, config.assets]
    for (const map of maps) {
      for (const address of Object.values(map)) {
        expect(address).toMatch(EVM_ADDRESS_RE)
      }
    }
  })
})

describe('parsePrice', () => {
  it('converts a dollar price to 6-decimal atomic units', () => {
    expect(parsePrice('$0.01')).toBe('10000')
  })

  it('handles a whole-dollar amount', () => {
    expect(parsePrice('$5')).toBe('5000000')
  })

  it('rejects a non-numeric price', () => {
    expect(() => parsePrice('$abc')).toThrow(/invalid price/)
  })

  // Minor 3 from review: the leading "$" was already optional by accident of
  // the regex. Pin it down as intentional, both forms parse the same way.
  it('treats the leading "$" as optional, not required', () => {
    expect(parsePrice('0.01')).toBe(parsePrice('$0.01'))
    expect(parsePrice('5')).toBe('5000000')
  })

  // Important finding from review: parsePrice used to floor anything past 6
  // fractional digits, so a nonzero configured price could silently become
  // free (parsePrice('$0.0000001') === '0' before this fix). It must now
  // reject rather than round, at exactly the boundary USDC can represent.
  describe('sub-atomic-unit prices (regression for silent truncation)', () => {
    it('accepts exactly 6 fractional digits at the smallest atomic unit', () => {
      expect(parsePrice('$0.000001')).toBe('1')
    })

    it('rejects 7 fractional digits instead of silently flooring to zero', () => {
      // Before the fix this returned '0' - a configured, nonzero price
      // silently became a free resource. It must now throw.
      expect(() => parsePrice('$0.0000001')).toThrow(/6/)
    })

    it('rejects a price that would floor to a materially different amount', () => {
      // Before the fix this returned '999999', one atomic unit below the
      // nearer '1000000' - a silent, wrong-amount charge either way.
      expect(() => parsePrice('$0.999999999')).toThrow(/6/)
    })
  })
})
