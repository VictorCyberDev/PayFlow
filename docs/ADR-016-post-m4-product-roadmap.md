# ADR-016: Post-M4 product roadmap and architecture lock

Status: **LOCKED / FROZEN POST-M5**

Freeze date: 2026-10-23

Authoritative implementation baseline: `main` at `771a1128392390c2015e40a543db496f5bda8fc9` after merged PR #12.

Current milestone state:

- M1 — CLOSED / MERGED
- M2 — CLOSED / MERGED
- M3 — CLOSED / MERGED
- M4 — CLOSED / MERGED
- Post-M4 payer-return UX repair — CLOSED / MERGED
- M5 — CLOSED / PASS / MERGED
- **M6 — NOT STARTED**

This amendment freezes the architecture and roadmap after M5. It is documentation-only. It does **not** authorize or begin M6, create an M6 branch, change financial semantics, change provider behavior, add a migration, or modify the M5 hosted acceptance environment.

## Product position

PayFlow is **verifiable financial authority for AI agents**: the authorization and evidence layer between probabilistic AI intent and deterministic money movement.

North star:

> AI may interpret, rank and propose. PayFlow determines whether financial authority exists, what exact authority exists, whether it is still valid at dispatch time, and how the resulting financial outcome can be independently verified.

Consumer promise:

> Give AI agents permission to spend — not control of your money.

Developer promise:

> Add deterministic financial authority, bounded execution and verifiable outcomes to an AI agent without giving the model direct control of payment credentials or financial truth.

Enterprise promise:

> Let agents act without losing control, accountability or auditability.

PayFlow is not a payment rail, wallet, bank, card issuer, credit provider, custody system, browser agent or generic checkout assistant. Payment providers remain execution rails. PayFlow owns the authority decision, bounded execution contract, reconciliation relationship and proof layer above them.

## Strategic amendment incorporated by this freeze

The final pre-lock research established that the agentic-commerce market is converging on five separate trust questions:

1. who is the human/principal;
2. which agent is acting;
3. what exact authority the human delegated;
4. whether this exact action is permitted now;
5. what financial effect actually occurred and whether that outcome can be independently proven.

The existing PayFlow architecture is already strongest at questions 3–5. The frozen roadmap therefore strengthens later milestones around externally verifiable agent identity, protocol-neutral interoperability, scoped agent access, merchant-side trust and portable outcome evidence without replacing the accepted kernel.

### Protocol-neutral rule

PayFlow MUST remain protocol-neutral. AP2, ACP, UCP, MCP, WebMCP and future agent-commerce protocols are adapters, transport or interoperability contexts — never new sources of financial authority.

No later milestone may claim official compliance, certification or compatibility with AP2, ACP, UCP, Visa Trusted Agent, Mastercard Agent Pay, AuthZEN or another standard unless that exact claim has been independently demonstrated and the relevant requirements are satisfied.

### Rail-neutral rule

PayPal remains the accepted execution rail for the hackathon path. Future payment-rail adapters may be considered after the locked competition roadmap, but they must not replace PayFlow's authorization semantics or become required to complete M6–M10.

### Commercial wedge

The consumer keyboard flow remains the primary competition demonstration because it is universally understandable. The likely first commercial wedge is B2B recurring or low-risk operational spend: procurement agents, approved-vendor purchasing, recurring supplies, controlled SaaS/vendor spend and similar bounded workflows where organizations want less repeated approval without surrendering control.

This commercial positioning does not alter milestone acceptance criteria.

---

# Global non-regression boundary

M1–M5 and the post-M4 payer-return repair are accepted foundations.

Future work MUST NOT redesign, replace or weaken:

- the Trust Kernel or `authorize()` financial decision semantics;
- `AgentPassport` as the durable agent identity/capability object;
- `Mandate` as the durable financial-authority object;
- intent compilation and the rule that model output is untrusted;
- `HumanConfirmationBoundary` and exact authenticated-action binding;
- durable reservations and authority accounting;
- signed execution grants and one-time claim semantics;
- Payment Attempt state transitions;
- PayPal dispatch, UNKNOWN quarantine, reconciliation or provider-conformance semantics;
- M4 discovery/selection trust boundaries;
- M4 checkout quote/manifest binding;
- payer-approval/resume revalidation;
- the evidence ledger and historical evidence;
- `OperationTraceService` verification semantics;
- the accepted M5 Authority projections, owner isolation, authenticated controls and durable hosted session/pending-action semantics.

Historical migrations **001 through 010 are immutable**. Migration 010 is the accepted M5 durable-host/session/action migration. Any future schema work begins at **011**, is forward-only, and requires the active milestone to justify it.

Browser/client state is never financial truth. UI state cannot authorize payment, widen authority, fabricate verification, downgrade durable completed state, bypass immediate server-side revalidation, or convert an external protocol assertion into PayFlow authority.

External agents, models, merchant observations, MCP tools, discovery providers, protocol messages, credentials, identity assertions and payment-provider responses are inputs/evidence. None may silently become financial authority.

## Product architecture boundary

The root package remains the trust-kernel/server foundation. Product surfaces remain isolated from the kernel dependency graph.

Browser or external-agent clients must never receive:

- database credentials;
- signing keys;
- raw execution-grant tokens;
- resume secrets;
- bootstrap/operator credentials;
- PayPal credentials or OAuth tokens;
- raw provider blobs containing payer-sensitive data;
- unrestricted persistence access;
- a credential whose scope bypasses normal PayFlow authorization.

Read-only product views and external verification interfaces must use bounded projections derived from authoritative durable state. `OperationTraceService` remains the canonical verifier for operation history.

## Experience principles

PayFlow should feel like a premium AI workspace crossed with a financial wallet, not a security console.

Visual thesis: **calm authority**.

Primary language must lead with the human outcome, not internal state-machine vocabulary. Use progressive disclosure:

1. what the agent may or may not do;
2. what happened and whether money moved;
3. why PayFlow allowed/denied/quarantined it;
4. verification detail;
5. raw identifiers/fingerprints only on deliberate expansion.

Top-level product surfaces remain intentionally small:

- Home
- Ask PayFlow
- Authority
- Activity
- Agents

The complete differentiator remains:

**human instruction → authenticated activation → bounded agent authority → deterministic commerce decision → reservation → one-time execution authority → provider execution → durable reconciliation → verifiable proof**.

---

# M5 — Authority Experience

Status: **CLOSED / PASS / MERGED**.

M5 made the accepted AgentPassport + Mandate architecture understandable and safely operable as a premium product without creating a second permission model. It introduced the user-facing Authority experience, natural-language review, exact authenticated activation, durable Authority reads, authenticated revoke controls, bounded Activity projections and a hosted non-production acceptance environment.

M5 is frozen. Later work composes above accepted M5 behavior.

---

# M6 — Delegated / Human-Not-Present Commerce

Status: **NOT STARTED**.

## Goal

Prove that a previously authenticated, bounded human instruction can safely authorize later agent execution without a new human confirmation when — and only when — the existing Mandate explicitly permits that exact transaction.

This is explicit delegated authority, not autonomy by default.

## Design rule

HNP execution MUST derive from existing Mandate thresholds/capabilities plus normal reservation, signed execution grant, immediate durable revalidation, provider conformance and reconciliation. Do not create a second HNP policy engine.

## Required scenarios

- legitimate pre-authorized purchase succeeds without another approval step;
- price drift beyond authority is denied before new provider capture;
- wrong merchant/product/condition/quantity is denied;
- revoked/suspended/expired authority produces zero new financial dispatch;
- concurrent attempts cannot overconsume budget or quantity;
- existing provider effects remain truthfully reconcilable after authority becomes unavailable;
- execution remains one-time and replay-safe.

## Hard gate

PASS requires deterministic unit/integration/concurrency coverage, adversarial zero-effect proofs, and one end-to-end PayPal Sandbox proof of delegated execution under valid bounded authority.

No M6 implementation is authorized by this ADR amendment alone.

---

# M7 — Live Agent Commerce Gateway

## Goal

Connect live agents and commerce inputs to the accepted PayFlow trust boundary while keeping every external system untrusted.

## Locked direction

- replace demo-only discovery on the winning path with live commerce input such as Channel3 where available;
- expose PayFlow to external/model agents through a bounded gateway;
- compose with PayPal Agent Toolkit/MCP or equivalent PayPal developer capabilities where appropriate rather than duplicating their payment-rail role;
- separate read-only discovery/verification operations from money-moving requests;
- require scoped agent authorization rather than one omnipotent API key;
- treat modern MCP/OAuth/OIDC resource authorization concepts as transport/access controls, not financial authority;
- demonstrate that an external agent can request an action but cannot widen a Mandate, forge Authority, obtain unrestricted payment authority or bypass the Trust Kernel.

Illustrative access scopes may include read-only Authority, purchase-request and verification permissions, but scopes do not replace Mandate authorization.

## Hard gate

PASS requires live input on the demonstration path, strict normalization/bounds, deterministic eligibility, trusted-term resolution, zero silent merchant substitution, scoped external-agent access and successful use of the accepted PayPal execution path without bypassing the kernel.

---

# M8 — Interoperable Verifiable Authority

## Goal

Make PayFlow identity and authority independently consumable and verifiable across agent, merchant, tool and protocol boundaries without giving the verifier a money-moving capability.

## Locked direction

### Merchant-verifiable agent identity

Create a bounded signed external assertion derived from the existing `AgentPassport`; do not invent a replacement identity model. A merchant/tool/verifier should be able to validate which PayFlow agent is acting, its declared purpose/audience, the referenced Authority, expiry and replay-resistant request context.

The assertion itself never authorizes a PayFlow payment. Final financial authority remains server-side and is revalidated by the accepted kernel.

### External Authority verification

A third party should be able to ask, through a read-only interface:

- which principal delegated authority;
- which agent is acting;
- scope, budget, expiry and capability;
- whether Authority is active/revoked/expired;
- whether a proposed action fits within it;
- what operation ultimately occurred.

### Protocol adapters

Provide bounded adapter/mapping work informed by AP2, ACP and UCP where useful. PayFlow remains the canonical authority model. Protocol-specific envelopes must not become a second permission engine.

MCP/WebMCP remain interaction protocols, not proof that payment authority exists.

## Hard gate

PASS requires independently callable read-only verification that cannot move money or widen authority, discloses no sensitive execution material, resists replay/tamper, and proves both valid and invalid/revoked/expired cases from durable PayFlow state.

---

# M9 — Trust Experience + Break PayFlow Arena

## Goal

Turn PayFlow's technical truth into the strongest visual and independently inspectable proof in the competition.

## Premium trust experience

The default experience must show:

- what happened;
- amount;
- merchant/item;
- whether money moved;
- which Authority applied;
- remaining authority;
- concise human explanation.

Expanded verification may show:

- human instruction/activation;
- agent identity;
- budget/merchant/product/quantity checks;
- quote/manifest relationship;
- grant/reservation state;
- provider order/capture state;
- Trust Trace stage status;
- technical references/fingerprints.

## Portable evidence / recourse receipt

M9 must expose a bounded, human-readable, read-only evidence package derived from existing evidence and verification services. It should communicate instruction, authority, agent, evaluated commerce terms, PayFlow decision, provider execution, capture count, final outcome and Trust Trace verdict.

This artifact is evidence, not a legal-liability determination and not a new source of authorization.

## Break PayFlow Arena

Use existing adversarial contracts and accepted services. Do not create a parallel security engine.

Selected live/hosted scenarios should include:

- prompt-injected price widening;
- $84 → $184 price drift;
- wrong merchant;
- used/refurbished substitution;
- quantity widening;
- agent impersonation or invalid external assertion;
- scope escalation;
- revoked mandate during checkout;
- expired authority;
- replay;
- duplicate browser return;
- lost provider response;
- concurrent execution;
- tampered verification material.

Each scenario leads with the financial outcome:

**Money moved: $0** or **Exactly one capture completed**.

### Break PayFlow 100

The competition proof should target a fixed benchmark of 100 adversarial agent-commerce scenarios, built from deterministic test/evidence contracts rather than manually curated screenshots.

The benchmark may be claimed only if the full fixed suite is reproducible and its results are recorded. Desired headline: **100 adversarial scenarios; 0 unauthorized captures; valid delegated payments still complete.** Do not claim this before the benchmark exists and passes.

## AG Grid / Studio strategy

AG Grid/Studio may be used for a Trust Studio/attack command center only if it materially improves investigation and is deep enough to justify sponsor claims. The consumer Authority Wallet remains a custom premium product surface.

## Hard gate

PASS requires a premium hosted experience, mobile/desktop usability, accessibility, deterministic authoritative projections, portable evidence, and live demonstration of selected adversarial cases whose provider effects match durable evidence.

---

# M10 — Judge-Proof Acceptance and Submission

## Goal

Convert the complete PayFlow system into an undeniable competition entry without weakening engineering truth.

## Final acceptance matrix

Demonstrate where applicable:

- natural-language intent;
- exact human review/activation;
- premium active Authority;
- constrained live discovery;
- legitimate selection;
- trusted quote/manifest;
- ALLOW and DENY paths;
- delegated/HNP execution;
- PayPal Sandbox execution;
- payer-return durability;
- exact-one capture/idempotency;
- reconciliation after ambiguous provider state;
- revoked/expired zero-new-dispatch behavior;
- Trust Trace VERIFIED for conforming completed operation;
- invalid/tampered verification failure;
- externally verifiable agent/Authority assertion;
- selected Break PayFlow attacks and, if completed, Break PayFlow 100;
- complete regression/CI green.

## Judge Repository Gate

Before submission freeze, the public repository MUST:

- contain an approved OSI open-source `LICENSE` visible at the repository root;
- have a current README that presents the actual final product rather than obsolete milestone state;
- include reproducible setup/run instructions;
- explain exactly how PayPal and AI are used;
- distinguish current functionality from future roadmap work;
- document sponsor integrations actually used, without claiming planned integrations as implemented;
- provide a working hosted demo or complete local run path;
- expose no credentials, bootstrap codes, private tokens or payer secrets.

## Devpost Gate

Before submission freeze:

- project name, tagline and description are complete;
- public repository URL is final;
- working demo URL is final;
- testing instructions/credentials are safe and sufficient;
- required PayPal/AI tool explanations are complete;
- sponsor selections reflect only integrations actually implemented;
- public YouTube demo is under three minutes and demonstrates the working product on its intended device;
- all eligibility and submission fields are complete;
- the narrative clearly identifies meaningful work completed during the hackathon period.

## Judging strategy

Optimize explicitly for:

1. Technological Implementation — real PayPal path, deterministic authorization, signed grants, durable concurrency, reconciliation, live integration and evidence;
2. Design — complete premium product rather than developer console;
3. Potential Impact — the trust gap preventing consumers and enterprises from safely delegating financial actions to AI;
4. Innovation / Idea — verifiable delegated authority and outcome proof, not generic AI shopping;
5. Presentation — one coherent story within the first three minutes.

Preferred narrative:

1. human delegates bounded authority;
2. AI/external agent proposes an action;
3. PayFlow blocks a manipulated or unauthorized attempt with **Money moved: $0**;
4. a valid delegated transaction completes through PayPal exactly once;
5. the authority chain and provider outcome are independently verified.

Primary prize target remains overall first place. Sponsor integrations must strengthen the core product rather than distort it.

---

# Explicit non-goals through M10

Do not add, solely for breadth:

- PayFlow-issued cards;
- wallets or custody;
- lending/credit;
- banking infrastructure;
- ten payment rails;
- a PayFlow browser agent;
- a proprietary LLM;
- refunds/subscriptions/disputes merely to match a competitor;
- a new policy engine parallel to Mandate/Trust Kernel;
- protocol-specific authority semantics that replace PayFlow Authority.

Refund/dispute evidence may be represented read-only where it strengthens recourse understanding, but new money-moving refund/dispute behavior requires separate explicit authorization and is not implied by this roadmap.

---

# Milestone progression and freeze rules

1. M6 is **NOT STARTED** at the time of this freeze.
2. No M6 branch, migration, implementation, external integration or live financial attempt is authorized by this documentation change.
3. Only one milestone is active at a time unless a later milestone has an explicitly authorized read-only research spike.
4. Each implementation milestone begins from the accepted main SHA of the previous milestone.
5. Each implementation milestone uses a dedicated branch/PR.
6. Every implementation prompt must restate the global non-regression boundary.
7. Existing accepted tests plus milestone-specific tests must pass before merge authorization.
8. UI appearance never overrides durable financial truth.
9. No external integration or protocol may silently become authority.
10. Failed live attempts remain evidence and are not overwritten for demo convenience.
11. M10 may polish presentation but may not rewrite financial semantics to make the demo easier.
12. **ADR-016 is now frozen.** Further architectural amendment requires explicit owner authorization and a documented reason that cannot be satisfied within this locked sequence. Competitive novelty alone is not sufficient reason to pivot.

# Locked roadmap

- M5 — Authority Experience — **CLOSED / PASS / MERGED**
- M6 — Delegated / Human-Not-Present Commerce — **NOT STARTED**
- M7 — Live Agent Commerce Gateway
- M8 — Interoperable Verifiable Authority
- M9 — Trust Experience + Break PayFlow Arena
- M10 — Judge-Proof Acceptance and Submission

This frozen sequence supersedes earlier loose post-M4 descriptions while preserving all accepted M1–M5 semantics and evidence.
