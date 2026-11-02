# Break Authority — benchmark results and exactly what they mean

Generated from the committed artifacts in `docs/evidence/` (regenerate: `npm run evidence:generate`; verified byte-for-byte in CI by `npm run evidence:check` and by `tests/m9-break-authority.test.ts`).

## Headline (precisely worded)

> **100 adversarial scenarios against the production authority modules and a deterministic fake rail: 0 uncontained. Valid controls still complete (5/5).**
> The same suite at **1000** scenarios: 0 uncontained.

It does **not** say "0 unauthorized captures", because no real payment provider was contacted and no capture occurred. `providerEffectsExercised` is `false` and `railKind` is `"deterministic-fake"` in every report.

## Integrated suite (1000 scenarios, 16 categories)

Each scenario calls production code: Trust Kernel, Gateway, Verify, portable-Proof verifier, delegation graph, A2A/MCP adapters, control-plane tenancy guards, machine-authority evaluation and the rail contract. A scenario is "contained" only if the system refused or contained it; the exact evidence string is stored per scenario.

| Category             | Scenarios | Contained |
| -------------------- | --------: | --------: |
| IDENTITY             |        63 |        63 |
| DELEGATION           |        63 |        63 |
| AMOUNT               |        63 |        63 |
| MERCHANT             |        63 |        63 |
| PRODUCT              |        63 |        63 |
| CURRENCY             |        63 |        63 |
| FEES                 |        63 |        63 |
| REPLAY               |        63 |        63 |
| CONCURRENCY          |        62 |        62 |
| PROVIDER_AMBIGUITY   |        62 |        62 |
| PROTOCOL             |        62 |        62 |
| PROOF_TAMPERING      |        62 |        62 |
| PRIVILEGE_ESCALATION |        62 |        62 |
| CROSS_TENANT         |        62 |        62 |
| LIFECYCLE            |        62 |        62 |
| MACHINE_TO_MACHINE   |        62 |        62 |

Valid controls (all must pass): `valid-action-completes-through-gateway`, `valid-action-settles-exactly-once-on-fake-rail`, `narrower-delegation-is-accepted`, `untampered-proof-verifies`, `in-bounds-machine-action-is-allowed`.

## Kernel-only suite

`break-authority-kernel-1000.json`: 1000 scenarios over 10 attack families directly against `authorize()`; 0 unauthorized allows; control decision `ALLOW`. Variants within a family are parameterised, so this is breadth of parameters, not 1,000 independent ideas — the integrated suite is the stronger evidence.

## Fault-injection matrix

41 scenarios, 41 passed, 0 failed (`fault-injection-report.json`). See `FAULT-INJECTION-MATRIX.md` for how a pass is defined and what it does not cover.

## Conformance

7/7 cases passed; `certificationClaim: false`. Passing PayFlow's own suite is not regulatory or third-party certification.

## Tool-selection evaluation

14/14 deterministic positive/negative/ambiguous cases for the reference selector (`tool-selection-eval.json`). No paid model was run; a real model needs its own run against the same golden set.

## Honest limits

- Fake rail only. Not a real capture, not an independent pentest, not a certification.
- The benchmark is a regression harness for our own invariants. Independent reproduction by a third party is an open external step.
