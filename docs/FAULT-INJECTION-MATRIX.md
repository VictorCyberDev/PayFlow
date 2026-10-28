# Fault-injection matrix

`src/network/fault-injection.ts` defines the mandated 41 scenarios and the report shape. `src/network/live-fault-injector.ts` is the injector that drives **production code**: the Trust Kernel through the Gateway, the provider-neutral rail contract (with the deterministic fake rail), lookup-only reconciliation, signed Authority presentations, portable Proof verification, the delegation graph, A2A delegation evaluation, MCP invocation, signed webhooks, and the financial-action schema.

## What makes a scenario pass

The injector derives the observed outcome from what the real code returned or threw. It does **not** read the scenario's expected value. An outcome that is not the expected safe one is reported as `UNSAFE`, which can never equal an expectation.

For authority-widening scenarios the scenario must also be refused **for its intended reason** (for example `MERCHANT_NOT_ALLOWED`, `CURRENCY_MISMATCH`, `AUTHORITY_INACTIVE`, `MONEY:FEE_BOUNDARY_EXCEEDED`). A denial that happens only because of some unrelated violation does not count; this was added after finding that the action-level scenarios were also being denied incidentally for a missing quantity.

## Evidence

- Test: `tests/m14-fault-injection-matrix.test.ts` (matrix completeness, live pass, negative control).
- Committed machine-readable report: `docs/evidence/fault-injection-report.json` (regenerate with `npm run evidence:generate`; CI runs `npm run evidence:check`).
- Mutation checks performed manually: removing the rail's grant-expiry check, and making the Gateway lifecycle gate unreachable, each turn the matrix and the M7 tests red.

## Limits (stated plainly)

- The rail is `DeterministicFakeRail`. A pass is **not** a real provider capture and **not** an independent penetration test.
- Crash-point scenarios (`crash-after-reservation`, `crash-after-grant`, `crash-after-provider-create`, `crash-after-capture`) model the recovery contract: restart can only look up provider truth, an expired one-time grant is refused, and a same-key retry cannot create a second effect. The durable, process-level crash behaviour of the real PostgreSQL stack is covered by the existing M2–M4 integration suites (`persistence`, `execution-grant`, `paypal`, `payment-resume`, `trust-boundary`) and by `tests/m7-network.integration.test.ts` (20-way concurrent requests, revocation after grant).
- For a live-provider assurance run, bind the same scenario list to the sandbox adapter and durable fixtures; that remains an external step.
