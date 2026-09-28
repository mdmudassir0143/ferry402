// Auto-generated from packages/facilitator/test/fixtures/HostileEscrow.sol via
// `forge build` (Solc 0.8.37, via a throwaway copy under
// packages/contracts/test/ -- forge bundles the same solc, so this is
// equivalent to the bare `solc --optimize --combined-json abi,bin`
// invocation this file previously documented), then extracted here so
// settle.fork.test.ts only needs `anvil` at runtime, not `solc`/`forge`.
// Regenerate the same way if HostileEscrow.sol changes.
export const hostileEscrowAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "token_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleAuthorization",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct HostileEscrow.Authorization",
        "components": [
          {
            "name": "from",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "value",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validAfter",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validBefore",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "nonce",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "token",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "PaymentSettled",
    "inputs": [
      {
        "name": "merchant",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "payer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "nonce",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  }
] as const

export const hostileEscrowBytecode = '0x60a060405234801561000f575f5ffd5b50604051610473380380610473833981810160405281019061003191906100c9565b8073ffffffffffffffffffffffffffffffffffffffff1660808173ffffffffffffffffffffffffffffffffffffffff1681525050506100f4565b5f5ffd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6100988261006f565b9050919050565b6100a88161008e565b81146100b2575f5ffd5b50565b5f815190506100c38161009f565b92915050565b5f602082840312156100de576100dd61006b565b5b5f6100eb848285016100b5565b91505092915050565b60805161036761010c5f395f61012301526103675ff3fe608060405234801561000f575f5ffd5b5060043610610034575f3560e01c8063985ca1d314610038578063fc0c546a14610054575b5f5ffd5b610052600480360381019061004d919061022e565b610072565b005b61005c610121565b60405161006991906102ca565b60405180910390f35b3373ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167fde9bbe11ca36734d239ef1f1444b4becef4690725e5e3ad94d80c0f651b43e707fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f7b005b9cd47c82983c45628678e0a695fc1b271bdbd239daf91249ed55c2c7aa60405161011192919061030a565b60405180910390a3505050505050565b7f000000000000000000000000000000000000000000000000000000000000000081565b5f5ffd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f61017282610149565b9050919050565b61018281610168565b811461018c575f5ffd5b50565b5f8135905061019d81610179565b92915050565b5f819050919050565b6101b5816101a3565b81146101bf575f5ffd5b50565b5f813590506101d0816101ac565b92915050565b5f5ffd5b5f60c082840312156101ef576101ee6101d6565b5b81905092915050565b5f60ff82169050919050565b61020d816101f8565b8114610217575f5ffd5b50565b5f8135905061022881610204565b92915050565b5f5f5f5f5f5f610160878903121561024957610248610145565b5b5f61025689828a0161018f565b965050602061026789828a016101c2565b955050604061027889828a016101da565b94505061010061028a89828a0161021a565b93505061012061029c89828a016101c2565b9250506101406102ae89828a016101c2565b9150509295509295509295565b6102c481610168565b82525050565b5f6020820190506102dd5f8301846102bb565b92915050565b5f819050919050565b6102f5816102e3565b82525050565b610304816101a3565b82525050565b5f60408201905061031d5f8301856102ec565b61032a60208301846102fb565b939250505056fea264697066735822122083d169d194010a9689b002ebf0278e0665bf962bc217d1ff356581865b95efed64736f6c63430008250033' as `0x${string}`
