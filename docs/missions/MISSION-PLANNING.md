# Mission planning (V3 M27)

A plan is a versioned, dependency-aware list of tasks for one mission. It is **bookkeeping about work**: it never moves money,
never widens the Mission Contract, and an estimate in it is never a quote.

## Who writes a plan

| Source     | Who                                                      | Effect                                                                                                                                                       |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TEMPLATE` | a member                                                 | active at once. Derived **only** from the contract: assigns work to agents that already hold the needed capability; invents no price, supplier or capability |
| `HUMAN`    | a member                                                 | active at once                                                                                                                                               |
| `MODEL`    | an agent holding `DRAFT` (a model acts through an agent) | stored `PROPOSED`; does nothing until a member activates it, and is revalidated against the contract **at activation**                                       |

A member cannot submit a plan labelled `MODEL`; an agent cannot submit one labelled anything else. The deterministic template is not
a model and is not presented as one. No real model is wired in this milestone; model output arrives through the same strict schema
and owner gate, and the tests use a clearly labelled fixture.

## Validation (a plan is refused whole)

Cycles; unknown, self or duplicate dependencies; an assigned agent not on the mission; a capability the agent was not granted; a
provider type the contract did not approve; a deadline past the mission's; more than 60 tasks; unknown or smuggled fields; and
`VERIFIED_QUOTE` as an estimate source (only the quote engine, M34, may write that). Over-budget estimates are **flagged**
(`overBudget`), not hidden.

## Readiness is honest

Each task is `EXECUTABLE`, `PREPARED_HANDOFF` or `UNAVAILABLE`. Computation and drafting over data the mission already holds are
`EXECUTABLE`. Anything that needs an external provider is `PREPARED_HANDOFF` until a connector is commissioned (M31+); the reason is
stored (`NO_CONNECTOR_COMMISSIONED`). Nothing is silently treated as automated.

## Task states

`BLOCKED → READY → IN_PROGRESS → COMPLETED | FAILED | HANDED_OFF`; `AWAITING_APPROVAL` before `READY` when the task needs an owner
(negotiate/contract per the contract's approval conditions, any purchase/reserve/refund, or an explicit flag); `SKIPPED`;
`INVALIDATED`. Dependency readiness is recomputed under the mission's row lock, so two agents cannot claim the same task.

- **Claim**: only the assigned agent, only a `READY` task, only while the mission is `ACTIVE` and the agent holds every required
  capability on the version in force. A `runKey` makes retries replays; a different run cannot take the task.
- **Complete**: needs the task's required evidence and the same `runKey`. Recorded as `AGENT_REPORTED`.
- **Hand off**: an agent that cannot do a step passes it to a person; a member confirms it with evidence, recorded as
  `OWNER_REPORTED`. Neither is provider-confirmed.
- **Approve**: owners only (`mission:approve`). Agents can never approve.

## Change

A new active plan supersedes the old one: unfinished tasks become `INVALIDATED`; finished work stays recorded under its own plan
version and is **never silently carried over**, so no step runs twice by accident. If the mission later narrows (capability removed,
agent removed, provider type no longer approved), affected tasks are `INVALIDATED` on the next read and their hard dependents are
`BLOCKED` (`DEPENDENCY_BROKEN`). Pausing or revoking the mission stops claims at once. Everything is durable: a restart mid-plan
resumes the same tasks.

## A defect the tests found

`claim` held a transaction connection and then asked the pool for a second one to check capabilities; eight concurrent claims
exhausted the pool and deadlocked. The capability check now runs on the caller's own connection. Any future code that calls
`authorizeCapability` from inside a transaction must pass its executor.

## Roles

`mission:plan`: OWNER, FINANCE_ADMIN. `mission:approve` (task approval): OWNER. `mission:control` (confirm-handoff, skip, invalidate,
retry): OWNER, FINANCE_ADMIN. Reading: every role.

## Not in M27

Real connectors (M31), a real model planner (needs a provider key; blocked), costs from quotes (M34), and compiling tasks into
Authority (M29). Status: **COMPLETE_LOCAL**.
