# Contributing to ferry402

Thanks for taking a look. This document covers the human process; if you are
an agent working on this repository, read [`AGENTS.md`](AGENTS.md) instead —
it has the conventions and the invariants a change must not break.

## Getting set up

```bash
git clone https://github.com/mdmudassir0143/ferry402.git
cd ferry402
pnpm install
pnpm -r build
```

`pnpm -r build` is not optional before testing. `@ferry402/sdk` publishes from
`dist/`, and `@ferry402/facilitator` resolves it through the workspace
symlink, so the facilitator's tests cannot even resolve the module until the
SDK has been built once.

Requires Node >= 20.18.3, pnpm 9.15.9 (pinned via `packageManager`, so
`corepack enable` is enough), and [Foundry](https://getfoundry.sh) for the
contracts.

## Running the tests

```bash
pnpm -r test                      # sdk (123) + facilitator (92, 1 skipped)
cd packages/contracts && forge test   # 39, including fuzz and invariant runs
```

`packages/contracts` is a standalone Foundry project with no `package.json`.
It is deliberately **not** a pnpm workspace member, so `pnpm -r` never touches
it — run `forge test` separately, and do run it, because the Solidity half of
the nonce derivation lives there.

None of the above touches a real network or spends funds. The live end-to-end
test is gated:

```bash
RUN_E2E=1 pnpm --filter @ferry402/facilitator test:e2e
```

That one spends real testnet USDC and ETH and needs a fully populated `.env`.

## What a good change looks like

**Tests that can fail.** This project has been bitten repeatedly by tests that
could not detect the thing they were written to defend — a guard whose test
passed because an unrelated `TypeError` happened to contain the right word, an
invariant that stayed green through 128,000 calls because it asserted
something tautological. Before you submit, break your change on purpose and
confirm the test goes red. If it doesn't, the test is decoration.

**The nonce derivation is implemented twice.** Once in TypeScript
(`packages/sdk/src/nonce.ts`), once in Solidity (`Escrow._checkBinding`). They
are pinned to the same golden vectors in two separate test suites. Changing
one without the other does not fail loudly at runtime — it silently stops
settling payments. Change both, or neither.

**Never commit a secret.** `.env` is gitignored and must stay untracked. Don't
echo keys into logs, test output, or commit messages. `.env.example` documents
the shape; it holds no values.

## Submitting

Open an issue first for anything substantial, so we don't both build it. For a
pull request: branch from `main`, keep the change focused, make sure
`pnpm -r build`, `pnpm -r test` and `forge test` all pass, and say in the
description what you verified rather than only what you changed.

Found a security issue? Don't open a public issue — see
[`SECURITY.md`](SECURITY.md).

## Licence

Contributions are accepted under the [MIT licence](LICENSE), the same terms
the project is released under.
