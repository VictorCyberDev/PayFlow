# PR #18 review map

Keep the integration PR draft. It is already large; splitting it now would risk stacked-history churn. Review by boundaries instead. No merge is authorized by passing local checks alone.

| Boundary      | Primary source                                                                                       | Reviewer questions                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M7–M15        | src/network/gateway.ts, durable-gateway.ts, access.ts, control-plane.ts, procurement.ts, metering.ts | Does authenticated identity bind the exact principal/agent? Are reservations durable and tenant scope enforced? Are simulated economics labelled? |
| M16–M30       | src/protocols, packages/sdk-_, network/verify_, rail.ts, financial-action.ts                         | Actual wire protocols or schemas? Read/write scopes? Real provider or fake? Are retries UNKNOWN-safe?                                             |
| M31–M45       | enterprise.ts, reconciliation-ops.ts, privacy.ts, embedded.ts, abuse-intelligence.ts                 | Trusted role evidence or strings? Atomic accounting? Provider evidence binding? Operational workflow versus helper?                               |
| M46–M60       | spec, packages/verifier, federation.ts, directory.ts, region.ts, transparency.ts, global-network.ts  | Trusted issuer binding? Stale/revoked keys? Real replication or pure functions? External network versus demonstrator?                             |
| Company/brand | apps/console, docs/brand/v2, company launch reports                                                  | Clear company/app separation? Truthful evidence? Accessibility? No premature success or customer claims?                                          |

Merge sequence: finish and separately accept M6 at a green exact head with live Sandbox HNP evidence; review/reconcile the newer M6 changes into this stacked branch; resolve launch blockers and rerun all gates; request human review of the bounded diff; only then consider merging. Do not merge PR #16 merely to unblock PR #18. Do not mark either accepted based on historical M4 evidence.
