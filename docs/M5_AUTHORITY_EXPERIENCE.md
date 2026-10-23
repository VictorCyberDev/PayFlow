# Milestone 5 — Authority Experience

Status: ACTIVE

Authoritative base: `main` at `1a3db3c09da77d4c86dfc37c48fc51617f1f3753` (ADR-016 merged).

M4 and the post-M4 payer-return repair remain CLOSED / UNCHANGED.

## Objective

Make PayFlow's accepted Agent Passport + Mandate architecture understandable, beautiful and safely operable by a real user without changing financial-authority semantics.

The user-facing product concept is **Authority**. Authority is a projection of existing durable truth; it is not a new financial-authority model.

The product experience should feel like a premium AI workspace crossed with a financial wallet: conversational, calm, legible, trustworthy and progressive rather than technical-first.

## Non-regression boundary

M5 MUST NOT redesign or replace:

- `authorize()` or Trust Kernel semantics;
- `AgentPassport`;
- `Mandate`;
- intent compilation or the rule that model output is untrusted;
- `HumanConfirmationBoundary` exact-action binding;
- reservations, execution grants or one-time claim semantics;
- Payment Attempt states;
- PayPal dispatch, UNKNOWN quarantine or reconciliation;
- checkout quote/manifest binding;
- payment-resume revalidation;
- evidence-ledger semantics;
- `OperationTraceService` verification semantics;
- migrations `001`–`009`.

Browser state is never financial truth. No browser/client value may widen authority, create financial permission, fabricate verification or mutate payment state directly.

Any schema addition must start at migration `010`, be additive and be justified by a missing durable requirement rather than UI convenience.

## Product architecture

The existing root package remains PayFlow's trust-kernel/server foundation.

The premium application lives in an isolated `apps/console/` boundary with its own dependency graph and build. The frontend must not receive database credentials, signing keys, execution grants, resume secrets, authentication assertions, PayPal credentials/OAuth tokens or unrestricted persistence access.

Trusted server routes may call existing PayFlow services and expose bounded projections.

Read-only operation history and verification must derive from `OperationTraceService`; the frontend must not reimplement trace verification.

## Experience thesis — Calm Authority

PayFlow should borrow principles, not branding:

- OpenAI: intent-first interaction, restrained surfaces, progressive reveal;
- Claude: focus, quiet hierarchy, minimal cognitive noise;
- Apple: agency, craft, Wallet-like authority objects, excellent spacing and motion;
- PayPal: confidence at money moments, explicit amount/merchant context, clear recovery and accessible controls.

Primary navigation stays small:

1. Home
2. Ask PayFlow
3. Authority
4. Activity
5. Agents

Technical concepts such as grants, reservations, manifests, provider observations, fingerprints and reason codes belong behind verification detail.

## Human-language rule

Primary UI language MUST describe consequences, not implementation internals.

Preferred examples:

- "Up to $100"
- "1 new item"
- "Approved merchants only"
- "Expires Friday at 6:00 PM"
- "Your agent can complete this without asking again"
- "You'll be asked before payment"
- "Your money didn't move"
- "Payment verified"

Terms such as `CAPTURE_PAYMENT`, `AMOUNT_EXCEEDS_LIMIT`, hashes and internal IDs may appear only in deliberately expanded technical evidence views.

## Progressive disclosure

Every important state should be understandable at four levels:

1. human-readable outcome;
2. concise reason/explanation;
3. verification detail;
4. technical references/fingerprints on explicit expansion.

## M5 phases

### M5A — Product boundary + Authority read model

Goal: establish the frontend/application boundary and a bounded server-side Authority projection derived from existing durable Agent Passport + Mandate truth.

Required:

- isolated `apps/console/` application boundary;
- no root UI-framework dependency pollution;
- bounded Authority projection contract;
- owner/agent binding enforced server-side;
- active/suspended/revoked/expired state represented correctly;
- remaining/current authority facts must come from durable state, not browser calculations where authoritative accounting exists;
- read-only behavior cannot dispatch payments or mutate authority;
- initial premium Home / Authority visual shell using deterministic fixtures only until authenticated server wiring is ready.

M5A does NOT create or activate mandates yet through the UI.

### M5B — Ask PayFlow + review experience

Goal: expose the existing natural-language intent pipeline without treating AI output as authorization.

Flow:

`natural language -> model interpretation -> deterministic compile -> NOT YET AUTHORIZED review`

Required:

- conversational composer;
- explicit untrusted interpretation state;
- deterministic terms shown in human language;
- no client-created trusted bounds;
- stale/expired review states represented correctly;
- no confirmation yet until M5C trusted-host boundary is wired.

### M5C — Authenticated exact activation

Goal: connect the product to the existing `HumanConfirmationBoundary` and `IntentActivationService`.

Required:

- exact review/challenge binding;
- owner-bound authentication via trusted host implementation;
- replay/stale/expired/tampered confirmation fails closed;
- successful activation creates the existing durable `Mandate`, not a parallel UI authority record;
- newly active Authority is rendered from fresh durable server state after activation;
- no optimistic browser success before durable activation succeeds.

### M5D — Authority controls + Activity

Goal: let users safely understand and manage current authority.

Required:

- Authority card/detail view;
- remaining/single/cumulative/quantity/merchant/condition/capability/expiry explanation;
- suspend/revoke paths only through authenticated server-side authority operations consistent with existing semantics;
- Activity list for allowed, denied, escalated, pending/unknown and completed operations;
- operation details derive from bounded durable projections and `OperationTraceService` where applicable;
- stale UI must never imply authority remains active after server-side revocation/expiry.

### M5E — M5 adversarial + hosted acceptance

Goal: prove the product layer cannot weaken the accepted kernel.

Required scenarios:

- client attempts to widen amount;
- client changes merchant/category/condition/quantity/capability;
- stale intent review;
- replayed confirmation;
- wrong owner/principal;
- wrong agent;
- expired/suspended/revoked passport;
- expired/revoked mandate reflected after refresh;
- stale browser says active while server says unavailable;
- direct API tampering;
- unauthorized read of another principal's Authority/Activity;
- UI refresh/reload does not cause financial dispatch;
- no payment provider calls from read-only Authority/Activity routes.

M5 closes only after hosted end-to-end acceptance and all accepted M1–M4 regressions remain green.

## Initial visual acceptance

### Home

The first view should not look like a SOC dashboard.

Primary composition:

- understated PayFlow brand/header;
- short human greeting/context;
- large Ask PayFlow composer;
- concise "Active authority" section;
- recent activity;
- no wall of KPIs.

### Authority card

The visual object should be legible in roughly two seconds:

- agent name;
- purpose;
- active/suspended/revoked/expired state;
- maximum / remaining amount;
- quantity and condition;
- merchant scope summary;
- expiry;
- whether autonomous completion is allowed or human approval is required;
- one clear action: View authority.

### Authority detail

Default view answers:

- What can this agent do?
- How much can it spend?
- Where/what can it buy?
- When does authority end?
- How much remains?
- Does it need me before paying?

Verification detail is collapsed by default.

## Accessibility and quality

- keyboard navigable;
- meaningful focus states;
- sufficient contrast;
- reduced-motion support;
- responsive mobile/desktop layouts;
- touch targets appropriate for payment/authority actions;
- loading states never imply success;
- UNKNOWN/unavailable financial states remain explicit and fail-safe;
- errors explain the safe next action without exposing secrets.

## Test and CI gate

Every M5 phase must preserve the existing root checks:

- format;
- lint;
- typecheck;
- static/unit tests;
- PostgreSQL integration tests;
- audit;
- build.

The console gets its own format/lint/typecheck/test/build checks without weakening the root gates.

## M5 final pass condition

M5 is PASS only when a user can:

1. enter a natural-language delegation;
2. clearly distinguish AI interpretation from authorized terms;
3. authenticate and activate exact terms;
4. see a premium active Authority derived from durable state;
5. understand constraints without technical knowledge;
6. inspect recent decisions/activity;
7. safely revoke/suspend where supported;
8. refresh/restart without losing truth;
9. fail closed under tampering/replay/stale/ownership attacks;
10. complete the hosted journey with M1–M4 regressions unchanged.

M6 MUST NOT start before M5 is independently reviewed and explicitly merged/closed.

## M5A implementation review boundary

The original candidate was inspected against ADR-016, domain schemas, intent activation and HumanConfirmationBoundary, repository accounting, and OperationTraceService. It preserved the kernel but lacked a read contract/security tests, working navigation/disclosures, a lockfile and independent console gates. This continuation repairs those gaps rather than replacing accepted services.

`src/authority-projection.ts` defines a bounded display-only contract and a read coordinator with trusted host authentication and owner-scoped store ports. It does **not** implement authentication, durable projection wiring, accounting, authorization or payment execution. A future adapter must read passport, mandate, revocation and accounting in one durable owner-bound snapshot, using the existing repository and server clock. `freshDispatchBlocked: null` means not established; an active display is never dispatch permission. Inactive views require blocked=true. Null cumulative/quantity values mean unavailable or not configured, not unlimited permission. The contract checks structural consistency only; it is not a replacement policy engine. No route exposes these ports in M5A.

The console has its own installed dependency graph, lockfile, ESLint, type generation/typecheck, Node tests and static production export. Root ESLint and Vitest exclude the console, whose checks run in a separate CI job. Root format still checks authored console files. ADR-016 has only five heading-spacing corrections required by the existing format gate; its roadmap is unchanged.

Fixtures use a distinct presentation-only shape marked NON_AUTHORITATIVE_FIXTURE; they are never serialized as the server projection. All visible amounts and outcomes are labelled examples. The composer reveals a fixed, explicitly non-interpreting preview marked NOT YET AUTHORIZED. No model integration, mandate activation, controls or live Activity reads are implemented. Verification disclosure reports fixture provenance, not invented live verification.

Authenticated durable projection wiring is a later trusted-host dependency for GUIDE to scope, not bypassed here. M5B and M6 are NOT STARTED. PR #12 must remain DRAFT / OPEN / UNMERGED pending independent GUIDE review.

## M5B — Ask PayFlow review implementation

M5A at `e8988d7a4fde62ff03ad8b3323b5180f4f823ff3` is accepted for progression. Its Authority projection/security contract and financial foundations remain unchanged.

M5B connects the composer to `IntentReviewService`, which reuses `interpretIntent` (existing strict model contract, deterministic compiler and conservative semantic validation). The result is a bounded, non-production display projection: source, interpretation/review status, fingerprint for valid drafts only, human-facing terms, fixed clarification/error text, minimal provenance, and a display deadline no later than five minutes or the proposed expiry. No raw provider output, reasoning, identity, activation requirement material, challenge, confirmation token, execution grant or resume capability is serialized. Model explanations do not become clarification questions. Secrets deliberately typed by a user remain user source; this layer does not claim general secret detection.

The compiler and semantic limitations documented in ADR-005/006 are preserved. Semantic disagreement cannot reach a valid review. This is not formal verification of arbitrary language; interpretation and even a valid draft remain untrusted. Rendering an active-looking review never authorizes a purchase.

### Non-production host boundary

`intent-review-demo-host.ts` serves the console static export and same-origin review endpoints, on loopback only when launched directly. It reads no credentials and constructs no live Groq/PayPal provider. It provides fixed server-owned demo bounds: USD 100, one new item, DemoMerchant, create-order/payment proposal capabilities, at most one day. Browser input accepts only source text; any client bounds, owner, agent or activation field is rejected before interpretation. There is no authentication implementation, durable write or financial service. The port is deliberately local, not a production deployment or substitute for M5C.

The recorded fake provider accepts one exact, explicitly specified sample (generated with a fresh expiry). This is fixture selection, not a second natural-language parser. Other text produces missing-field clarification without inferring any permissions. The UI labels recorded model behavior; arbitrary live NL interpretation has not been proven by this demo. A provider implementing the existing interface can be injected into server tests; normal CI never needs a live provider. The accepted Groq adapter and opt-in smoke guard remain unchanged.

To inspect the local full flow, build the isolated console, then run `node --import tsx src/intent-review-demo-host.ts` from repository root. This is an optional development command, not a deployment. Static export alone has no review API; if the local host is absent, the UI shows a safe unavailable state.

### Product states and tests

The display controller covers empty, interpreting, valid/untrusted review, clarification, rejection, safe failure, edited-source stale state and expired review. Edits and out-of-order responses invalidate prior results, including edit-away-and-back. A reload starts empty and issues no review, activation or payment automatically. Review state is memory-only. Provider/transport waits are bounded. No confirmation action is rendered.

Root tests cover real compiler/semantic processing through fake model fixtures, model widening/mismatch/activation injection, client-bound injection, provider errors/timeouts, output exclusion, and local HTTP handling. Console tests exercise the actual controller and server-rendered React review surface, including clarification/rejection without fabricated terms, escaped source text, accessibility announcements, stale responses, expiry and reload. Read-only M5A projection tests remain intact.

M5B has no financial migration, no activation, no mandate creation, and no payment/provider dispatch. Console and root CI remain independently validated. No hosted console is deployed; obtaining a hosted API would require separate infrastructure scope. Existing payer-return hosting/configuration is untouched.

M5B implementation stops for independent GUIDE review. M5C and M6 are NOT STARTED. PR #12 remains DRAFT / OPEN / UNMERGED.

## M5C — Authenticated exact activation candidate

M5A and M5B are CLOSED / PASS at their accepted heads. M5C adds a separate opt-in host; it does not change the accepted intent/compiler, HumanConfirmationBoundary, IntentActivationService, domain, financial accounting/execution or migrations 001–009.

### Authentication and exact action

`ConsoleSessions` is deliberately **NON-PRODUCTION DEMO**, not an external identity provider. An operator privately supplies a high-entropy bootstrap key (generate at least 32 random bytes), a fixed existing principal and agent, and a dedicated database. The browser cannot select an identity or provision principals, passports or activation policies. Session tokens are 256-bit random opaque values; only their SHA-256 digest indexes server memory. Cookies are HttpOnly, Path=/, SameSite=Strict, explicit 15-minute expiry, and Secure with the __Host- prefix for HTTPS audiences. HTTP is allowed only on loopback. Login has a bounded guessing window; authenticated mutation traffic and session/review caches are bounded. Production authentication is not claimed.

A same-origin session read exposes a synchronizer CSRF nonce and expiry, **not** the HttpOnly session credential. The nonce is not an authentication assertion and is insufficient without the cookie. State changes require JSON, the exact configured origin/host audience, the valid cookie and the session CSRF header (bootstrap instead requires the private operator code and exact origin). No CORS access is granted. Logout revokes the server session; expiry rejects reads and future confirmations. As with the accepted boundary, an already authenticated action that has entered activation follows the existing transaction linearization semantics; logout does not retroactively undo a committed mandate.

The host seals explicit create-review/confirm HTTP actions into one-use, exact-binding, short-lived in-memory assertions. Fabricated, cloned, expired or mismatched assertions cannot pass the existing HumanConfirmationBoundary. No assertion, bootstrap key, raw cookie, activation challenge or private session material is serialized to product output or written to evidence.

### Durable review, confirmation and fresh display

`ConsoleActivation.prepare` reuses the existing interpret/compile/semantic pipeline, then invokes the existing authenticated `createReview`. Principal and agent bindings, epochs, hashes, challenge and provenance are persisted by M3C. A server-only cache retains the challenge and exact service request. The bounded pending sheet includes exact source, agent, spend/cumulative/quantity/merchant/condition/capability/threshold/expiry terms and a display hash. The client may submit only an explicit confirmation action, review reference and matching display hash. It cannot submit replacement terms or any activation capability. The service recompiles and revalidates the real durable review at activation.

`confirmReviewedIntent` alone creates the durable Mandate and existing activation evidence. The host returns only ACTIVATED and mandate ID, or a safe rejection. The client then performs a separate owner-bound fresh Authority read through the **unchanged M5A AuthorityViewService/schema** and new `PostgresAuthorityViewReader`. The adapter uses one read-only repeatable snapshot and the accepted repository accounting/integrity checks. It represents current revocation, identity status and earliest passport/mandate expiry; it never authorizes a proposal. Active display is withheld when the read fails, is expired, revoked, unavailable or belongs to another owner. Fresh-dispatch permission remains unknown (null) for an active projection: a displayed Authority cannot replace kernel revalidation.

No optimistic client activation occurs. Reload restores only via session and Authority GETs; the mandate ID in the URL is an untrusted resource reference, never identity or permission. Periodic/manual reads and local expiry clear stale active display. Editing source invalidates pending UI, not durable financial state. Creating a newer review does **not** invalidate an older pending review in accepted M3C semantics; existing expiry/epoch/replay rules remain authoritative. We add no latest-review-wins policy.

### Runtime and limits

`console-activation-host.ts` is a separate loopback-only entrypoint. It requires explicit PAYFLOW_M5C_DEMO=true, privately configured DATABASE_URL, PAYFLOW_M5C_PRINCIPAL_ID, PAYFLOW_M5C_AGENT_ID and PAYFLOW_M5C_BOOTSTRAP_KEY. It does not auto-provision or migrate financial state. An operator must already provision the selected principal/passport/policy through trusted existing mechanisms. After building the console, the development entrypoint is `node --import tsx src/console-activation-host.ts`. No credential values should appear in commands, logs, screenshots or PR evidence.

The recorded M5B interpretation demo limitation remains explicit: the M5C runtime uses only a fully specified recorded sample; it constructs no live Groq/PayPal provider. Generic providers can be injected for deterministic tests, but no provider receives identity/session/database capabilities. Original M5B host remains incapable of activation. Home/Activity/Authority illustrations stay labelled fixtures; only the separate exact confirmation and fresh saved-state view represent durable activation.

Session state and challenge cache are process-local and lost on restart. Restart fails closed for unfinished confirmations; an already-created mandate remains durable and may be freshly read after a new authenticated demo session. This is a single-process local demo, not a distributed production session system. Hosted console: NOT DEPLOYED; hosted authenticated acceptance remains required in M5E. No new migration is needed. M5D controls and M6 execution are NOT STARTED.

### Validation boundary

M5C tests cover the actual local HTTP/session path into the existing durable activation transaction, one mandate under concurrency/replay, owner/agent/epoch/passport/principal/challenge/hash/fingerprint failures, cookie/CSRF/origin/expiry/logout failures, and read-only refresh with zero payment/reservation/grant/proposal rows. Existing M1–M4 tests are unchanged. Console tests cover the exact sheet, client races/expiry/reload and the requirement for a successful fresh read before ACTIVE. Session tests cover forged/cloned proofs, action/audience binding, HttpOnly/Secure attributes and private-token exclusion. Normal CI constructs no live provider.

M5C stops for independent GUIDE review. PR #12 must stay DRAFT / OPEN / UNMERGED. Do not start M5D or M6.

## M5D — authority controls and durable Activity

M5A/B/C are CLOSED / PASS for progression. The preceding phase-stop notes are preserved historical evidence; this section is the authorized M5D continuation. Accepted M5C head: `831d21e1f928faae4b8db6247d80c69329d7fbd8`. M5D reuses its fixed-owner non-production sessions, private bootstrap, opaque cookie, CSRF/origin/audience/expiry protections and exact activation path unchanged.

### Control and read boundaries

`ConsoleControls` exposes a bounded latest-20 owner-scoped Authority list through the accepted `AuthorityViewService` and `PostgresAuthorityViewReader`. Each item comes from a fresh durable read and accepted accounting. A malformed/unavailable item fails the list closed. The list is not a new authorization policy. Active display still means fresh-dispatch permission is not established (null); every future execution must use the existing kernel/revalidation path.

The only new control is explicit `REVOKE_AUTHORITY`. The host verifies the existing session, exact same origin, CSRF, strict action/mandate selector and durable principal ownership/integrity before calling the existing `PostgresTrustRepository.revokeMandate`. That accepted transaction alone updates revoked_at and appends the existing MANDATE_REVOKED event. Repeated/concurrent requests read the durable winner and do not append another event. No existing receipt, evidence entry, reservation, grant, provider observation or payment is rewritten. No refund or cancellation is claimed. No mandate suspension semantics exist; no pause mutation is introduced. An already-suspended agent passport can be displayed as Paused using accepted durable facts.

The API returns a bounded acknowledgement, not a revoked projection. The controller enters REVOKING then VERIFYING, performs separate fresh GETs and displays Revoked only when the saved Authority says REVOKED. Failure retains the prior snapshot with a safe warning; manual/periodic reads correct it. Reload restores no browser-owned state. Current-state reads, not cache/query-string claims, control display. The confirmation sheet explicitly says completed payments are not reversed.

### Activity and verification

`ConsoleActivity` reads the latest 20 proposal-backed operations, or one exact operation selector, using server-side mandate/principal ownership before invoking the existing `OperationTraceService`. It checks trace principal/mandate/agent/proposal references against the selected owner-bound record before disclosure. The accepted service remains the sole operation verifier. Durable validated DecisionReceipts supply the decision and bounded reason-code explanations; browser history supplies nothing.

`ActivityItemSchema` is a strict bounded presentation projection, not a second verifier. It retains the exact trace status and bounded stages. Verified CAPTURED can show money moved YES; accepted verified no-effect finalization or explicit denied-before-execution evidence can show NO. Ambiguous/in-flight outcomes remain UNKNOWN. INVALID, INCOMPLETE and LEGACY are not upgraded to completed/verified payment. Untrusted provider bodies, payer details, raw signatures, authentication assertions, session cookies, challenges, resume secrets and credentials are absent. Technical order/capture/attempt references are available only in progressive disclosure. No request path constructs or calls a provider.

New same-origin routes in the opt-in demo host:

- GET `/api/activation/authorities` — no browser parameters;
- GET `/api/activation/activity` — optional sole `operationId` selector;
- POST `/api/activation/revoke` — exact action and mandate ID, authenticated/CSRF protected.

Reads set no-store, append no evidence and perform no financial mutation. The host has no payment rail. Tests use existing deterministic financial fixtures solely to establish legitimate historical states in an isolated PostgreSQL test database; they do not add an execution API or make live provider calls.

### Product and limits

The console supplements the labelled example Authority with durable management cards and replaces fixture Activity with the durable journal. It shows limits/accounting/quantity/scope/capabilities/thresholds/timestamps, readable status, current dispatch block facts, an explicit revoke sheet and progressive operation details. Lists refresh manually, on focus and every 15 seconds; bounded request timeouts and stale-request epochs prevent late results from replacing newer state. Local expiry hides stale active display pending a fresh server read. Related Authority links use durable IDs as selectors and reauthenticate on read.

This remains a fixed-owner, single-process, loopback-only NON-PRODUCTION DEMO, not production authentication. No new infrastructure or migrations; migrations 001–009 and accepted financial/domain/activation/verification code are unchanged. Historical verification needs retained public signing keys: tests inject the trusted public-key ring; the local CLI supplies an empty ring and therefore honestly returns INCOMPLETE when the accepted verifier needs an unavailable key. It never fabricates verification. The bounded list covers proposal-backed operations; pre-proposal selection/quote refusals and deep paginated Studio/history are not added. Lists are latest 20, not a claim to show every Authority/operation. Activity records outside the Authority list remain accessible through the exact owner-bound Authority read.

### Validation and stop gate

New tests cover actual HTTP revoke/read routes, owner and selector isolation, CSRF/origin/session/expiry failures, concurrent idempotency, fresh stale-state correction, accepted authorization rejection after revoke, unchanged completed payment truth, no read evidence/mutation/provider effects, accurate ALLOW/DENY/ESCALATE/unknown/no-effect/completion projections, exact trace verdict preservation, sensitive-field exclusion, controller races/failures/reload/expiry and rendered confirmation/disclosure states. Existing M1–M4 tests remain required. Normal CI live PayPal/Groq/external-auth calls are zero.

Hosted console: NOT DEPLOYED. M5E owns hosted end-to-end acceptance and is NOT STARTED. M6 is NOT STARTED. M5D implementation candidate must stop for independent GUIDE review. Keep PR #12 DRAFT / OPEN / UNMERGED; do not mark ready or merge.

## M5E — adversarial and hosted acceptance (candidate)

M5A–M5D are CLOSED / PASS at their accepted heads; M5D head `38655faa7a23151d8a40e25f6cc664dad586309f`. M5E changes no accepted financial, authentication, session, activation, verification, provider or migration code: `src/`, `db/` and `api/` are byte-identical to the accepted M5D head. All M5E changes are tests, a test-only host, console presentation fixes found by the visual/browser review, CI, and this document.

### Hosted deployment — BLOCKED — ARCHITECTURAL BOUNDARY

> **Superseded by M5E-HOST (section below).** This section is preserved as the historical record of the original blocker; the blocker was closed by durable host state and a real hosted acceptance.

A real hosted deployment was attempted as an investigation and **was not performed**. Nothing was created, deployed or configured on any host.

- **Blocker 1 (accepted boundary):** the M5C host keeps sessions (`ConsoleSessions`) and the exact-review challenge cache (`ConsoleActivation`) in process memory. This is the accepted, documented semantic ("process-local; restart fails closed"). Vercel Functions give no single-instance guarantee, so login, review and confirmation could land on different instances and the confirmation would fail closed at random. Making sessions/challenges durable would redesign session semantics and the HumanConfirmationBoundary hand-off, which M5E may not do.
- **Blocker 2 (infrastructure):** no durable PostgreSQL exists for M5. The only database account visible to this session (Supabase) holds unrelated products' databases; none is an approved, isolated PayFlow M5 database. Creating one is new paid infrastructure plus secret handling, which needs an explicit owner decision.
- **Blocker 3 (entrypoint):** `console-activation-host.ts` hard-codes `http://127.0.0.1:8080` and loopback listen. `ConsoleSessions` already supports an HTTPS audience (`__Host-` prefix, `Secure`), but the entrypoint exposes no way to configure it. A narrow configurable-origin change would be possible, but is moot without 1 and 2.
- **Preserved:** the existing Vercel project `payflow` (payer-return deployment) was only listed, not modified. No environment variable, domain or deployment was touched.
- **What would unblock it (GUIDE decision):** an owner-approved single-process, long-lived host (container/VM) behind TLS, plus an isolated PostgreSQL provisioned operator-side with migrations 001–009, one principal, one AgentPassport and one activation policy. Required environment (names only, values supplied privately): `PAYFLOW_M5C_DEMO=true`, `DATABASE_URL`, `PAYFLOW_M5C_PRINCIPAL_ID`, `PAYFLOW_M5C_AGENT_ID`, `PAYFLOW_M5C_BOOTSTRAP_KEY` (at least 32 random bytes), and a configurable HTTPS origin (the narrow entrypoint change above). Hosted HTTPS, Secure/`__Host-` cookie and exact-origin behavior are therefore proven only at unit level (`tests/console-session.test.ts`), not on a hosted URL.

Hosted URL: NONE. Hosted acceptance: NOT PERFORMED (blocked as above).

### Demo-auth limitation (unchanged)

Identity remains the accepted NON-PRODUCTION fixed-owner demo: a privately configured operator code, a server-configured principal and agent, process-local opaque sessions. No production authentication is claimed. The UI states "Non-production workspace · No production login".

### M5E architecture

- `tests/m5e-adversarial.integration.test.ts` — the adversarial matrix over the real HTTP host and real PostgreSQL (39 tests).
- `tests/e2e-host.ts` — TEST-ONLY host. It wires the same handler, sessions, recorded model and owner-bound controls as the opt-in host against an isolated database with an adjustable clock and a loopback control port (advance time, revoke "from another device", count financial rows). It is not product code and is never deployed.
- `apps/console/e2e/journey.e2e.mjs` — 10 Chromium tests on the real static console (`npm run test:e2e` in `apps/console`; dev dependency `playwright-core` 1.56.1, console-only). No live Groq or PayPal. CI job `console-e2e` runs it with a PostgreSQL service.
- Console fixes from the visual/browser review (presentation only): (1) after a revoke completes, the exact-confirmation card re-reads durable state instead of continuing to show "Authority active" until its own poll; (2) a meaningful Activity empty state when signed out or unavailable; (3) "1 item remaining" pluralization; (4) 44px minimum touch targets on narrow/coarse-pointer screens (previously 18–37px for navigation, buttons, disclosures; the skip link measured 42px on the CI runner's fonts while passing locally, so it is now sized explicitly rather than by font metrics).

### Adversarial matrix and evidence

"M5E" = `tests/m5e-adversarial.integration.test.ts`; "M5C" = `tests/console-activation.integration.test.ts`; "M5D" = `tests/console-controls.integration.test.ts`; "E2E" = `apps/console/e2e/journey.e2e.mjs`.

| Case                                                               | Result      | Evidence                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1–A5 amount, merchant, quantity, condition, capability tampering  | PASS        | M5E "A1-A5 confirm with injected …" (13 fields) confirms the untampered review still yields exactly the reviewed terms; "review request with client …"; M5C "rejects client … substitution"              |
| A6 injected ACTIVE                                                 | PASS        | M5E "A6/A7 injected ACTIVE state and remaining budget are rejected" (query and header); M5C fresh read                                                                                                   |
| A7 injected remaining budget                                       | PASS        | M5E "A7 remaining budget is the durable accounting value"                                                                                                                                                |
| B1 tampered cookie                                                 | PASS        | M5E "B1 a single changed character…"; E2E "tampered session cookie…"; `console-session.test.ts`                                                                                                          |
| B2 expired session                                                 | PASS        | M5E "B2"; M5C expiry; E2E "session expiry on the server…"                                                                                                                                                |
| B3/B4 missing, empty, wrong CSRF                                   | PASS        | M5E "B3/B4" (3 variants × review, confirm, revoke, logout); E2E "CSRF failure…"                                                                                                                          |
| B5 cross-origin                                                    | PASS        | M5E "B5 cross-origin mutation" (4 variants), "no CORS grant on any response"                                                                                                                             |
| B6 arbitrary principal                                             | PASS        | M5E "B6" (body, query, header, login)                                                                                                                                                                    |
| B7 another principal's mandate                                     | PASS        | M5E "B7": response identical to an unknown ID, durable state unchanged; M5D "wrong owner"                                                                                                                |
| C1 expired review                                                  | PASS        | M5E "C1"; M5C "rejects disabled principal and expired review"                                                                                                                                            |
| C2/C3 replay, concurrent confirmation                              | PASS        | M5E "C2/C3 many concurrent confirmations" (8 parallel → exactly one Mandate); M5C replay                                                                                                                 |
| C4–C7 tampered display hash, fingerprint, reviewed hash, challenge | PASS        | M5C "tampered … handle", "core rejects corrupted durable …"                                                                                                                                              |
| C8 changed principal/agent/policy epoch                            | PASS        | M5C "core rejects changed … epoch"                                                                                                                                                                       |
| C9 suspended/revoked/expired passport                              | PASS        | M5C "core rejects … passport"                                                                                                                                                                            |
| D1–D4 revoke, reload, stale tab, repeat                            | PASS        | M5E "D1-D6/E1-E5" (3 concurrent + 1 repeat → one MANDATE_REVOKED event); E2E "stale tab…", "double-click…"                                                                                               |
| D5 wrong principal revoke                                          | PASS        | M5E "D5"; M5D "wrong owner…"                                                                                                                                                                             |
| D6 revoke payment side effects                                     | PASS (zero) | M5E and E2E assert zero payment rows after revoke                                                                                                                                                        |
| E1–E5 read-only reload/Activity/details/refresh                    | PASS        | M5E "D1-D6/E1-E5" (5× all read routes, evidence and mandates byte-identical); E2E 3× reload; M5D "reloads do not append evidence or call provider"                                                       |
| F1–F7 Activity truth                                               | PASS        | M5D (DENY, ESCALATE, ALLOW, pending, CAPTURED, no-effect, UNKNOWN, INVALID, INCOMPLETE) and `tests/activity-projection.test.ts` (INVALID/INCOMPLETE/LEGACY never upgraded) — all pre-existing, unchanged |

Host surface (M5E): no debug/environment/provision endpoint; no stack traces or secrets in errors; unauthenticated visitors mutate nothing; cookie attributes and no secret/raw challenge in login or review output; a review with no confirmation leaves no Mandate.

### Secrets and log review (local)

Static export scanned for `DATABASE_URL`, `postgres://`, Groq/PayPal names, private keys, bootstrap, resume/grant and challenge material: none. The E2E captures every same-origin response body and header during a full journey and asserts the bootstrap code, database URL and the same patterns are absent. Host source contains two `console.log` calls, both fixed startup banners without values; the catch-all handler logs nothing. CI output carries no secret (test credentials are ephemeral CI-service values).

### Zero-payment closure

After every browser journey and every adversarial journey the tests assert zero rows in `payment_attempts`, `authorization_reservations`, `execution_grants`, `transaction_proposals` and `paypal_provider_observations`. M5 spends nothing.

### Visual, accessibility and quality review

Reviewed in headless Chromium against the locally served console (not a hosted URL): desktop 1280px home, confirmation and revoked states; mobile 375px revoke sheet. Findings fixed (listed above). Remaining observations for GUIDE, not fixed because they belong to accepted M5A/M5B composition: Home stacks Ask, review, confirmation, a labelled fixture Authority card, saved authorities and Activity in one long scroll; the labelled example card persists beside real saved authority. Automated checks: no horizontal overflow at 375px on home, confirmation, authority and revoke sheet; every interactive element at least 44×44px on mobile; keyboard-only journey from skip link through activation and revocation (focus moves to the revoke sheet); visible focus indicator; every input labelled; live regions present; reduced motion removes animation/transition; WCAG AA contrast ratios on all visible text; `details`/`summary` operable by keyboard; no runtime or hydration console errors; double-click produces one Mandate and one revocation; a server-unavailable read keeps the prior state with a safe message and shows no stack trace.

### Known limitations

- Hosted acceptance not performed (blocked above); hosted visual/performance/secret review is therefore local only.
- Fixed-owner, single-process, in-memory sessions; not production authentication.
- Recorded model behavior only; live Groq interpretation not exercised.
- Mobile and desktop review covered the states listed above rather than every screen state; no assistive-technology (screen reader) run, only programmatic accessibility checks.
- The accepted M2 test `paypal.integration.test.ts` "closure expiration before handoff while the passport lock is held" is timing-sensitive: it failed in 5 of 8 isolated runs and in one of three full runs on this machine, and passes when its whole file runs. Its source and the code it exercises are unchanged since M2/M5D. It is not modified here.

### M5E stop gate

M5E implementation is complete except hosted acceptance. M6 is NOT STARTED. PR #12 stays DRAFT / OPEN / UNMERGED pending GUIDE review.

## M5E-HOST — durable hosted acceptance

Accepted candidate before this work: `cacdf569a872b4013c48544dcdfa0a0350bf15a7` (CI run `39954606027`, all three jobs green). M5E-HOST closes only the hosted-acceptance gate. It does not change authentication semantics, the HumanConfirmationBoundary, IntentActivationService, Mandate, the Trust Kernel, payments, PayPal, reconciliation or OperationTraceService. M6 is NOT STARTED.

### What changed (and only that)

The blocker was process-local host state. Two things are now durable, behind two small ports, so any host instance (including a serverless invocation) can serve any request:

- **Sessions** — `DurableConsoleSessions` (`src/console-session-durable.ts`). Same M5C guarantees: opaque 256-bit token, **only its SHA-256 is stored** (never the raw token), fixed server-configured principal, HttpOnly + SameSite=Strict cookie (`__Host-` + Secure on HTTPS), explicit 15-minute expiry, CSRF synchronizer value (**derived** with an HMAC from a key derived from the operator secret, not stored), exact origin/host audience, bounded login-guessing window and per-session mutation budget (**atomic SQL shared by all instances**), logout revocation.
- **Pending exact confirmations** — `PendingStore` (`src/console-pending.ts`). The accepted in-memory store stays the default (local host unchanged). The PostgreSQL store keeps the server-only confirmation material; the raw activation challenge is stored only as **AES-256-GCM ciphertext** bound to its review id. Consumption is **one conditional `UPDATE`**, so at most one caller on any instance obtains it; the accepted M3C service still enforces replay/epoch/expiry/ownership independently.
- `ConsoleSessionPort` lets the accepted in-memory sessions and the durable sessions be used interchangeably (callers `await`). Activation, controls, activity and authority logic is otherwise untouched.
- **Migration `010`** (additive, host-state only): `console_demo_sessions`, `console_demo_login_window`, `console_pending_actions`. No foreign key to, and no write to, any financial table. Migrations 001–009 and all historical rows are unchanged.
- `createHostedConsole` (`src/console-hosted.ts`) and `hosting/m5/` form the thin Vercel adapter (HTTP -> durable session/security -> existing services). The recorded demo sample is a pure function of the hour bucket so every instance agrees on it.
- `hosting/operator/provision-m5.ts` is the **operator-only** provisioning script (never deployed, no HTTP surface). It applies migrations 001–010, then one principal, one passport and one activation policy, and **refuses any database that contains financial history**.

### Topology (separate from the payer-return project)

- Vercel project `payflow-m5-acceptance` (`prj_qJObWd2e02rgib4iXBRJsA7pbhim`), a different project from the payer-return project (`payflow`), root directory `hosting/m5`, built from `VictorCyberDev/PayFlow` at the accepted commit. Preview deployments are disabled; production deployments are created explicitly for an exact commit.
- Hosted URL: **https://payflow-m5-acceptance.vercel.app** (NON-PRODUCTION demo).
- Isolated PostgreSQL: a new, empty Neon project `payflow-m5-acceptance` (`dark-term-10581960`), database `m5_acceptance`. It is not the historical PayFlow database and holds no M4 evidence. Its schema fingerprint (columns, constraints, indexes, function bodies, triggers, enum types) is identical to a local database built from migrations 001–010.
- Deployment protection is turned off for this acceptance project only; access is gated by the operator code, shared rate limits, CSRF and exact-origin checks. The UI states it is a non-production demo.
- Environment (names only; production target; the two secrets are write-only sensitive variables): `DATABASE_URL`, `PAYFLOW_M5_BOOTSTRAP_KEY` (at least 32 random bytes), `PAYFLOW_M5_DEMO=true`, `PAYFLOW_M5_PRINCIPAL_ID`, `PAYFLOW_M5_AGENT_ID`, `PAYFLOW_M5_ORIGIN` (exact HTTPS origin).
- Security headers on every response: CSP (`default-src 'self'`; inline script/style allowed only because the Next static export requires it; `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, HSTS. API responses are `no-store` and grant no CORS; static assets carry a same-origin (not wildcard) CORS value.

### Findings from the live acceptance, and fixes

Hosted acceptance found five real problems that local tests could not (each reproduced against the real origin and fixed with the narrowest change):

1. The function build resolved `postgres`, `zod` and Node types from the repository root, but only the sub-projects were installed, so only the static console deployed. Install the root dependencies.
2. A catch-all filename (`[...path].ts`) did not match nested API paths for a non-framework project. Use `api/host.ts` plus a rewrite (the same pattern as the payer-return function).
3. A **named** rewrite parameter made Vercel append `?path=...` to every API request; the fail-closed host (exactly one `mandateId` allowed) correctly refused the Authority reads. Use an unnamed capture group.
4. Vercel serves static assets with `Access-Control-Allow-Origin: *`; overridden with the exact same origin for non-API paths.
5. The hosted secret-review regex matched a Next.js framework constant (`/ROOT/node_modules/...`); narrowed to real stack-trace patterns and extended with literal forbidden-secret checks supplied at run time.

### Evidence

- Local and CI (deterministic): the REQUIRED restart pattern (login, destroy host, session valid, pending review, destroy host, one confirmation, destroy host, replay refused); two independent instances sharing one database including concurrent confirmation across both; a store-level atomic-claim race (16 claimants over 4 connection pools, exactly one wins); durable session and exact-action regressions; provisioning guard and function-adapter tests. Mutation controls: swapping the durable pending store for the in-memory one fails 6 of those tests; removing the atomic-consume guard fails the store-level race test.
- Hosted, real HTTPS origin: `apps/console/e2e-hosted/hosted.mjs` **6 / 6** (headers and cookie attributes; full 20-step journey including stale-tab correction; adversarial checks; secret review of the client bundle and every response including literal database host/password; mobile 375 px; host-audience check), run twice on identical code.
- Hosted restart durability (real deployment replacement): a session and pending review created on one deployment were still valid on a brand-new deployment; the pre-restart review was confirmed once, replay was refused (409), the fresh read showed ACTIVE then REVOKED.
- Hosted concurrency: 8 simultaneous confirmations of one review produced exactly one activation (`200` once, `409` seven times).
- Database after all hosted runs: 9 mandates, all revoked, exactly one `MANDATE_REVOKED` event each; 39 evidence events with **0 broken hash-chain links and 0 sequence gaps**; **0** payment attempts, reservations, execution grants, transaction proposals, provider observations and receipts. Stored session hashes are all 64 characters; every pending challenge is ciphertext.
- Logs: the build event stream was read in full (no database URL/host/password, operator code or environment values); runtime logs are empty (the host writes nothing on request paths, and only a fixed token on misconfiguration).
- Visual: hosted desktop (confirmation, active, revoked) and mobile reviewed; no horizontal overflow, 44 px targets, meaningful empty states.

### Known limitations

- NON-PRODUCTION fixed-owner demo auth; recorded model behavior only; no production authentication claim.
- Another owner's mandate: proven by real-flow local suites (same code path) and, on the hosted origin, by an unknown/not-owned id being indistinguishable and unmutated; a hosted positive control with a second provisioned owner was not performed.
- After a revocation made in another tab, a tab's top confirmation card self-corrects on its own poll (at most 15 s) or its Refresh action; the saved-authority list corrects on focus and manual refresh.
- Vercel request-level logs were not retrievable through the available tooling, so access logs were not inspected.
- The acceptance database password and operator code necessarily passed through tool calls in the session that performed the deployment. Treat both as compromised after acceptance: delete the `payflow-m5-acceptance` Vercel project and Neon project, or rotate both.
- Pre-existing dev-only advisories (vitest/vite/esbuild at the root; `eslint-config-next` tooling in the console) are not shipped; production dependency audits report 0 vulnerabilities for both the root and the console.
- The accepted M2 test `paypal.integration.test.ts` "closure expiration before handoff while the passport lock is held" remains timing-sensitive locally; unchanged.
- Deployment is manual by design (previews disabled); the hosted function reflects the commit recorded in its deployment metadata (`81467da…`; later commits change only documentation).

### Stop gate

M5E-HOST is complete when exact-head CI is green. M5 is ready for final GUIDE closure review; M6 is NOT STARTED; PR #12 stays DRAFT / OPEN / UNMERGED.
