import { describe, it, expect } from 'vitest'
import {
  encodeEntry,
  encodeEntries,
  writeEntry,
  writeEntries,
  journalEntryForSettlement,
  HCS_MAX_MESSAGE_BYTES,
  type JournalEntry,
  type TopicSubmitter,
} from '../src/journal.js'
import type { SettleResult } from '../src/chains/base.js'

const MERCHANT: JournalEntry['merchant'] = '0.0.123456'
const MERCHANT_EVM: JournalEntry['merchantEvm'] = '0x1111111111111111111111111111111111111111'
const PAYER: JournalEntry['payer'] = '0x2222222222222222222222222222222222222222'
const TX_HASH = '0x3333333333333333333333333333333333333333333333333333333333333333'
const NONCE = '0x4444444444444444444444444444444444444444444444444444444444444444'

function sampleEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    v: 1,
    type: 'payment',
    merchant: MERCHANT,
    merchantEvm: MERCHANT_EVM,
    sourceChain: 'base-sepolia',
    asset: 'USDC',
    amount: '10000',
    payer: PAYER,
    txHash: TX_HASH,
    nonce: NONCE,
    ts: '2026-09-23T10:00:00Z',
    ...overrides,
  }
}

/** Records every call it receives instead of touching the network -- the
 *  fake this task's credential constraints require: there is no live Hedera
 *  account available to sign a real submit. */
function createFakeSubmitter(startSequence = 1): TopicSubmitter & { calls: Array<{ topicId: string; message: Uint8Array }> } {
  const calls: Array<{ topicId: string; message: Uint8Array }> = []
  let sequence = startSequence
  return {
    calls,
    async submitMessage({ topicId, message }) {
      calls.push({ topicId, message })
      return { topicId, sequenceNumber: sequence++ }
    },
  }
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes))
}

describe('encodeEntry', () => {
  it('encodes an entry within the HCS 1024-byte message limit', () => {
    const bytes = encodeEntry(sampleEntry())
    expect(bytes.byteLength).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES)
    expect(decode(bytes)).toEqual(sampleEntry())
  })

  it('rejects an entry missing its originating txHash', () => {
    expect(() => encodeEntry(sampleEntry({ txHash: '' }))).toThrow(/txHash/)
  })

  it('rejects an entry with an unsupported schema version', () => {
    expect(() => encodeEntry(sampleEntry({ v: 2 as 1 }))).toThrow(/v/)
  })

  it('rejects an entry with an entry type outside the four defined types', () => {
    expect(() => encodeEntry(sampleEntry({ type: 'refund' as JournalEntry['type'] }))).toThrow(/type/)
  })

  it('rejects an entry whose asset is not USDC', () => {
    expect(() => encodeEntry(sampleEntry({ asset: 'USDT' as 'USDC' }))).toThrow(/asset/)
  })

  // Amendment 3: `merchant` is the Hedera account id -- an EVM address here
  // is exactly the confusion the amendment documents happening once already
  // (a Hedera account id where the contract expected an address, or vice
  // versa). This is not merely "is it a non-empty string": a swapped pair
  // would pass a bare presence check and still be un-reconcilable.
  it('rejects an entry whose merchant is an EVM address instead of a Hedera account id', () => {
    expect(() => encodeEntry(sampleEntry({ merchant: MERCHANT_EVM }))).toThrow(/merchant/)
  })

  it('rejects an entry missing merchantEvm entirely', () => {
    expect(() => encodeEntry(sampleEntry({ merchantEvm: '' }))).toThrow(/merchantEvm/)
  })

  // Amendment 3, the other direction: a Hedera account id where an EVM
  // address is required.
  it('rejects an entry whose merchantEvm is a Hedera account id instead of an EVM address', () => {
    expect(() => encodeEntry(sampleEntry({ merchantEvm: MERCHANT }))).toThrow(/merchantEvm/)
  })

  it('rejects an entry whose amount is not a plain decimal integer string', () => {
    expect(() => encodeEntry(sampleEntry({ amount: '100.5' }))).toThrow(/amount/)
    expect(() => encodeEntry(sampleEntry({ amount: '-100' }))).toThrow(/amount/)
    expect(() => encodeEntry(sampleEntry({ amount: '1e5' }))).toThrow(/amount/)
    expect(() => encodeEntry(sampleEntry({ amount: '' }))).toThrow(/amount/)
  })

  it('rejects an entry whose payer is not a well-formed EVM address', () => {
    expect(() => encodeEntry(sampleEntry({ payer: 'not-an-address' }))).toThrow(/payer/)
  })

  it('rejects an entry whose nonce is not a bytes32 hex value', () => {
    expect(() => encodeEntry(sampleEntry({ nonce: '0x1234' }))).toThrow(/nonce/)
  })

  it('rejects an entry whose ts is not an ISO-8601 timestamp', () => {
    expect(() => encodeEntry(sampleEntry({ ts: 'September 23 2026' }))).toThrow(/ts/)
  })

  // Correction 3: an entry that cannot fit within the HCS message limit must
  // be rejected outright, never allowed through to a submit that would fail
  // at runtime. `sourceChain` is the one loosely-shaped field available to
  // inflate without tripping any OTHER validation rule first.
  it('rejects an entry that exceeds the 1024-byte HCS message limit', () => {
    const oversized = sampleEntry({ sourceChain: 'x'.repeat(2000) })
    expect(() => encodeEntry(oversized)).toThrow(/1024/)
  })
})

describe('encodeEntries (batching)', () => {
  it('packs multiple small entries into a single message when they fit', () => {
    const entries = [sampleEntry({ txHash: `${TX_HASH.slice(0, -1)}1` }), sampleEntry({ txHash: `${TX_HASH.slice(0, -1)}2` })]
    const messages = encodeEntries(entries)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.byteLength).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES)
    expect(decode(messages[0]!)).toEqual(entries)
  })

  it('splits into multiple messages, preserving order, when entries do not all fit in one', () => {
    // Padded so that two entries together fit under 1024 bytes but three do
    // not (verified independently: single ~480B, two ~963B, three ~1444B) --
    // this demonstrates genuine 2-per-message batching, not just one entry
    // per message.
    const entries = [0, 1, 2, 3].map((i) => sampleEntry({ txHash: `${TX_HASH.slice(0, -1)}${i}`, sourceChain: `chain-${i}-${'a'.repeat(80)}` }))
    const messages = encodeEntries(entries)
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message.byteLength).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES)
      expect(decode(message)).toHaveLength(2)
    }
    // Order is preserved across message boundaries.
    const flattened = messages.flatMap((message) => decode(message) as JournalEntry[])
    expect(flattened.map((e) => e.txHash)).toEqual(entries.map((e) => e.txHash))
  })

  it('throws when a single entry cannot fit within the limit even alone', () => {
    const hopeless = sampleEntry({ sourceChain: 'x'.repeat(2000) })
    expect(() => encodeEntries([hopeless])).toThrow(/1024/)
  })

  it('rejects an empty array', () => {
    expect(() => encodeEntries([])).toThrow(/at least one/i)
  })

  it('validates every entry before encoding any message (fails closed on the whole batch)', () => {
    const good = sampleEntry({ txHash: `${TX_HASH.slice(0, -1)}1` })
    const bad = sampleEntry({ txHash: '' })
    expect(() => encodeEntries([good, bad])).toThrow(/txHash/)
  })
})

describe('writeEntry', () => {
  it('submits the encoded entry to the injected submitter and returns its result', async () => {
    const submitter = createFakeSubmitter(7)
    const entry = sampleEntry()

    const result = await writeEntry(entry, { topicId: '0.0.9999', submitter })

    expect(result).toEqual({ topicId: '0.0.9999', sequenceNumber: 7 })
    expect(submitter.calls).toHaveLength(1)
    expect(submitter.calls[0]!.topicId).toBe('0.0.9999')
    expect(decode(submitter.calls[0]!.message)).toEqual(entry)
  })

  it('never calls the submitter for an entry that fails validation', async () => {
    const submitter = createFakeSubmitter()
    const invalid = sampleEntry({ txHash: '' })

    await expect(writeEntry(invalid, { topicId: '0.0.9999', submitter })).rejects.toThrow(/txHash/)
    expect(submitter.calls).toHaveLength(0)
  })
})

describe('writeEntries', () => {
  it('submits one message per batch, in order, and returns one result per message', async () => {
    const submitter = createFakeSubmitter(100)
    const entries = [0, 1, 2, 3].map((i) => sampleEntry({ txHash: `${TX_HASH.slice(0, -1)}${i}`, sourceChain: `chain-${i}-${'a'.repeat(80)}` }))

    const results = await writeEntries(entries, { topicId: '0.0.8888', submitter })

    expect(submitter.calls).toHaveLength(2)
    expect(results).toHaveLength(submitter.calls.length)
    expect(results.map((r) => r.sequenceNumber)).toEqual(submitter.calls.map((_, i) => 100 + i))
    const flattened = submitter.calls.flatMap((call) => decode(call.message) as JournalEntry[])
    expect(flattened.map((e) => e.txHash)).toEqual(entries.map((e) => e.txHash))
  })

  it('never calls the submitter at all if any entry in the batch is invalid', async () => {
    const submitter = createFakeSubmitter()
    const entries = [sampleEntry({ txHash: `${TX_HASH.slice(0, -1)}1` }), sampleEntry({ txHash: '' })]

    await expect(writeEntries(entries, { topicId: '0.0.8888', submitter })).rejects.toThrow(/txHash/)
    expect(submitter.calls).toHaveLength(0)
  })
})

describe('journalEntryForSettlement', () => {
  function successfulSettlement(overrides: Partial<SettleResult> = {}): SettleResult {
    return {
      success: true,
      payer: PAYER,
      transaction: TX_HASH,
      network: 'base-sepolia',
      settledAmount: 9_900n,
      nonce: NONCE as SettleResult['nonce'],
      ...overrides,
    }
  }

  it('records the OBSERVED settledAmount, never a requested amount', () => {
    // 9_900n stands in for a fee-on-transfer token's observed credit, which
    // this test deliberately makes DIFFERENT from any "requested" figure
    // (e.g. a hypothetical maxAmountRequired of 10_000) that a regression
    // might accidentally substitute -- SettleResult carries no such field at
    // all, but this pins the actual value recorded rather than merely its
    // presence.
    const entry = journalEntryForSettlement({
      merchant: MERCHANT,
      merchantEvm: MERCHANT_EVM,
      sourceChain: 'base-sepolia',
      settlement: successfulSettlement(),
      ts: '2026-09-23T10:00:00Z',
    })

    expect(entry.amount).toBe('9900')
    expect(entry.nonce).toBe(NONCE)
    expect(entry.txHash).toBe(TX_HASH)
    expect(entry.payer).toBe(PAYER)
    expect(entry.type).toBe('payment')
    expect(entry.merchant).toBe(MERCHANT)
    expect(entry.merchantEvm).toBe(MERCHANT_EVM)
    // Round-trips through the encoder/size bound too.
    expect(() => encodeEntry(entry)).not.toThrow()
  })

  it('throws when given a failed settlement (no settledAmount/nonce)', () => {
    const failed: SettleResult = {
      success: false,
      errorReason: 'unexpected_settle_error',
      payer: PAYER,
      transaction: '',
      network: 'base-sepolia',
    }

    expect(() =>
      journalEntryForSettlement({
        merchant: MERCHANT,
        merchantEvm: MERCHANT_EVM,
        sourceChain: 'base-sepolia',
        settlement: failed,
      }),
    ).toThrow(/settledAmount|nonce/)
  })

  it('defaults ts to the current time when not provided', () => {
    const before = Date.now()
    const entry = journalEntryForSettlement({
      merchant: MERCHANT,
      merchantEvm: MERCHANT_EVM,
      sourceChain: 'base-sepolia',
      settlement: successfulSettlement(),
    })
    const after = Date.now()
    const parsed = Date.parse(entry.ts)
    expect(parsed).toBeGreaterThanOrEqual(before)
    expect(parsed).toBeLessThanOrEqual(after)
  })
})
