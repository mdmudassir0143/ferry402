// Auto-generated from packages/facilitator/test/fixtures/HostileEscrow.sol via:
//   solc --optimize --combined-json abi,bin test/fixtures/HostileEscrow.sol
// (solc 0.8.37), then extracted here so settle.fork.test.ts only needs
// `anvil` at runtime, not `solc`. Regenerate the same way if
// HostileEscrow.sol changes.
export const hostileEscrowAbi = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "merchant",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "payer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "nonce",
        "type": "bytes32"
      }
    ],
    "name": "PaymentSettled",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "from",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "to",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "value",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "validAfter",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "validBefore",
            "type": "uint256"
          },
          {
            "internalType": "bytes32",
            "name": "nonce",
            "type": "bytes32"
          }
        ],
        "internalType": "struct HostileEscrow.Authorization",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      },
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "settleAuthorization",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const

export const hostileEscrowBytecode = '0x6080604052348015600e575f5ffd5b5061015b8061001c5f395ff3fe608060405234801561000f575f5ffd5b5060043610610029575f3560e01c8063985ca1d31461002d575b5f5ffd5b61004061003b3660046100a7565b610042565b005b604080515f1981527f7b005b9cd47c82983c45628678e0a695fc1b271bdbd239daf91249ed55c2c7aa6020820152339182917fde9bbe11ca36734d239ef1f1444b4becef4690725e5e3ad94d80c0f651b43e70910160405180910390a3505050505050565b5f5f5f5f5f5f8688036101608112156100be575f5ffd5b87356001600160a01b03811681146100d4575f5ffd5b96506020880135955060c0603f19820112156100ee575f5ffd5b5060408701935061010087013560ff81168114610109575f5ffd5b959894975092956101208101359461014090910135935091505056fea2646970667358221220ad3a99a938a33f27d258a8feee6a495453203206d482b3f7bdee4499fc25b67664736f6c63430008250033' as `0x${string}`
