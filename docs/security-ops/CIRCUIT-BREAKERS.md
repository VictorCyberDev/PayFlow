# Circuit breakers

Status: DRAFT operational documentation, 2026-11-02. Developer preview, PayPal Sandbox only. This page separates the stop-controls that exist in code from the ones that do not. Do not describe the second list as available.

Another engineer is currently adding some broader breakers (organization suspend, environment restrict, global execution disable). **They are not in this branch and are not claimed here.** Until that work lands and is documented, treat them as absent.

## Existing controls

Ordered narrowest to broadest. Each entry gives what it stops, how to apply it, the code path, how to verify fail-closed, and the limit.

| #   | Control                             | Stops                                                                       | How to apply                                                                                         |
| --- | ----------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Revoke a developer credential       | One bearer token (one agent's API access via that token)                    | `POST /v1/admin/credentials/{credentialId}/revoke` with the Sandbox admin token                      |
| 2   | Suspend or revoke an agent          | Every credential of one agent                                               | `organization_agents.lifecycle` to `SUSPENDED`, `REVOKED` or `RETIRED`                               |
| 3   | Revoke an Authority                 | One Authority (mandate); all future spend against it                        | `mandates.revoked_at` set, via owner console `POST /api/activation/revoke` or an operator SQL update |
| 4   | Disconnect the payment rail         | All execution that needs the owner's vaulted wallet (zero provider effect)  | Remove the owner's wallet connection; the gateway answers `PAYMENT_RAIL_NOT_CONNECTED`               |
| 5   | Unset `PAYFLOW_GATEWAY_ADMIN_TOKEN` | The whole admin surface (issue, list, revoke credentials; sample Authority) | Remove the variable in Vercel and redeploy                                                           |
| 6   | Platform-level pause (Vercel)       | The entire deployment                                                       | Pause or disable the Vercel project/deployment. This is a hosting action, not a PayFlow control.     |

### 1. Revoke a credential

- Code: `CredentialStore.revoke` (`src/network/credentials.ts`), route in `src/network/admin-rest.ts`.
- Effect: `agent_credentials.status = 'REVOKED'`, `revoked_at = coalesce(revoked_at, now)`. Idempotent. Scoped to the admin token's organization and environment; another tenant's ID behaves as absent (`404 NOT_FOUND`).
- Fail-closed check: `CredentialStore.authenticate` reads the row on **every** request (no cache), so the next request with that token returns `ACCESS_INACTIVE` (HTTP 401). Every failure reason before that point is the same class so a caller cannot probe which part of a token was wrong.
- Limits: needs the admin token to exist. A revoked credential does not stop other credentials of the same agent; use control 2 for that. Does not stop a request already past authentication.
- Tests: `tests/m7-sdk-journey.integration.test.ts` and `tests/m7-hosted-gateway.integration.test.ts` (bad/missing credential is a structured 401); live: revoked credential `REJECTED 401, effectCount 0` in `docs/evidence/live/m7-sandbox-acceptance-2026-11-02.json` (Sandbox).

### 2. Suspend an agent

- Code: `organization_agents.lifecycle` (`REGISTERED, ACTIVE, SUSPENDED, REVOKED, RETIRED`; migration 013); transitions through `transitionAgentLifecycle` in `src/network/postgres-adapters.ts`; history table `agent_lifecycle_events` (migration 014).
- Effect: `CredentialStore.authenticate` rejects a credential whose agent is `SUSPENDED`, `REVOKED` or `RETIRED` with `ACCESS_INACTIVE`, even if the credential itself is `ACTIVE` and unexpired. The Gateway also maps a suspended agent to `AGENT_SUSPENDED`.
- How: there is **no admin HTTP route** for the transition today. Use the control-plane adapter from code, or as a logged emergency action an operator SQL update (INCIDENT-RUNBOOKS.md RB-1). The direct SQL update does not append `agent_lifecycle_events`; add the evidence row in the incident log.
- Limits: tied to the `organization_agents` row. An agent with no row (`life[0]` undefined) is **not** rejected by that check, so control 2 only works for agents registered in `organization_agents`. The hosted sample Authority registers its agent there.

### 3. Revoke an Authority

- Code: `PostgresTrustRepository.revokeMandate` (`src/persistence.ts`), console route `/api/activation/revoke` (`src/console-controls.ts`, owner-authenticated, CSRF protected).
- Effect: `mandates.revoked_at` is set once, with evidence appended for the winner of a race. Durable revalidation reads it (`src/network/durable-gateway.ts` line reading `mandates.revoked_at`; the formal linearization point is described in `docs/THREAT_MODEL.md`, section "Formal revocation linearization point"). Result: `DENY AUTHORITY_REVOKED`, `effectCount 0`, `recoverable: false`.
- Fail-closed check: send a purchase request against the revoked Authority with a fresh nonce; expect `DENIED`, `AUTHORITY_REVOKED`, zero new rows in `payment_attempts`, `execution_grants`, `authorization_reservations`. Done live (Sandbox) in the M7 acceptance file.
- Limits: per Authority. Revocation is recorded at `revoked_at`; an attempt already `CLAIMED`/`EXECUTING` cannot be cancelled, only reconciled. It is not reversible by design; issue a new Authority.

### 4. Disconnect the payment rail

- Code: `DemoShoppingAgent.paymentAvailable()` and `gatewayPort().attempt` in `src/delegated-demo.ts` return `PAYMENT_RAIL_NOT_CONNECTED` **before any record is written** when no provider is configured or the owner's stored wallet is not connected (`paymentReady` is `stored.connected()` in `src/console-hosted.ts` wiring). Mapped to `reason: PAYMENT_RAIL_NOT_CONNECTED`, `recoverable: true`, `ASK_OWNER_TO_CONNECT_PAYMENT_METHOD` in `src/network/gateway-execution.ts`.
- Test: `tests/m7-hosted-gateway.integration.test.ts` (rail not connected is refused with zero effect).
- Limits: it is per owner wallet and also removes legitimate work. It is not a switch with an off/on audit trail; there is no "disable execution" flag. Removing PayPal environment variables from the deployment has a similar effect only on the next deploy and also disables the isolated M6 demo composition.

### 5. Unset the admin token

- Code: `src/network/hosted-gateway.ts`: `adminToken` absent means `admin` is `undefined`, so every `/v1/admin/*` path returns `404 ROUTE_NOT_FOUND`. The hosted config rejects a token shorter than 32 characters (`PAYFLOW_GATEWAY_ADMIN_TOKEN_TOO_SHORT` in `src/console-hosted.ts`).
- Test: "without PAYFLOW_GATEWAY_ADMIN_TOKEN no administrative route exists" in `tests/m7-hosted-gateway.integration.test.ts`.
- Limits: this stops **issuing** credentials and the sample-Authority endpoint, but it also removes the HTTP way to revoke credentials. If you disable the admin surface during an incident, revoke with SQL (RB-4). It does not stop agents already holding valid credentials.

### 6. Platform pause

Vercel project pause or disabling the deployment stops all traffic, including legitimate reads. Use only when the IL accepts total unavailability. After resume, reconcile in-flight attempts (UNKNOWN-OPERATIONS.md).

## Added after the first draft (in source and tested; not deployed)

Migration `021_m13_m14_controls_audit_ratelimit.sql` and `src/network/ops-controls.ts` add:

| Control              | How an operator sets it                                                                                                           | Effect                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Organization suspend | `update organizations set status='SUSPENDED' where id='<org>'`                                                                    | Every credential of that organization is refused (`ACCESS_INACTIVE`, 401). Reads included.                     |
| Organization pause   | `insert into execution_controls(scope,disabled,reason) values ('ORG:<org>',true,'<why>')`                                         | New economic requests are refused with `EXECUTION_PAUSED`, zero effect. Proof reads and verification continue. |
| Environment pause    | scope `ENV:SANDBOX` or `ENV:PRODUCTION`                                                                                           | Same, for every organization in that environment.                                                              |
| Global pause         | scope `GLOBAL`                                                                                                                    | Same, everywhere.                                                                                              |
| Unpause              | `update execution_controls set disabled=false where scope='<scope>'`                                                              | Service resumes.                                                                                               |
| Rate limits          | Automatic. Per credential 120 requests/minute on `/v1`, 60/minute on admin routes, 120/minute on `/v1/keys` per forwarded address | `429` with `Retry-After`, zero effect, never processed                                                         |

There is deliberately **no HTTP endpoint** that writes `execution_controls`; changing a pause needs database access, which is itself the authorization. Tests: `tests/m13-m14-ops.integration.test.ts`.

Limits of these controls: they are checked at request time and do not cancel a payment already in flight. A paused system still reconciles. Rate limiting is keyed on the credential id or the forwarded address, which an attacker with many credentials or addresses can spread across. There is no alerting that sets a pause automatically.

## NOT IMPLEMENTED (still)

These do not exist in this branch. Do not tell anyone they do.

- Credential-level or agent-level HTTP route for suspension (only the SQL/adapter path exists).
- An automatic provider circuit breaker (stop sending to PayPal after N consecutive failures). The only provider-side behavior is ambiguity handling: timeouts become UNKNOWN. `retryDelayMs` in `src/network/reliability.ts` is a backoff helper, not a breaker.
- Per-key signing-key revocation or a key-status list in the hosted path (see INCIDENT-RUNBOOKS.md RB-8).
- Spend freeze by amount or velocity at the platform level. Per-Authority limits are enforced by the Trust Kernel (`maxSingleTransactionMinor`, `cumulativeLimitMinor`, `quantityLimit`, expiry), but there is no operator-set global ceiling.
- Automatic triggering of any breaker from monitoring. There is no monitoring or alerting in the repository.

## Choosing a breaker

| Situation                                           | Use                                               |
| --------------------------------------------------- | ------------------------------------------------- |
| One leaked token                                    | 1                                                 |
| One agent misbehaving                               | 2, then 3 for its Authorities                     |
| One Authority looks wrong                           | 3                                                 |
| Owner wallet or provider trouble, stop new dispatch | 4                                                 |
| Admin token leaked                                  | 5 (after rotating), and revoke credentials by SQL |
| Unknown scope, need total stop                      | 6, with IL approval                               |
