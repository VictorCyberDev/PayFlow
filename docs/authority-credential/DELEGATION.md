# Tenant delegation API (M18)

A delegation lets one agent hand part of its **already bounded** authority to another agent. It is a **constraint**, never a
payment instrument: every delegated purchase still goes through the same Trust Kernel, reservation, one-time grant and
Execution Boundary as any other. No endpoint here can widen a parent, and none bypasses the kernel.

## Rules enforced by the server

| Rule                                                                                                                                                             | Where it is decided      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Tenant, environment and acting identity come from the **authenticated** member or agent credential, never a body field                                           | `hosted-gateway.ts`      |
| A ROOT is built from the **stored** Authority: action `PURCHASE`, the Authority's currency, merchants within its list, a shared budget `<=` its cumulative limit | `delegation-service.ts`  |
| A request that names a currency, action kind, audience or amount ceiling for a root is rejected (`400`)                                                          | strict request schema    |
| A HOP can only narrow; omitted fields inherit the parent; any wider field is refused (`403`)                                                                     | delegation engine        |
| An AGENT may extend only a delegation it **holds** (`NOT_THE_DELEGATING_AGENT`); a member may act for the tenant                                                 | `createHop`              |
| Each delegation is bound to one organization, environment and Authority; A2A refuses a delegation used for another Authority                                     | migration 027, `reserve` |
| Budget is shared and conserved across the chain under root-first row locks; a known-zero-effect outcome returns it, an UNKNOWN outcome keeps the charge          | engine                   |
| Revoking a delegation takes its whole subtree out of service; charges already reserved stay counted                                                              | `revokeFor`              |
| Idempotent on `idempotencyKey` (16–128 chars); the same key with a different request is `409`                                                                    | unique index + digest    |
| Another tenant's id is indistinguishable from a missing one (`404`)                                                                                              | tenant-scoped queries    |

## Roles

`authority:delegate` — OWNER, FINANCE_ADMIN. `authority:delegate_revoke` — OWNER, FINANCE_ADMIN, SECURITY_ADMIN.
Reading (`view:authorities`) follows the existing read roles.

## Endpoints

| Method and path                                            | Caller           | Purpose                                                                          |
| ---------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `POST /v1/admin/org/authorities/{authorityId}/delegations` | member           | Create the root                                                                  |
| `GET  /v1/admin/org/authorities/{authorityId}/delegations` | member           | List chains for one Authority                                                    |
| `GET  /v1/admin/org/delegations/{id}`                      | member           | Inspect: lineage, own limits, **effective** permissions, remaining shared budget |
| `POST /v1/admin/org/delegations/{id}/hops`                 | member           | Extend on behalf of the tenant                                                   |
| `POST /v1/admin/org/delegations/{id}/revoke`               | member           | Revoke the subtree                                                               |
| `POST /v1/agent/delegations/{id}/hops`                     | agent credential | The holder extends to another agent                                              |
| `GET  /v1/agent/delegations/{id}`                          | agent credential | Inspect a delegation the agent holds or issued                                   |

Spending is unchanged: present `delegation: { delegationId }` on an A2A `message:send` for `request_authorized_action`.
The action's `authority` must equal the delegation's stored Authority.

## SDK

`PayFlowMemberClient.delegations` (`createRoot`, `delegate`, `inspect`, `list`, `revoke`) and
`PayFlowAgentDelegationClient` (`delegate`, `inspect`) in `@payflow/sdk`.

## Design note

The Gateway accepts a purchase only from the agent named by the Authority. A realistic chain is therefore
principal → supervisory agent(s) → the acting agent; the acting agent is the leaf.

## Limitations

Delegation depth is at most 5. Only the PURCHASE action kind exists. Presented (inline) delegation scopes are verified but
do not replace server-owned access.
