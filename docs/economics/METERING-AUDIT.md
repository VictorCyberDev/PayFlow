# Metering audit

Scope: `src/network/metering.ts`, `src/network/billing.ts`, `src/network/economics.ts`, the persistence in `src/network/postgres-adapters.ts` and `db/migrations/013_m7_m15_network_control_plane.sql`, and whether the live Gateway (`src/network/gateway-execution.ts`, `src/network/hosted-gateway.ts`) and the verification surface emit usage. Audit date 2026-11-02 against the working tree on branch `claude/eloquent-einstein-dw0mxk`. Source files were read, not changed. Findings are from reading code and grepping for call sites, not from running a deployment.

## Verdict

**Metering is implemented as a library and storage layer but is not connected to the live path. No meter is emitted by the Gateway or by Verify. Today the product produces zero billable usage events.** Any usage-based price would bill nothing.

## Meters that exist

| Meter              | Defined in code (`UsageMeter`) | DB check constraint (`usage_events.meter`) | Priced in `PRICING_ARCHITECTURE`                                  | Emitted by live Gateway | Emitted by Verify |
| ------------------ | ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------- | ----------------------- | ----------------- |
| GOVERNED_ACTION    | yes                            | yes                                        | PLATFORM placeholder = 1 minor unit; DEVELOPER and ENTERPRISE = 0 | **no**                  | n/a               |
| VERIFY_CALL        | yes                            | yes                                        | 0 in every plan                                                   | n/a                     | **no**            |
| ACTIVE_AGENT       | yes                            | yes                                        | 0 in every plan                                                   | **no**                  | n/a               |
| ENTERPRISE_CONTROL | yes                            | yes                                        | 0 in every plan                                                   | **no**                  | n/a               |

Supporting pieces that do exist and work in isolation:

- `UsageEvent` with organization, environment, meter, quantity, timestamp and idempotency key.
- `calculateMeteredAmountMinor`: integer arithmetic, rejects non-integer or non-positive quantities, overflow-checked.
- `buildUsageInvoice`: filters by organization, environment and half-open period, aggregates by meter, produces a DRAFT `usage-invoice/v1` validated by Zod.
- `InMemoryBillingProvider`: sandbox-only, draft-only; refuses PRODUCTION invoices. No real billing provider exists.
- `PostgresNetworkStore.recordUsage` and `usageEvents`: insert with `on conflict (idempotency_key) do nothing`, so a retried delivery does not double count. Covered by the integration test noted in the M7-M60 ledger.
- `modelVerificationEconomics` in `economics.ts`: pure arithmetic over caller-supplied numbers; not connected to measured usage.
- Test `tests/m12-m15-pilot-billing.test.ts` checks one invoice for 50 governed actions at the placeholder rate.

## Evidence that the live path does not emit

- `recordUsage` has **no caller** outside its own definition (grep over `src`, `api`, `hosting`, `packages`).
- `ExecutingGateway` exposes an `onEvent` hook that emits privacy-safe analytics events (`gateway.request_received`, `gateway.replay_blocked`, `gateway.allow`, `gateway.deny`, `gateway.executed`, `gateway.unknown`). These carry `clientId` and `authority` only, **no organization id, no environment, no idempotency key, no quantity**, and they are analytics, not usage records.
- `createHostedGatewayHandler` constructs `ExecutingGateway` without `onEvent`, so even those events are not consumed.
- `src/network/public-verify.ts` and `src/network/verify-rest.ts` contain no usage or metering references.
- `organization_agents` rows are created (hosted-gateway sample provisioning, `credentials.ts` lookups), which is the raw material for ACTIVE_AGENT, but nothing derives an event from it.
- No code path writes `ENTERPRISE_CONTROL`; it has no defined unit.

## Exact gaps

1. **No emission point.** Nothing calls `recordUsage` from the Gateway after a decision, nor from Verify.
2. **No organization context in the Gateway event.** `GatewayEvent` lacks organization and environment; `UsageEvent` requires both. The mandate/principal-to-organization mapping must be resolved at the emission point.
3. **No idempotency key derivation.** The key must be derived from something stable per decision (for example Authority id + agent id + nonce, or request id). The Gateway already claims a replay nonce atomically, so the natural key exists but is unused. A replay-blocked request must not create a second event.
4. **No definition of what counts as a governed action.** ALLOW only? ALLOW plus DENY? Escalations? Replay-blocked requests? Executed vs evaluated? The three outcomes have different cost (executions are about 4x the estimated cost of evaluations in COST-MODEL.md). Needs a written definition before price.
5. **Evaluation and execution are not separate meters.** Only GOVERNED_ACTION exists; the model shows executions cost more. Either a new meter or metadata is needed.
6. **ACTIVE_AGENT has the wrong shape for events.** `calculateMeteredAmountMinor`/`buildUsageInvoice` sum quantities. An "active agent" is a distinct count per period, not a sum; emitting one event per day per agent would overbill by summation. It needs a period-distinct aggregation (count distinct agent per billing period) rather than the current sum.
7. **ENTERPRISE_CONTROL has no unit or trigger.** It is a meter name only.
8. **Verify has no organization identity at all.** Public verification is deliberately anonymous; per-call metering requires either an API key or an IP/abuse-based counter. Its cost is also unmeasured.
9. **`recordUsage` drops metadata.** The table has a `metadata jsonb` column, the adapter never writes it; no outcome, meter sub-type or request reference is retained for audit or dispute.
10. **Pricing plan vocabulary mismatch.** Code plan ids are `DEVELOPER`, `PLATFORM`, `ENTERPRISE`; the packages in PRICING-ARCHITECTURE.md are SANDBOX, PLATFORM, ENTERPRISE, VERIFY. There is no VERIFY plan and no notion of allowances, tiers, minimums or platform-fee-plus-usage beyond a single `monthlyBaseMinor`.
11. **No metering of SANDBOX vs PRODUCTION policy.** The Gateway does not stamp environment; invoices are sandbox-only; no production billing provider exists.
12. **Integer minor units only.** A price below one cent per action (for example 0.4 cent) cannot be represented; the unit price is integer minor units.
13. **Quantity type.** DB `quantity` is `bigint`; the JS path requires safe integers. Fine at current scale; note for high volume.
14. **No reconciliation or invoice finalization.** Invoices are DRAFT only; no void/finalize flow tied to usage, no usage-to-invoice reconciliation job.
15. **No read API or dashboard** for an organization to see its usage (`billing:read` scope is defined in `control-plane.ts` but no metering endpoint was found).
16. **Cost telemetry is absent.** No measurement of CPU, wall time, DB time or bytes per operation exists, so COST-MODEL.md profile inputs remain estimates.
17. **No tests tie the Gateway to metering.** The only billing test uses hand-built events.

## Minimal path to a truthful meter (not implemented)

Emit one `GOVERNED_ACTION` event, keyed by the replay-claim identity, from the Gateway at the point the decision is recorded, with organization and environment resolved from the Authority, and metadata recording the decision. Add a nightly distinct-count job for ACTIVE_AGENT. Decide the definitions in item 4 first. All of this is outside this workstream's write scope.

## Update: gaps closed in source after this audit

| Gap                                     | Status now                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 No emission point                     | `GOVERNED_ACTION` is emitted by the hosted Gateway after every evaluated request                                                                             |
| 2 No organization context               | Resolved from the credential's organization and environment at the emission point                                                                            |
| 3 No idempotency key                    | Key is a SHA-256 of Authority + agent + nonce; a retried delivery cannot double count                                                                        |
| 4 No definition of a governed action    | Defined: an authenticated, well-formed, non-replayed request PayFlow evaluated. Auth failures, malformed requests and replay-blocked repeats are not metered |
| 6 ACTIVE_AGENT shape                    | Derived as a distinct count per period from GOVERNED_ACTION metadata                                                                                         |
| 9 metadata dropped                      | Outcome metadata (agent, decision, status) is now written; no secrets or nonces                                                                              |
| 17 No test ties the Gateway to metering | `tests/m7-hosted-gateway.integration.test.ts` (metering)                                                                                                     |

Still open: 5, 7, 8, 10-16. Nothing here is deployed.
