# Forward traceability — what the code reaches, and what reaches nothing

Mandate section 20 asks for a review in the direction people skip. Reverse traceability ("for every requirement, find the behaviour") is the one everybody does, because a requirements list makes it easy. Forward traceability — "for every implementation, is it integrated, used, reachable?" — is the one that finds orphans, and nothing in this repository was checking it.

`scripts/orphan-scan.mjs` now does, and is re-runnable:

```bash
node scripts/orphan-scan.mjs
```

It resolves every relative import in `src/`, `tests/`, `scripts/`, `examples/`, `api/`, `hosting/`, `packages/`, `plugins/` and `spec/`, then reports modules that nothing reaches. It is deliberately conservative: it reports with a reason and distinguishes three cases.

## Why a green suite proves nothing here

`src/missions/fx.ts` is a careful piece of work: integer BigInt arithmetic, no floats anywhere, directional rounding so that what is owed rounds **up** and what is available rounds **down**, explicit refusals for a stale rate, the wrong pair or an unknown currency. It has a passing test. It is imported by **nothing**.

A test suite cannot find this, because **the test is itself an importer**. Coverage counts the lines the tests run, and those lines run. The module is complete, correct, tested — and dead. That is the whole argument for scanning in this direction.

## Findings, 2026-11-11

### Unreachable: nothing imports it, not even a test — **none**

`src/demo-projection.ts` was the one: zero references anywhere in the repository, including by name. It imports `OperationTraceSchema` and `AdversarialResultSchema`, so it is an earlier demo surface superseded by the console.

It is now **parked with its reason** rather than deleted or left failing. Deleting another author's module is the owner's call and there is no urgency. But leaving it to fail kept the check out of CI, and an unresolved finding that keeps CI red stops the check doing its real job — which is catching the **next** orphan, not re-reporting this one. Parking states the decision, keeps it visible in every run's output, and lets the gate start working.

### In CI, as of 2026-11-11

```
npm run orphan:scan
```

runs in the `verify` job beside `format:check`, `lint`, `typecheck`, `secret:scan` and `embed:app:check`. A module that becomes unreachable from shipping code **and** tests now fails the build. Adding one deliberately means adding it to the parked list with a reason, which is the point: "nothing imports this" becomes either a build failure or a decision somebody wrote down.

### Test-only: imported by tests, by no shipping code (22 on the first scan, 19 now)

This is the finding that changes how the later milestones should be read.

| Module                                            | Milestone it belongs to              |
| ------------------------------------------------- | ------------------------------------ |
| `src/network/abuse-intelligence.ts`               | M80 network abuse intelligence       |
| `src/network/embedded.ts`, `embedded-profiles.ts` | M79 embedded Authority               |
| `src/network/economics.ts`                        | M78 verification economics           |
| `src/network/transparency.ts`                     | M86 operational key transparency     |
| `src/network/region.ts`                           | M85 multi-region operation           |
| `src/network/global-network.ts`                   | M81–M90 network                      |
| `src/network/directory.ts`                        | M89 external issuer interoperability |
| `src/network/public-authority.ts`                 | M81 public schemas                   |
| `src/network/network-rules.ts`                    | network rules and recourse           |
| `src/network/privacy.ts`                          | M74 privacy enforcement              |
| `src/network/policy-packs.ts`                     | M69 organizational policies          |
| `src/network/enterprise-connectors.ts`            | M70 ERP/AP connectors                |
| `src/network/pilots.ts`                           | M77 PSP integration readiness        |
| `src/network/verify-rest.ts`                      | verification surface                 |
| `src/network/durable-gateway.ts`                  | Gateway durability                   |
| `src/network/billing.ts`                          | M59 billing — see below              |
| `src/missions/fx.ts`                              | M65 multi-currency / FX              |
| `src/missions/channel-resend.ts`                  | email channel (B-1)                  |
| `src/protocols/tool-adapters.ts`                  | framework adapters                   |
| `src/payment-resume.ts` (3 test files)            | payer approval resumption            |
| `src/service.ts`                                  | —                                    |

**What this means, stated plainly:** for M69, M74, M77, M78, M79, M80, M81, M85, M86 and M89, the code exists and is tested in isolation and **is not reachable from the running product**. The audit matrix marks most of them `PARTIAL`; this is the concrete reason why, and it is a sharper statement than "partial". A module with a passing unit test and no importer is not a milestone delivered; it is a milestone's parts, machined and left on the bench.

Test-only is a **finding, not a verdict**. Some of these are legitimately test-only: `src/missions/fx.ts` is a pure function waiting for a rate source (no provider is commissioned, blocker B-5), and a verifier helper proven in isolation can be fine. Each needs judging on its own, which is why the script reports rather than fails on them.

### One of these was mine

`src/network/billing.ts` exports `buildUsageInvoice`, and when I built the M59 usage view I wrote the invoice-line construction again inside `usageHome` instead of calling it. The scan caught my own duplication on its very first run.

`usageHome` now calls `buildUsageInvoice` with the DEVELOPER plan, so one piece of code knows how a PayFlow invoice is shaped. Re-running the scan confirms it: the test-only count fell from 22 to 21 and `billing.ts` is no longer listed. That is the check earning its place on the first thing it was pointed at, and it happened to be mine — which is the more useful demonstration than if it had only caught someone else's.

## What this does not claim

It resolves **relative** imports only. A module reached through a bare-specifier package path, a dynamic string built at runtime, or a build-time code generator would be reported as unreachable even though it is used. That is why the entry-point list exists and why the output is phrased as findings. It is a tool for a person to read, not a gate that knows better than the person.
