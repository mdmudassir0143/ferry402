import { describe, it, expect } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1'
import { SECP256K1N } from '../src/chains/base.js'

/**
 * Pins `chains/base.ts`'s single `SECP256K1N` literal against `@noble/curves`'
 * own `secp256k1.CURVE.n` — an independent implementation of the same curve
 * this codebase does not otherwise depend on for anything except this check
 * (it arrives transitively via viem, but is declared here as an explicit
 * devDependency rather than relied on as a phantom dependency).
 *
 * Review round 1 (M1) flagged six separate hardcoded copies of
 * `SECP256K1N_HALF` and five of the full order `n` across this codebase,
 * with nothing anywhere asserting any of them were correct — precisely how
 * a 94-hex-digit typo in one of them (see the task-7 report) shipped
 * undetected by any test until the malleable-signature mutation test
 * happened to catch it. `chains/base.ts` now derives `SECP256K1N_HALF` from
 * a single `SECP256K1N` constant (`/ 2n`) rather than hardcoding the half
 * value a second time; this test is what stands between THAT one remaining
 * literal and silent drift.
 *
 * The asymmetry that makes this test necessary rather than merely nice to
 * have: a `SECP256K1N_HALF` that is too LARGE is caught deterministically
 * by the malleable-signature test (a flipped-to-high-`s` signature that
 * should be rejected gets accepted instead, every single run — that is
 * exactly how the 94-digit bug surfaced). A `SECP256K1N_HALF` that is too
 * SMALL is caught only probabilistically by the ordinary happy-path test,
 * because a fresh ECDSA signature's `s` is uniformly distributed across
 * roughly half the possible values each run — a boundary this far off would
 * still pass most runs by chance. That silent, flaky-not-failing weakening
 * of the malleability check is the failure mode no other test in this
 * suite can reliably detect, which is why it needs an explicit, dedicated
 * pin against a source independent of this file's own arithmetic.
 */
describe('SECP256K1N', () => {
  it('matches @noble/curves secp256k1.CURVE.n exactly', () => {
    expect(SECP256K1N).toBe(secp256k1.CURVE.n)
  })
})
