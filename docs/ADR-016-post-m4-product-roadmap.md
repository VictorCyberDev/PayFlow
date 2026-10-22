# ADR-016: Post-M4 product roadmap and architecture lock

Status: PROPOSED FOR LOCK — architectural planning only. No M5 implementation is authorized by this ADR until the roadmap is accepted and the next milestone is explicitly started.

Authoritative baseline: `main` at `dd5e9a460559528b27364fd2b35eaaada73c65d8` after merged PR #10. M4 is CLOSED / UNCHANGED. The post-M4 PayPal return UX repair is CLOSED / PASSED / MERGED.

## Product position

PayFlow is the **verifiable authority layer for agentic commerce**.

North star:

> AI may interpret, rank and propose. PayFlow determines whether financial authority exists, what exact authority exists, whether it is still valid at dispatch time, and how the resulting financial outcome can be independently verified.

Product promise:

> Give AI agents permission to spend — not control of your money.

The post-M4 roadmap incorporates three sources of strategy:

1. the accepted PayFlow architecture and regression-tested trust boundaries;
2. competitive research across current PayPal AI Hackathon submissions and the wider agentic-commerce landscape, including the rise of verifiable user instructions, agent identity, delegated authority, human-not-present execution and cross-system verification;
3. a premium product experience inspired by the interaction principles of OpenAI, Claude, Apple and PayPal: conversational simplicity, focus, hierarchy, agency, calmness, transaction confidence and progressive disclosure.

## Global non-regression boundary

M1–M4 and the post-M4 payer-return repair are accepted foundations.

Future work MUST NOT redesign or replace:

- the Trust Kernel or `authorize()` financial decision semantics;
- `AgentPassport` as the durable agent identity/capability object;
- `Mandate` as the durable financial-authority object;
- intent compilation and the rule that model output is untrusted;
- `HumanConfirmationBoundary` and exact authenticated-action binding;
- durable reservations and authority accounting;
- signed execution grants and one-time claim semantics;
- Payment Attempt state transitions;
- PayPal dispatch, UNKNOWN quarantine, reconciliation or provider-conformance semantics;
- M4 checkout quote/manifest binding;
- payer-approval/resume revalidation;
- the evidence ledger and historical evidence;
- `OperationTraceService` verification semantics.

Historical migrations `001` through `009` are immutable. New schema work, if justified, starts at `010` and must be forward-only.

Browser/client state is never financial truth. UI state cannot authorize payment, widen authority, fabricate verification, downgrade durable completed state, or bypass server-side revalidation.

The new product surface MUST compose above or beside the accepted kernel. It must not move financial trust into the browser.

## Product architecture boundary

The existing root package remains the trust-kernel/server foundation. A premium application surface should be isolated under an application boundary such as `apps/console/` with its own frontend dependency graph and build. Do not casually add large UI-framework dependencies to the root kernel package.

Trusted server adapters may expose bounded application endpoints, but browser clients must never receive:

- database credentials;
- signing keys or raw execution-grant tokens;
- resume secrets;
- authentication assertions;
- PayPal credentials or OAuth tokens;
- raw provider blobs containing payer-sensitive data;
- unrestricted internal persistence access.

Read-only product views should prefer bounded server projections derived from authoritative durable state. `OperationTraceService` remains the verification source for operation history; the UI may render it but not reimplement verification logic.

## Experience principles

PayFlow should feel like a premium AI workspace crossed with a financial wallet, not a security console.

The visual thesis is **calm authority**.

- OpenAI influence: conversational, intent-first interaction; restrained surfaces; progressive tool reveal.
- Claude influence: focus, quiet hierarchy, minimal cognitive noise.
- Apple influence: agency, craft, legibility, Wallet-like authority objects, excellent spacing and motion.
- PayPal influence: confidence at money moments, explicit amount/merchant context, clear cancellation/recovery, accessible payment controls.

The interface must use progressive disclosure:

1. human-readable outcome;
2. concise explanation of why it was allowed/denied;
3. verification detail;
4. raw technical identifiers only when deliberately expanded.

Do not make hashes, state-machine labels or reason codes the primary user language.

Top-level product surfaces are intentionally small:

- Home
- Ask PayFlow
- Authority
- Activity
- Agents

Technical concepts such as grants, reservations, manifests, provider observations and fingerprints live behind verification detail unless needed for a judge or operator.

## Competitive product principle

PayFlow will not try to win by becoming another generic AI checkout assistant, another payment firewall or another mandate engine.

The differentiator is the complete authority chain:

**human instruction → authenticated activation → bounded agent authority → deterministic commerce decision → one-time execution authority → provider execution → durable reconciliation → verifiable proof**.

The roadmap should make that chain portable, user-legible and externally verifiable while preserving the existing trust kernel.

---

# M5 — Authority Experience

## Goal

Make the accepted Agent Passport + Mandate architecture understandable, beautiful and safely operable by a real user without changing the underlying authorization model.

M5 introduces the premium human product layer around existing trust primitives. It does NOT create a parallel "Authority Passport" backend model.

The user-facing concept is **Authority**: a composed representation of the existing Agent Passport, active Mandate and relevant current authority facts.

## Required product flow

A human can:

1. describe an intended delegation in natural language;
2. see AI interpretation clearly labelled as NOT YET AUTHORIZED;
3. review the deterministic bounded terms produced by the existing intent pipeline;
4. authenticate and confirm the exact terms through the existing confirmation boundary;
5. see the resulting active Authority in a premium Wallet-like representation;
6. inspect remaining budget, merchant/product/quantity/capability constraints and expiry;
7. suspend/revoke only through an authenticated trusted server path consistent with existing semantics;
8. inspect recent allowed/denied attempts in human language.

## UX acceptance

The primary path must be understandable without exposing implementation terminology.

Example user language:

- "Up to $100"
- "1 new item"
- "Approved merchants only"
- "Expires Friday at 6:00 PM"
- "Your agent can complete this without asking again" or "You will be asked before payment"

Technical detail remains available through "View verification details".

## M5 hard gates

PASS requires all of the following:

- no replacement or semantic widening of `AgentPassport` or `Mandate`;
- AI output remains untrusted until exact authenticated confirmation;
- no client-generated authority is accepted as truth;
- owner/agent binding is enforced server-side;
- stale, replayed or expired reviews fail closed;
- Authority rendering is derived from durable authoritative state;
- revoke/suspend/expiry semantics are represented correctly;
- existing M1–M4 tests remain green;
- new browser/product tests cover owner isolation, stale UI, replay and untrusted-field tampering;
- a polished hosted flow exists from natural-language intent through active Authority.

## Explicitly out of scope

- changing payment-state semantics;
- new payment rail;
- live Channel3;
- new cross-protocol standards;
- full Break PayFlow arena;
- direct human-not-present financial expansion beyond already accepted semantics.

M5 must pass before M6 starts.

---

# M6 — Delegated / Human-Not-Present Commerce

## Goal

Prove that a previously authenticated, bounded human instruction can safely authorize later agent execution without a new human confirmation when — and only when — the existing mandate explicitly permits that exact transaction.

This is not "autonomy by default." It is explicit delegated authority.

## Design rule

HNP execution MUST derive from existing Mandate thresholds/capabilities plus normal reservation, execution-grant, immediate revalidation and provider-conformance checks. Do not create a second HNP policy engine.

## Required scenarios

- legitimate pre-authorized purchase succeeds without an extra approval step;
- price drift beyond the mandate is denied before new provider capture;
- wrong merchant/product/condition/quantity is denied;
- revoked/suspended/expired authority causes zero new financial dispatch;
- concurrent attempts cannot overconsume a budget or quantity limit;
- existing provider effect can still be truthfully reconciled after authority becomes unavailable;
- execution remains one-time and replay-safe.

## Product experience

The user must understand the difference between:

- "Your agent may do this without asking again"
- "Your approval is required before payment"

The UI must show current authority, remaining budget, next expiry and recent autonomous use without implying that the browser itself controls enforcement.

## Hard gate

M6 passes only with deterministic unit/integration/concurrency coverage and one end-to-end Sandbox proof of delegated execution under a valid bounded mandate, plus adversarial proofs of zero unauthorized provider effects.

---

# M7 — Live Agent Commerce Gateway

## Goal

Connect PayFlow's existing trust boundary to live agent-commerce inputs and tools while keeping those external systems untrusted.

## Primary work

- replace demo-only discovery for the winning path with a real Channel3 integration where available;
- retain deterministic eligibility and controlled trusted-term resolution;
- expose PayPal agent/tool operations only behind PayFlow authority checks;
- separate read-only operations from money-moving capabilities;
- demonstrate that an external/model agent can request a commerce action but cannot widen the mandate or directly obtain payment authority.

## Architecture rule

Channel3, MCP/tool calls, model output and merchant observations are evidence/input, not authority.

The existing M4 distinction between discovery observations and executable trusted checkout terms remains intact.

## Hard gate

PASS requires live discovery or other live commerce input on the demonstration path, strict normalization/bounds, deterministic eligibility, exact mapping/trusted-term verification, zero silent merchant substitution, and successful use of the existing PayPal execution path without bypassing the Trust Kernel.

---

# M8 — Interoperable Verifiable Authority

## Goal

Make PayFlow authority independently consumable and verifiable across agent/merchant/tool boundaries without claiming certification or compatibility that has not been demonstrated.

## Product concept

A third party should be able to ask:

- Which human/principal delegated this authority?
- Which agent is acting?
- What is the scope, budget, expiry and capability?
- Is the authority active/revoked/expired?
- Does this requested action fit within it?
- What operation ultimately occurred?

## Work direction

Create bounded external authority/verifier contracts that reuse existing durable identity, mandate, signing and evidence material. Where appropriate, provide adapters informed by emerging concepts such as verifiable intent and agent delegation, but label them accurately and avoid false standards-compliance claims.

## Hard gate

PASS requires an independently callable verifier/interface that cannot move money, cannot widen authority, does not disclose sensitive execution material, and can prove both a valid request and an invalid/tampered/revoked request from durable PayFlow state.

---

# M9 — Trust Experience + Break PayFlow Arena

## Goal

Turn PayFlow's strongest technical proof into the strongest visual proof in the competition.

M9 is not merely a dashboard milestone. It is where PayFlow demonstrates — live — that a model or external system can be wrong, manipulated or malicious while financial authority remains conserved.

## Premium trust experience

Build a polished Authority/Activity experience around existing `OperationTraceService` and Authority Meter data.

Default view:

- what happened;
- amount;
- merchant/item;
- whether it was allowed/denied/unknown;
- which Authority applied;
- remaining authority;
- concise human explanation.

Expanded verification view:

- human instruction/activation;
- agent identity;
- budget/merchant/product/quantity checks;
- quote/manifest relationship;
- grant/reservation state;
- provider order/capture state;
- Trust Trace stage status;
- technical references/fingerprints on deliberate expansion.

## Break PayFlow Arena

Use the existing adversarial scenario contracts as the foundation. Do not invent a parallel security engine.

The arena should visually demonstrate attacks such as:

- prompt-injected price widening;
- $84 → $184 price drift;
- wrong merchant;
- used/refurbished substitution;
- quantity widening;
- revoked mandate during checkout;
- expired authority;
- replay;
- duplicate browser return;
- lost provider response;
- concurrent execution.

For each scenario, show the most important outcome first:

**Money moved: $0** or **Exactly one capture completed**.

Then show why.

## AG Grid / Studio strategy

Use AG Grid/Studio only where it materially improves the command-center/verification/attack experience. Avoid decorative sponsor integration. Sponsor use must be deep enough to be defensible on its own judging criteria.

## Hard gate

PASS requires a premium hosted experience, mobile/desktop usability, accessibility, deterministic rendering from authoritative projections, no UI-side verification logic that can override server truth, and live demonstration of selected adversarial cases with provider-call counts/effects matching the existing scenario evidence.

---

# M10 — Judge-Proof Acceptance and Submission

## Goal

Convert the complete PayFlow system into an undeniable competition entry optimized for the PayPal AI Hackathon judging criteria without weakening the engineering truth.

## Required acceptance matrix

Demonstrate, using the final hosted build where possible:

- natural-language intent;
- exact human review/activation;
- premium active Authority;
- constrained live discovery;
- legitimate selection;
- trusted quote/manifest;
- ALLOW and DENY paths;
- delegated/HNP path where applicable;
- PayPal Sandbox execution;
- payer-return durability where applicable;
- exact-one capture/idempotency;
- reconciliation after ambiguous provider state;
- revoked/expired zero-new-dispatch behavior;
- Trust Trace VERIFIED for a conforming completed operation;
- tampered/invalid verification failure;
- selected Break PayFlow attacks;
- external authority verification;
- complete regression and CI green.

## Submission strategy

Optimize explicitly for the five Devpost criteria:

### Technological Implementation
Show the real PayPal path, deterministic authorization, signed grants, durable concurrency, reconciliation, live integrations and verifiable evidence.

### Design
The hosted app must feel like a complete premium product, not a developer console.

### Potential Impact
Frame the problem as the trust gap preventing people and enterprises from safely allowing AI agents to spend on their behalf.

### Innovation / Idea
Lead with verifiable delegated authority — not generic AI shopping.

### Presentation
The first three minutes must tell one coherent story:

1. human delegates bounded authority;
2. AI proposes an action;
3. PayFlow stops a manipulated/unauthorized attempt;
4. the valid transaction completes through PayPal;
5. the resulting authority chain is independently verified.

## Prize strategy

Primary target: overall first place.

Secondary sponsor target should favor integrations that strengthen the product rather than distort it. AG Grid/Studio is useful for the trust/attack experience; Channel3 is useful for live commerce discovery. Sponsor requirements must never justify bypassing core trust boundaries.

## Hard gate

No submission freeze until the final hosted environment passes the acceptance matrix, the demonstration is repeatable, all mandatory Devpost fields/assets are complete, and the three-minute narrative can be executed without relying on hidden manual repair steps.

---

# Milestone progression rules

1. Only one milestone is active at a time unless a later milestone has an explicitly authorized read-only research spike.
2. Each milestone begins from the accepted main SHA of the previous milestone.
3. Each implementation milestone uses a dedicated branch/PR.
4. Every Work prompt must restate the global non-regression boundary.
5. Existing accepted tests plus milestone-specific tests must pass before merge authorization.
6. No milestone can declare success from UI appearance alone; durable state and authoritative provider evidence control financial truth.
7. No new external integration may silently become authority.
8. A failed live attempt is preserved as evidence; do not create replacement financial attempts without explicit authorization where required.
9. M10 may polish presentation but may not rewrite financial semantics to make a demo easier.

# Locked roadmap summary

- M5 — Authority Experience
- M6 — Delegated / Human-Not-Present Commerce
- M7 — Live Agent Commerce Gateway
- M8 — Interoperable Verifiable Authority
- M9 — Trust Experience + Break PayFlow Arena
- M10 — Judge-Proof Acceptance and Submission

This sequence supersedes earlier loose post-M4 roadmap descriptions while preserving all accepted M1–M4 semantics and evidence.
