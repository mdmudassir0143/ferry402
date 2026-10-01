/**
 * Shared on-chain constants — hand-written minimal ABIs (the demo only ever
 * reads `balanceOf` and the `PaymentSettled` event, the same minimal-ABI
 * convention every other package in this repo uses rather than pulling in a
 * full build artifact) and the Base Sepolia USDC deployment this whole repo
 * targets.
 */
import type { Address } from 'viem'

export const escrowReadAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'event',
    name: 'PaymentSettled',
    anonymous: false,
    inputs: [
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'bytes32', indexed: false },
    ],
  },
] as const

export const erc20BalanceAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

export const USDC_ADDRESS_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
export const USDC_NAME = 'USDC'
export const USDC_VERSION = '2'
export const BASE_SEPOLIA_CHAIN_ID = 84532
export const PRICE_ATOMIC_UNITS = '10000' // $0.01 at USDC's 6 decimals

export const MIRROR_NODE_BASE_URL = 'https://testnet.mirrornode.hedera.com'
