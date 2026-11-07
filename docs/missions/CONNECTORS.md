# Connectors (V3 M31)

A connector is a governed, **read-only** way for a mission's agent to observe the outside world. It is the only door through which agents bring outside data into a mission, so it is deliberately narrow.

## What a connector can and cannot do

- It can **observe**: `SEARCH`, `READ`, `COMPARE`, `STATUS`, `VERIFY`. Nothing else is in the vocabulary. Capabilities that move money, message people, negotiate, reserve or sign (`PURCHASE`, `COMMUNICATE`, `NEGOTIATE`, `CONTRACT`, `RESERVE`, `REFUND_REQUEST`) cannot be claimed by a definition and cannot be requested through the API (400). Those get their own governed channels in later milestones; they never ride on a connector.
- What it returns is **untrusted**: bounded in size, record count and time, parsed strictly (https URLs only, no credentials in URLs, bounded text and claims), and labelled `UNTRUSTED_OBSERVATION` with the notice "not a quote, not a commitment, not verified by PayFlow". Anything that does not parse is recorded as `INVALID_OUTPUT` and **nothing of it is shown**.
- Errors never leak: an adapter's internal error text is never returned or stored.

## Who decides what

| Question                                         | Answered by                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Which connectors exist                           | Code (`src/missions/connectors.ts`), reviewed. Not configuration.                                                                    |
| Is this one installed and on for my organization | An owner/finance admin (`connector:manage`), after acknowledging what its data may be used for                                       |
| Pause it now                                     | Security admin or above (`connector:contain`) - containment, not restoration                                                         |
| May this agent call it for this mission          | The mission: ACTIVE, before its deadline, the agent granted that capability, and the contract approved the connector's provider type |

## Every call

Checked in order; a refusal before the call is claimed fetches nothing and writes no call row:

1. caller is an agent; the connector offers the capability; the capability is observe-only;
2. mission gate (same check as everything else); 3. provider type approved by the contract;
3. connector installed, enabled (not disabled/suspended), allowed in this environment (sandbox connectors never in PRODUCTION), has the credential reference it needs, circuit closed;
4. the mission's hourly allowance for this connector (counted under a lock, so concurrent calls cannot overshoot);
5. idempotency: the same key returns the stored result and does not call out again; the same key for a different request is refused.

The adapter then runs with a hard timeout and **no database connection held**. Every claimed call is recorded in an append-only table (a finished row cannot change; enforced by trigger) and audited. The log holds outcome and counts, not the data.

Three consecutive failures open a circuit for five minutes (`DEGRADED`); calls during it do not reach the adapter. One success closes it.

## Credentials

An install may carry a credential **reference** (a name for a secret held elsewhere), never the secret. The API never returns the reference, only `hasCredential`. No LIVE connector ships in this milestone, so no credential is used anywhere yet.

## What ships

One connector: **`payflow-demo-catalog`** (SANDBOX): the fictional keyboards the sandbox checkout sells. It is useful for exercising agent workflows end to end and is labelled so; it is refused in PRODUCTION. **There is no real marketplace connector.** A real one needs authorized access (for example developer keys) that only the owner can provide; the registry, install flow, limits, circuit and recording are ready for it.

## Planning

`GET plan` readiness now reflects reality: a task needing `SEARCH`/`READ` on a provider type is `EXECUTABLE` only if a READY connector serves it for this organization at the moment the plan is proposed or activated, otherwise `PREPARED_HANDOFF`. Plans already stored are not re-evaluated when a connector is installed later; propose a new plan version.

## Status

COMPLETE_LOCAL for the framework and the sandbox catalogue; **no live connector (BLOCKED_EXTERNAL for any real marketplace: credentials/authorization).** Not deployed; migration 034 pending on the public database. 12 integration tests on real PostgreSQL and HTTP; 10 mutation checks each fail a test (one test failure also found a real bug: a timeout was recorded as a generic failure because aborting the signal let the adapter's rejection win the race).
