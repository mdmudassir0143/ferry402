// Auto-generated from packages/facilitator/test/fixtures/SettleToken.sol via:
//   solc --optimize --combined-json abi,bin test/fixtures/SettleToken.sol
// (solc 0.8.37, matching packages/contracts/foundry.toml's pinned version),
// then extracted here so settle.fork.test.ts only needs `anvil` at runtime,
// not `solc`/`forge` -- mirrors the pattern used by DomainToken.abi.ts and
// Escrow.abi.ts in this same directory. Regenerate the same way if
// SettleToken.sol changes.
export const settleTokenAbi = [
  {
    "inputs": [],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AuthorizationAlreadyUsed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AuthorizationExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AuthorizationNotYetValid",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotPayee",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSignature",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSignatureSValue",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSignatureVValue",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TokenInsufficientBalance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TransferToZeroAddress",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "authorizer",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "nonce",
        "type": "bytes32"
      }
    ],
    "name": "AuthorizationUsed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "value",
        "type": "uint256"
      }
    ],
    "name": "Transfer",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "DOMAIN_SEPARATOR",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "RECEIVE_WITH_AUTHORIZATION_TYPEHASH",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "authorizer",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "nonce",
        "type": "bytes32"
      }
    ],
    "name": "authorizationState",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "balanceOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "mint",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "name",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
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
    "name": "receiveAuthorizationDigest",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
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
      },
      {
        "internalType": "uint8",
        "name": "v",
        "type": "uint8"
      },
      {
        "internalType": "bytes32",
        "name": "r",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "s",
        "type": "bytes32"
      }
    ],
    "name": "receiveWithAuthorization",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "transfer",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "version",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const

export const settleTokenBytecode = '0x60a060405234801561000f575f5ffd5b50604080518082018252600b81526a29b2ba3a3632aa37b5b2b760a91b6020918201528151808301835260018152603160f81b9082015281517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f918101919091527f9fc10f0abf80bc565f0cf5521517afd1679d4177cc45676baac6ad45bd7fc270918101919091527fc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc660608201524660808201523060a082015260c00160408051601f19818403018152919052805160209091012060805260805161088f6101075f395f8181610109015261034d015261088f5ff3fe608060405234801561000f575f5ffd5b50600436106100a6575f3560e01c806370a082311161006e57806370a082311461016e5780637f2eecc314610196578063a9059cbb146101bd578063acabfdec146101e0578063e94a0102146101f3578063ef55bec61461022b575f5ffd5b806306fdde03146100aa578063313ce567146100ea5780633644e5151461010457806340c10f191461013957806354fd4d501461014e575b5f5ffd5b6100d46040518060400160405280600b81526020016a29b2ba3a3632aa37b5b2b760a91b81525081565b6040516100e191906106cf565b60405180910390f35b6100f2600681565b60405160ff90911681526020016100e1565b61012b7f000000000000000000000000000000000000000000000000000000000000000081565b6040519081526020016100e1565b61014c61014736600461071f565b61023e565b005b6100d4604051806040016040528060018152602001603160f81b81525081565b61012b61017c366004610747565b6001600160a01b03165f9081526020819052604090205490565b61012b7fd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de881565b6101d06101cb36600461071f565b6102ae565b60405190151581526020016100e1565b61012b6101ee366004610767565b6102c4565b6101d061020136600461071f565b6001600160a01b03919091165f908152600160209081526040808320938352929052205460ff1690565b61014c6102393660046107b8565b610396565b6001600160a01b0382165f908152602081905260408120805483929061026590849061083a565b90915550506040518181526001600160a01b038316905f907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9060200160405180910390a35050565b5f6102ba3384846105df565b5060015b92915050565b604080517fd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de86020808301919091526001600160a01b0398891682840152969097166060880152608087019490945260a086019290925260c085015260e080850191909152815180850390910181526101008401825280519083012061190160f01b6101208501527f000000000000000000000000000000000000000000000000000000000000000061012285015261014280850191909152815180850390910181526101629093019052815191012090565b336001600160a01b038916146103bf57604051630476d41960e01b815260040160405180910390fd5b8542116103df57604051636fc721b960e11b815260040160405180910390fd5b8442106103ff57604051630f05f5bf60e01b815260040160405180910390fd5b6001600160a01b0389165f90815260016020908152604080832087845290915290205460ff161561044357604051634a8478f960e11b815260040160405180910390fd5b7f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08111156104845760405163185f3d1d60e21b815260040160405180910390fd5b8260ff16601b1415801561049c57508260ff16601c14155b156104ba5760405163449f5db160e01b815260040160405180910390fd5b5f6104c98a8a8a8a8a8a6102c4565b604080515f8082526020820180845284905260ff88169282019290925260608101869052608081018590529192509060019060a0016020604051602081039080840390855afa15801561051e573d5f5f3e3d5ffd5b5050604051601f1901519150506001600160a01b038116158061055357508a6001600160a01b0316816001600160a01b031614155b1561057157604051638baa579f60e01b815260040160405180910390fd5b6001600160a01b038b165f8181526001602081815260408084208b8552909152808320805460ff1916909217909155518892917f98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a591a36105d28b8b8b6105df565b5050505050505050505050565b6001600160a01b03821661060657604051633a954ecd60e21b815260040160405180910390fd5b6001600160a01b0383165f908152602081905260409020548181101561063f57604051631de6a8f360e11b815260040160405180910390fd5b6001600160a01b038085165f9081526020819052604080822085850390559185168152908120805484929061067590849061083a565b92505081905550826001600160a01b0316846001600160a01b03167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef846040516106c191815260200190565b60405180910390a350505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b038116811461071a575f5ffd5b919050565b5f5f60408385031215610730575f5ffd5b61073983610704565b946020939093013593505050565b5f60208284031215610757575f5ffd5b61076082610704565b9392505050565b5f5f5f5f5f5f60c0878903121561077c575f5ffd5b61078587610704565b955061079360208801610704565b95989597505050506040840135936060810135936080820135935060a0909101359150565b5f5f5f5f5f5f5f5f5f6101208a8c0312156107d1575f5ffd5b6107da8a610704565b98506107e860208b01610704565b975060408a0135965060608a0135955060808a0135945060a08a0135935060c08a013560ff81168114610819575f5ffd5b989b979a50959894979396929550929360e081013593506101000135919050565b808201808211156102be57634e487b7160e01b5f52601160045260245ffdfea26469706673582212204cba19bccd2c27ca582ff418345bd1faca71d0c8f1bc98746a0f4ee936ed029064736f6c63430008250033' as `0x${string}`
