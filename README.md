# PayFlow

**Verifiable financial authority for AI agents.**

> Give AI agents permission to spend — not control of your money.

PayFlow sits between probabilistic AI intent and deterministic money movement. An AI agent may interpret, rank and propose a commerce action; PayFlow decides whether exact financial authority exists, enforces that authority at execution time, reconciles the payment provider outcome and preserves verifiable evidence of what actually happened.

## Why PayFlow exists

AI agents are becoming capable of shopping, procurement and other money-moving actions. The hard problem is not making an agent click “Pay.” It is proving:

- who authorized the agent;
- which agent is acting;
- what exact authority was delegated;
- whether the proposed merchant/item/amount/quantity is allowed now;
- whether that authority is still active at dispatch time;
- whether the provider actually moved money;
- whether the result can be verified after retries, redirects, failures or ambiguity.

PayFlow is the authority and evidence layer for those questions. PayPal is the current execution rail, not the source of PayFlow authority.

## Product status

Accepted milestones on `main`:

| Milestone | Result |
| --- | --- |
| M1 — Trust Kernel | CLOSED / MERGED |
| M2 — Durable authorization, signed execution grants, PayPal recovery | CLOSED / MERGED |
| M3 — AI intent + authenticated mandate activation | CLOSED / MERGED |
| M4 — Trusted commerce + PayPal Sandbox acceptance | CLOSED / MERGED |
| Post-M4 — deterministic payer-return UX | CLOSED / MERGED |
| M5 — Authority Experience | CLOSED / PASS / MERGED |
| M6 — Delegated / Human-Not-Present Commerce | **NOT STARTED** |

The post-M5 roadmap is frozen in [`docs/ADR-016-post-m4-product-roadmap.md`](docs/ADR-016-post-m4-product-roadmap.md).

## Live previews

### M5 Authority Experience

**https://payflow-m5-acceptance.vercel.app**

This is the accepted **non-production** Authority Experience. It demonstrates:

- Ask PayFlow;
- untrusted AI interpretation presented as not yet authorized;
- exact authenticated confirmation;
- durable Authority views;
- remaining budget/constraints/expiry;
- Activity projections;
- authenticated revoke controls;
- durable hosted sessions and pending review state;
- stale/replay/tamper protections.

The hosted M5 environment intentionally uses a fixed-owner non-production demo identity and recorded model behavior. It is not a production identity system and M5 performs no PayPal capture.

### Real PayPal Sandbox terminal-payment proof

A separate accepted post-M4 deployment proves the real payment path and deterministic payer-return UX:

**https://payflow-git-post-payment-ux-reconciliation-start-up16.vercel.app/paypal/return?token=6P5145740X635133T**

Accepted Sandbox evidence for that operation:

- amount: **$84.00 USD**;
- PayPal order: COMPLETED;
- capture: COMPLETED;
- Payment Attempt: CAPTURED;
- execution grant: CONSUMED;
- reservation: COMMITTED;
- Trust Trace: VERIFIED;
- completed provider capture count: **exactly 1**;
- safe terminal resume: **0 additional captures**.

The public demos are deliberately separated today: M5 proves the premium Authority product and durable authenticated controls; the accepted M4/post-M4 environment proves real PayPal execution. M6 has not started.

## The authority chain

```text
Human instruction
        ↓
AI interpretation (untrusted)
        ↓
Exact authenticated activation
        ↓
Mandate + AgentPassport
        ↓
Deterministic Trust Kernel
        ↓
Durable reservation
        ↓
Signed one-time execution grant
        ↓
Immediate authority revalidation
        ↓
PayPal execution
        ↓
UNKNOWN-safe reconciliation
        ↓
Durable evidence + Trust Trace
```

The model never grants itself financial permission.

## Core security invariants

- AI/model output is untrusted until exact authenticated confirmation.
- Browser state is never financial truth.
- `Mandate` is the durable financial-authority object.
- `AgentPassport` is the durable agent identity/capability object.
- DENY never reaches the payment provider.
- Escalation requires a separate authenticated human action.
- Budget and quantity consumption use durable transactional reservations.
- Execution grants are signed, exact-bound, short-lived and one-time claimable.
- Authority is revalidated immediately before new provider effects.
- Revoked or expired authority cannot authorize new dispatch.
- Ambiguous provider outcomes enter UNKNOWN/quarantine rather than being guessed as failed.
- Reconciliation observes existing provider effects without silently creating a replacement purchase.
- Checkout quote/manifest terms are bound to exact merchant/item/SKU/condition/quantity/amount/currency expectations.
- PayPal return parameters are notifications, not financial authority.
- `OperationTraceService` verifies historical relationships from durable state.
- Historical evidence is not rewritten to make a demo look cleaner.

## PayPal integration

The accepted payment path uses the **PayPal Sandbox Orders v2 API** with server-side OAuth and `intent=CAPTURE`.

PayFlow persists a durable Payment Attempt before provider side effects and keeps stable provider idempotency identifiers. It explicitly represents payer approval, capture ambiguity and reconciliation.

A PayPal order being created is **not** treated as payment success. A successful operation requires provider conformance plus durable local finalization.

Normal tests and CI do not contact PayPal. Live Sandbox smoke/acceptance paths require explicit opt-in and external credentials.

## AI integration

PayFlow's intent pipeline can use a server-side model provider to interpret natural-language delegation into a strict structured draft. The accepted implementation includes a bounded Groq integration and deterministic local compilation/semantic checks.

The model:

- receives untrusted source intent;
- cannot create a trusted Mandate directly;
- cannot authenticate the user;
- cannot issue execution grants;
- cannot dispatch PayPal;
- cannot widen local review bounds;
- cannot override deterministic authorization.

The product rule is simple:

> **The AI interprets your intention. It does not grant itself permission.**

## Authority Experience

M5 adds a premium product layer above the accepted kernel rather than a second permission model.

Top-level surfaces:

- Home
- Ask PayFlow
- Authority
- Activity
- Agents

The primary UX uses human language such as:

- “Up to $100”
- “1 new item”
- “Approved merchants only”
- “Expires Friday at 6:00 PM”
- “Your agent can complete this without asking again”

Technical details remain behind progressive disclosure.

See [`docs/M5_AUTHORITY_EXPERIENCE.md`](docs/M5_AUTHORITY_EXPERIENCE.md) for the accepted M5 evidence and boundaries.

## Repository structure

```text
apps/console/      premium Authority Experience
api/               bounded deployment/API entry points
db/migrations/     forward-only PostgreSQL migrations
hosting/            hosted M5 adapter and operator-only provisioning tooling
src/                trust kernel, intent, authority, commerce and provider services
tests/              deterministic, adversarial and PostgreSQL integration suites
docs/               architecture decisions and acceptance evidence
```

## Development

Requirements:

- Node.js / npm compatible with the lockfile;
- PostgreSQL for integration tests;
- no external provider credentials required for normal validation.

Install and run the main validation gates:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:coverage
npm audit --omit=dev --audit-level=high
npm run build
```

Console validation:

```bash
cd apps/console
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

For integration tests, point `TEST_DATABASE_URL` at a disposable PostgreSQL database.

### Optional live provider smoke tests

Live providers are always explicit opt-in. Credentials alone do not enable them.

Groq intent smoke:

```bash
RUN_GROQ_SMOKE_TEST=true npm run test:groq:smoke
```

PayPal Sandbox smoke:

```bash
PAYPAL_ENVIRONMENT=sandbox \
RUN_PAYPAL_SANDBOX_SMOKE_TEST=true \
PAYPAL_CLIENT_ID=... \
PAYPAL_CLIENT_SECRET=... \
npm run test:paypal:sandbox
```

Never commit provider credentials, database URLs, bootstrap/operator codes, PayPal payer credentials, resume capabilities or signing secrets.

## Accepted M5 verification baseline

Final M5 branch head: `773de321e8ed6f262e22c4a2f489b6021b3ba3de`.

Merged main baseline: `771a1128392390c2015e40a543db496f5bda8fc9`.

Accepted exact-head CI: GitHub Actions run `39968156114` — SUCCESS.

Final reported M5 validation included:

- root tests: **1,679 passed, 0 failed, 3 skipped**;
- PostgreSQL integration list: **755 passed, 0 failed**;
- statements coverage: **95.37%**;
- branches: **90.03%**;
- functions: **94.16%**;
- console tests: **67 / 67**;
- Chromium E2E: **10 / 10**;
- root and console production audits: **0 vulnerabilities**;
- hosted acceptance: PASS.

Migration `010` adds only durable non-production host/session/pending-action state for M5. Migrations `001` through `010` are frozen by ADR-016; future schema work, if explicitly authorized by a later milestone, begins at `011`.

## Roadmap — frozen, M6 not started

The accepted sequence is:

1. **M6 — Delegated / Human-Not-Present Commerce**
2. **M7 — Live Agent Commerce Gateway**
3. **M8 — Interoperable Verifiable Authority**
4. **M9 — Trust Experience + Break PayFlow Arena**
5. **M10 — Judge-Proof Acceptance and Submission**

ADR-016 also locks later work around protocol-neutral interoperability, merchant-verifiable agent identity, scoped external-agent access, portable outcome evidence, the Break PayFlow benchmark and final judge-repository/Devpost acceptance gates.

None of those later milestones are implemented merely because they are described here.

## Current non-goals

PayFlow is deliberately not trying to become:

- a bank;
- wallet/custody infrastructure;
- a card issuer;
- a lender;
- a proprietary LLM;
- a generic browser agent;
- a replacement for PayPal/Stripe/Visa/Mastercard payment rails;
- a second protocol-specific policy engine.

The product moat is the complete conserved authority chain from human instruction to independently verifiable financial outcome.

## Open source

PayFlow is released under the [MIT License](LICENSE).

## Safety / environment note

This repository currently demonstrates financial authorization and PayPal integration in **Sandbox/non-production environments**. It is not production banking infrastructure, a custody service or a claim of regulatory certification.