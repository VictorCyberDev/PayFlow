# EXPERIENCE-001: PayFlow experience architecture lock

Status: **LOCKED PRE-M6**

Lock date: 2026-10-23

Companion to: `docs/ADR-016-post-m4-product-roadmap.md`

Authoritative implementation baseline at lock: `main` at `0aa289bdf2e037a43d644acd67d84326b922df85`.

Milestone state at lock:

- M1-M5 — CLOSED / MERGED
- **Experience Architecture X1-X9 — REQUIRED BEFORE M6**
- **M6 — NOT STARTED**

This document does not modify financial semantics, provider behavior, durable state, historical evidence, or the M1-M5 trust architecture. It locks the customer-experience architecture that all product-facing work from M6 onward must inherit.

## 1. Why this lock exists

The M1-M5 backend is materially stronger than the customer-facing experience. The current product is technically truthful and accessible, but it exposes too much of the internal implementation model directly to users.

The present experience accumulates intent review, activation, authority state, management, activity, verification, technical references, agent identity, demo-environment language, and control actions into a long single-page surface.

That creates three risks:

1. Customers must understand PayFlow's internal architecture to use it comfortably.
2. Technical proof competes visually with the financial outcome the customer actually cares about.
3. Later milestones would add delegated execution, live commerce, interoperable identity, and attack/proof experiences onto an already overloaded information architecture.

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

## 3. Locked customer mental model

The customer should understand PayFlow through four concepts:

- **Authority** — what an agent is allowed to do.
- **Agent** — who is acting under that Authority.
- **Activity** — what the agent attempted or completed.
- **Proof** — why PayFlow allowed, blocked, held, or verified the outcome.

The customer should not need to understand Mandates, execution grants, reservation state machines, provider-conformance internals, operation traces, or database state to operate PayFlow safely.

Those concepts remain authoritative in the backend and may appear in the Proof layer.

## 4. Locked information architecture

The current one-page anchor-navigation model is not the target experience for M6-M10.

Primary customer destinations are locked as follows.

### Home

Purpose: orientation and attention.

Primary question: **Is everything okay?**

Home must be state-aware rather than a permanent marketing hero. It should summarize active Authority, attention-required states, and recent meaningful outcomes without reproducing every product surface.

Possible state-aware headlines include:

- **Everything is within your rules.**
- **1 payment needs attention.**
- **Shopping Agent can act without asking you again.**
- **No active Authorities yet.**

Home must not become a second Activity page or a dashboard of every internal metric.

### New Authority / Ask PayFlow

Purpose: delegation.

Primary question: **What may my agent do?**

The flow must guide the user through one principal decision at a time:

`instruction -> interpretation -> boundaries -> confirmation -> Authority created`

The interface may use natural language, but model output remains untrusted until normal PayFlow activation semantics complete.

Authentication and demo-access mechanics must not visually become part of the Authority concept.

### Authorities

Purpose: control.

Primary question: **What can my agents currently do with my money?**

Each Authority must foreground:

- purpose;
- agent;
- maximum or remaining amount in customer-friendly language;
- quantity or item scope where applicable;
- merchant boundary;
- condition boundary where applicable;
- expiry;
- whether the agent may complete an eligible action without asking again;
- the primary control, such as revoke.

Accounting internals such as reservation state, execution-grant state, and raw identifiers belong in Proof unless they materially affect the immediate customer decision.

### Activity

Purpose: understanding financial effects.

Primary question: **What happened to my money?**

Activity is a financial journal, not a log viewer.

The financial outcome must dominate the row and detail experience.

Preferred primary outcomes include:

- **$0 moved**
- **$84 paid once**
- **Checking what happened — do not retry yet**

### Agents

Agent identity remains a core object but does not have to receive equal top-level prominence for the consumer experience before multi-agent or external-agent use justifies it.

Agents must be reachable contextually from related Authorities and Activity.

M7 and later may promote Agents where the use case requires it.

## 5. Locked three-layer disclosure model

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

- Price exceeded your $100 limit.
- Refurbished condition is not allowed.
- Shopping Agent may buy one new keyboard from approved merchants until Friday.
- Authority was revoked before dispatch.

### Layer 3 — Proof

Technical and evidentiary detail for judges, developers, enterprise users, investigation, or disputed situations.

Proof may expose:

- Authority or Mandate identifier;
- agent identifier;
- evaluated terms;
- decision reason codes;
- reservation state;
- execution-grant state;
- provider order/capture references;
- reconciliation status;
- Trust Trace stages;
- timestamps;
- evidence fingerprints;
- cryptographic or protocol references where relevant.

Primary customer surfaces must not nest Proof inside multiple levels of generic disclosure controls.

Proof should become a deliberate destination, panel, drawer, or dedicated detail mode.

## 6. Locked financial hierarchy

For any financial action, information priority is:

1. Financial outcome.
2. Authority that applied.
3. Human explanation.
4. Customer control.
5. Proof.

For example, a denied attempt should lead with:

> **$0 moved**

Then explain:

> Blocked by your Keyboard Authority. Price was $184; your maximum is $100.

Only after that should the user need to open Proof.

A completed operation should lead with:

> **$84 paid once**

Then explain which Authority permitted it and what remains.

An ambiguous provider state should lead with explicit safety guidance:

> **We have not confirmed whether money moved. Do not retry yet.**

Technical state names must not replace this customer language.

## 7. Locked customer-language boundary

Primary customer language must describe financial meaning, not internal implementation.

Preferred translations include:

- `Mandate` -> **Authority**
- `AgentPassport` -> **Agent**
- autonomous threshold -> **Can spend without asking up to...**
- cumulative limit -> **Total budget**
- committed amount -> **Used** or **Spent**, only where financially accurate
- reserved amount -> **Pending**, only where financially accurate
- fresh dispatch blocked -> **Can't start new purchases**
- provider conformance -> **Payment verified**
- reconciliation -> **Checking what happened**
- unknown financial outcome -> **We haven't confirmed whether money moved. Do not retry yet.**

The following normally belong only in Proof:

- execution grant;
- operation ID;
- fingerprint;
- reason code;
- raw provider state;
- state-machine terminology.

Plain language must never misrepresent durable financial truth.

## 8. Locked Authority hierarchy

The front of an Authority should answer:

1. What is this Authority for?
2. Which agent can use it?
3. How much may the agent spend?
4. How much remains, where applicable?
5. What may it buy or do?
6. Where may it act?
7. Until when?
8. Can it act without asking again?
9. How do I stop it?

Secondary accounting and verification detail belongs in Explanation or Proof.

The customer-facing Authority object must not visually imply that PayFlow is a card issuer, wallet, bank account, or custody product.

## 9. Locked Activity hierarchy

Activity must behave like a financial journal rather than an operational log.

A row should prioritize:

- amount or `$0` outcome;
- concise action label;
- item or merchant where helpful;
- agent;
- human time;
- short explanation if blocked or unresolved.

Exact UTC timestamps belong in Proof unless required for the immediate customer decision.

`Why?` may open Explanation.

`View proof` may open the technical/evidentiary layer.

Do not require three or more nested disclosure levels.

## 10. Locked Home behavior

Home is an attention system, not an everything system.

It should surface only what materially helps the user orient or act.

A mature Home may contain:

- overall status;
- one or more important active Authorities;
- attention-required outcomes;
- a short recent-activity summary;
- one strong action such as **New Authority**.

Home must not duplicate the full Authorities or Activity experience.

## 11. Locked demo and sandbox disclosure

Truthful demo boundaries remain mandatory, but disclosure must be architected rather than repeated across every high-visibility surface.

A persistent environment indicator such as **SANDBOX** or **DEMO** may identify the environment.

A dedicated **About this demo** surface may explain:

- fixed identity;
- recorded model fixtures;
- non-production authentication;
- which flows create durable Authority;
- which flows do or do not execute payment;
- known limitations.

Primary customer screens should not repeat the same caveat in multiple banners, footnotes, and paragraphs unless the specific action requires an immediate safety warning.

No disclosure may be removed if doing so would make the demo materially misleading.

## 12. Locked interaction-responsibility rules

Customer-facing UI must not make the user responsible for maintaining PayFlow's internal state.

Avoid primary controls such as:

- Refresh saved state.
- Re-read durable state.
- Retry provider observation.
- Refresh Authority projection.

The system should update authoritative projections automatically where possible.

When freshness is uncertain, the customer sees the human consequence, for example:

> We couldn't refresh this Authority. Showing the last confirmed state from 2 minutes ago.

Diagnostic/manual refresh tools may exist in Proof or developer mode.

## 13. Locked time and number presentation

Primary UI should use human-readable local presentation where safe and unambiguous.

Examples:

- **Expires Friday at 6:00 PM**
- **Updated just now**
- **2 days remaining**

Exact UTC timestamps remain available in Proof.

Currency and amount formatting must preserve financial accuracy and provider currency semantics.

## 14. Locked mobile principle

Responsive desktop is not sufficient.

M6-M10 customer surfaces must be deliberately designed for mobile as a first-class use case.

The current horizontal-scroll anchor navigation is not the final mobile information architecture.

Mobile navigation should prioritize the same customer jobs as desktop:

- Home;
- New Authority;
- Authorities;
- Activity.

Agent access may be contextual or secondary until the use case justifies top-level prominence.

Accessibility foundations already accepted in M5 remain non-regression requirements, including focus visibility, reduced-motion support, readable contrast, and suitable touch targets.

## 15. Locked brand concept

The visual identity must emerge from PayFlow's actual product behavior rather than generic fintech or AI decoration.

Working brand concept:

**Bounded Flow**

The locked visual grammar is:

### Frame

Represents what may happen.

The Frame is the visual expression of Authority and bounded permission.

### Flow

Represents what is attempting to happen.

The Flow may originate from an agent, user instruction, or commerce action.

### Gate

Represents PayFlow's deterministic decision boundary.

A valid action may pass.

An invalid action must visibly stop before financial execution.

### Trace

Represents what actually happened and how PayFlow can prove it.

The Trace must never visually imply success before durable evidence supports that conclusion.

This grammar may be expressed in layout, motion, diagrams, Authority objects, marketing, Trust Trace, and later Break PayFlow experiences.

It must not change financial semantics.

## 16. Locked motion principle

Motion should describe PayFlow behavior rather than generic AI magic.

Preferred behavioral motion concepts include:

- **Constrain** — fluid natural-language intent resolves into explicit boundaries.
- **Seal** — authenticated Authority settles into a stable Frame.
- **Dispatch** — an eligible action moves toward the Gate.
- **Deny** — the action stops before the payment rail.
- **Verify** — durable provider/evidence confirmation resolves into a stable Trace.

Reduced-motion users must receive equivalent information without relying on animation.

Motion must never imply money moved before durable financial truth supports that claim.

## 17. Locked anti-patterns

PayFlow must avoid category-default branding that weakens distinctiveness or teaches the wrong mental model.

Do not default to:

- purple-to-cyan AI gradients;
- glowing intelligence orbs;
- neural-network decoration;
- robot mascots;
- shield/checkmark security branding as the primary identity;
- dark SOC-dashboard aesthetics;
- card or wallet metaphors that imply custody or issuing;
- generic glassmorphism as the brand;
- excessive rounded-card stacks;
- a dark Linear-style clone;
- green merely because the product relates to money;
- color as the only state indicator.

The product should feel like controlled financial agency, not cybersecurity software and not generic AI software.

## 18. Locked distinctiveness requirement

The final visual system must pass a name-hidden recognition test.

The design should contain a small number of repeatable, ownable memory structures across product and marketing.

Candidate memory structures may include:

- Frame geometry;
- Gate geometry;
- Flow/Trace behavior;
- a distinctive Authority object;
- typography;
- color relationships;
- motion signatures;
- proof/outcome language.

The exact logo, color palette, typeface, illustration system, and icon set are **not locked by EXPERIENCE-001**.

They must be tested during X7 and X8 rather than selected because they merely look premium.

## 19. Visual choices intentionally left open

The following remain unresolved until the visual-territory gate:

- exact primary and secondary colors;
- exact typefaces;
- final logo or wordmark;
- final Authority object silhouette;
- icon family;
- illustration system;
- photography direction;
- detailed motion timings;
- dark-mode treatment;
- final grid and spacing tokens.

This is intentional.

The experience architecture is locked first so visual design solves the correct product structure.

## 20. Locked relationship to M6-M10

### M6 — Delegated / Human-Not-Present Commerce

M6 must demonstrate delegated execution through the locked customer hierarchy.

The customer should understand:

- what Authority exists;
- whether the agent may act without asking again;
- what action occurred;
- whether money moved;
- why PayFlow allowed or blocked the action.

M6 must not add a second policy engine or expose implementation vocabulary merely because delegated execution is technically complex.

### M7 — Live Agent Commerce Gateway

M7 must keep external-agent and protocol complexity behind the customer model.

The customer sees Agent, Authority, Activity, and Proof.

MCP, OAuth/OIDC scopes, Channel3 normalization, PayPal toolkit details, and protocol mechanics belong in integration/developer or Proof experiences unless they materially affect the user's decision.

### M8 — Interoperable Verifiable Authority

M8 may add merchant/verifier experiences, but read-only verification must remain clearly distinct from customer money-moving control.

External assertions and protocol adapters must not visually or semantically become new Authority sources.

### M9 — Trust Experience + Break PayFlow

M9 should amplify the same `Frame -> Flow -> Gate -> Trace` grammar rather than inventing a separate security aesthetic.

Break PayFlow must lead with the financial outcome:

- **Money moved: $0**
- **Exactly one capture completed**

Technical attack and evidence detail may then expand into Proof.

### M10 — Judge-Proof Acceptance

M10 presentation should show the same consumer experience first and reveal technical depth through Proof.

The judge should not need to navigate a developer console to understand PayFlow's value.

## 21. Mandatory pre-M6 gates

M6 implementation must not begin until X1-X9 are completed and explicitly locked.

### X1 — Customer mental model

Define the consumer, judge, and enterprise mental models.

Prove which information belongs in Customer, Explanation, and Proof layers.

### X2 — Information architecture

Define real destinations, route structure, navigation hierarchy, state-aware Home behavior, and contextual Agent access.

The single-page anchor architecture is not accepted as the final target.

### X3 — Disclosure model

Specify how Outcome, Explanation, and Proof work for Authority, Activity, ambiguous provider outcomes, denied actions, and verified operations.

### X4 — Language system

Lock customer terminology, status language, error language, time formatting, financial-outcome phrases, and demo disclosure.

Backend terminology remains available in Proof.

### X5 — Core-flow wireframes

Produce and review wireframes for:

- Home;
- New Authority / Ask PayFlow;
- interpretation and boundary review;
- Authority confirmation;
- Authorities list/detail;
- Activity list/detail;
- Agent context;
- Proof view;
- revoke flow;
- ambiguous-outcome flow;
- mobile variants.

### X6 — Future-state wireframes

Prove that the architecture can accommodate at least:

- M6 delegated valid purchase;
- M6 blocked price drift;
- M7 external-agent context;
- M8 verification context;
- M9 Break PayFlow attack/proof flow.

This gate prevents solving only the current M5 screen structure.

### X7 — Visual territory exploration

Apply at least three genuinely distinct visual systems to the same accepted wireframes.

Each territory should define:

- color logic;
- type logic;
- Frame/Gate treatment;
- Authority object;
- motion concept;
- icon/illustration direction;
- product and marketing examples.

Do not select a territory because it is merely the prettiest.

### X8 — Recognition and comprehension tests

Test both:

1. **Recognition** — with the PayFlow name hidden, does the system still look distinct from neighboring fintech and AI brands?
2. **Comprehension** — within roughly five seconds, can a first-time viewer identify what the agent may do, how much it may spend, and whether money moved?

Also verify accessibility, mobile behavior, and reduced-motion equivalents.

### X9 — Experience and brand freeze

Create the final PayFlow Experience + Brand specification.

X9 should lock:

- information architecture;
- customer language;
- disclosure rules;
- chosen visual territory;
- color tokens;
- typography;
- logo/mark rules;
- Frame/Gate/Flow/Trace rules;
- Authority object;
- motion;
- iconography;
- illustration/photography rules;
- layout/grid;
- accessibility requirements;
- mobile rules;
- marketing-product consistency;
- Proof mode;
- implementation tokens/components.

Only after X9 passes may M6 implementation begin.

## 22. Experience non-regression rules

From X9 onward, every customer-facing milestone must preserve the following unless an explicitly authorized experience amendment proves the change is necessary:

1. Customer mental model before backend topology.
2. Outcome before technical proof.
3. Financial truth before visual celebration.
4. Real destinations rather than one-page feature accumulation.
5. Three disclosure layers: Outcome, Explanation, Proof.
6. Home as an attention system, not an everything system.
7. Authority as a bounded permission object, not a wallet/card metaphor.
8. Activity as a financial journal, not a raw log viewer.
9. Customer language before state-machine language.
10. Demo transparency without disclaimer overload.
11. Mobile as a first-class experience.
12. Accessible contrast, focus, touch targets, and reduced-motion equivalents.
13. No customer-facing control may silently widen, create, or reinterpret financial Authority.
14. No visual state may contradict durable financial truth.
15. Proof may reveal complexity; primary customer surfaces should not require it.

## 23. Locked execution order

The authoritative execution sequence is:

`M1-M5 CLOSED -> X1 -> X2 -> X3 -> X4 -> X5 -> X6 -> X7 -> X8 -> X9 LOCK -> M6 -> M7 -> M8 -> M9 -> M10`

M6 remains **NOT STARTED** until X9 is complete and explicitly accepted.

EXPERIENCE-001 is a companion product/experience lock to ADR-016. It does not reopen the frozen financial architecture, change any accepted M1-M5 financial semantics, or authorize implementation by itself.
