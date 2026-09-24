import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import type { PaymentPayload, PaymentRequirements } from 'x402/types'

/** Nothing listens here. Passed as `rpcUrl` for tests that must prove a
 *  check fails WITHOUT ever making a chain call — if the implementation
 *  regressed to read the domain before that check, the test would hang or
 *  reject on a connection error instead of resolving cleanly. */
export const UNREACHABLE_RPC_URL = 'http://127.0.0.1:1'

export const ESCROW_ADDRESS: Address = '0x2222222222222222222222222222222222222222'
export const OTHER_ADDRESS: Address = '0x9999999999999999999999999999999999999999'

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export interface AuthorizationFields {
  from: Address
  to: Address
  value: string
  validAfter: string
  validBefore: string
  nonce: Hex
}

export function buildRequirements(overrides: Partial<PaymentRequirements> & { asset: Address }): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '1000000',
    resource: 'https://example.com/paid-resource',
    description: 'a paid resource',
    mimeType: 'application/json',
    payTo: ESCROW_ADDRESS,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  }
}

export function buildPayload(params: { network: PaymentPayload['network']; signature: Hex; authorization: AuthorizationFields }): PaymentPayload {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: params.network,
    payload: {
      signature: params.signature,
      authorization: params.authorization,
    },
  }
}

/**
 * Signs a `ReceiveWithAuthorization` struct with the given private key over
 * the given token's domain, using viem's own EIP-712 signer (which
 * normalizes to low-s / v in {27,28} on its own -- the "happy path"
 * fixture this produces is never itself malleable; malleability is
 * introduced deliberately and separately in the tests that need it).
 */
export async function signAuthorization(params: {
  privateKey: Hex
  tokenAddress: Address
  tokenName: string
  tokenVersion: string
  chainId: number
  authorization: AuthorizationFields
}): Promise<Hex> {
  const account = privateKeyToAccount(params.privateKey)
  return account.signTypedData({
    domain: {
      name: params.tokenName,
      version: params.tokenVersion,
      chainId: params.chainId,
      verifyingContract: params.tokenAddress,
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: params.authorization.from,
      to: params.authorization.to,
      value: BigInt(params.authorization.value),
      validAfter: BigInt(params.authorization.validAfter),
      validBefore: BigInt(params.authorization.validBefore),
      nonce: params.authorization.nonce,
    },
  })
}

/**
 * Flips a low-s signature to its mathematically-equivalent high-s
 * ("malleable") counterpart: same message, same underlying key, a
 * DIFFERENT valid-per-raw-ecrecover signature that OpenZeppelin's
 * `ECDSA.recover` (and this verifier) must reject. `s' = n - s`,
 * `v' = 55 - v` (27<->28).
 */
export function flipToMalleable(signature: Hex): Hex {
  const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const r = signature.slice(2, 66)
  const s = BigInt(`0x${signature.slice(66, 130)}`)
  const v = Number.parseInt(signature.slice(130, 132), 16)
  const flippedS = (SECP256K1N - s).toString(16).padStart(64, '0')
  const flippedV = (55 - v).toString(16).padStart(2, '0')
  return `0x${r}${flippedS}${flippedV}` as Hex
}

/** Rewrites just the trailing recovery-id byte of a signature, e.g. to an
 *  out-of-range value like `0` or `1` (a raw yParity, not the {27,28} `v`
 *  OpenZeppelin's ECDSA -- and real USDC -- requires). */
export function withVByte(signature: Hex, v: number): Hex {
  return `${signature.slice(0, 130)}${v.toString(16).padStart(2, '0')}` as Hex
}
