# ADR-017: Financial Authority Network — M7–M60 Company Roadmap Lock

Status: **PROPOSED STRATEGIC LOCK / DOCUMENTATION ONLY**

Research freeze date: **2026-10-28**

Branch: `roadmap/m7-m60-authority-network-lock`

Authoritative implementation baseline at research freeze:

- `main` = `880a890f9e0735d03ee7e0de625907e408f5fc73`
- M6 PR #16 = open, draft, unmerged
- M6 branch = `m6-delegated-human-not-present-commerce`
- M6 head = `9f1aca949c1bb492c83a52772c2fb2b16ef01b6e`
- exact-head M6 CI is green
- M6 live PayPal Sandbox acceptance, independent review and merge remain required
- **M7 remains NOT STARTED**

This ADR is a company-roadmap amendment. It does **not** start M7, authorize M7 implementation, weaken the M6 acceptance gate, change financial semantics, alter provider behavior, add a migration, or merge M6.

---

# 1. Company category lock

PayFlow's company category is:

> **Financial authority for autonomous systems.**

Long-term network category:

> **The Financial Authority Network for AI Agents.**

Network line:

> **Any agent. Any rail. One authority truth.**

Enterprise promise:

> **Let agents execute financial work without surrendering financial control.**

Developer promise:

> **Give an agent financial capability without giving it unrestricted financial power.**

Verifier promise:

> **Know whether the agent was actually authorized — before money moves.**

The company is deliberately narrower than payments and broader than a payment product.

PayFlow is not a bank, card network, PSP, wallet, custody provider, lender, checkout assistant, browser agent, model provider, identity provider or generic authorization platform.

PayFlow owns the **financial-authority boundary** between intent and financial execution:

`Intent -> Identity context -> Financial Authority -> Runtime Revalidation -> Execution -> Reconciliation -> Verifiable Financial Truth`

Payment providers execute. Identity providers identify/authenticate. Commerce protocols transport. Agent frameworks reason and act. PayFlow determines whether financial authority exists for the exact action now, constrains execution, and proves what actually happened.

---

# 2. Company constitution — non-negotiable invariants

These rules survive every future milestone unless a later ADR explicitly proves a safer equivalent and is separately approved.

1. **Deterministic financial authority.** Model output is untrusted input. A model never becomes the source of financial truth.
2. **Zero standing financial privilege.** An agent should hold no broader persistent money-moving privilege than required for the bounded task.
3. **Delegation may attenuate, never silently widen.** Sub-agents and downstream services cannot claim more financial authority than the parent delegation.
4. **Immediate runtime revalidation.** Permission must still be valid at the final dispatch boundary, not merely at planning time.
5. **Exactly-once or safely unresolved.** Retries, duplicate callbacks, concurrency and provider ambiguity may never turn one authorized action into accidental repeated financial effects.
6. **UNKNOWN is first-class truth.** A system that does not know whether money moved must not invent certainty or silently retry.
7. **Reservation before consumption.** Bounded authority cannot be overdrawn through concurrency or racing agents.
8. **Portable proof.** Authorized third parties should be able to verify bounded claims and financial outcomes without receiving money-moving capability.
9. **Verification never moves money.** Read-only verification and proof interfaces are separate from execution interfaces.
10. **Protocols are adapters, not authority.** MCP, A2A, AP2, ACP, UCP, AuthZEN, Visa TAP, future standards and merchant schemas can carry context but cannot silently replace PayFlow Authority.
11. **Rails are replaceable.** PayPal is the first accepted rail; no future rail may redefine PayFlow's authority semantics.
12. **Identity is composable.** Entra, Okta, OIDC, SPIFFE-style workload identity, future agent identity systems and PayFlow Agent identity can be inputs without becoming financial authority themselves.
13. **Evidence is append-only in meaning.** Historical financial evidence cannot be rewritten to make a later narrative look cleaner.
14. **Privacy by minimization.** A verifier receives only what it needs for the requested verification purpose.
15. **No false compliance.** PayFlow may publish mappings and evidence; it must not claim certification, regulatory compliance or standards conformance before that exact status is obtained and independently demonstrable.
16. **No security-by-brand.** The logo, Gate mark, color or acceptance mark is never itself evidence of authorization.
17. **No feature breadth that weakens the kernel.** New financial actions are added one semantic class at a time with explicit failure, replay, reconciliation and evidence contracts.
18. **Financial truth before interface optimism.** UI, motion and notifications must never celebrate success before durable financial truth exists.

---

# 3. Market and standards conclusion

The 2026 market is converging around agent identity, verifiable intent, delegated credentials, runtime authorization, merchant recognition and payment execution. This validates the category but also means PayFlow must not compete by merely offering spending limits or generic policy checks.

The durable differentiation is the combination of:

- exact financial-authority semantics;
- reservation and authority accounting;
- immediate execution-boundary revalidation;
- one-time execution grants;
- replay/concurrency safety;
- provider-effect truth;
- UNKNOWN-safe reconciliation;
- independent proof of authority and financial outcome;
- protocol- and rail-neutral composition.

Generic authorization standards are allies. PayFlow should interoperate with externalized authorization systems where useful while preserving the specialized financial semantics that generic PDP/PEP systems do not define.

Open identity and verifiable-credential standards are potential representation/interoperability tools, not reasons to replace the accepted PayFlow authority kernel.

---

# 4. Base product architecture

The long-term company consists of one authority kernel exposed through several coherent products. These are product surfaces, not parallel policy engines.

## 4.1 Authority

Audience: people, finance teams, organizations.

Purpose:

- create financial authority;
- understand interpreted boundaries;
- authenticate activation;
- inspect remaining authority;
- amend through explicit safe transitions;
- suspend/revoke;
- see delegations and expiry;
- understand which agents may use it.

Authority is where human or organizational intent becomes durable financial authority.

## 4.2 Gateway

Audience: agents, developers, platforms.

Purpose:

- request permission for a proposed financial action;
- obtain bounded, one-time execution capability where permitted;
- submit trusted commerce/action context;
- receive DENY / ESCALATE / ALLOW-style results and safe explanations;
- never obtain unrestricted payment credentials or direct database authority.

Gateway surfaces eventually include REST, TypeScript/Python SDKs, MCP, A2A and compatible platform adapters.

## 4.3 Verify

Audience: merchants, PSPs, platforms, counterparties, auditors, agents.

Purpose:

- verify agent/principal linkage where disclosed;
- verify that an authority reference is active and authentic;
- verify whether a proposed action fits a bounded authority;
- verify freshness/revocation/expiry;
- verify a completed operation's integrity;
- never create, widen or execute financial authority.

Verify is the foundation of network effects.

## 4.4 Proof

Audience: principals, finance teams, auditors, security teams, counterparties and machines.

Purpose:

- show what was authorized;
- show what action was evaluated;
- show reservation/grant/execution state;
- show provider effect;
- show capture count;
- show reconciliation state;
- show final verified outcome;
- expose tamper-evident machine-verifiable evidence where appropriate.

Proof is not merely an activity log. It is the financial-truth product.

## 4.5 Control Plane

Audience: enterprise organizations.

Purpose:

- organizations/workspaces;
- agent inventory;
- human sponsors/owners;
- role separation;
- authority templates;
- approval requirements;
- identity-provider integration;
- lifecycle/revocation;
- data-retention/residency controls;
- integration and audit administration.

The Control Plane configures governance around the kernel; it does not replace the kernel.

## 4.6 Rail Adapters

Purpose:

- translate an accepted execution grant into a provider-specific action;
- capture provider evidence;
- reconcile ambiguity;
- normalize final effect into PayFlow's financial-outcome model.

PayPal remains rail one. Each later rail must satisfy the same authority and evidence boundary.

## 4.7 Merchant Acceptance Kit

Purpose:

- Verify SDK;
- server-side verification examples;
- Gate/Authority Mark display rules;
- merchant request signing/verification where supported;
- proof deep links;
- privacy-preserving disclosure defaults;
- integration test suite.

The Mark signals that verification is supported. It is never proof by itself.

## 4.8 Developer Platform

Purpose:

- five-minute quickstart;
- sandbox organizations and agents;
- API/SDK reference;
- MCP server;
- A2A Agent Card;
- webhooks/events;
- proof verifier;
- test fixtures;
- threat model;
- error taxonomy;
- reconciliation guidance;
- conformance/evaluation suites.

## 4.9 Trust / Benchmark Lab

Purpose:

- Break Authority scenarios;
- replay and concurrency tests;
- provider ambiguity drills;
- malicious merchant/input tests;
- delegation attacks;
- proof tamper tests;
- reproducible public benchmark suites.

This lab uses the production authority model. It never becomes a separate security engine.

---

# 5. Internal module map

The implementation should converge toward clearly isolated modules with stable contracts:

1. **Principal & Organization** — humans, organizations, ownership and accountability context.
2. **Agent Identity Bridge** — PayFlow Agent identity plus bounded links to external agent/workload identities.
3. **Authority** — durable financial authority, scope, budget, time, merchant/action constraints and state.
4. **Delegation Graph** — parent/child delegation with monotonic attenuation.
5. **Intent Compiler** — converts untrusted natural-language or structured intent into reviewable candidate constraints; never self-authorizes.
6. **Trust Kernel** — deterministic authorization decision engine.
7. **Reservation Ledger** — concurrency-safe temporary consumption of bounded authority.
8. **Execution Grant** — one-time cryptographically bound dispatch authority.
9. **Execution Boundary** — immediate durable revalidation immediately before external effect.
10. **Rail Adapter Interface** — provider-neutral execution contract.
11. **Payment/Financial Attempt State Machine** — durable lifecycle of financial effects.
12. **Reconciliation Engine** — provider truth after timeout, network loss or ambiguous response.
13. **Evidence Ledger** — append-only semantic evidence.
14. **Operation Trace / Proof Engine** — verifies the chain of authority and outcome.
15. **Verification Service** — read-only external verification projections.
16. **Gateway & Agent Access** — scoped external access, OAuth/OIDC-compatible controls where appropriate.
17. **Protocol Adapters** — MCP/A2A/AP2/ACP/UCP/AuthZEN/etc. mappings without duplicate authority semantics.
18. **Control Plane** — organization, policy templates, sponsors, SSO/SCIM, retention and administration.
19. **Telemetry & Abuse Intelligence** — operational security and anomaly signals; signals may trigger review but never silently fabricate authority.
20. **Benchmark / Conformance** — deterministic security, interoperability and regression suites.

---

# 6. Experience and base visual system

The existing Frame/Gate/Flow/Proof concept is retained because it expresses the product rather than decorating it.

## Brand memory structures

- **Frame** = bounded authority.
- **Gate** = execution boundary.
- **Flow** = proposed action approaching authority.
- **Proof** = financial truth after the attempt.
- **Outcome line** = `$0 moved`, `$84 paid once`, or an unresolved equivalent based on authoritative state.

The **Gate** becomes the primary transferable brand asset. It must work at favicon size, inside an SDK, in a ChatGPT app, at merchant checkout, in an enterprise console and eventually as an acceptance/verification mark.

## Visual direction

The company becomes **geometry-first and monochrome-first**:

- near-black / Carbon as primary ink;
- warm Bone/Paper as primary ground;
- neutral surfaces for hierarchy;
- the current amber family becomes a semantic **Authority Signal**, not a decorative brand flood;
- state is always carried by shape + language, never color alone.

No generic fintech blue, AI purple gradient, robot mascot, shield/check identity, glassmorphism, casino-style success animation or rounded-card dashboard clone.

## Motion grammar

The canonical motion language becomes:

1. **Bound** — loose intent resolves into explicit boundaries.
2. **Gate** — a proposed action approaches the execution boundary.
3. **Commit** — only an authorized action crosses after execution conditions hold.
4. **Verify** — only durable provider/evidence truth resolves the interface.

UNKNOWN remains visually unresolved. Nothing may animate as success before financial truth exists.

## Core surfaces

Personal / small-team product:

- Home
- New Authority
- Authorities
- Agents
- Activity
- Proof

Developer product:

- Overview
- Agents
- Gateway
- API / SDK / MCP / A2A
- Webhooks
- Proof Verifier
- Sandbox
- Logs

Enterprise product:

- Organization
- Authorities
- Agents
- Delegations
- Templates / Controls
- Activity
- Reconciliation
- Integrations
- Audit / Proof
- Security / Data controls

Verifier / merchant experience:

- one minimal verification result;
- clear principal/agent/action/authority status where disclosure is permitted;
- expiry/revocation/freshness;
- provider/outcome proof where requested;
- no execution control.

---

# 7. Naming lock

`PayFlow` is treated as the **current project/codename**, not an automatically permanent commercial masterbrand.

Reason: PayPal continues to operate a current product family called Payflow / Payflow Gateway in the same broad payments ecosystem. This ADR does not make a legal infringement finding. It creates a commercial naming-risk gate.

Before broad public commercial launch, the company must either:

1. obtain appropriate professional clearance to continue the PayFlow name; or
2. adopt a new cleared masterbrand.

Naming brief:

- 4–8 letters preferred;
- globally pronounceable;
- abstract rather than `Pay+X`, `Agent+X`, `Trust+X`, `Guard+X` or `Flow+X`;
- capable of becoming a noun and product-family prefix;
- visually strong in text and symbol use;
- clearable across relevant trademark classes and major markets;
- reasonable domain/package/social availability;
- compatible with `Name Authority`, `Name Gateway`, `Name Verify`, `Name Proof`.

The Gate/Frame/Flow visual grammar must survive a rename. The kernel, database migrations, Git history, evidence and financial semantics do not depend on the public wordmark.

---

# 8. AI-native distribution lock

PayFlow must be discoverable and usable by agents, not only humans.

Distribution targets include:

- public REST API;
- TypeScript SDK;
- Python SDK;
- official MCP server and registry publication;
- A2A Agent Card / agent discovery surface;
- ChatGPT app submission where eligible;
- reference integrations for major agent frameworks;
- canonical machine-readable documentation;
- package registries;
- signed well-known metadata where appropriate;
- public verifier endpoints;
- merchant integration kit.

Tool vocabulary should remain small and semantically obvious. Prefer a handful of high-value tools such as:

- `check_financial_authority`
- `request_authorized_action`
- `verify_authority`
- `verify_financial_proof`
- `reconcile_financial_action`

Tool-selection evaluation is a product discipline. Maintain positive, negative and ambiguous prompt suites so agent platforms select PayFlow when financial authority is relevant and avoid it when it is not.

Search/AEO strategy is evidence-led, not content spam. Publish the best canonical material on bounded financial authority, agent payment authorization, human-not-present controls, replay safety, provider ambiguity, financial reconciliation, delegated authority, autonomous procurement and verifiable financial outcomes.

---

# 9. Commercial model lock

Initial commercial wedge:

> **Autonomous procurement and accounts-payable execution under bounded financial authority.**

Examples:

- approved-vendor purchasing;
- recurring supplies;
- controlled SaaS/vendor spend;
- invoice settlement;
- inventory replenishment;
- routine operational procurement.

Why this wedge: business workflows already contain suppliers, budgets, approvals, invoice context and accountability structures, making delegated execution measurable and valuable.

Expansion is by **financial action semantics**, not random verticals.

Long-term action taxonomy may include:

- purchase;
- invoice settlement;
- subscription/renewal;
- refund authorization;
- payout;
- procurement order;
- reimbursement;
- recurring payment;
- marketplace disbursement;
- machine-to-machine purchase;
- treasury movement.

Each action class requires its own authority, failure, replay, reconciliation and proof contract before launch.

Pricing direction:

- generous sandbox/developer tier;
- platform subscription;
- governed-action usage;
- enterprise annual commitment for organization controls, retention, regional options, integrations, support and assurance;
- verification should be free or very low-friction where possible to maximize network adoption.

The core business should not depend on charging a percentage of payment volume. PayFlow is not trying to become the execution rail.

---

# 10. Network flywheel lock

The intended network effect is:

1. Principals create useful, reusable bounded Authority.
2. Agents integrate because Authority lets them act without unrestricted credentials.
3. Merchants integrate Verify because they need to distinguish legitimate autonomous action from risky automation.
4. Platforms embed Gateway/Verify because doing so increases safe automation.
5. More verification points make PayFlow Authority more useful to agents and principals.
6. Open verifier tooling and standards compatibility reduce ecosystem fear of vendor lock-in.
7. The Gate/Authority Mark becomes recognizable because it appears at real decision boundaries, not because it is placed everywhere decoratively.

Long-term Mastercard-scale outcome:

> People who have never opened the PayFlow application still benefit because software, merchants, platforms or financial institutions around them use PayFlow-compatible authority or verification infrastructure.

---

# 11. Milestone governance model

The roadmap has three lock strengths.

### Execution lock — M6–M15

Detailed implementation order and hard gates are binding unless explicitly amended.

### Architecture lock — M16–M30

The destination and dependency order are binding; implementation details may change as standards and market evidence change.

### Strategic horizon lock — M31–M60

The company direction is locked, but every five-milestone phase requires fresh research before implementation because standards, regulation and market structure will change.

Only one money-moving milestone should be active at a time unless an explicitly authorized read-only research/documentation stream cannot affect financial behavior.

---

# 12. M6–M60 roadmap

## PHASE A — PROVE THE KERNEL, BECOME A PLATFORM (M6–M10)

### M6 — Delegated / Human-Not-Present Commerce

Close the already implemented M6 work with real PayPal Sandbox acceptance, exact-one capture, replay safety, `$184 -> $0 moved`, independent review and merge.

**Hard gate:** live `M6 SANDBOX ACCEPTANCE: PASS`, evidence preserved, independent review complete, CI green, merged.

### M7 — Authority Platform + External Agent Gateway

Turn the accepted kernel into a hosted platform with external-agent access, stable API contracts, scoped access, developer quickstart, first live commerce input and the naming/brand clearance program.

**Hard gate:** an external agent can request an eligible action but cannot widen Authority, bypass the Trust Kernel, access unrestricted credentials or fabricate proof; valid HNP PayPal action completes exactly once and malicious drift moves `$0`.

### M8 — Verify + Interoperable Authority

Launch independent read-only verification and portable bounded assertions derived from durable PayFlow state. Add carefully bounded MCP/A2A/AP2/ACP/UCP/AuthZEN mappings where justified.

**Hard gate:** independent verifier proves valid, invalid, revoked, expired and tampered cases; verification cannot move money or widen authority.

### M9 — Trust Experience + Break Authority 100

Upgrade the product into a premium Authority/Gateway/Verify/Proof experience and run a fixed reproducible adversarial benchmark.

**Hard gate:** fixed 100-case suite is reproducible; public claims match measured results; valid delegated actions still complete while unauthorized cases have no unauthorized provider effect.

### M10 — Public Developer Preview + Hackathon Freeze

Finish company-grade documentation, SDK entry point, hosted demo, public repo hygiene, final competition submission, privacy/security baseline and commercial-name decision gate.

**Hard gate:** exact-head acceptance is reproducible; public integration works; no secrets; final name is either cleared for use at this stage or a migration plan/new masterbrand is approved.

---

## PHASE B — DOMINATE THE FIRST COMMERCIAL WEDGE (M11–M15)

### M11 — Procurement Authority Pack

Create production-shaped authority templates and APIs for approved-vendor purchasing, invoice settlement and bounded operational spend.

**Gate:** one repeated end-to-end procurement workflow is proven with deterministic evidence.

### M12 — Design Partner Pilots

Run structured pilots with agent builders, finance/procurement software and/or businesses with real automation needs.

**Gate:** at least five serious design-partner relationships and at least two concrete pilot/integration commitments or equivalent evidence.

### M13 — Enterprise Organization Control Plane

Organizations, environments, roles, human sponsors, agent inventory, authority templates, revocation controls, SSO/OIDC and SCIM where justified.

**Gate:** owner isolation, sponsor accountability, role separation and lifecycle controls are independently tested.

### M14 — Production Reliability & Security Baseline

Multi-environment deployment, key rotation, backup/restore, incident response, abuse controls, observability, SLOs and disaster testing.

**Gate:** documented recovery exercises and failure drills complete without weakening financial invariants.

### M15 — Pricing + Revenue Validation

Test platform subscription, governed-action usage and enterprise commitments without turning PayFlow into a take-rate PSP.

**Gate:** at least one credible paid or contractually committed commercial path and measured customer value.

---

## PHASE C — BECOME AGENT-NATIVE INFRASTRUCTURE (M16–M20)

### M16 — Official MCP Distribution

Publish the production-quality MCP server, ownership metadata, safe tool descriptions and registry entry.

**Gate:** clean install/discovery path and tool-selection evaluation suite.

### M17 — ChatGPT App Surface

Build a tightly scoped ChatGPT app around real authority workflows where platform eligibility and policies permit.

**Gate:** app review requirements, privacy disclosures and action safety are satisfied; no claims of recommendation/featuring are made unless actually granted.

### M18 — A2A Agent Card + Agent-to-Agent Delegation

Publish discoverable capabilities and bounded agent-to-agent request flows.

**Gate:** sub-agent requests are cryptographically linked and can only attenuate parent authority.

### M19 — Major Agent Framework Reference Integrations

Reference adapters/examples for leading agent ecosystems while keeping Gateway semantics stable.

**Gate:** at least three independent agent frameworks use the same financial-authority contract without bespoke policy forks.

### M20 — Agent Discoverability & Selection Evals

Build a maintained benchmark for when models should invoke PayFlow, which tool they should choose and when they must not call it.

**Gate:** measurable precision/recall-style evaluation across direct, indirect, ambiguous and negative financial-authority prompts.

---

## PHASE D — CREATE THE VERIFICATION NETWORK (M21–M25)

### M21 — Verify API Public Release

Stable read-only verification API with privacy-minimized responses.

**Gate:** independent integrations verify authority without receiving execution power.

### M22 — Portable Authority Credential / Presentation Research-to-Implementation

Implement a standards-compatible portable proof/presentation format where W3C/OpenID or other mature specifications genuinely fit.

**Gate:** selective disclosure, revocation/freshness and tamper detection demonstrated; no standard claim exceeds implementation.

### M23 — Merchant Verify SDK + Gate Mark Alpha

Ship merchant libraries and a controlled Gate/Authority Mark program.

**Gate:** mark display is always backed by real verification; the mark alone is never trusted as evidence.

### M24 — Authority / Verifier Directory

Create machine-readable discovery for approved PayFlow services, verifier keys/endpoints and ecosystem integrations.

**Gate:** namespace ownership, key rotation and anti-impersonation behavior are tested.

### M25 — Merchant / PSP Verification Pilots

Integrate Verify into merchants, PSP-adjacent systems or marketplaces without requiring PayFlow to process the payment.

**Gate:** third-party transaction flow benefits from PayFlow verification while execution remains on an external rail.

---

## PHASE E — MULTI-RAIL + MULTI-ACTION AUTHORITY (M26–M30)

### M26 — Second Execution Rail

Add a genuinely different provider rail behind the accepted execution-boundary interface.

**Gate:** same Authority semantics, replay guarantees, UNKNOWN handling and Proof model survive both rails.

### M27 — Third Rail / Account-to-Account or Equivalent

Add a rail with different settlement/failure characteristics to pressure-test neutrality.

**Gate:** provider-specific semantics are normalized without lying about differences.

### M28 — Financial Action Schema v1

Generalize beyond `purchase` into a typed `financial_action` model without losing exact semantics.

**Gate:** backward compatibility and explicit action-specific authority contracts.

### M29 — Additional Consequential Actions

Introduce a small number of actions such as invoice payment, payout, refund or renewal only after individual safety contracts exist.

**Gate:** each action has replay, concurrency, reversal, ambiguity and proof tests.

### M30 — Multi-Currency / Fee / FX Authority

Represent currency, conversion, fee and price-slippage bounds explicitly.

**Gate:** no currency conversion or fee widening can silently escape Authority.

---

## PHASE F — ENTERPRISE FINANCIAL AUTHORITY OS (M31–M35)

### M31 — Delegation Graph at Enterprise Scale

Multi-level agents, departments, services and sub-agents with strict attenuation.

### M32 — Separation of Duties + Multi-Party Approval

Quorum, role separation, dual control and policy-required human escalation for high-impact authority.

### M33 — Agent Lifecycle Governance

Human sponsor, creation, review, expiry, orphan detection, disablement and revocation across large fleets.

### M34 — Organization Policy Packs

Reusable procurement, AP, marketplace and machine-spend templates layered above the same kernel.

### M35 — ERP / Procurement / AP Integrations

Deep integrations with systems of record so Authority can follow real business context rather than isolated demo objects.

**Phase gate M31–M35:** enterprise governance must increase control without creating a second authorization truth.

---

## PHASE G — RESILIENCE, ASSURANCE + REGULATORY READINESS (M36–M40)

### M36 — Reconciliation Operations Center

Enterprise-grade handling of UNKNOWN, provider delay, conflicting evidence and recovery.

### M37 — Break Authority 1000

Expand the deterministic adversarial benchmark across agents, protocols, rails, concurrency and external integrations.

### M38 — Data Residency / Retention / Privacy Controls

Regional storage, retention policies, deletion boundaries, minimization and proof retention rules.

### M39 — Independent Security / Assurance Program

Work toward appropriate external audits/certifications such as SOC 2 / ISO 27001 where commercially justified. Never claim them before obtained.

### M40 — Regulatory & Standards Evidence Maps

Maintain auditable mappings to relevant frameworks such as SAFR, NIST agent-identity guidance, applicable AI/payment/privacy obligations and standards conformance.

**Phase gate M36–M40:** PayFlow can explain and evidence controls without pretending a mapping equals legal compliance.

---

## PHASE H — GROW THE ACCEPTANCE NETWORK (M41–M45)

### M41 — Authority Mark Public Beta

Controlled program allowing merchants/platforms to signal support for verifiable autonomous authority.

### M42 — Frictionless Verification Economics

Make verification free or extremely low-friction where sustainable to maximize acceptance.

### M43 — PSP / Acquirer / Gateway Partner Kit

Reference integration layer for providers that want PayFlow Authority/Proof without ceding their rail role.

### M44 — Marketplace / Platform Embedded Authority

Allow platforms to embed the Authority/Verify experience under clear branding and security rules.

### M45 — Network Abuse Intelligence

Cross-network operational signals for compromised agents, replay storms and anomalous behavior. Signals can trigger review/deny according to explicit policy but do not create new financial authority.

**Phase gate M41–M45:** users who never open PayFlow directly must already benefit through a third-party integration.

---

## PHASE I — OPEN AUTHORITY STANDARDIZATION (M46–M50)

### M46 — Public Financial Authority Schema

Publish a precise, implementation-independent schema for expressing bounded financial authority and action requests.

### M47 — Open-Source Verifier

Release a small independently auditable verifier so ecosystem participants can validate proofs without depending entirely on PayFlow-hosted code.

### M48 — Conformance Suite

Publish deterministic tests for authority issuance/presentation, revocation, attenuation, replay safety and proof verification.

### M49 — Standards-Body Participation

Participate where appropriate in FIDO, AAIF/MCP/A2A, OpenID or other relevant communities rather than creating an isolated proprietary pseudo-standard.

### M50 — Financial Authority Interoperability Profile v1

Publish a mature profile that maps PayFlow's financial semantics onto relevant open standards without claiming ownership of unrelated standards.

**Phase gate M46–M50:** at least one independently built implementation or verifier interoperates from the public specification/conformance suite.

---

## PHASE J — FEDERATED GLOBAL AUTHORITY NETWORK (M51–M55)

### M51 — Multi-Region Active/Active Trust Infrastructure

Resilient global verification and authority services with region-aware data handling.

### M52 — Public Key / Configuration Transparency

Tamper-evident publication of verifier keys, rotations and network configuration so ecosystem participants can detect unauthorized change.

### M53 — Federated Verification

Multiple trusted verification operators can validate authority/proof under a common network profile.

### M54 — External Authority Issuer Interoperability

Allow approved external issuers to express compatible bounded authority while PayFlow Verify can validate provenance and semantics. External issuance never bypasses financial execution checks.

### M55 — Machine-to-Machine Authority

Agents, devices and services can purchase compute, data, energy, logistics or other machine services under zero-standing, bounded financial authority.

**Phase gate M51–M55:** the network no longer depends on every participant calling one centralized PayFlow verification endpoint.

---

## PHASE K — MASTERCARD-SCALE FINANCIAL AUTHORITY (M56–M60)

### M56 — Embedded Consumer Authority

Banks, wallets, assistants and operating systems can expose bounded financial authority to consumers without requiring consumers to become direct PayFlow app users.

### M57 — Embedded Enterprise Authority

Procurement, finance, ERP, marketplace and agent platforms can make PayFlow-compatible authority a native infrastructure capability.

### M58 — Ubiquitous Authority Acceptance

The Gate/Authority Mark becomes a recognizable signal that a merchant/platform supports verifiable autonomous financial authority, backed by real verification.

### M59 — Network Rules + Recourse Evidence Framework

Publish clear technical network rules for authority provenance, verification, proof, operational disputes and evidence exchange. PayFlow does not unilaterally declare legal liability.

### M60 — Financial Authority Network

Operate as a neutral global infrastructure layer in which principals, agents, merchants, enterprise platforms and financial rails interoperate around a shared verifiable authority model.

Success at M60 is not measured by how many people have opened the PayFlow app. It is measured by how often financial actions are safer and more accountable because PayFlow-compatible Authority, Verify or Proof is present somewhere in the transaction chain.

---

# 13. Metrics that matter

Early metrics:

- delegated actions evaluated;
- unauthorized provider effects prevented;
- legitimate authorized completion rate;
- duplicate-capture prevention;
- time to integration;
- design-partner activation;
- repeated procurement workflows;
- proof verification success;
- reconciliation time for UNKNOWN outcomes.

Network metrics:

- active agents using Gateway;
- active organizations issuing Authority;
- merchants/platforms using Verify;
- percentage of verified actions initiated by users who never directly opened PayFlow;
- number of independent frameworks/rails integrated without semantic forks;
- number of independent verifier implementations;
- Authority Mark acceptance points;
- protocol/standards conformance pass rates.

Never optimize vanity registrations over real governed financial actions and verifications.

---

# 14. Explicit long-term non-goals

Even at M60, PayFlow should not become these merely for breadth:

- a general-purpose LLM;
- a consumer bank by default;
- a card issuer by default;
- a crypto custody provider by default;
- a generic IAM replacement;
- a generic policy engine for every enterprise permission;
- a browser automation company;
- an ecommerce marketplace;
- a merchant of record merely to own checkout;
- a social trust/reputation score for humans;
- a system that silently makes legal-liability judgments;
- a proprietary standard that refuses to interoperate with mature open work.

Any future move into regulated financial products requires a separate company-level strategic and regulatory decision. It is not implied by this roadmap.

---

# 15. Brand and product test

Before any feature is accepted, ask:

1. Does this strengthen financial authority, execution truth or verification?
2. Does it broaden distribution while keeping the category narrow?
3. Could a rail, model or protocol be replaced without breaking the authority model?
4. Does it create a new source of truth that conflicts with the Trust Kernel?
5. Does it help a user, agent, merchant or auditor understand whether authority existed and what actually happened?
6. Can the claim be independently demonstrated?

If the answer to #1 or #5 is no, the feature is probably outside the company's center.

---

# 16. Immediate next-state rule

This ADR does not change the active execution state:

> **Finish M6 first.**

Until M6 passes live Sandbox acceptance, independent review and merge:

- M7 remains NOT STARTED;
- no M7 financial implementation begins;
- the roadmap may be reviewed/documented only;
- no future milestone may be used to excuse an M6 acceptance gap.

Once M6 is closed, M7 becomes the first execution milestone under this roadmap.

---

# 17. Final company thesis

The company should not try to be everywhere by becoming everything.

It should become everywhere by making one primitive indispensable:

> **Financial authority for autonomous systems.**

The product becomes broad through compatibility — agents, protocols, merchants, enterprise platforms, rails and regions — while the company remains narrow in what it promises to own:

> **Was this exact autonomous financial action authorized, was that authority still valid at execution time, what financial effect actually occurred, and can the result be independently verified?**

If PayFlow can become the most credible answer to that question, people who never open the application can still benefit from the network — the intended Mastercard-scale outcome.
