# Threat model update (M14)

Status: DRAFT, 2026-11-02. This **extends** [docs/THREAT_MODEL.md](../THREAT_MODEL.md); it does not replace it. That document remains the reference for the Trust Kernel, execution grants, PayPal provider ambiguity, payer approval, discovery and the M4 boundaries. Read it first. The company-level review in [docs/COMPANY-LAUNCH-SECURITY-REVIEW.md](../COMPANY-LAUNCH-SECURITY-REVIEW.md) and the M7 takeover audit ([docs/TAKEOVER-AUDIT-M7-M25.md](../TAKEOVER-AUDIT-M7-M25.md)) supply the external-agent Gateway context.

Scope: the developer-preview external-agent Gateway (`/v1/*`) mounted by `src/network/hosted-gateway.ts` on a Vercel host with a Neon Postgres database, PayPal Sandbox only. Not covered: production money movement, a second rail, multi-region, customer environments. Nothing here is the output of an independent audit or penetration test.

Assets used below: A1 funds and Authority (the right to spend, `mandates`); A2 the Authority ledger (`authorization_reservations`, `execution_grants`, `payment_attempts`); A3 evidence (`evidence_events`, Proofs); A4 bearer credentials (`agent_credentials`); A5 signing key; A6 admin token; A7 owner PayPal wallet instrument (encrypted, `011`/`012` migrations); A8 tenant data.

| Control legend | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| Test           | exists in `tests/`; does not imply independent proof |
| Residual       | what remains true after the control                  |

## T1 Malicious or manipulated agent

- Asset: A1, A2.
- Attacker: an AI agent with a valid credential that is prompt-injected, misaligned, or deliberately abusive. It chooses amount, merchant, item and timing.
- Existing controls: the agent never supplies authority. Its claimed amount/currency/merchant is compared with the trusted quote and refused before any manifest, proposal, reservation or grant exists (`src/network/gateway-execution.ts`, `expected` handling; `docs/TAKEOVER-AUDIT-M7-M25.md` section 3). The Trust Kernel applies Authority limits (single transaction, cumulative, quantity, merchant scope, expiry, condition, risk). Credential is bound to exactly one agent and principal; mismatches are `ACCESS_AGENT_MISMATCH` / `ACCESS_PRINCIPAL_MISMATCH`. Unknown request fields are rejected (`.strict()` schemas, `REQUEST_MALFORMED`). Evidence: `docs/evidence/break-authority-*.json` (1,000 scripted scenarios against a deterministic fake rail), `tests/m7-gateway-execution.integration.test.ts`.
- Residual: a malicious agent can spend **up to** its Authority's limits on the allowed merchant. That is by design; sizing the Authority is the owner's control. Scripted scenarios are 16 attack families, not a proof against novel attacks. No per-agent request throttling exists (see T11 and review F-02), so an agent can generate load and denied-request evidence rows.

## T2 Compromised developer token

- Asset: A4, then A1 up to Authority limits and A8 reads (Proof, Authority).
- Attacker: anyone who obtains `pf_<env>_pfc_<24hex>.<secret>` (repo leak, log, chat, CI).
- Existing controls: only the SHA-256 digest of a 256-bit secret is stored (`src/network/credentials.ts`); compared with `timingSafeEqual` against a fixed-length value even when the row is absent; uniform `ACCESS_INACTIVE` failure; scopes limited to five named scopes by a database CHECK (migration 020); TTL between 60 seconds and 90 days; tenant/environment-scoped revoke; revoke is immediate (row read per request); agent suspension overrides a live credential. Runbook: INCIDENT-RUNBOOKS.md RB-4.
- Residual: it is a bearer token; possession is use. No IP binding, no mutual TLS, no anomaly detection, no rate limit. `last_used_at` is the only usage signal and is overwritten on each call (no per-request audit table for successful reads). The secret scan (`npm run secret:scan`) only covers committed files. A credential with `action:request` can spend until revoked or the Authority is exhausted.

## T3 Compromised employee or operator

- Asset: A5, A6, A7, database, Vercel project.
- Attacker: an insider or someone holding an operator laptop/session with Vercel, Neon or PayPal Sandbox access.
- Existing controls: secrets are environment variables, not committed (`docs/SECURITY-ASSURANCE-READINESS.md`, secret classes). Wallet instrument and setup tokens are AES-256-GCM encrypted with keys derived from `PAYFLOW_M5_BOOTSTRAP_KEY` (`src/console-session-durable.ts`, `hosting/m6/api/vault.ts`). Evidence is hash-chained so silent edits are detectable after the fact. Admin credentials are only digest-compared and never logged.
- Residual: **There is a single application database role** (`DATABASE_URL`) with full read/write; no separation between the application, migration and operator roles, no row-level security, no database triggers preventing UPDATE/DELETE on `evidence_events` (only commerce tables have immutability triggers, migrations 006 and later). Whoever holds that URL can rewrite state and re-hash a chain they can recompute. The signing key sits in the same Vercel environment as the database URL. No four-eyes control, no access logging beyond what Vercel and Neon provide, no hardware-backed key. Treat any person with Vercel or Neon access as able to defeat every control in this document.

## T4 Replay

- Asset: A1, A2.
- Attacker: anyone who captured a request, a grant token, a Proof or an Authority presentation.
- Existing controls: request nonce claimed atomically in `replay_keys` per `gateway-purchase:{mandate}:{agent}`; second presentation is `DENY REPLAY_DETECTED` with no new effect (live Sandbox evidence `docs/evidence/live/m7-sandbox-acceptance-2026-11-02.json`). Execution grants are one time: `ISSUED` to `CLAIMED` to `CONSUMED` under row lock, 120 second default and 300 second maximum TTL, `EXECUTION_GRANT_CONSUMED` on reuse (`src/execution-grant.ts`). One grant and one reservation map to one `payment_attempts` row (UNIQUE constraints, migration 003). Provider-side idempotency uses persisted request IDs. Verifier presentations have `verification_replay_keys` (migration 013).
- Residual: a nonce is replay protection, not authentication; the credential still decides who may call. Replay retention windows for `replay_keys` are not documented and there is no cleanup job. In-memory replay/limiter helpers in `src/protocols` are single-process only (`docs/COMPANY-LAUNCH-SECURITY-REVIEW.md` blocker 4).

## T5 Provider ambiguity

- Asset: A1, A2, A3.
- Attacker: not necessarily malicious: network failure, a provider timeout, a lost response, or an attacker who induces timeouts to cause a double charge or a false "failed".
- Existing controls: timeout or ambiguous failure after possible transmission becomes `CAPTURE_UNKNOWN` / `ORDER_CREATE_UNKNOWN`, never ordinary failure; authority stays quarantined (grant `CLAIMED`, reservation `EXECUTING`); Show Order precedes any capture decision; the same persisted request ID is reused (`src/paypal.ts` `reconcile`); the agent sees `effectCount: null`, `doNotRetry: true` (`src/network/gateway-execution.ts`). Fault matrix: `docs/FAULT-INJECTION-MATRIX.md` (41 scenarios, fake rail). Operator process: UNKNOWN-OPERATIONS.md.
- Residual: PostgreSQL and PayPal share no atomic transaction (`docs/THREAT_MODEL.md`); exactly-once is not claimed. Reconciliation is manual-trigger only: no scheduler, so UNKNOWN can sit indefinitely. `PayPalExecutionRail.reconcile` can resubmit with the same request ID inside a six-hour window; it is not observation-only (review F-08). `reconciliation_queue` is not wired. Live Sandbox UNKNOWN was not exercised (M7 acceptance record: "UNKNOWN (not manufactured)").

## T6 Cross-tenant request

- Asset: A8, A1.
- Attacker: a holder of a valid credential for tenant X addressing tenant Y's Authority, credential, agent or Proof.
- Existing controls: a credential names one agent and principal; the Authority must belong to that same pair (`ACCESS_AGENT_MISMATCH`, `ACCESS_PRINCIPAL_MISMATCH`); admin routes are bound to one organization and environment (`staticAdminAuthenticator`), credential list/revoke SQL filter by `organization_id` and `environment`; another tenant's credential ID is `NOT_FOUND`; Proof reads check ownership through `ProofReader`; agent lifecycle updates by composite key return `CROSS_TENANT_ACCESS_DENIED`; `authority_ownership` binds mandates to organization/environment (migration 013). Tests: `tests/m7-network.integration.test.ts`, `tests/m8-portable-proof.integration.test.ts` ("scope and ownership").
- Update 2026-11-03: organization views, credentials, approvals and pauses are now scoped to the authenticated MEMBER's organization and environment (`organization_members`, migration 023), with a tested cross-organization and cross-environment matrix (`tests/m13-rbac.integration.test.ts`). The static operator token holds no organization role. Residual: multi-tenancy is exercised by tests but not by any live second tenant. Isolation is application-level only; there is no row-level security. A SQL injection or an application bug would expose every tenant. `agent_credentials.organization_id` is not checked against the agent's `organization_agents` row at issue time beyond the admin context.

## T7 Merchant substitution

- Asset: A1.
- Attacker: an agent or a compromised catalog/discovery source steering payment to a different payee than the one the Authority allows.
- Existing controls: trusted quote and sealed checkout manifest (`ADR-011`); immutable merchant bindings (`commerce_merchant_bindings`, immutability triggers, migration 006); the PayPal payee must match `expectedPayPalMerchantId` (`DEMO_MERCHANT_ID`, `DemoAgentSchema` in `src/console-hosted.ts`); Authority `merchantScope`; execution grant binds `merchantId`, `amountMinor`, `currency` and the reservation re-checks them (`RESERVATION_BINDING_MISMATCH`); a capture whose payee/amount/currency differs is quarantined as `COMMERCE_*`. Live: merchant drift `DENIED`, `effectCount 0`.
- Residual: only the single demo merchant (`DEMOACCOUNT01` by default) exists. Binding rotation for real merchants, third-party catalogs and merchant onboarding are untested. `docs/THREAT_MODEL.md` "M4E discovery and ranking attacks" remains the authority for untrusted discovery.

## T8 Approval-channel compromise

- Asset: A1 (human approval above thresholds), A3.
- Attacker: someone who can forge, replay or hijack an approval (browser session theft, CSRF, a fake approver, a social-engineering message).
- Existing controls: owner console uses durable sessions with CSRF and origin checks, a 30-requests-per-window session limit (`src/console-session-durable.ts`), payer return handling per M4D, bounded one-time setup tokens bound to principal + session + state digest (`docs/M6-ACCEPTANCE-HANDOFF.md`), approvals unique per `(request_id, approver_principal_id)` with `action_digest` (migration 014).
- Residual: **the enterprise approval path is not authenticated end to end.** `evaluateApprovalEvidence` assumes already-authenticated server records; signer/role verification and revocation are an open launch blocker (`docs/COMPANY-LAUNCH-SECURITY-REVIEW.md` item 1). The sample Authority sets both thresholds equal to its limit (`autonomousPurchaseThresholdMinor` and `humanApprovalThresholdMinor` are 10000), so the live Sandbox run did not exercise human approval. There is no approval-via-email/chat channel to attack because none exists; if one is added it needs its own review. Demo access uses an access code and a bootstrap key; no MFA.

## T9 Privilege widening

- Asset: A1, A4.
- Attacker: an agent, delegate or administrator trying to obtain more scope, a larger Authority, or a longer lifetime than it was given.
- Existing controls: credential scopes are a closed enum enforced in schema and DB constraint (`GatewayScopeSchema`, migration 020); `requireAgentAccess` checks scope, audience and time; admin context fixes the tenant and environment regardless of request body (the handler overwrites `organizationId` and `environment` from the admin context); delegation attenuation in `src/network/` (child cannot exceed parent) with fault-injection scenarios requiring the _intended_ denial reason (`docs/FAULT-INJECTION-MATRIX.md`); Authority mandates are immutable once saved (`mandates.fingerprint`).
- Residual: A2A child constraints are not applied to the exact action (`docs/COMPANY-LAUNCH-SECURITY-REVIEW.md` item 3), so delegation must not be used for financial execution. The admin token is a single static secret with no role split (it can both issue and revoke, and it can create a sample Authority). There is no approval step for issuing a credential. Credential issue has no per-agent cap on number of active credentials.

## T10 Hosted-gateway specific risks

### T10a Share link and deployment protection

- Asset: A1, A8.
- Attacker: anyone who obtains a shared preview URL or its bypass material.
- Existing controls: the M7 acceptance preview was behind Vercel Authentication and accessed with a 23-hour share link (`docs/TAKEOVER-AUDIT-M7-M25.md` section 6, `docs/evidence/live/m7-sandbox-acceptance-2026-11-02.json`). Application security headers and CSP in `vercel.json`. The gateway still requires a bearer credential, so a share link alone does not authenticate a caller.
- Residual: deployment protection is a platform setting not represented in the repository, so it can be switched off without any code change or test failing. A share link removes the only outer layer; then rate limiting is absent (T11) and the admin token is the only barrier on `/v1/admin/*`. Share links are not inventoried or revoked by any PayFlow procedure. Record each link's expiry and revoke it after use.

### T10b Admin token

- Asset: A6, A4.
- Existing controls: absent token disables all admin routes (404); minimum length 32 enforced at config (`src/console-hosted.ts`); constant-time digest comparison, never logged; bound to one organization/environment (`src/network/admin-rest.ts`); body limit 16 KiB (`src/network/hosted-gateway.ts`).
- Residual: one static bearer secret, no rotation procedure beyond redeploy, no expiry, no IP allow-list, no rate limit on guessing (32 characters of entropy makes guessing impractical but the absence of throttling is still a gap), no audit row for admin actions (issue and revoke are not written to `evidence_events`; the credential table is the only record). An admin can mint a credential for any registered agent in its tenant.

### T10c Sample Authority provisioning

- Asset: A1.
- Existing controls: `POST /v1/admin/sandbox/authority` is admin-authenticated; it creates a fixed Sandbox Authority ($100, one keyboard, only `DEMO_MERCHANT_ID`, new condition, 24-hour expiry, `CAPTURE_PAYMENT`) and inserts the organization/agent rows with `on conflict do nothing`.
- Residual: each call creates a **new** mandate; calling it repeatedly multiplies spendable Authority (each is a fresh $100) with no cap. It writes the mandate through `repo.saveMandate` but does not append an evidence event of its own and does not create an `authority_ownership` row in the code shown. It is clearly labelled Sandbox in the response, but nothing prevents someone enabling the same code path with a production database. There is no production environment guard besides configuration.

### T10d Shared database with the M6 acceptance evidence

- Asset: A3, A2.
- Context: the M7 live acceptance ran on the **existing M6 acceptance Neon database**, with migrations 013 to 020 applied in one additive transaction after a snapshot branch (`br-super-field-b8baqoz2`). The M6 evidence (1 captured, 79 events, 14 mandates, 1 vaulted wallet before) therefore lives beside M7 test data, credentials and sample Authorities.
- Existing controls: additive migrations only; snapshot taken first; M6 counts recorded before and after the run; hash-chained `evidence_events`.
- Residual: M6 historical evidence, M7 test traffic and credential rows share one database, one role and one `evidence_events` chain. An M7 mistake (or an operator's SQL) can alter M6 acceptance evidence, and a restore for one purpose affects the other. The snapshot predates migrations 013 to 020, so restoring it would drop every M7 table and credential. No restore has been rehearsed (BACKUP-RESTORE.md). Recommend a dedicated database for anything beyond acceptance evidence, and a read-only copy of the M6 evidence.

## T11 Abuse and denial of service

- Asset: availability, A2, cost.
- Attacker: any caller, with or without a valid credential.
- Existing controls: 16 KiB request body cap on the hosted gateway; strict schemas; console session limit (30 requests per window); `localProtocolRateLimit` and injectable `rateLimit` on the MCP/A2A HTTP adapters (single-process, in-memory); `RateLimitStore`/`enforceRateLimit` abstraction in `src/network/reliability.ts`.
- Residual: **the hosted `/v1/*` handler applies no rate limit.** The abstraction is not backed by a database implementation and is not called by `hosted-gateway.ts`. Each authenticated request performs a database read and a `last_used_at` write; unauthenticated requests with well-formed tokens still hit the database. Vercel platform protections (firewall, attack challenge) may help but are not configured in the repository.

## Explicit non-claims

No certification, no audit and no attestation. No penetration test. No measured availability. The deterministic fake rail results are not provider evidence. The live Sandbox run exercised one capture and a small set of denials, not UNKNOWN, not suspension, and not hosted admin issuance (per the acceptance record).
