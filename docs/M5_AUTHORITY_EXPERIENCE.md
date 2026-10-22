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
