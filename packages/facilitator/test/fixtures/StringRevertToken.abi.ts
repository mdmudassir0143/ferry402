// Auto-generated from packages/facilitator/test/fixtures/StringRevertToken.sol via:
//   solc --optimize --combined-json abi,bin test/fixtures/StringRevertToken.sol
// (solc 0.8.37), then extracted here so settle.fork.test.ts only needs
// `anvil` at runtime, not `solc`. Regenerate the same way if
// StringRevertToken.sol changes.
export const stringRevertTokenAbi = [
  {
    "inputs": [],
    "stateMutability": "nonpayable",
    "type": "constructor"
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

export const stringRevertTokenBytecode = '0x60a060405234801561000f575f5ffd5b50604080518082018252601181527029ba3934b733a932bb32b93a2a37b5b2b760791b6020918201528151808301835260018152603160f81b9082015281517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f918101919091527fac2313d7e46180acbf5b03893a528792461f36c122d233b4f85635fff3ce0017918101919091527fc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc660608201524660808201523060a082015260c00160408051601f198184030181529190528051602090910120608052608051610acd61010d5f395f818161010f01526103530152610acd5ff3fe608060405234801561000f575f5ffd5b50600436106100a6575f3560e01c806370a082311161006e57806370a08231146101745780637f2eecc31461019c578063a9059cbb146101c3578063acabfdec146101e6578063e94a0102146101f9578063ef55bec614610231575f5ffd5b806306fdde03146100aa578063313ce567146100f05780633644e5151461010a57806340c10f191461013f57806354fd4d5014610154575b5f5ffd5b6100da6040518060400160405280601181526020017029ba3934b733a932bb32b93a2a37b5b2b760791b81525081565b6040516100e7919061090d565b60405180910390f35b6100f8600681565b60405160ff90911681526020016100e7565b6101317f000000000000000000000000000000000000000000000000000000000000000081565b6040519081526020016100e7565b61015261014d36600461095d565b610244565b005b6100da604051806040016040528060018152602001603160f81b81525081565b610131610182366004610985565b6001600160a01b03165f9081526020819052604090205490565b6101317fd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de881565b6101d66101d136600461095d565b6102b4565b60405190151581526020016100e7565b6101316101f43660046109a5565b6102ca565b6101d661020736600461095d565b6001600160a01b03919091165f908152600160209081526040808320938352929052205460ff1690565b61015261023f3660046109f6565b61039c565b6001600160a01b0382165f908152602081905260408120805483929061026b908490610a78565b90915550506040518181526001600160a01b038316905f907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9060200160405180910390a35050565b5f6102c0338484610798565b5060015b92915050565b604080517fd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de86020808301919091526001600160a01b0398891682840152969097166060880152608087019490945260a086019290925260c085015260e080850191909152815180850390910181526101008401825280519083012061190160f01b6101208501527f000000000000000000000000000000000000000000000000000000000000000061012285015261014280850191909152815180850390910181526101629093019052815191012090565b336001600160a01b038916146104075760405162461bcd60e51b815260206004820152602560248201527f46696174546f6b656e56323a2063616c6c6572206d7573742062652074686520604482015264706179656560d81b60648201526084015b60405180910390fd5b85421161046a5760405162461bcd60e51b815260206004820152602b60248201527f46696174546f6b656e56323a20617574686f72697a6174696f6e206973206e6f60448201526a1d081e595d081d985b1a5960aa1b60648201526084016103fe565b8442106104c75760405162461bcd60e51b815260206004820152602560248201527f46696174546f6b656e56323a20617574686f72697a6174696f6e2069732065786044820152641c1a5c995960da1b60648201526084016103fe565b6001600160a01b0389165f90815260016020908152604080832087845290915290205460ff16156105515760405162461bcd60e51b815260206004820152602e60248201527f46696174546f6b656e56323a20617574686f72697a6174696f6e20697320757360448201526d1959081bdc8818d85b98d95b195960921b60648201526084016103fe565b7f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08111156105d25760405162461bcd60e51b815260206004820152602860248201527f46696174546f6b656e56323a20696e76616c6964207369676e6174757265202760448201526773272076616c756560c01b60648201526084016103fe565b8260ff16601b14806105e757508260ff16601c145b6106445760405162461bcd60e51b815260206004820152602860248201527f46696174546f6b656e56323a20696e76616c6964207369676e6174757265202760448201526776272076616c756560c01b60648201526084016103fe565b5f6106538a8a8a8a8a8a6102ca565b604080515f8082526020820180845284905260ff88169282019290925260608101869052608081018590529192509060019060a0016020604051602081039080840390855afa1580156106a8573d5f5f3e3d5ffd5b5050604051601f1901519150506001600160a01b038116158015906106de57508a6001600160a01b0316816001600160a01b0316145b61072a5760405162461bcd60e51b815260206004820152601e60248201527f46696174546f6b656e56323a20696e76616c6964207369676e6174757265000060448201526064016103fe565b6001600160a01b038b165f8181526001602081815260408084208b8552909152808320805460ff1916909217909155518892917f98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a591a361078b8b8b8b610798565b5050505050505050505050565b6001600160a01b0382166108005760405162461bcd60e51b815260206004820152602960248201527f46696174546f6b656e56323a207472616e7366657220746f20746865207a65726044820152686f206164647265737360b81b60648201526084016103fe565b6001600160a01b0383165f908152602081905260409020548181101561087d5760405162461bcd60e51b815260206004820152602c60248201527f46696174546f6b656e56323a207472616e7366657220616d6f756e742065786360448201526b656564732062616c616e636560a01b60648201526084016103fe565b6001600160a01b038085165f908152602081905260408082208585039055918516815290812080548492906108b3908490610a78565b92505081905550826001600160a01b0316846001600160a01b03167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef846040516108ff91815260200190565b60405180910390a350505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b0381168114610958575f5ffd5b919050565b5f5f6040838503121561096e575f5ffd5b61097783610942565b946020939093013593505050565b5f60208284031215610995575f5ffd5b61099e82610942565b9392505050565b5f5f5f5f5f5f60c087890312156109ba575f5ffd5b6109c387610942565b95506109d160208801610942565b95989597505050506040840135936060810135936080820135935060a0909101359150565b5f5f5f5f5f5f5f5f5f6101208a8c031215610a0f575f5ffd5b610a188a610942565b9850610a2660208b01610942565b975060408a0135965060608a0135955060808a0135945060a08a0135935060c08a013560ff81168114610a57575f5ffd5b989b979a50959894979396929550929360e081013593506101000135919050565b808201808211156102c457634e487b7160e01b5f52601160045260245ffdfea2646970667358221220021ce1415a1782d44aafabc850f3790ad29ddfdf9f471ce21b2ce18946378b3e64736f6c63430008250033' as `0x${string}`
