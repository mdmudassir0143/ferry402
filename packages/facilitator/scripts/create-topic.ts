/**
 * Task 10 — creates the live HCS journal topic on Hedera testnet, from the
 * operator account configured in `.env` (`HEDERA_ACCOUNT_ID` /
 * `HEDERA_PRIVATE_KEY`).
 *
 * Run once, by hand, against real Hedera testnet:
 *
 *   pnpm --filter @ferry402/facilitator exec tsx scripts/create-topic.ts
 *
 * Prints the new topic id (e.g. `0.0.xxxxxxx`) on success. The operator's
 * private key is read from the environment and never printed or logged.
 *
 * `HEDERA_PRIVATE_KEY` here is ECDSA, DER-encoded — loaded with
 * `PrivateKey.fromStringDer()`. Do NOT switch this to
 * `PrivateKey.fromStringED25519()`: that call does not throw on a
 * DER-encoded ECDSA key, it silently derives a different (wrong) key, and
 * the resulting `INVALID_SIGNATURE` at submit time gives no indication why.
 */
import { AccountId, Client, PrivateKey, TopicCreateTransaction } from '@hashgraph/sdk'

async function main() {
  const accountId = process.env.HEDERA_ACCOUNT_ID
  const privateKeyDer = process.env.HEDERA_PRIVATE_KEY
  if (!accountId || !privateKeyDer) {
    throw new Error('create-topic: HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY must both be set (see .env.example)')
  }

  const operatorId = AccountId.fromString(accountId)
  const operatorKey = PrivateKey.fromStringDer(privateKeyDer)

  const client = Client.forTestnet().setOperator(operatorId, operatorKey)

  try {
    const response = await new TopicCreateTransaction()
      .setTopicMemo('ferry402 journal (Task 10, live testnet)')
      .execute(client)
    const receipt = await response.getReceipt(client)
    const topicId = receipt.topicId
    if (!topicId) {
      throw new Error('create-topic: receipt carried no topicId')
    }
    console.log(`Created HCS topic: ${topicId.toString()}`)
    console.log(`Hashscan: https://hashscan.io/testnet/topic/${topicId.toString()}`)
  } finally {
    client.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
