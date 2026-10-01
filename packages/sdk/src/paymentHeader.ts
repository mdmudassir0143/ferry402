import { computeNonce } from './nonce.js'
import type { PaymentRequirements } from './types.js'

/**
 * I5 (publish-blocking, final review): **no stock x402 client can pay a
 * ferry402 route.**
 *
 * Amendment 1 made the EIP-3009 authorization `nonce` a DERIVED value —
 * `keccak256(abi.encode(merchantEvm, paymentId))`, see `nonce.ts` — instead
 * of the random bytes `x402@1.2.0`'s own `createNonce()` generates. That is
 * the correct trade-off (a random nonce is exactly what let anyone redirect
 * a payment to a merchant they don't control; see the design doc's
 * Amendment 1), but it is also why upstream `x402` client helpers
 * (`x402-fetch`, `x402-axios`, or anything hand-rolled against
 * `x402/client`) cannot pay a ferry402 route: they sign whatever nonce they
 * mint themselves, `ferry402`'s `matchChallenge` never sees it match either
 * derivation candidate, and every attempt fails closed with
 * `invalid_payment` (0.2.0: no longer `payment_expired` — a stock client's
 * self-invented nonce is one of several indistinguishable mismatch causes,
 * not a known expiry; see `middleware.ts`'s `matchChallenge` failure
 * comment) — indistinguishable, from the client's side, from any other
 * rejected nonce.
 *
 * `createPaymentHeader` is the replacement: it derives the SAME nonce
 * `ferry402`'s middleware and `Escrow.settleAuthorization` derive, signs the
 * EIP-3009 `ReceiveWithAuthorization` struct against it, and returns the
 * base64 `X-PAYMENT` header value a merchant route accepts.
 *
 * This is a lift, not a reimplementation, of
 * `packages/facilitator/test/support/fixtures.ts`'s `signAuthorization` —
 * the one place in this codebase that has actually signed a real EIP-3009
 * authorization and had it accepted by real USDC (see
 * `packages/facilitator/test/e2e.test.ts`, Task 10's live Base Sepolia run).
 * `computeNonce` is likewise the existing, golden-vector-pinned
 * implementation (`nonce.ts`) — this file introduces no independent nonce
 * math. Three call sites already have to agree on this hash byte-for-byte
 * (`Escrow.sol`, `ferry402`'s middleware, a facilitator's `/verify`); a
 * payer-side client signing against a hand-rolled fourth would be exactly
 * the kind of divergent nonce site this codebase has spent the whole build
 * preventing.
 */

/**
 * The subset of a viem `Account`'s (`LocalAccount`/`PrivateKeyAccount`)
 * surface `createPaymentHeader` needs, expressed structurally rather than
 * imported from `viem` — this package has no runtime dependency on `viem`
 * and this interface exists so it doesn't need to acquire one just to name
 * a parameter type. Any viem account (`privateKeyToAccount(...)`, a
 * `walletClient`'s connected account, a hardware-wallet-backed account, ...)
 * satisfies this shape without adapting it: `signTypedData`'s parameter and
 * return shapes here are copied directly from viem's own `SignTypedDataParameters`
 * / `Hex` for that reason, not independently designed.
 */
export interface EIP3009Signer {
  /** The address whose authorization this signs — becomes
   *  `authorization.from` in the signed payload. Must be the address that
   *  actually holds the funds being authorized; nothing here checks that. */
  address: `0x${string}`
  signTypedData(parameters: {
    domain: {
      name: string
      version: string
      chainId: number
      verifyingContract: `0x${string}`
    }
    types: {
      ReceiveWithAuthorization: readonly [
        { name: 'from'; type: 'address' },
        { name: 'to'; type: 'address' },
        { name: 'value'; type: 'uint256' },
        { name: 'validAfter'; type: 'uint256' },
        { name: 'validBefore'; type: 'uint256' },
        { name: 'nonce'; type: 'bytes32' },
      ]
    }
    primaryType: 'ReceiveWithAuthorization'
    message: {
      from: `0x${string}`
      to: `0x${string}`
      value: bigint
      validAfter: bigint
      validBefore: bigint
      nonce: `0x${string}`
    }
  }): Promise<`0x${string}`>
}

/** The exact EIP-712 `types` entry every `ReceiveWithAuthorization` signer
 *  in this codebase signs against — copied from
 *  `packages/facilitator/test/support/fixtures.ts`'s
 *  `RECEIVE_WITH_AUTHORIZATION_TYPES` (itself matching EIP-3009 and real
 *  USDC's own `FiatTokenV2` ABI) so this file does not restate it with any
 *  chance of drifting a field name or type. */
const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ] as const,
} as const

export interface CreatePaymentHeaderOptions {
  /**
   * EIP-712 domain `name` of the asset named by `requirement.asset` (e.g.
   * `"USDC"` for Base Sepolia's official USDC deployment). Not derivable
   * from `PaymentRequirements` alone — x402's schema carries no EIP-712
   * domain fields, and a token's `name`/`version` are deployment-specific
   * (see `packages/facilitator/src/chains/base.ts`'s `getTokenDomain` doc
   * comment: USDC's domain `version` differs between deployments). Read it
   * once from the token contract's own `name()`, the same way this repo's
   * facilitator does, or from your deployment notes.
   */
  tokenName: string
  /** EIP-712 domain `version` of `requirement.asset` (e.g. `"2"`). See
   *  `tokenName`'s note — this is deployment-specific and cannot be
   *  assumed or hardcoded generically. */
  tokenVersion: string
  /**
   * EIP-712 domain `chainId` — the numeric EIP-155 chain id backing
   * `requirement.network` (e.g. `84532` for `"base-sepolia"`, `8453` for
   * `"base"`). x402's `network` is a string identifier, not the numeric id
   * EIP-712 signing requires, so this cannot be derived from `requirement`
   * alone either.
   */
  chainId: number
  /**
   * Authorization validity window start, in whole seconds since the Unix
   * epoch. Defaults to 60 seconds before now — the same clock-skew margin
   * `packages/facilitator/test/e2e.test.ts` signs against a real chain
   * with.
   */
  validAfter?: bigint
  /**
   * Authorization validity window end, in whole seconds since the Unix
   * epoch. Defaults to `requirement.maxTimeoutSeconds` seconds from now.
   */
  validBefore?: bigint
}

/**
 * Builds and signs a base64 `X-PAYMENT` header value for one entry of a
 * ferry402 402 response's `accepts` array.
 *
 * `requirement` MUST be a `PaymentRequirements` entry ferry402 itself
 * issued (i.e. one carrying `extra.merchantEvm` and `extra.paymentId` —
 * see `buildRequirements`/`ferry402`'s `issueChallenge`), not a hand-built
 * or generic upstream x402 requirement: the whole point of this function is
 * to derive the SAME nonce the issuing server will check for, and that
 * derivation's other input (`merchantEvm`) only travels inside `extra`.
 *
 * `signer` never has to be a real network-connected wallet — anything
 * satisfying `EIP3009Signer` (see its doc comment) works, most simply
 * viem's own `privateKeyToAccount(...)`. This function performs no network
 * I/O itself; the caller is responsible for actually sending the resulting
 * header (as `X-PAYMENT`) to the merchant route that issued `requirement`.
 *
 * @returns the base64-encoded `X-PAYMENT` header value — pass it straight
 *   through as `headers['X-PAYMENT']` on the retried request.
 */
export async function createPaymentHeader(
  requirement: PaymentRequirements,
  signer: EIP3009Signer,
  options: CreatePaymentHeaderOptions,
): Promise<string> {
  const merchantEvm = requirement.extra?.merchantEvm as `0x${string}` | undefined
  const paymentId = requirement.extra?.paymentId as `0x${string}` | undefined
  if (!merchantEvm || !paymentId) {
    throw new Error(
      'createPaymentHeader: requirement.extra.merchantEvm and requirement.extra.paymentId are ' +
        'both required. This must be a PaymentRequirements entry ferry402 itself issued (the ' +
        "`accepts` array of its 402 response) - a generic/upstream x402 requirement has no " +
        'way to name the merchant binding this payment must derive its nonce from.',
    )
  }

  // THE fix for I5: the nonce a stock x402 client would mint itself
  // (`createNonce()`, random bytes) is derived here instead, via the exact
  // same golden-vector-pinned function `Escrow.settleAuthorization` and
  // `ferry402`'s own middleware use - see this file's top-of-file doc
  // comment.
  const nonce = computeNonce(merchantEvm, paymentId)

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = options.validAfter ?? nowSeconds - 60n
  const validBefore = options.validBefore ?? nowSeconds + BigInt(requirement.maxTimeoutSeconds)

  const authorization = {
    from: signer.address,
    to: requirement.payTo as `0x${string}`,
    value: requirement.maxAmountRequired,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  }

  const signature = await signer.signTypedData({
    domain: {
      name: options.tokenName,
      version: options.tokenVersion,
      chainId: options.chainId,
      verifyingContract: requirement.asset as `0x${string}`,
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter,
      validBefore,
      nonce,
    },
  })

  const paymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: requirement.network,
    payload: { signature, authorization },
  }

  return Buffer.from(JSON.stringify(paymentPayload)).toString('base64')
}
