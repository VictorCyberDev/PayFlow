# ADR-018 — PayFlow Roadmap V3: Business Execution Platform + Financial Authority Network (M26–M95)

**Date:** 2026-11-07  
**Decision:** User-approved V3 roadmap preservation; implementation and external commissioning remain evidence-gated.  
**Baseline:** `c803e7cdec096dfd7812140d1494c971c868fb5d` at time of preservation.  
**Scope:** New customer product M26–M60; rebaseline pre-existing strategic roadmap M26–M60 to V3 M61–M95 without deleting historical references.  
**Status:** Adopted as forward execution sequence for review; **this document does not mark any milestone complete**.

## 1. Constitution

The PayFlow company builds three connected product surfaces:

- **PayFlow Missions:** outcome-driven agents coordinating business tasks under a Mission Contract.
- **PayFlow Spend Desk:** owner workspace for sourced providers, quotes, negotiations, approvals, obligations, payments and completion.
- **PayFlow Authority:** existing Trust Kernel, Gateway, reservations, single-use grants, provider reconciliation, Proof and independent Verify.

**Positioning:** Let authorized AI do economically consequential work; keep every financial commitment under the owner's control and prove the outcomes.

The initial accessible vertical is **Founder Launch**; recurring agency/SMB procurement and business operations are the intended repeat-use commercial wedge. Broad marketplace and financial network infrastructure is a later platform horizon. No product-market fit is claimed.

Architectural invariants: one Trust Kernel; authenticated principal ≠ Authority; source quote ≠ accepted commitment; negotiated term ≠ payment permission; completed tool call ≠ settled provider effect; UNKNOWN ≠ FAILED; no automatic retry of uncertain economic actions; every delegation attenuates; shared budgets conserved under concurrency; no fake listings, supplier acceptance, bookings, hires, external customers or partner logos.

Legal/provider boundaries: use only authorized APIs and permitted communication/checkout/contract flows; marketplace funding/hiring remains on the marketplace where required. No false escrow/guaranteed settlement claim.

## 2. Preservation and migration of historical IDs

Historical `docs/ADR-017-financial-authority-network-m7-m60.md`, its architecture records, existing module names, signed evidence, past PRs and SQL migration filenames remain immutable evidence. The old M26–M60 labels **must not be used as future V3 execution milestones without the explicit crosswalk below**.

New V3 M26–M60 = complete business-execution product. Legacy M26–M60 = V3 M61–M95 (exact positional offset +35). **Do not rename or re-run any existing SQL migration based on milestone label**. Migration number is database version, independent of V3 roadmap milestone.

If source docs disagree about an old milestone, preserve the older source and reference this ADR as the newer sequencing amendment. Do not misrepresent older code as having been rebuilt or newly accepted.

## 3. Current baseline and phase-zero closure

As of this ADR, repo source `c803e7cdec096dfd7812140d1494c971c868fb5d` includes merged PRs #33–#40 (Gate A and M16–M25 foundation). Latest owner report: 2,297 local tests passed, 3 skipped on pre-#40 tree; PR #40 docs-only CI successful. This ADR does not independently claim those local totals.

Gate A is **owner-gated**, not publicly commissioned. Vercel `payflow-public` has no deployment. Public Neon lacks post-023 application tables; finish migrations using controlled migrator and verify privileges. Privileged `svc_public_app` still requires owner-approved removal; `svc_public_rt` requires owner-set secret; production-only secrets, real monitored security contact and separate alert channel are not yet commissioned. Keep `payflow-m6-acceptance` protected. Never use secrets-in-transcript workaround or copy accepted wallet/payment data to the public sandbox.

Open positioning PR #32 and any current integration PR must be reviewed on their exact heads before merging. Scope and sequencing updates do not authorize payment rail deployment.

Phase-zero gate: security remediation; public URL; verified anonymous developer journey; safe cron/reconciliation; privilege tests; genuine PayPal Sandbox acceptance wherever claimed; documented rollback and measured uptime/readiness. Owner-gated work may remain pending while independent V3 engineering proceeds.

## 4. Product release gates

- **M30:** real mission contract, durable plan, budget and owner controls.
- **M35:** real supported external source discovery with provenance, supplier assessment and comparable quotes.
- **M40:** bounded negotiation and legitimate PayPal Sandbox execution with independent Proof; no phantom merchant checkout.
- **M45:** multi-vendor order, fulfillment and financial obligation accountability.
- **M50:** marketplace-compliant talent discovery/hiring and milestone tracking.
- **M55:** complete integrated Founder Launch mission across supported providers; unsupported actions are explicit handoffs.
- **M60:** durable recurring customer-ready Missions/Spend Desk, actual third-party user evaluation, real source/payment evidence and measured retention/value.
- **M65:** additional genuinely commissioned execution rails and consequential action types.
- **M70–M95:** enterprise financial Authority, operational assurance, distribution, standards and network.

Each gate requires reproducible functional tests, failure tests, operational proof in the intended environment, security boundaries and truthful external status. 'CODE_PRESENT', 'COMPLETE_LOCAL' and 'COMPLETE_REAL' are not interchangeable.

## 5. M26–M60: complete Missions / Spend Desk product

### Phase A — Mission Operating System foundation (M26–M30)

| Milestone                                      | Contract and implementation                                                                                                                        | Acceptance                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M26 — Mission Contract v1**                  | Versioned goal/outcome schema, context, location, deadline, acceptance conditions, risk/permission limits, owner-signature and change controls.    | Create, amend, cancel and replay missions without agent widening, tenant crossover, ambiguous terms or stale-plan execution.                          |
| **M27 — Mission Planning Engine**              | Dependency-aware tasks, cost/time estimates, assumptions, resource requirements, specialist assignment and plan versioning.                        | Durable executable plan with explicit capability handoffs, uncertainty, human approvals and deterministic resumption.                                 |
| **M28 — Project Budget and Commitment Ledger** | Separate planned, quoted, approved, committed, reserved, in-flight, settled, refunded, cancelled, externally committed and unknown exposures.      | Atomic shared-budget conservation under concurrent agents, no double-count of commitments during state transitions, consistent currency/fee handling. |
| **M29 — Mission Authority Compiler**           | Translate owner-approved mission limits into existing PayFlow Authority, delegation, procurement rules and execution grants; no new policy engine. | All action paths evaluate the one Trust Kernel; negotiation scope cannot become contractual/payment authority.                                        |
| **M30 — Mission Workspace v1**                 | Mission control UI for owners, agent roles, timelines, money, approvals, supplier evidence, action status and pause/revoke.                        | New user can create, inspect, revise, interrupt and resume a real mission with accessible mobile/desktop UX.                                          |

**Phase hard gate:** An owner can create a durable mission with a fixed shared budget, delegate narrowly, pause/resume and inspect real state. No agent can grant itself economic power.

### Phase B — Supplier discovery and intelligent sourcing (M31–M35)

| Milestone                                     | Contract and implementation                                                                                                                      | Acceptance                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **M31 — External Connector Framework**        | Permissioned connector manifests for search, pricing, communication, booking, execution and read-only status; provider-specific scope and quota. | No adapter can bypass the Trust Kernel, use unauthorized endpoints or falsely advertise a capability.                   |
| **M32 — Multi-Source Product Discovery**      | Authorized commerce/catalog APIs, normalized offers, pagination, inventory/availability timestamping, query budgets and provenance.              | Actual provider results can be ingested; duplicates identified; missing catalog access reported rather than fabricated. |
| **M33 — Supplier Identity and Qualification** | Identity, trust signals, product legitimacy, coverage, sanctions/compliance checks where justified, verification state and source confidence.    | Unverified suppliers are explicitly unverified; source metadata is independently retrievable.                           |
| **M34 — Quote and Total-Landed-Cost Engine**  | RFQ/quote schema, tax, shipping, fees, deposits, warranties, cancellation, expiry, location, currencies and total cost.                          | Side-by-side comparison for equivalent requirements; stale quotes or untrusted totals cannot become authoritative.      |
| **M35 — Sourcing Optimization Engine**        | Explainable ranking across total landed cost, time, quality, fit, reliability and risk under user-selected weights.                              | Repeatable ranked shortlist tied to evidence; optimization never invents merchant prices or commits funds.              |

**Phase hard gate:** An authenticated mission finds real eligible offers from supported sources, retains provenance, produces an explainable shortlist and knows when execution is unsupported.

### Phase C — Negotiation and authorized purchasing (M36–M40)

| Milestone                                       | Contract and implementation                                                                                                                      | Acceptance                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **M36 — Negotiation Contract**                  | Independent negotiation rights, bounds, counteroffer authority, approved communication channels, nonbinding/binding semantics and opt-out rules. | Agents cannot represent a binding offer, approve their own concession or expand the maximum commitment.                                         |
| **M37 — Supplier Communication Engine**         | Permissioned RFQs, responses, follow-ups and negotiations through provider-approved channels; durable messages and anti-spam controls.           | No unsolicited flooding or unapproved communication; all exchanged terms have attributable evidence.                                            |
| **M38 — Counteroffer and Bargaining Engine**    | Structured counteroffers for price, delivery, warranty, support and payment timing; supplier acknowledgement and term expiry.                    | Every proposed concession is within mission policy; no fabricated supplier acceptance.                                                          |
| **M39 — Offer Acceptance and Human Escalation** | Explicit quoted/offered/conditionally accepted/approved/contractually committed states, owner gates and changed-term invalidation.               | No binding commitment without required authenticated approval and applicable provider/legal mechanism.                                          |
| **M40 — Procurement-to-PayPal Execution**       | Connect trusted quote and procurement pack to current Gateway, Trust Kernel, reservation, grant, PayPal Sandbox, reconciliation and Proof.       | Real provider acceptance for allowed case; wrong amount/merchant denied pre-provider; replay at most once; UNKNOWN never retries automatically. |

**Phase hard gate:** A real supported quote can move from sourcing through bounded negotiation and approved PayPal Sandbox execution to independent Proof; denial and UNKNOWN are fail-closed.

### Phase D — Orders, fulfillment and financial obligations (M41–M45)

| Milestone                                     | Contract and implementation                                                                                                        | Acceptance                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **M41 — Order and Commitment Records**        | Order IDs, accepted terms, supplier obligations, purchase documents, deposit and payment milestones, event provenance.             | No loss/duplication under restart; externally recorded commitments have explicit verification status. |
| **M42 — Fulfillment and Delivery Tracking**   | Supported shipping, booking and service-delivery status connectors, evidence, deadlines and escalation states.                     | Distinguish purchased, shipped, delivered, accepted and disputed using authoritative status.          |
| **M43 — Returns, Cancellations and Disputes** | Provider-supported cancellation, refund, return and dispute procedures; obligations and receipts update only with actual evidence. | Requested refunds never appear settled; dispute/UNKNOWN are tracked and reconciled safely.            |
| **M44 — Extended Obligation Accounting**      | Contracts, recurring subscriptions, invoices, deposits and cross-provider commitments with conservative exposure accounting.       | Project budget recognizes liabilities before payment and avoids double-count when obligations settle. |
| **M45 — Multi-Vendor Commerce Acceptance**    | Integrated two-plus provider/supplier scenario, shared mission budget, independent orders and fulfillment statuses.                | Budget invariants survive concurrent multi-vendor changes, refunds, delays and unknown effects.       |

**Phase hard gate:** Multi-supplier mission correctly records orders, financial obligations, provider confirmations and actual fulfillment without conflating them.

### Phase E — Talent discovery, contracting and delivery (M46–M50)

| Milestone                                              | Contract and implementation                                                                                                     | Acceptance                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **M46 — Work Scope and Talent Requirements**           | Skill-specific briefs, deliverables, competencies, price ceiling, timelines, milestone criteria and fair job-related selection. | Founder approves a precise scope with objectively reviewable deliverables and budget.           |
| **M47 — Talent Marketplace Integrations**              | Official permitted search and workflow adapters (e.g., Upwork MCP if authorized), identity/terms checks, rate limits.           | Real searches and authorized draft actions work; no scraping or off-platform payment bypass.    |
| **M48 — Candidate Evaluation and Shortlisting**        | Evidence-backed portfolio/experience review, availability, rates, relevant criteria and human-reviewed shortlist.               | No fabricated competence or discriminatory inference; rankings transparent and auditable.       |
| **M49 — Offer and Contract Coordination**              | Provider-compliant proposals, milestones, contract handoffs, explicit legal and funding acceptance gates.                       | Hiring and funding actions execute only via properly authorized platform/owner workflows.       |
| **M50 — Deliverables and Contractor Payment Tracking** | Deliverable submissions, acceptance/dispute lifecycle, invoice/provider payout references and proof association.                | No false escrow claims; accepted work and actual provider-confirmed transfers shown distinctly. |

**Phase hard gate:** Real marketplace-compliant talent workflows allow sourcing through verified deliverable/payment status; platform financial rules are preserved.

### Phase F — Workspaces and complete Founder Launch (M51–M55)

| Milestone                                         | Contract and implementation                                                                                                          | Acceptance                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **M51 — Workspace Discovery**                     | Authorized workplace/coworking/meeting search, locality, capacities, time windows, rates and vendor data provenance.                 | Real availability/price results where providers permit; inaccessible coverage flagged.                                     |
| **M52 — Workspace Qualification and Negotiation** | Compare location, deposit, terms, cancellation, utilities, lease risk, availability and provider communication.                      | Owner can compare verified total liabilities and bounded quotes without accidental tenancy/contract signing.               |
| **M53 — Authorized Booking and Deposits**         | Safe booking/deposit provider integrations and confirmation capture; permitted human handoffs when booking API unavailable.          | Never claim reserved space or paid deposit without authentic provider evidence.                                            |
| **M54 — Business Services Marketplace Layer**     | Accountants, designers, developers, marketers, legal/professional services and operations suppliers via approved discovery channels. | Regulated advice and contracts retain professional/human approval; capability limitations visible.                         |
| **M55 — Founder Launch Mission**                  | Orchestrate workspaces, equipment, specialist talent, supplier communications, obligations and approvals in one mission.             | Independent complete multi-domain scenario with durable progress, real supported execution and clear unautomated handoffs. |

**Phase hard gate:** A founder progresses a real mission across sourcing, talent, workspace, services and payments with honest execution-versus-handoff states.

### Phase G — Autonomous operations and commercial product (M56–M60)

| Milestone                                                    | Contract and implementation                                                                                                     | Acceptance                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **M56 — Durable Mission Automation**                         | Fault-tolerant orchestration, workflows, retries, resumption, deadlines, notifications and recovery.                            | No duplicate messages/payment effects after crash, timeout or replay; resumable across workers.              |
| **M57 — Recurring Business Operations**                      | Recurring supplier replenishment, software renewals, supported invoices and budget period rollovers.                            | Each recurrence individually checked under active Authority and provider terms; revocation effective.        |
| **M58 — Vertical Mission Templates**                         | Agency, small commerce, events, travel, procurement and other evidence-supported mission recipes.                               | Each template only advertises commissioned functions; unimplemented actions produce explicit handoffs.       |
| **M59 — Complete Customer Experience and Commercialization** | Onboarding, tenant management, app permissions, billing/usage, support, accessibility, privacy, analytics and billing controls. | Stranger onboarding and return usage demonstrated; no reliance on founder to complete routine actions.       |
| **M60 — Full Product and Market Acceptance**                 | Integrated provider, mission, budget, hiring, workspace, purchase, fulfillment, recurring and customer-evaluation gates.        | Independent external users complete supported multi-domain missions; real outcomes measured, not fabricated. |

**Phase hard gate:** Independent users operate durable missions and recurring workflows; external customer adoption evaluated honestly; sandbox cannot be confused with live business commitments.

## 6. M61–M95: preserved legacy network program

### M61–M65 — Multi-rail and multi-action economic execution (legacy M26–M30)

- M61 / old M26 — Second Execution Rail
- M62 / old M27 — Third Rail / account-to-account or equivalent
- M63 / old M28 — Financial Action Schema v1
- M64 / old M29 — Additional Consequential Actions
- M65 / old M30 — Multi-Currency / Fee / FX Authority

**Hard gate:** Real provider-specific semantics; at least two distinct real provider/rail acceptance paths; same Authority, replay, UNKNOWN and Proof guarantees.

### M66–M70 — Enterprise Authority and business systems (legacy M31–M35)

- M66 / old M31 — Enterprise Delegation Graph
- M67 / old M32 — Separation of Duties + Multi-Party Approval
- M68 / old M33 — Agent Lifecycle Governance
- M69 / old M34 — Organization Policy Packs
- M70 / old M35 — ERP / Procurement / AP Integrations

**Hard gate:** Enterprise organization and identity integration without another authorization truth.

### M71–M75 — Resilience, assurance and regulatory readiness (legacy M36–M40)

- M71 / old M36 — Reconciliation Operations Center
- M72 / old M37 — Break Authority 1000
- M73 / old M38 — Data Residency / Retention / Privacy Controls
- M74 / old M39 — Independent Security / Assurance Program
- M75 / old M40 — Regulatory & Standards Evidence Maps

**Hard gate:** Reliable recovery and honest independent security/legal evidence.

### M76–M80 — Embedded distribution and acceptance network (legacy M41–M45)

- M76 / old M41 — Authority Mark Public Beta
- M77 / old M42 — Frictionless Verification Economics
- M78 / old M43 — PSP / Acquirer / Gateway Partner Kit
- M79 / old M44 — Marketplace / Platform Embedded Authority
- M80 / old M45 — Network Abuse Intelligence

**Hard gate:** Independent third-party host users genuinely benefit from verification and Authority without requiring direct PayFlow UI access.

### M81–M85 — Open Economic Authority Interoperability (legacy M46–M50)

- M81 / old M46 — Public Financial Authority Schema
- M82 / old M47 — Open-Source Verifier
- M83 / old M48 — Conformance Suite
- M84 / old M49 — Standards-Body Participation
- M85 / old M50 — Financial Authority Interoperability Profile v1

**Hard gate:** Independent verifier or implementation works from the public specification and tests.

### M86–M90 — Federated Authority Infrastructure (legacy M51–M55)

- M86 / old M51 — Multi-Region Active/Active Trust Infrastructure
- M87 / old M52 — Public Key / Configuration Transparency
- M88 / old M53 — Federated Verification
- M89 / old M54 — External Authority Issuer Interoperability
- M90 / old M55 — Machine-to-Machine Authority

**Hard gate:** Multiple independent operators verify signed Authority/Proof with controlled trust and no central-only dependency.

### M91–M95 — Global Financial Authority Network (legacy M56–M60)

- M91 / old M56 — Embedded Consumer Authority
- M92 / old M57 — Embedded Enterprise Authority
- M93 / old M58 — Ubiquitous Authority Acceptance
- M94 / old M59 — Network Rules + Recourse Evidence Framework
- M95 / old M60 — Financial Authority Network

**Hard gate:** Actual multi-party adoption, rails, credentials, verifiers and recourse operations; no simulated ecosystem claims.

## 7. Crosswalk rule and traceability

For every historical milestone H in M26–M60, V3 = H + 35. For M1–M25, the historical number remains unchanged. Exact items M26→M61, M30→M65, M31→M66, M35→M70, M36→M71, M40→M75, M41→M76, M45→M80, M46→M81, M50→M85, M51→M86, M55→M90, M56→M91, M60→M95.

Some old M26–M60 scaffolds are already in `src/network/`, `db/migrations/`, `docs/`, SDKs and examples. Inventory and reuse them; record implementation, real API wiring, tests, external commissioning and business use separately. Do not force-migrate those historical filenames.

## 8. Execution order and customer feedback loops

Start external customer research immediately. M26–M40 is the first **complete economic workflow**, not a promise to finish the full product. The whole product includes M41–M60; do not call it done at M40. First validate recurring SMB procurement, while Founder Launch provides a memorable integrated use case. Every milestone must be traceable to actual customer tasks and a bounded business outcome.

Do not build generic agents with access to unrestricted shopping, messaging, hiring or payments. Specialist tools receive precisely scoped capability grants. A capability-aware planner chooses EXECUTE (provider supported + authorized), PREPARE_HANDOFF (provider requires user/platform action), or UNAVAILABLE (no honest path); it never treats simulated action as a real booking, hire or payment.

Cost and risk controls: provider quota and model spend per mission; privacy limits for job candidates and quotes; supplier anti-spam; permissioned account access; explicit time and currency semantics; durable idempotency for message sending and economic effects; audit without storing secrets.

## 9. Measurement and product validation

At every phase collect: mission completion, time-to-first-valid-quote, real offer quality and provenance, total landed cost, approved negotiation concessions, founder intervention time, authorized commit rate, false denials, duplicate effects, unresolved UNKNOWN exposure, fulfillment timeliness, customer retention, external evaluations, paid usage and infrastructure cost. Do not invent savings or conversion metrics from fixtures.

A use case that cannot yet be commissioned due to marketplace, country, provider, merchant or credential restrictions must not be publicly presented as universally executable.

## 10. Release governance

Every branch/PR must cite V3 milestone, legacy references if relevant, module changes, migrations, exact-head CI, tests, demo evidence, credential/external blockers, customer-facing outcome and rollback. Migrate databases additively and only under authorized migrator; accepted M6 evidence remains untouched.

Status taxonomy: `COMPLETE_LOCAL`, `COMPLETE_REAL`, `PARTIAL`, `BLOCKED_EXTERNAL`. Track code, API wiring, local integration, hosted commissioning and external customer validation separately. No milestone may pass solely on docs, simulator, manifest, code presence or green CI.

This ADR controls **future milestone naming and execution order**; it does not merge PRs, trigger deployment or authorize destructive actions.

## 11. Immediate next work

1. Finish Gate A owner-controlled production setup separately; do not block safe V3 coding.
2. Review the pending OAuth/ChatGPT and PayPal positioning PRs on current main rather than merging blindly.
3. Begin **V3 M26 Mission Contract v1**, inventorying Trust Kernel, Gateway, delegated Authority, procurement schema, money/exposure projection, AI intent, workflow storage and current console.
4. Then M27–M30 with tests and a working owner-visible mission; develop official connector discovery plans for M31 in parallel.
5. Preserve this ADR and crosswalk as the authoritative V3 planning baseline after review, without rewriting historical acceptance material.
