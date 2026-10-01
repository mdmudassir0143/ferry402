/**
 * Hedera mirror-node read helpers, factored out of `run.ts` so `examples/demo`
 * and `examples/demo-ui` read the HCS journal back identically.
 */
import type { Address } from 'viem'
import { MIRROR_NODE_BASE_URL } from './constants.js'

// Mirror-node ingestion lags consensus by a few seconds in practice — polled
// for the same read-after-write reason as `pollBalanceOf`, per the task's
// own guidance to poll rather than paper over public-infra lag.
export async function fetchMirrorTopicMessage(
  topicId: string,
  sequenceNumber: number,
  { retries = 20, delayMs = 3_000 }: { retries?: number; delayMs?: number } = {},
): Promise<{ message: string; consensus_timestamp: string; sequence_number: number }> {
  const url = `${MIRROR_NODE_BASE_URL}/api/v1/topics/${topicId}/messages/${sequenceNumber}`
  let lastStatus = 0
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      return (await res.json()) as { message: string; consensus_timestamp: string; sequence_number: number }
    }
    lastStatus = res.status
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`topic ${topicId} sequence ${sequenceNumber} never indexed by the mirror node after ${retries} attempts (last status ${lastStatus})`)
}

/**
 * Sums every `type: 'payment'` journal entry for `merchantEvm` across the
 * WHOLE topic, read back from the mirror node — the "journal total" half of
 * the closing reconciliation line. Paginates via the mirror node's own
 * `links.next`, decoding each message as either a single entry (plain
 * object) or a batch (JSON array) — see `encodeEntries`'s doc comment in
 * packages/facilitator/src/journal.ts for why a message can be either shape.
 * Capped at a generous number of pages so a run can never hang on an
 * unexpectedly large topic.
 */
export async function sumJournalForMerchant(topicId: string, merchantEvm: Address, { maxPages = 50 }: { maxPages?: number } = {}): Promise<bigint> {
  let total = 0n
  let next: string | null = `/api/v1/topics/${topicId}/messages?limit=100&order=asc`
  for (let page = 0; next && page < maxPages; page++) {
    const res = await fetch(`${MIRROR_NODE_BASE_URL}${next}`)
    if (!res.ok) break
    const body = (await res.json()) as { messages: Array<{ message: string }>; links?: { next?: string | null } }
    for (const m of body.messages) {
      let decoded: unknown
      try {
        decoded = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8'))
      } catch {
        continue
      }
      const entries = Array.isArray(decoded) ? decoded : [decoded]
      for (const entry of entries) {
        const e = entry as { type?: string; merchantEvm?: string; amount?: string }
        if (e.type === 'payment' && typeof e.merchantEvm === 'string' && e.merchantEvm.toLowerCase() === merchantEvm.toLowerCase() && e.amount) {
          total += BigInt(e.amount)
        }
      }
    }
    next = body.links?.next ?? null
  }
  return total
}
