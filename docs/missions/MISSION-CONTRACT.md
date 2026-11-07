# Mission Contract v1 (V3 M26)

Schema `payflow-mission/v1`. A mission is a **durable, versioned planning and permission boundary**. It never moves money and
it is not a second Trust Kernel: later milestones (M29) compile an owner-approved mission into the existing Authority and
delegation representations, and every economic action still goes through the one Trust Kernel.

## What it holds

Objective, intended outcome, success criteria, business context, country, currency, `totalBudgetMinor`, `maxCommitmentMinor`
(never above the budget), spending categories, approved provider types, merchant restrictions (`NONE_ALLOWED` by default,
`ONLY` a list, or `ANY`), agent assignments with capabilities, approval conditions, priority, risk tier and a deadline. Money is an
integer count of minor units; floats, zero, negatives and unsafe integers are refused. Unknown fields are rejected **at every
depth**, so authority cannot be smuggled in through a nested field.

Capabilities: `SEARCH READ COMPARE DRAFT COMMUNICATE NEGOTIATE REQUEST_APPROVAL RESERVE CONTRACT PURCHASE REFUND_REQUEST STATUS VERIFY`.
Having a capability on a mission is permission to _attempt_ that kind of work; spending still needs the Trust Kernel.

## States

`DRAFT → PENDING_OWNER_APPROVAL → ACTIVE ⇄ PAUSED`; `ACTIVE/PAUSED → COMPLETED | EXPIRED`; any non-terminal `→ CANCELLED | REVOKED`.
`FAILED` is reserved for the system. Terminal states never leave. A mission with an approved version that gets a proposed revision
**stays ACTIVE under the approved version**; the proposal is `pendingVersion` and changes nothing until an owner approves it.

## Versions and who may change what

- Contract versions are immutable (a database trigger refuses `UPDATE` of the contract and any `DELETE`); only the decision
  columns change. Transitions are append-only.
- The version **in force** is the last owner-approved one. `authorizeCapability` reads that version, never a draft or proposal.
- A **revision** names the version it was based on (`baseVersion`); a stale base is `409 STALE_VERSION`. Concurrent editors cannot
  both win. Control operations may carry `expectedRowVersion`.
- A revision that grants **anything** its predecessor did not takes effect only after an owner approves it. The rule
  (`wideningReasons`) covers: budget, max commitment, deadline, currency, categories (and removing the restriction), provider
  types, merchants (including unrestricted), agents, capabilities, relaxed approval gates, a raised human-approval threshold and
  a raised risk tier. It errs toward "wider".
- **Agents never change Authority.** An agent holding `REQUEST_APPROVAL` may _propose_ a revision (`202`, `applied: false`), even a
  narrowing one; it cannot edit a draft, approve, reject, pause, revoke or create. The service refuses these for any non-member
  caller, not only the route.

## Roles

| Permission                                           | Roles                                |
| ---------------------------------------------------- | ------------------------------------ |
| `mission:create`, `mission:revise`                   | OWNER, FINANCE_ADMIN                 |
| `mission:approve` (put a version in force / refuse)  | OWNER                                |
| `mission:control` (submit, resume, cancel, complete) | OWNER, FINANCE_ADMIN                 |
| `mission:contain` (pause, revoke)                    | OWNER, FINANCE_ADMIN, SECURITY_ADMIN |
| `view:missions`                                      | every role                           |

Containment is not release: SECURITY_ADMIN can pause or revoke but cannot resume.

## API

Members: `POST/GET /v1/admin/org/missions`, `GET …/{id}`, `GET …/{id}/history`, `POST …/{id}/{revisions|approve|reject|submit|pause|resume|cancel|revoke|complete}`.
Agents: `GET /v1/agent/missions`, `GET /v1/agent/missions/{id}`, `POST /v1/agent/missions/{id}/revisions`.
SDK: `PayFlowMemberClient.missions`, `PayFlowAgentMissionClient`. OpenAPI: `openapi/payflow-v1.yaml`.

## What is enforced where

Tenant, environment and acting identity come from the authenticated caller. Another tenant's mission is a `404`, including on
revisions. Expiry is recorded by the system (`DEADLINE_PASSED`) when the version in force is past its deadline, on the next read
or capability check; `expireDue()` is idempotent and safe for a scheduler.

## Not in M26

Planning (M27), the project ledger (M28), compilation into Authority (M29) and the workspace UI (M30). A scheduled sweeper for
`expireDue` is not wired; expiry is applied lazily. Nothing here is deployed (migration 030 is pending on the public database).

Status: **COMPLETE_LOCAL**.
