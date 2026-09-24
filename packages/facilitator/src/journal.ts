import { TopicMessageSubmitTransaction, type Client } from '@hashgraph/sdk'
import type { SettleResult } from './chains/base.js'

/**
 * Task 9 — the HCS journal writer.
 *
 * The brief this file was scaffolded from specified a `JournalEntry` schema
 * that predates two spec amendments (see
 * `docs/superpowers/specs/2026-09-23-anychain402-design.md`). Both are
 * load-bearing here, not cosmetic:
 *
 * - **Amendment 3** (merchant identity is two identifiers, not one): the
 *   Hedera clearing layer keys on a Hedera account id (`merchant`), but the
 *   `Escrow` ledger row this journal is reconciling against is keyed by a
 *   per-chain EVM address. A journal entry carrying only one identity cannot
 *   be joined back to the escrow it came from — see `merchantEvm` below.
 * - **Amendment 2** (credit the observed delta): `Escrow` credits
 *   `balanceOf(after) - balanceOf(before)`, not the amount the payer's
 *   authorization requested — they can differ under a fee-on-transfer token.
 *   This module never derives `amount` from an authorization; it only
 *   accepts it as the pre-computed `settledAmount` on a successful
 *   `SettleResult` (see `journalEntryForSettlement`), which is itself sourced
 *   from the verified `PaymentSettled` log (see `chains/base.ts`).
 */

export type JournalEntryType = 'payment' | 'withdrawal' | 'statement' | 'consolidation'

const JOURNAL_ENTRY_TYPES: ReadonlySet<string> = new Set<JournalEntryType>(['payment', 'withdrawal', 'statement', 'consolidation'])

/**
 * One immutable record written to the HCS journal topic. Every field is a
 * `string` (even numeric ones) deliberately: HCS messages are opaque bytes,
 * and round-tripping through JSON is simplest when nothing needs
 * bigint-vs-number reconciliation on the read side (a mirror-node consumer,
 * per Task 10).
 */
export interface JournalEntry {
  v: 1
  type: JournalEntryType
  /** The Hedera account id this journal — and `SettlementLedger` — key on,
   *  e.g. `"0.0.123456"`. NEVER the EVM address; see `merchantEvm`. */
  merchant: string
  /**
   * The merchant's EVM address on `sourceChain` — the key of the `Escrow`
   * ledger row this entry reconciles against, and the account
   * `Escrow.withdraw` pays out to. Added by Amendment 3: without this, a
   * journal entry cannot be joined back to the on-chain event that produced
   * it, because the two systems key on two different identifiers for the
   * same merchant.
   */
  merchantEvm: string
  sourceChain: string
  asset: 'USDC'
  /**
   * The OBSERVED on-chain credit, as a non-negative decimal integer string
   * (atomic units, e.g. USDC's 6 decimals) — `Escrow`'s own
   * `PaymentSettled.value`, never the amount requested by an authorization.
   * See this module's doc comment (Amendment 2) and `journalEntryForSettlement`.
   */
  amount: string
  /** The payer's EVM address. */
  payer: string
  /** The originating transaction hash on `sourceChain` — what makes this
   *  topic an auditable join between chain state and ledger state. Required:
   *  an entry with no originating transaction proves nothing. */
  txHash: string
  /** The EIP-3009 authorization nonce this entry settled (bytes32 hex). */
  nonce: string
  /** ISO-8601 UTC timestamp, e.g. `"2026-09-23T10:00:00Z"`. */
  ts: string
}

/**
 * `ConsensusSubmitMessage`'s hard limit. Entries must fit within this on
 * their own (see `encodeEntry`) and batches must never exceed it either (see
 * `encodeEntries`) — there is no server-side fallback for an oversized
 * message; the intent is to catch this HERE, before a submit is ever
 * attempted, per this task's Correction 3.
 */
export const HCS_MAX_MESSAGE_BYTES = 1024

const HEDERA_ACCOUNT_ID_RE = /^\d+\.\d+\.\d+$/
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/
const TX_HASH_RE = /^0x[0-9a-fA-F]+$/
const DECIMAL_STRING_RE = /^\d+$/
// Deliberately requires the `T` separator and an explicit `Z`/offset -- a
// plain `Date.parse` accepts far looser strings (e.g. "Sept 23 2026") that
// would still round-trip through JSON but are not the ISO-8601 shape every
// entry in the brief's own example uses.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function fail(field: string, reason: string): never {
  throw new Error(`JournalEntry: ${reason} (field "${field}")`)
}

function requireMatch(entry: JournalEntry, field: keyof JournalEntry, pattern: RegExp, description: string): void {
  const value = entry[field]
  if (typeof value !== 'string' || value.length === 0) {
    fail(field, `missing required field "${field}"`)
  }
  if (!pattern.test(value)) {
    fail(field, `expected ${description}, got ${JSON.stringify(value)}`)
  }
}

/**
 * Validates every required field of a `JournalEntry`, independent of size.
 * Throws a descriptive `Error` (naming the offending field) on the first
 * failure; never mutates `entry`. Exported so `encodeEntries` can validate
 * every member of a batch up front, before encoding or submitting ANY of
 * them (fail-closed: a batch either commits entirely valid, or nothing is
 * even encoded).
 */
export function validateJournalEntry(entry: JournalEntry): void {
  if (entry.v !== 1) {
    fail('v', `unsupported schema version ${JSON.stringify(entry.v)}, expected 1`)
  }
  if (!JOURNAL_ENTRY_TYPES.has(entry.type)) {
    fail('type', `unsupported entry type ${JSON.stringify(entry.type)}`)
  }
  // Amendment 3: `merchant` and `merchantEvm` are two DIFFERENT identifiers
  // for the same merchant, in two different shapes -- validating each
  // against the OTHER's shape (not just "is a non-empty string") is what
  // catches the exact confusion Amendment 3 documents happening once already
  // (a Hedera account id passed where an EVM address was required, or vice
  // versa), rather than silently journaling a swapped pair that can never be
  // reconciled against either chain.
  requireMatch(entry, 'merchant', HEDERA_ACCOUNT_ID_RE, 'a Hedera account id ("shard.realm.num", e.g. "0.0.123456")')
  requireMatch(entry, 'merchantEvm', EVM_ADDRESS_RE, 'a 20-byte EVM address ("0x" + 40 hex chars)')
  if (typeof entry.sourceChain !== 'string' || entry.sourceChain.length === 0) {
    fail('sourceChain', 'missing required field "sourceChain"')
  }
  if (entry.asset !== 'USDC') {
    fail('asset', `unsupported asset ${JSON.stringify(entry.asset)}, expected "USDC"`)
  }
  // Amendment 2: `amount` is validated as a bare non-negative decimal
  // integer string -- the same shape as the OBSERVED on-chain delta
  // `journalEntryForSettlement` sources from `SettleResult.settledAmount`,
  // never a value that could carry a sign, a decimal point, or exponent
  // notation the way an unchecked `auth.value` echo might.
  requireMatch(entry, 'amount', DECIMAL_STRING_RE, 'a non-negative decimal integer string')
  requireMatch(entry, 'payer', EVM_ADDRESS_RE, 'a 20-byte EVM address ("0x" + 40 hex chars)')
  // Loosely shaped ("0x" + at least one hex char, no fixed length) rather
  // than a fixed 32-byte regex: unlike `nonce` (always this contract's
  // bytes32), `txHash` is whatever `sourceChain`'s own transaction hash
  // format is, so only "present, and hex" is safe to assume generically. The
  // one property that MUST hold -- and the one this task's own required test
  // exercises -- is that it is never empty: an entry with no originating
  // transaction hash proves nothing about chain state.
  requireMatch(entry, 'txHash', TX_HASH_RE, 'a non-empty "0x"-prefixed hex string')
  requireMatch(entry, 'nonce', NONCE_RE, 'a bytes32 hex value ("0x" + 64 hex chars)')
  requireMatch(entry, 'ts', ISO_TIMESTAMP_RE, 'an ISO-8601 UTC timestamp (e.g. "2026-09-23T10:00:00Z")')
}

/**
 * Validates `entry`, JSON-encodes it, and enforces the HCS 1024-byte message
 * limit. Throws (rather than truncating or silently succeeding) on either a
 * validation failure or an oversized encoding -- see Correction 3: a single
 * entry that doesn't fit cannot be meaningfully chunked (it's one JSON
 * object), so the only safe behavior is to reject it before a submit is ever
 * attempted, not let `TopicMessageSubmitTransaction` fail at runtime.
 */
export function encodeEntry(entry: JournalEntry): Uint8Array {
  validateJournalEntry(entry)
  const bytes = new TextEncoder().encode(JSON.stringify(entry))
  if (bytes.byteLength > HCS_MAX_MESSAGE_BYTES) {
    throw new Error(`JournalEntry: encoded entry is ${bytes.byteLength} bytes, exceeds the HCS message limit of ${HCS_MAX_MESSAGE_BYTES} bytes`)
  }
  return bytes
}

/**
 * Packs `entries` into as few HCS messages as possible while respecting the
 * 1024-byte limit, WITHOUT reordering them -- the journal's entire value is
 * an ORDERED record, so entries destined for the same topic must not be
 * shuffled across message boundaries to save a byte. Each returned
 * `Uint8Array` is a JSON ARRAY of one or more entries (deliberately distinct
 * from `encodeEntry`'s bare-object wire shape, so a mirror-node consumer can
 * tell a batched message from a single one just by checking
 * `Array.isArray(JSON.parse(...))`).
 *
 * Fails closed on the WHOLE batch, before encoding or submitting anything:
 * every entry is validated up front (so one bad entry deep in a large batch
 * never results in a partial submit), and any entry that cannot fit within
 * the limit EVEN ALONE is rejected outright -- per Correction 3, "reject or
 * chunk anything oversized rather than letting a submit fail at runtime";
 * a single `JournalEntry` is atomic JSON and cannot itself be chunked
 * further, so rejection is the only safe option at that point.
 */
export function encodeEntries(entries: readonly JournalEntry[]): Uint8Array[] {
  if (entries.length === 0) {
    throw new Error('encodeEntries: at least one entry is required')
  }
  for (const entry of entries) {
    validateJournalEntry(entry)
  }

  const encodeBatch = (batch: readonly JournalEntry[]): Uint8Array => new TextEncoder().encode(JSON.stringify(batch))

  const messages: Uint8Array[] = []
  let currentBatch: JournalEntry[] = []

  for (const entry of entries) {
    const candidate = [...currentBatch, entry]
    const candidateBytes = encodeBatch(candidate)
    if (candidateBytes.byteLength <= HCS_MAX_MESSAGE_BYTES) {
      currentBatch = candidate
      continue
    }
    if (currentBatch.length === 0) {
      // This single entry doesn't fit even alone in its own batch of one --
      // no amount of re-batching helps; it must be rejected outright.
      throw new Error(
        `encodeEntries: entry with txHash ${entry.txHash} is ${candidateBytes.byteLength} bytes even alone, exceeds the HCS message limit of ${HCS_MAX_MESSAGE_BYTES} bytes and cannot be chunked further`,
      )
    }
    messages.push(encodeBatch(currentBatch))
    currentBatch = [entry]
    const soloBytes = encodeBatch(currentBatch)
    if (soloBytes.byteLength > HCS_MAX_MESSAGE_BYTES) {
      throw new Error(
        `encodeEntries: entry with txHash ${entry.txHash} is ${soloBytes.byteLength} bytes even alone, exceeds the HCS message limit of ${HCS_MAX_MESSAGE_BYTES} bytes and cannot be chunked further`,
      )
    }
  }
  if (currentBatch.length > 0) {
    messages.push(encodeBatch(currentBatch))
  }
  return messages
}

// --- Submission -------------------------------------------------------------

/**
 * The seam between this module's (fully unit-testable, no network required)
 * validation/batching logic and the real Hedera network. Injected, never
 * constructed internally by `writeEntry`/`writeEntries` -- per this task's
 * credential constraints, there is no live Hedera account available to this
 * codebase right now, so the only honest way to test the orchestration below
 * is against a fake implementing this same interface. `createHederaTopicSubmitter`
 * is the real, `@hashgraph/sdk`-backed implementation; wiring it up against a
 * real topic and a real operator account is Task 10's job.
 */
export interface TopicSubmitter {
  submitMessage(params: { topicId: string; message: Uint8Array }): Promise<{ topicId: string; sequenceNumber: number }>
}

export interface WriteEntryOptions {
  /** The HCS topic every entry in this call is submitted to (Task 10's
   *  `HCS_TOPIC_ID`). */
  topicId: string
  submitter: TopicSubmitter
}

/**
 * Validates and encodes `entry`, then submits it as a single HCS message via
 * `options.submitter`. Validation (inside `encodeEntry`) runs BEFORE the
 * submitter is ever invoked -- an invalid entry must never reach the
 * network, let alone spend the ~$0.0008 `ConsensusSubmitMessage` cost.
 */
export async function writeEntry(entry: JournalEntry, options: WriteEntryOptions): Promise<{ topicId: string; sequenceNumber: number }> {
  const message = encodeEntry(entry)
  return options.submitter.submitMessage({ topicId: options.topicId, message })
}

/**
 * Batches `entries` (see `encodeEntries`) and submits one HCS message per
 * batch, in order. Every entry is validated before ANY message is submitted
 * (fail-closed across the whole call, not just the entry that happens to be
 * invalid) -- `encodeEntries` itself already guarantees this, since it
 * validates every entry before encoding the first message.
 *
 * Submitted sequentially, not concurrently: messages to the SAME topic are
 * meant to preserve the caller's entry order (the journal's whole value is
 * being an ORDERED record), and the real `TopicSubmitter` signs through one
 * Hedera operator account, so concurrent submission would race rather than
 * preserve order.
 */
export async function writeEntries(entries: readonly JournalEntry[], options: WriteEntryOptions): Promise<Array<{ topicId: string; sequenceNumber: number }>> {
  const messages = encodeEntries(entries)
  const results: Array<{ topicId: string; sequenceNumber: number }> = []
  for (const message of messages) {
    results.push(await options.submitter.submitMessage({ topicId: options.topicId, message }))
  }
  return results
}

// --- Building entries from a settlement -------------------------------------

export interface JournalEntryForSettlementInput {
  /** The Hedera account id -- the clearing-layer identity. */
  merchant: string
  /** The same merchant's EVM address on `sourceChain` -- see Amendment 3. */
  merchantEvm: string
  sourceChain: string
  /**
   * A SUCCESSFUL settlement's result. Deliberately typed as a `Pick` of only
   * the fields this function actually reads (never the whole `SettleResult`,
   * and never `PaymentPayload`/`PaymentRequirements`) -- there is no field
   * on this type through which an authorization's REQUESTED amount
   * (`auth.value`/`requirements.maxAmountRequired`) could reach `amount`
   * below even by accident. Only `settledAmount` -- the OBSERVED balance
   * delta `settlePayment` already extracted from the verified
   * `PaymentSettled` log -- and `nonce` are used (per Correction 2: do not
   * re-derive from the authorization, do not re-fetch the receipt).
   */
  settlement: Pick<SettleResult, 'settledAmount' | 'nonce' | 'transaction' | 'payer'>
  /** Defaults to `new Date().toISOString()`. Overridable for deterministic tests. */
  ts?: string
}

/**
 * Builds a `type: 'payment'` `JournalEntry` from a successful `SettleResult`.
 * Throws if `settlement` lacks `settledAmount`/`nonce` -- both are ONLY
 * present on `SettleResult` when `success` is true (see its doc comment in
 * `chains/base.ts`), so their absence means the caller is trying to journal
 * a settlement that never actually credited anyone.
 */
export function journalEntryForSettlement(input: JournalEntryForSettlementInput): JournalEntry {
  if (input.settlement.settledAmount === undefined || input.settlement.nonce === undefined) {
    throw new Error(
      'journalEntryForSettlement: settlement has no settledAmount/nonce -- only a SUCCESSFUL SettleResult (success: true) may be journaled as a payment',
    )
  }
  return {
    v: 1,
    type: 'payment',
    merchant: input.merchant,
    merchantEvm: input.merchantEvm,
    sourceChain: input.sourceChain,
    asset: 'USDC',
    // Amendment 2: the OBSERVED delta, sourced from the verified
    // `PaymentSettled` log via `settlePayment` -- never `auth.value`.
    amount: input.settlement.settledAmount.toString(),
    payer: input.settlement.payer,
    txHash: input.settlement.transaction,
    nonce: input.settlement.nonce,
    ts: input.ts ?? new Date().toISOString(),
  }
}

/**
 * The real, `@hashgraph/sdk`-backed `TopicSubmitter` (`@hashgraph/sdk` at
 * 2.81.0 -- see the package.json dependency this task pinned). Wraps exactly
 * the call the brief specifies:
 * `new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(bytes)`,
 * executed against the given, already-constructed `Client`.
 *
 * Deliberately UNTESTED by this task's own suite: every check above this
 * function is pure and network-free by construction specifically so it COULD
 * be unit-tested without credentials (see this task's brief). This function
 * is the opposite -- a thin wrapper whose only job is to call the real SDK,
 * which itself opens a gRPC channel and expects a funded operator account to
 * sign with. There are no Hedera credentials available to this codebase
 * right now (see the task brief's "Credentials" section), so proving this
 * function works end to end -- a real topic, a real submit, a real mirror
 * node query -- is explicitly Task 10's job, not this one's. `client` is
 * accepted as a parameter (never constructed from `process.env` internally)
 * so this function has exactly one responsibility: adapt `TopicSubmitter` to
 * the real SDK, not also decide how the operator is configured.
 */
export function createHederaTopicSubmitter(client: Client): TopicSubmitter {
  return {
    async submitMessage({ topicId, message }) {
      const response = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message).execute(client)
      const receipt = await response.getReceipt(client)
      if (receipt.topicSequenceNumber === null) {
        throw new Error(`createHederaTopicSubmitter: receipt for topic ${topicId} carried no topicSequenceNumber`)
      }
      return { topicId, sequenceNumber: receipt.topicSequenceNumber.toNumber() }
    },
  }
}
