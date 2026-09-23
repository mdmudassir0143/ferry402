# anychain402 — Plan 1: Base Vertical Slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer can wrap an Express route in one line and accept x402 USDC payment from Base, with funds landing in a non-custodial escrow and every payment journaled to Hedera Consensus Service.

**Architecture:** Payer signs an EIP-3009 authorization naming our `Escrow` contract on Base. Our middleware returns a 402 carrying an `accepts` array; the facilitator verifies the signature, serves the request, then redeems the authorization on-chain and writes a journal entry to an HCS topic. No bridge is involved.

**Tech Stack:** Foundry (Solidity 0.8.24), TypeScript 5.x, pnpm workspaces, Express, viem, `@hashgraph/sdk`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-anychain402-design.md`

## Global Constraints

- Node >= 20.18.3
- MIT licence on every package
- **No admin path may move merchant funds.** Any PR introducing one is rejected.
- USDC only in v1. No other assets.
- Authorization redemption uses **`receiveWithAuthorization`**, never
  `transferWithAuthorization` — see Task 2 rationale.
- HCS journal entries follow the v1 schema in the spec's Data Model section.
- No secrets committed. `.env` is gitignored; `.env.example` is checked in.
- Every task ends with a commit.

## Verified upstream facts (confirmed 2026-09-23 against `x402@1.2.0`)

These were checked by reading the package's type definitions, not documentation:

- `x402Response.accepts` is `ZodOptional<ZodArray<..., "many">>` — **multiple
  payment options per 402 response are supported.** The core design assumption holds.
- `PaymentRequirements` = `{ scheme: "exact", network, maxAmountRequired, resource,
  description, mimeType, outputSchema?, payTo, maxTimeoutSeconds, asset, extra? }`
- `ExactEvmPayloadAuthorization` = `{ from, to, value, validAfter, validBefore, nonce }`
  — this is exactly the EIP-3009 authorization tuple.
- `VerifyResponse` = `{ isValid, invalidReason?, payer }`
- `SettleResponse` = `{ success, errorReason?, payer, transaction, network }`
- `x402-express` exports `paymentMiddleware(payTo, routes, facilitator?, paywall?)`
  — it takes **one** `payTo`, which is why we cannot reuse it directly: multi-chain
  acceptance needs a different escrow address per network.
- The `network` enum contains `base`, `base-sepolia`, `polygon`, `polygon-amoy`,
  `solana`, `avalanche`, `sei`, `abstract`, `iotex`, `peaq`, `story`, `educhain`,
  `skale-base-sepolia`. **It does not contain Arbitrum, Ethereum, Optimism or Hedera.**

**Consequence for scope:** Arbitrum cannot be advertised in `accepts` without
extending the upstream enum. Plan 3 must resolve this before adding Arbitrum.
Hedera's absence is harmless — in our architecture Hedera is the clearing layer,
never an x402 payment network.

---

## File Structure

```
packages/
  contracts/                  Foundry
    src/Escrow.sol            per-source-chain escrow; holds merchant balances
    src/interfaces/IEIP3009.sol
    test/Escrow.t.sol         unit + invariant + fuzz
    foundry.toml
  sdk/                        the product developers install
    src/index.ts              public exports
    src/middleware.ts         Express middleware; emits multi-entry accepts
    src/requirements.ts       builds PaymentRequirements[] from config
    src/types.ts              Anychain402Config and friends
    test/*.test.ts
  facilitator/
    src/server.ts             Express app: /verify, /settle
    src/chains/base.ts        Base adapter: verify sig, redeem authorization
    src/journal.ts            HCS journal writer
    test/*.test.ts
```

One responsibility per file. `requirements.ts` is pure and therefore trivially
testable; `middleware.ts` handles HTTP only; chain-specific logic never leaks
outside `chains/`.

---

## Task 1: Monorepo skeleton and toolchain

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`
- Create: `packages/contracts/foundry.toml`
- Create: `.github/workflows/ci.yaml`

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm -r test` and `forge test` both run green on an empty suite

- [ ] **Step 1: Initialise the workspace**

```bash
mkdir -p packages/{contracts,sdk,facilitator}
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - 'packages/*'
EOF
```

- [ ] **Step 2: Root package.json**

```json
{
  "name": "anychain402",
  "private": true,
  "license": "MIT",
  "engines": { "node": ">=20.18.3" },
  "scripts": {
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint"
  }
}
```

- [ ] **Step 3: Install Foundry and initialise contracts package**

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
cd packages/contracts && forge init --no-git --no-commit . && forge build
```
Expected: `forge build` succeeds. (`forge` is not installed on this machine yet.)

- [ ] **Step 4: Verify both toolchains run**

Run: `pnpm install && cd packages/contracts && forge test`
Expected: forge reports its default counter test passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: monorepo skeleton with pnpm workspaces and foundry"
```

---

## Task 2: Escrow accepts an authorized payment

**Files:**
- Create: `packages/contracts/src/interfaces/IEIP3009.sol`
- Create: `packages/contracts/src/Escrow.sol`
- Test: `packages/contracts/test/Escrow.t.sol`

**Interfaces:**
- Consumes: Task 1 toolchain
- Produces:
  - `Escrow.settleAuthorization(address merchant, Authorization calldata auth, uint8 v, bytes32 r, bytes32 s)`
  - `Escrow.balanceOf(address merchant) returns (uint256)`
  - `struct Authorization { address from; address to; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; }`

**Rationale — why `receiveWithAuthorization`:** EIP-3009 offers both
`transferWithAuthorization` and `receiveWithAuthorization`. The former can be
submitted by *anyone* who observes the signature, which allows a griefer to
front-run redemption and break our accounting. `receiveWithAuthorization`
requires `msg.sender == to`, so only the escrow itself can redeem. Use it.

- [ ] **Step 1: Write the failing test**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract EscrowTest is Test {
    Escrow escrow;
    MockUSDC usdc;
    address merchant = address(0xBEEF);
    uint256 payerKey = 0xA11CE;
    address payer;

    function setUp() public {
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        escrow = new Escrow(address(usdc));
        usdc.mint(payer, 1_000e6);
    }

    function test_settleAuthorization_creditsMerchant() public {
        Escrow.Authorization memory auth = Escrow.Authorization({
            from: payer,
            to: address(escrow),
            value: 10e6,
            validAfter: 0,
            validBefore: block.timestamp + 3600,
            nonce: bytes32(uint256(1))
        });
        (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

        escrow.settleAuthorization(merchant, auth, v, r, s);

        assertEq(escrow.balanceOf(merchant), 10e6);
        assertEq(usdc.balanceOf(address(escrow)), 10e6);
    }

    function _sign(Escrow.Authorization memory a)
        internal view returns (uint8, bytes32, bytes32)
    {
        bytes32 digest = usdc.receiveAuthorizationDigest(
            a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce
        );
        return vm.sign(payerKey, digest);
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `forge test --match-test test_settleAuthorization_creditsMerchant -vv`
Expected: FAIL — `Escrow` and `MockUSDC` do not exist yet.

- [ ] **Step 3: Write `IEIP3009.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
```

- [ ] **Step 4: Write `MockUSDC.sol`**

A minimal EIP-3009 token implementing `receiveWithAuthorization`, an
EIP-712 domain, `mint`, `balanceOf`, `transfer`, and a public
`receiveAuthorizationDigest(...)` helper returning the EIP-712 digest for the
`ReceiveWithAuthorization` typehash
`keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")`.
It must revert on a reused nonce and on `msg.sender != to`.

- [ ] **Step 5: Write minimal `Escrow.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEIP3009} from "./interfaces/IEIP3009.sol";

contract Escrow {
    struct Authorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    IEIP3009 public immutable token;
    mapping(address => uint256) private _balances;

    event PaymentSettled(
        address indexed merchant, address indexed payer, uint256 value, bytes32 nonce
    );

    error RecipientMismatch();

    constructor(address token_) {
        token = IEIP3009(token_);
    }

    function balanceOf(address merchant) external view returns (uint256) {
        return _balances[merchant];
    }

    function settleAuthorization(
        address merchant,
        Authorization calldata auth,
        uint8 v, bytes32 r, bytes32 s
    ) external {
        if (auth.to != address(this)) revert RecipientMismatch();

        token.receiveWithAuthorization(
            auth.from, auth.to, auth.value,
            auth.validAfter, auth.validBefore, auth.nonce, v, r, s
        );

        _balances[merchant] += auth.value;
        emit PaymentSettled(merchant, auth.from, auth.value, auth.nonce);
    }
}
```

Note: replay protection is delegated to the token's own nonce tracking, which
EIP-3009 mandates. Task 4 proves this holds under fuzzing.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `forge test --match-test test_settleAuthorization_creditsMerchant -vv`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/contracts && git commit -m "feat(contracts): escrow accepts EIP-3009 authorized payments"
```

---

## Task 3: Merchant withdrawal is always available

**Files:**
- Modify: `packages/contracts/src/Escrow.sol`
- Test: `packages/contracts/test/Escrow.t.sol`

**Interfaces:**
- Consumes: `Escrow.settleAuthorization`, `Escrow.balanceOf` from Task 2
- Produces: `Escrow.withdraw(uint256 amount, address to)`

- [ ] **Step 1: Write the failing tests**

```solidity
function test_withdraw_transfersToMerchant() public {
    _payMerchant(10e6);
    vm.prank(merchant);
    escrow.withdraw(4e6, merchant);
    assertEq(escrow.balanceOf(merchant), 6e6);
    assertEq(usdc.balanceOf(merchant), 4e6);
}

function test_withdraw_revertsWhenOverBalance() public {
    _payMerchant(10e6);
    vm.prank(merchant);
    vm.expectRevert(Escrow.InsufficientBalance.selector);
    escrow.withdraw(11e6, merchant);
}

function test_noAdminCanMoveMerchantFunds() public {
    _payMerchant(10e6);
    vm.prank(address(0xDEAD));
    vm.expectRevert(Escrow.InsufficientBalance.selector);
    escrow.withdraw(10e6, address(0xDEAD));
}
```

Add a `_payMerchant(uint256 amount)` helper that signs and settles an
authorization with a fresh nonce derived from a counter.

- [ ] **Step 2: Run and confirm failure**

Run: `forge test --match-contract EscrowTest -vv`
Expected: FAIL — `withdraw` undefined.

- [ ] **Step 3: Implement withdraw**

```solidity
error InsufficientBalance();

event Withdrawn(address indexed merchant, address indexed to, uint256 amount);

function withdraw(uint256 amount, address to) external {
    uint256 bal = _balances[msg.sender];
    if (amount > bal) revert InsufficientBalance();
    unchecked { _balances[msg.sender] = bal - amount; }
    require(token.transfer(to, amount), "transfer failed");
    emit Withdrawn(msg.sender, to, amount);
}
```

- [ ] **Step 4: Run and confirm passing**

Run: `forge test --match-contract EscrowTest -vv`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts && git commit -m "feat(contracts): merchant-only withdrawal with no admin path"
```

---

## Task 4: Replay and accounting invariants under fuzzing

**Files:**
- Create: `packages/contracts/test/EscrowInvariant.t.sol`
- Modify: `packages/contracts/test/Escrow.t.sol`

**Interfaces:**
- Consumes: full `Escrow` surface from Tasks 2–3
- Produces: no new production interface; proves threat #1 from the spec

- [ ] **Step 1: Write the replay fuzz test**

```solidity
function testFuzz_authorizationCannotBeReplayed(uint96 amount) public {
    vm.assume(amount > 0 && amount <= 1_000e6);
    Escrow.Authorization memory auth = _auth(amount, bytes32(uint256(99)));
    (uint8 v, bytes32 r, bytes32 s) = _sign(auth);

    escrow.settleAuthorization(merchant, auth, v, r, s);
    vm.expectRevert();
    escrow.settleAuthorization(merchant, auth, v, r, s);

    assertEq(escrow.balanceOf(merchant), amount);
}
```

- [ ] **Step 2: Write the solvency invariant**

```solidity
// EscrowInvariant.t.sol
function invariant_escrowHoldsAtLeastSumOfBalances() public view {
    assertGe(usdc.balanceOf(address(escrow)), handler.totalCredited() - handler.totalWithdrawn());
}
```

Create an `EscrowHandler` contract that randomly settles and withdraws, tracking
`totalCredited` and `totalWithdrawn`, and register it with
`targetContract(address(handler))` in `setUp`.

- [ ] **Step 3: Run and confirm both fail initially**

Run: `forge test --match-path 'test/Escrow*' -vv`
Expected: the invariant file fails to compile until the handler exists.

- [ ] **Step 4: Implement the handler, then run**

Run: `forge test --match-path 'test/Escrow*' -vv`
Expected: PASS. Set `fuzz.runs = 512` and `invariant.runs = 256` in `foundry.toml`.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts && git commit -m "test(contracts): replay fuzzing and escrow solvency invariant"
```

---

## Task 5: Build multi-chain PaymentRequirements

**Files:**
- Create: `packages/sdk/src/types.ts`
- Create: `packages/sdk/src/requirements.ts`
- Test: `packages/sdk/test/requirements.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `type Anychain402Config = { price: string; accept: SupportedChain[]; settleTo: 'hedera'; merchant: string; facilitator: string; escrows: Record<SupportedChain, \`0x${string}\`>; assets: Record<SupportedChain, \`0x${string}\`> }`
  - `type SupportedChain = 'base' | 'base-sepolia' | 'polygon' | 'polygon-amoy'`
  - `buildRequirements(config: Anychain402Config, resource: string): PaymentRequirements[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { buildRequirements } from '../src/requirements'

const config = {
  price: '$0.01',
  accept: ['base-sepolia', 'polygon-amoy'] as const,
  settleTo: 'hedera' as const,
  merchant: '0.0.123456',
  facilitator: 'http://localhost:4000',
  escrows: {
    'base-sepolia': '0x1111111111111111111111111111111111111111',
    'polygon-amoy': '0x2222222222222222222222222222222222222222',
  },
  assets: {
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    'polygon-amoy': '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  },
}

describe('buildRequirements', () => {
  it('emits one entry per accepted chain', () => {
    const reqs = buildRequirements(config as any, 'https://api.test/premium')
    expect(reqs).toHaveLength(2)
    expect(reqs.map(r => r.network)).toEqual(['base-sepolia', 'polygon-amoy'])
  })

  it('points payTo at that chain escrow', () => {
    const [base] = buildRequirements(config as any, 'https://api.test/premium')
    expect(base.payTo).toBe('0x1111111111111111111111111111111111111111')
    expect(base.scheme).toBe('exact')
  })

  it('converts a dollar price to 6-decimal atomic units', () => {
    const [base] = buildRequirements(config as any, 'https://api.test/premium')
    expect(base.maxAmountRequired).toBe('10000')
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @anychain402/sdk test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `requirements.ts`**

```ts
import type { Anychain402Config, PaymentRequirements } from './types'

const USDC_DECIMALS = 6

export function parsePrice(price: string): string {
  const cleaned = price.replace(/^\$/, '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`invalid price: ${price}`)
  const [whole, frac = ''] = cleaned.split('.')
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS)
  return BigInt(whole + padded).toString()
}

export function buildRequirements(
  config: Anychain402Config,
  resource: string,
): PaymentRequirements[] {
  const maxAmountRequired = parsePrice(config.price)
  return config.accept.map(network => ({
    scheme: 'exact' as const,
    network,
    maxAmountRequired,
    resource,
    description: `Payment for ${resource}`,
    mimeType: 'application/json',
    payTo: config.escrows[network],
    maxTimeoutSeconds: 300,
    asset: config.assets[network],
    extra: { settleTo: config.settleTo, merchant: config.merchant },
  }))
}
```

- [ ] **Step 4: Run and confirm passing**

Run: `pnpm --filter @anychain402/sdk test`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the testnet USDC addresses before relying on them**

Run:
```bash
cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "symbol()(string)" \
  --rpc-url https://sepolia.base.org
```
Expected: `USDC`. Do the same for the Amoy address against an Amoy RPC. Correct
the fixture if either differs — do not carry an unverified address forward.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk && git commit -m "feat(sdk): build multi-chain PaymentRequirements from one config"
```

---

## Task 6: The middleware — 402 challenge and payment acceptance

**Files:**
- Create: `packages/sdk/src/middleware.ts`
- Create: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/middleware.test.ts`

**Interfaces:**
- Consumes: `buildRequirements`, `Anychain402Config` from Task 5
- Produces: `anychain402(config: Anychain402Config): RequestHandler`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { anychain402 } from '../src'

function appWith(verifyResult: any) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(verifyResult), { status: 200 })) as any
  const app = express()
  app.use('/premium', anychain402(config as any))
  app.get('/premium', (_req, res) => res.json({ ok: true }))
  return app
}

it('returns 402 with an accepts array when no payment is present', async () => {
  const res = await request(appWith({})).get('/premium')
  expect(res.status).toBe(402)
  expect(res.body.accepts).toHaveLength(2)
  expect(res.body.x402Version).toBe(1)
})

it('serves the route when the facilitator says the payment is valid', async () => {
  const res = await request(appWith({ isValid: true, payer: '0xabc' }))
    .get('/premium').set('X-PAYMENT', Buffer.from(JSON.stringify(payload)).toString('base64'))
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true })
})

it('returns 402 with the reason when verification fails', async () => {
  const res = await request(appWith({ isValid: false, invalidReason: 'insufficient_funds' }))
    .get('/premium').set('X-PAYMENT', Buffer.from(JSON.stringify(payload)).toString('base64'))
  expect(res.status).toBe(402)
  expect(res.body.error).toBe('insufficient_funds')
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @anychain402/sdk test`
Expected: FAIL — `anychain402` not exported.

- [ ] **Step 3: Implement the middleware**

```ts
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { buildRequirements } from './requirements'
import type { Anychain402Config } from './types'

export function anychain402(config: Anychain402Config): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`
    const accepts = buildRequirements(config, resource)

    const header = req.header('X-PAYMENT')
    if (!header) {
      res.status(402).json({ x402Version: 1, accepts })
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    } catch {
      res.status(402).json({ x402Version: 1, accepts, error: 'invalid_payload' })
      return
    }

    const selected = accepts.find(a => a.network === (payload as any)?.network)
    if (!selected) {
      res.status(402).json({ x402Version: 1, accepts, error: 'invalid_network' })
      return
    }

    const verifyRes = await fetch(`${config.facilitator}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: selected }),
    })
    const verdict = await verifyRes.json() as { isValid?: boolean; invalidReason?: string }

    if (!verdict.isValid) {
      res.status(402).json({ x402Version: 1, accepts, error: verdict.invalidReason ?? 'invalid_payment' })
      return
    }

    res.locals.x402 = { payload, requirements: selected }
    next()
  }
}
```

- [ ] **Step 4: Run and confirm passing**

Run: `pnpm --filter @anychain402/sdk test`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk && git commit -m "feat(sdk): express middleware emitting multi-chain 402 challenges"
```

---

## Task 7: Facilitator verify endpoint for Base

**Files:**
- Create: `packages/facilitator/src/chains/base.ts`
- Create: `packages/facilitator/src/server.ts`
- Test: `packages/facilitator/test/verify.test.ts`

**Interfaces:**
- Consumes: `PaymentRequirements` shape from Task 5
- Produces:
  - `verifyPayment(payload, requirements): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>`
  - `POST /verify` returning that same object

- [ ] **Step 1: Write the failing test**

```ts
it('rejects an authorization whose recipient is not our escrow', async () => {
  const result = await verifyPayment(
    { network: 'base-sepolia', payload: { authorization: { ...auth, to: '0xdead...' }, signature: sig } },
    requirements,
  )
  expect(result.isValid).toBe(false)
  expect(result.invalidReason).toBe('invalid_exact_evm_payload_recipient_mismatch')
})

it('rejects an expired authorization', async () => {
  const expired = { ...auth, validBefore: String(Math.floor(Date.now() / 1000) - 10) }
  const result = await verifyPayment(
    { network: 'base-sepolia', payload: { authorization: expired, signature: sig } },
    requirements,
  )
  expect(result.invalidReason).toBe('invalid_exact_evm_payload_authorization_valid_before')
})

it('accepts a well-formed authorization signed by the payer', async () => {
  const result = await verifyPayment(validPayload, requirements)
  expect(result.isValid).toBe(true)
  expect(result.payer).toBe(payerAddress)
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @anychain402/facilitator test`
Expected: FAIL — `verifyPayment` not defined.

- [ ] **Step 3: Implement verification**

Recover the signer with viem's `verifyTypedData` against the EIP-712
`ReceiveWithAuthorization` struct using the USDC contract's domain
(`name`, `version`, `chainId`, `verifyingContract` read from chain). Check, in
order: `to === requirements.payTo`, `value >= requirements.maxAmountRequired`,
`validAfter <= now`, `validBefore > now`, and that the recovered signer equals
`authorization.from`. Return the matching `invalidReason` from the x402 error
enum on the first failure.

- [ ] **Step 4: Run and confirm passing**

Run: `pnpm --filter @anychain402/facilitator test`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/facilitator && git commit -m "feat(facilitator): verify EIP-3009 authorizations for Base"
```

---

## Task 8: Facilitator settle endpoint redeems on-chain

**Files:**
- Modify: `packages/facilitator/src/chains/base.ts`
- Modify: `packages/facilitator/src/server.ts`
- Test: `packages/facilitator/test/settle.fork.test.ts`

**Interfaces:**
- Consumes: `verifyPayment` from Task 7; `Escrow.settleAuthorization` from Task 2
- Produces:
  - `settlePayment(payload, requirements): Promise<{ success: boolean; errorReason?: string; payer: string; transaction: string; network: string }>`
  - `POST /settle`

- [ ] **Step 1: Write the failing fork test**

```ts
it('redeems the authorization and credits the merchant on a Base Sepolia fork', async () => {
  const result = await settlePayment(validPayload, requirements)
  expect(result.success).toBe(true)
  expect(result.transaction).toMatch(/^0x[0-9a-f]{64}$/)

  const balance = await publicClient.readContract({
    address: escrowAddress, abi: escrowAbi,
    functionName: 'balanceOf', args: [merchantEvmAddress],
  })
  expect(balance).toBe(10_000n)
})
```

Run this against an anvil fork: `anvil --fork-url https://sepolia.base.org`.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @anychain402/facilitator test settle`
Expected: FAIL — `settlePayment` not defined.

- [ ] **Step 3: Implement settlement**

Re-run `verifyPayment` first and abort on failure. Then send
`escrow.settleAuthorization(merchant, auth, v, r, s)` with a wallet client
funded from `FACILITATOR_PRIVATE_KEY`, wait for the receipt, and return the
`SettleResponse` shape. On revert, map to `errorReason: 'unexpected_settle_error'`.

- [ ] **Step 4: Run and confirm passing**

Run: `pnpm --filter @anychain402/facilitator test settle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/facilitator && git commit -m "feat(facilitator): settle authorizations into escrow on Base"
```

---

## Task 9: HCS journal writer

**Files:**
- Create: `packages/facilitator/src/journal.ts`
- Test: `packages/facilitator/test/journal.test.ts`

**Interfaces:**
- Consumes: the `SettleResponse` produced by Task 8
- Produces:
  - `type JournalEntry = { v: 1; type: 'payment' | 'withdrawal' | 'statement' | 'consolidation'; merchant: string; sourceChain: string; asset: 'USDC'; amount: string; payer: string; txHash: string; nonce: string; ts: string }`
  - `writeEntry(entry: JournalEntry): Promise<{ topicId: string; sequenceNumber: number }>`
  - `encodeEntry(entry: JournalEntry): Uint8Array`

- [ ] **Step 1: Write the failing test**

```ts
it('encodes an entry within the HCS 1024-byte message limit', () => {
  const bytes = encodeEntry(sampleEntry)
  expect(bytes.byteLength).toBeLessThanOrEqual(1024)
  expect(JSON.parse(new TextDecoder().decode(bytes)).v).toBe(1)
})

it('rejects an entry missing its originating txHash', () => {
  expect(() => encodeEntry({ ...sampleEntry, txHash: '' })).toThrow(/txHash/)
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @anychain402/facilitator test journal`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the writer**

Validate required fields, JSON-encode, and submit with
`new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(bytes)`
from `@hashgraph/sdk`, using a client built from `HEDERA_ACCOUNT_ID` and
`HEDERA_PRIVATE_KEY`. Return the topic id and sequence number from the receipt.

- [ ] **Step 4: Run and confirm passing**

Run: `pnpm --filter @anychain402/facilitator test journal`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/facilitator && git commit -m "feat(facilitator): HCS journal writer for settled payments"
```

---

## Task 10: End-to-end on live testnets

**Files:**
- Create: `packages/facilitator/test/e2e.test.ts`
- Create: `scripts/deploy-base-sepolia.sh`
- Create: `README.md`

**Interfaces:**
- Consumes: every prior task
- Produces: a Hashscan link and a Base Sepolia transaction hash, which together
  satisfy the spec's verifiable-testnet-transaction requirement

- [ ] **Step 1: Deploy the escrow to Base Sepolia**

```bash
cd packages/contracts && forge create src/Escrow.sol:Escrow \
  --rpc-url https://sepolia.base.org \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --constructor-args 0x036CbD53842c5426634e7929541eC2318f3dCF7e
```
Record the address in `.env.example` as a comment, not as a secret.

- [ ] **Step 2: Create the HCS topic**

```bash
pnpm --filter @anychain402/facilitator exec tsx scripts/create-topic.ts
```
Expected: prints a topic id like `0.0.xxxxxxx`. Record it.

- [ ] **Step 3: Write the end-to-end test**

Start the facilitator, start a demo Express app using `anychain402`, then:
request without payment and assert 402 with two `accepts` entries; sign a real
EIP-3009 authorization with a funded Base Sepolia key; retry with `X-PAYMENT`;
assert 200. Then assert `escrow.balanceOf(merchant)` increased and that the HCS
topic gained a message whose `txHash` matches the settlement transaction.

- [ ] **Step 4: Run it**

Run: `pnpm --filter @anychain402/facilitator test e2e`
Expected: PASS. Capture the settlement tx hash and the Hashscan topic URL.

- [ ] **Step 5: Write the README**

Cover: what it does, the one-line integration example from Task 6, prerequisites
(Node 20.18.3+, Foundry, a funded Base Sepolia key, a Hedera testnet account),
every environment variable, how to run the facilitator, and the two proof links
from Step 4.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: end-to-end Base Sepolia payment with HCS journal"
```

---

## Self-review notes

**Spec coverage.** Escrow and merchant withdrawal → Tasks 2–4. SDK surface →
Tasks 5–6. Facilitator verify/settle → Tasks 7–8. HCS journal and its schema →
Task 9. Security threat #1 (replay) → Task 4. Testing strategy → Tasks 4, 8, 10.
**Deferred to later plans, by design:** `SettlementLedger.sol` and net positions
(Plan 2), Polygon and Arbitrum (Plan 3), netting and consolidation (Plan 3),
dashboard and scaffold-hbar template (Plan 4).

**Known gap to resolve in Plan 3.** Arbitrum is absent from the upstream x402
network enum. Options: contribute the network upstream, fork the schema, or drop
Arbitrum from v1. Decide before Plan 3 begins, not during it.

**Type consistency.** `Authorization` is spelled identically in Tasks 2, 3, 4, 7
and 8. `buildRequirements` and `Anychain402Config` from Task 5 are used unchanged
in Task 6. `SettleResponse` field names in Task 8 match the upstream schema
verified above.

---

## AMENDMENTS (applied mid-execution — supersede the task text above)

**A1 — merchant binding (supersedes Task 2 Step 5 and ripples forward).**
See spec Amendment 1. `settleAuthorization` gains a `bytes32 paymentId` parameter and
requires `auth.nonce == keccak256(abi.encode(merchant, paymentId))`. Credit uses the
observed `balanceOf` delta, not `auth.value`, under a `nonReentrant` guard.

Binding on later tasks:
- **Task 4:** fuzz that a valid authorization cannot be settled to a different merchant.
- **Task 5:** `PaymentRequirements.extra` must carry `paymentId` alongside `merchant`.
- **Task 6:** the client derives `nonce = keccak256(abi.encode(merchant, paymentId))`.
- **Task 7:** `/verify` recomputes the nonce and rejects a mismatch before settling.
- **Task 8:** `settlePayment` passes `paymentId` through to the contract call.

**A2 — MockUSDC strictness.** The mock rejects malleable signatures (`s` above
secp256k1n/2, `v` outside {27,28}) because real USDC does, and its strictness tests are
committed so CI enforces them.

**A3 — known limitation, deferred.** EIP-1271 smart-contract-wallet signatures are not
supported. Real USDC v2.2 accepts them and smart wallets are common on Base; adding
support changes `IEIP3009`, the mock and the verify path, so it belongs to its own plan.
