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
