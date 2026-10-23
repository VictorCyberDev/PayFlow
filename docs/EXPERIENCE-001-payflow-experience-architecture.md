# EXPERIENCE-001: PayFlow experience architecture lock

Status: **LOCKED PRE-M6**

Lock date: 2026-10-23

Companion to: `docs/ADR-016-post-m4-product-roadmap.md`

Authoritative implementation baseline at lock: `main` at `0aa289bdf2e037a43d644acd67d84326b922df85`.

Milestone state at lock:

- M1–M5 — CLOSED / MERGED
- **Experience Architecture X1–X9 — REQUIRED BEFORE M6**
- **M6 — NOT STARTED**

This document does not modify financial semantics, provider behavior, durable state, historical evidence, or the M1–M5 trust architecture. It locks the customer-experience architecture that all product-facing work from M6 onward must inherit.

## 1. Why this lock exists

The M1–M5 backend is materially stronger than the customer-facing experience. The current product is technically truthful and accessible, but it exposes too much of the internal implementation model directly to users.

The present experience accumulates intent review, activation, authority state, management, activity, verification, technical references, agent identity, demo environment language and control actions into a long single-page surface. This creates three risks:

1. customers must understand PayFlow's internal architecture to use it comfortably;
2. technical proof competes visually with the financial outcome the customer actually cares about;
3. later milestones would add delegated execution, live commerce, interoperable identity and attack/proof experiences onto an already overloaded information architecture.

The experience must therefore be rebuilt around the customer's mental model before M6 begins.

## 2. Experience north star

PayFlow remains **verifiable financial authority for AI agents**.

Customer-facing experience principle:

> The backend may be complex. The customer's decision should not be.

Primary customer questions:

1. What can my AI do?
2. How much can it spend?
3. Does it need to ask me?
4. What happened?
5. Did my money move?
6. Can I stop it?
7. Why did PayFlow allow or block it?

The product must answer these questions before exposing implementation vocabulary.

## 3. Locked information architecture

The current one-page anchor-navigation model is not the target experience for M6–M10.

Primary customer destinations are locked as:

### Home
Purpose: orientation and attention.

Primary question: **Is everything okay?**

Home must be state-aware rather than a permanent marketing hero. It should summarize active authority, attention-required states and recent meaningful outcomes without reproducing every product surface.

### New Authority / Ask PayFlow
Purpose: delegation.

Primary question: **What may my agent do?**

The flow must guide the user through one principal decision at a time:

`instruction → interpretation → boundaries → confirmation → Authority created`

Authentication/demo-access mechanics must not visually become part of the authority concept.

### Authorities
Purpose: control.

Primary question: **What can my agents currently do with my money?**

Each Authority must foreground purpose, agent, remaining/maximum amount, scope, expiry, whether the agent may act without asking again, and the primary control such as revoke.

### Activity
Purpose: understanding financial effects.

Primary question: **What happened to my money?**

Activity is a financial journal, not a log viewer. The financial outcome must dominate the row/detail experience.

### Agents
Agent identity remains a core object but does not have to receive equal top-level prominence for the consumer experience before multi-agent/external-agent use justifies it. Agents must be reachable contextually from related Authorities and Activity. M7+ may promote Agents where the use case requires it.

## 4. Three-layer disclosure model

Every customer-facing record must follow exactly three conceptual information layers.

### Layer 1 — Outcome

Immediate, human-readable truth.

Examples:

- **$0 moved**
- **$84 paid once**
- **$16 remaining**
- **Agent can spend up to $100**
- **Checking what happened — do not retry yet**

### Layer 2 — Explanation

Enough information to understand or control the result.

Examples:

- price exceeded your $100 limit;
- refurbished condition is not allowed;
- Shopping Agent may buy one new keyboard from approved merchants until Friday;
- authority was revoked before dispatch.

### Layer 3 — Proof

Technical and evidentiary detail for judges, developers, enterprise reviewers, disputes and advanced users.

May include:

- Authority/Mandate identifier;
- Agent identifier;
- reservation state;
- execution-grant state;
- provider order/capture references;
- reconciliation state;
- Trust Trace stages;
- fingerprints/hashes;
- precise machine timestamps;
- reason codes.

Proof must not compete with Layer 1 in the default consumer view.

Nested disclosure should not become an arbitrary tree. The target product pattern is Customer → Explanation → Proof, with Proof commonly implemented as a dedicated detail view, drawer or mode rather than deeply nested disclosure elements.

## 5. Outcome hierarchy

Financial outcome is the most important visual fact in Activity and execution-result surfaces.

Required primary outcome language:

- **$0 moved** for blocked/no-effect attempts where durable evidence supports that claim;
- **$X paid once** for exactly-one completed capture where durable evidence supports that claim;
- **Outcome not confirmed** / equivalent human wording for ambiguous provider state, paired with a clear instruction not to retry where appropriate.

The user should not have to inspect provider, trace or operation detail to learn whether money moved.

## 6. Customer-language boundary

Primary UX must use customer concepts while preserving exact engineering truth behind the projection.

Preferred customer vocabulary:

- `Mandate` → **Authority**
- `AgentPassport` → **Agent**
- cumulative limit → **Total budget**
- autonomous threshold → **Can spend without asking up to…**
- committed → **Spent/used** only where semantically exact
- reserved → **Pending** where semantically exact
- fresh dispatch blocked → **Can't start new purchases**
- provider reconciliation → **Checking what happened**
- provider-conformant completed outcome → **Payment verified** where supported

Normal customer views should not foreground:

- execution grant;
- fingerprint;
- reason code;
- operation identifier;
- provider-state machine vocabulary;
- internal authentication/bootstrap terminology.

Those remain available in Proof when valuable.

## 7. Environment and demo disclosure

Truthful non-production labeling remains mandatory, but repeated caveats must not become the visual identity.

Target pattern:

- one persistent **SANDBOX** / demo-environment indicator;
- one clear **About this demo environment** explanation;
- contextual warnings only when they materially affect the user's current decision.

Example money and real durable financial state must never be visually confusable.

## 8. Temporal and numeric presentation

Primary customer surfaces should favor human-readable time and financial language.

Examples:

- **Expires Friday at 6:00 PM** rather than a full UTC machine string;
- **$16 remaining** rather than exposing all accounting fields at once.

Exact timestamps, reserved amounts, committed amounts and other implementation-meaningful detail remain available when required in Explanation or Proof.

## 9. Interaction responsibility

Customers should not be asked to operate system-maintenance concepts.

Examples:

- durable state should refresh automatically;
- primary UI should not require a generic **Refresh saved state** action to remain trustworthy;
- stale/unavailable projections should explain when information was last updated and what the user should do;
- demo authentication should happen before or outside the conceptual Authority-creation flow where possible without weakening the accepted security boundary.

## 10. Brand grammar — locked concept, unlocked styling

The visual identity must derive from PayFlow's actual product meaning rather than generic fintech or generic AI aesthetics.

Locked conceptual territory: **Bounded Flow**.

Locked experience grammar:

### Frame
Represents the exact boundary of Authority — what may happen.

### Flow
Represents the attempted agent action — what wants to happen.

### Gate
Represents deterministic authorization at the boundary. Valid actions may proceed; invalid actions stop before financial dispatch.

### Trace
Represents what actually happened and the durable evidence that proves it.

This grammar should eventually inform product components, motion, marketing graphics, receipts, presentation material and the M9 Trust/Break PayFlow experience.

The previous working term **Authority Pass** is not locked. The preferred direction is an **Authority Frame** or equivalent non-card/non-wallet object so PayFlow is not mistaken for a bank, stored-value wallet, card issuer or payment rail.

## 11. Brand constraints

PayFlow should not default into common category clichés solely for familiarity.

Avoid as primary identity devices:

- generic purple/blue AI gradients;
- glowing AI orbs;
- neural-network decoration;
- robot mascots;
- shield/checkmark security logos;
- cybersecurity-terminal aesthetics;
- indiscriminate glassmorphism;
- generic dark Linear-style UI;
- payment-card imagery that implies PayFlow stores funds;
- green chosen merely because it signals money;
- excessive rounded-card composition.

The customer layer should feel human, calm, precise and financially trustworthy. The Proof layer may be denser and more technical without turning the whole product into a security operations console.

## 12. Visual identity items deliberately NOT frozen yet

The following are research candidates, not final locked assets:

- exact primary/secondary color palette;
- exact brand typeface;
- final symbol/wordmark;
- exact icon set;
- exact radius scale;
- exact photography/illustration treatment;
- final motion timings/easing;
- final generative Authority-pattern system.

They are intentionally deferred until the same experience architecture is tested across multiple genuinely distinct visual territories.

No later team may treat an exploratory palette or font suggestion as final merely because it appeared in research.

## 13. Product-state architecture

Home should adapt to user state.

Examples:

### New user
Primary task: create first Authority.

### Healthy returning user
Primary message: everything is within your rules, followed by active Authority and recent outcome summary.

### Attention-required state
Primary message: unresolved/ambiguous financial outcome, expired/revoked state requiring acknowledgement, or another genuinely actionable condition.

### Delegated-commerce state after M6
Primary message: which Authority can act without asking again, remaining bounds and recent delegated activity.

The permanent marketing-style hero must not prevent Home from functioning as a real operational surface.

## 14. Experience Architecture gates — X1 through X9

These gates are mandatory before M6 begins.

### X1 — Customer mental model

Define and approve the consumer, judge and enterprise mental models. Identify the minimum information each needs and what must remain behind Explanation/Proof.

PASS when each major surface is expressed in customer jobs rather than backend modules.

### X2 — Information architecture

Define the real destination model for Home, New Authority, Authorities, Activity and contextual Agents.

PASS when the one-page accumulation pattern is replaced in the target design with navigable destinations and state-aware Home behavior.

### X3 — Disclosure model

Apply Outcome → Explanation → Proof consistently to Authority, Activity, blocked attempts, successful payments, unknown outcomes and agent identity.

PASS when no core consumer flow requires navigating arbitrary nested technical disclosure to understand money movement or control authority.

### X4 — Language system

Create the canonical customer vocabulary and technical-proof vocabulary.

PASS when a normal customer can understand the primary product without knowing Mandate, AgentPassport, execution grant, provider-conformance or reconciliation terminology.

### X5 — Core-flow wireframes

Produce responsive wireframes for:

- Home — new, healthy and attention-required states;
- New Authority / Ask PayFlow;
- Authority list;
- Authority detail/control;
- Activity list;
- Activity detail;
- Agent contextual detail;
- Proof layer.

PASS when each screen has one dominant user question/action and the financial outcome/control hierarchy is obvious.

### X6 — Future-state wireframes

Design the same information architecture against at least:

- one M6 valid delegated execution with no additional human confirmation;
- one M6 blocked delegated attempt with **$0 moved**;
- one ambiguous provider/reconciliation outcome;
- one M8 externally verifiable agent/Authority proof;
- one M9 Break PayFlow attack result.

PASS when M6–M9 can fit the experience architecture without reintroducing the one-page technical dump.

### X7 — Visual territory exploration

Apply at least three genuinely distinct brand territories to the same approved wireframes.

Each territory must define:

- Frame/Flow/Gate/Trace expression;
- color roles;
- typography roles;
- geometry;
- iconography;
- motion principles;
- illustration/photography direction;
- customer vs Proof-mode expression.

PASS when options are materially different and not merely palette swaps.

### X8 — Recognition + comprehension validation

Evaluate both:

1. **Recognition** — with the PayFlow wordmark hidden, does the system still feel recognizably PayFlow?
2. **Comprehension** — can a first-time viewer identify what the agent may do, how much it may spend, whether it must ask again, and whether money moved?

Do not select a design solely because it is the most visually dramatic.

PASS requires a territory that is both distinctive and immediately understandable.

### X9 — Experience & Brand lock

Create the final implementation specification after X1–X8 pass.

The final lock must cover:

- information architecture;
- navigation;
- responsive behavior;
- page/state templates;
- customer language;
- disclosure model;
- brand idea;
- logo/mark usage;
- color tokens;
- typography;
- layout/grid;
- geometry/radii;
- components;
- Authority Frame;
- Activity outcome system;
- Proof mode;
- icons;
- motion including reduced-motion behavior;
- accessibility/contrast;
- illustration/photography;
- data visualization;
- sandbox/demo labeling;
- marketing/product consistency.

Only after X9 passes may the implementation phase begin.

## 15. Milestone linkage

### M6 — Delegated / Human-Not-Present Commerce

M6 remains **NOT STARTED** until X1–X9 pass.

M6 implementation must use the locked experience architecture for all customer-facing work. The hero proof should make autonomous-but-bounded execution understandable without exposing backend mechanics by default.

Required customer-facing outcomes include:

- valid delegated purchase → **$X paid once**;
- price/merchant/condition/quantity violation → **$0 moved**;
- revoked/expired Authority → **$0 moved** for new dispatch;
- ambiguous provider result → explicit non-retry/reconciliation guidance.

### M7 — Live Agent Commerce Gateway

External-agent complexity must not leak into normal consumer navigation. Agent/tool scopes belong primarily in contextual Agent detail and Proof/developer surfaces unless the customer must make a decision about them.

### M8 — Interoperable Verifiable Authority

Merchant/verifier assertions must remain understandable as proof of identity/authority context, not as a second consumer permission model.

### M9 — Trust Experience + Break PayFlow Arena

M9 expands the locked Proof language rather than inventing a new visual system. Break PayFlow should amplify Frame/Flow/Gate/Trace and the same outcome language used in normal Activity.

### M10 — Judge-Proof Acceptance

The final video, Devpost graphics, repository visuals and hosted product must present one coherent identity and one coherent mental model. Judges should see technical depth through deliberate Proof views, not because the consumer UI is overloaded with internals.

## 16. Non-regression and truth rules

Experience simplification must never simplify away financial truth.

The UI MUST NOT:

- infer success from browser state;
- claim `$0 moved` without authoritative evidence;
- claim `paid once` without authoritative exact-one proof;
- hide UNKNOWN/ambiguous financial outcomes behind a success-looking state;
- make visual animation authoritative;
- widen an Authority through UI convenience;
- convert external identity/protocol assertions into payment authority;
- obscure revoke/expiry consequences;
- fabricate user activity for demo polish.

The customer layer is a projection of durable truth, not a replacement for it.

## 17. Freeze rule

This document is the authoritative pre-M6 customer-experience architecture.

Further changes require explicit owner authorization and a documented reason. Visual exploration is allowed inside X7; architectural drift outside the X1–X9 sequence is not.

Current execution sequence:

**M5 CLOSED → X1 → X2 → X3 → X4 → X5 → X6 → X7 → X8 → X9 LOCK → M6 → M7 → M8 → M9 → M10**

Until X9 is accepted, **M6 remains NOT STARTED**.