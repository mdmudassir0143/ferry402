# Documentation

Start with the root [`README.md`](../README.md) — it covers the quickstart,
the one-line integration, and the full config reference. These three
documents extend it rather than repeat it:

- **[`architecture.md`](architecture.md)** — how the system works end to end:
  the request lifecycle, why serve-then-settle is the architecture and what
  `/verify` has to prove because of it, the trust model, and why Hedera is
  the ledger.
- **[`deployments.md`](deployments.md)** — the live Base Sepolia + Hedera
  testnet transaction record: every address, the Escrow deployment, all
  seven settlements, the three-way reconciliation, and how to deploy your
  own.
- **[`troubleshooting.md`](troubleshooting.md)** — real failure modes with
  real symptoms, grounded in the actual error paths in `packages/sdk` and
  `packages/facilitator`.

`docs/superpowers/` holds internal spec and planning artifacts for this
project's own development process — not user-facing documentation.
