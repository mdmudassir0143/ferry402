import { describe, it, expect, vi } from 'vitest'

/**
 * Isolated from journal.test.ts deliberately: this is the ONE test file in
 * this task that mocks `@hashgraph/sdk` at all, so every other test keeps
 * exercising the real (unmocked) module import path.
 *
 * `createHederaTopicSubmitter`'s NETWORK-CALLING behavior (a real
 * `execute`/`getReceipt` round trip against Hedera) genuinely cannot be
 * tested here -- there are no Hedera credentials available to this
 * environment (see the task-9 brief's "Credentials" section), and faking
 * that round trip would just be re-testing the fake. But the function
 * contains one PURE conditional that doesn't require a live account to
 * exercise: `receipt.topicSequenceNumber === null`. `vi.mock` replaces
 * `TopicMessageSubmitTransaction` with a fake that returns a receipt with a
 * null sequence number, with no network access at all, so this branch is
 * exercised honestly rather than left as an unverified `if`.
 */
vi.mock('@hashgraph/sdk', () => {
  class FakeTopicMessageSubmitTransaction {
    setTopicId() {
      return this
    }
    setMessage() {
      return this
    }
    async execute() {
      return {
        async getReceipt() {
          return { topicSequenceNumber: null }
        },
      }
    }
  }
  return { TopicMessageSubmitTransaction: FakeTopicMessageSubmitTransaction }
})

const { createHederaTopicSubmitter } = await import('../src/journal.js')

describe('createHederaTopicSubmitter', () => {
  it('throws when the receipt carries no topicSequenceNumber', async () => {
    // The fake client is never actually called by anything in this test --
    // `execute`/`getReceipt` above ignore their arguments entirely -- so an
    // empty object stands in for a real `Client` without needing one.
    const submitter = createHederaTopicSubmitter({} as never)

    await expect(submitter.submitMessage({ topicId: '0.0.9999', message: new Uint8Array([1, 2, 3]) })).rejects.toThrow(/topicSequenceNumber/)
  })
})
