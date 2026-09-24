import { describe, it, expect } from 'vitest'
import { buildRequirements, parsePrice } from '../src/requirements.js'
import type { Anychain402Config } from '../src/types.js'

const config: Anychain402Config = {
  price: '$0.01',
  accept: ['base-sepolia', 'polygon-amoy'],
  settleTo: 'hedera',
  merchant: '0.0.123456',
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
      paymentId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    for (const r of reqs) {
      expect(r.extra?.merchant).toBe('0.0.123456')
      expect(r.extra?.paymentId).toBe(
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      )
    }
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
        paymentId: '0xdead' as `0x${string}`,
      }),
    ).toThrow(/paymentId/)
  })

  it('only ever emits networks from the supported set', () => {
    const reqs = buildRequirements(config, 'https://api.test/premium')
    const allowed = new Set(['base', 'base-sepolia', 'polygon', 'polygon-amoy'])
    for (const r of reqs) {
      expect(allowed.has(r.network)).toBe(true)
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
})
