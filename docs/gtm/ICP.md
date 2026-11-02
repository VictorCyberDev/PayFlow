# Ideal Customer Profile (hypotheses to test)

Status: **every row below is a hypothesis.** PayFlow has had 0 customer conversations. Facts about PayFlow (what exists today) are in the repo; claims about buyers are guesses until discovery interviews (see DISCOVERY-GUIDE.md) produce evidence. Product reality: developer preview, PayPal Sandbox only, no customers, no certification.

Legend: [H] = hypothesis. [F] = fact about PayFlow from repo docs.

## Cross-segment

- [F] PayFlow decides what an agent may do economically, enforces before money moves, and proves what happened; unknown provider outcomes stay UNKNOWN.
- [H] The first real buyer is a team already letting software initiate money movement, not one merely exploring.

## 1. AI procurement

- First buyer [H]: product or AI lead at a procurement platform; finance/security stakeholder as veto.
- Technical user [H]: platform/payments engineer.
- Painful problem [H]: agents advance purchases to payment but "inside policy" is not independently enforced or provable at the payment step.
- Current alternative [H]: platform-internal approval workflows and ERP controls.
- Economic consequence of failure [H]: wrongful payments, duplicate payments, audit findings.
- Why now [H]: vendors market autonomous source-to-pay agents.
- Why PayFlow [H]: pre-execution enforcement, replay prevention, proof.
- Likely objection [H]: "We built this" / sandbox-only PayPal is irrelevant to our rails.
- Required proof: working rail adapter for their payment path, design-partner pilot with measured denial/replay/UNKNOWN handling.

## 2. Accounts-payable automation

- First buyer [H]: product/risk leader; controller as stakeholder.
- Technical user [H]: payments engineering.
- Problem [H]: AI-prepared payments need an authority boundary and unknown-payout handling.
- Current alternative [H]: approval chains, dual control, bank-side limits.
- Consequence [H]: misdirected payouts, duplicates, unreconciled payments.
- Why now [H]: AP vendors advertise agentic AI.
- Why PayFlow [H]: deterministic check plus Proof package for auditors.
- Objection [H]: existing controls suffice; integration cost; no certification.
- Proof: replay and UNKNOWN test vectors on their flow; auditor-readable Proof export.

## 3. Agent infrastructure

- First buyer [H]: platform/product lead.
- Technical user [H]: agent/platform engineer.
- Problem [H]: tool-calling frameworks offer generic approval but no payment-grade authority.
- Alternative [H]: human-in-the-loop prompts, scoped OAuth, in-house limits.
- Consequence [H]: customer agents overspend; the platform bears reputational risk.
- Why now [H]: agents increasingly given tools that touch payments.
- Why PayFlow [H]: SDK/protocol layer that any agent framework can call.
- Objection [H]: out of scope for our product; competing "trust layer" vendors.
- Proof: reference integration; two independent frameworks calling it.

## 4. Enterprise AI

- First buyer [H]: head of AI platform or CISO.
- Technical user [H]: AI platform engineering.
- Problem [H]: internal agents may buy or pay; no one owns limits.
- Alternative [H]: ban autonomous spend; corporate cards.
- Consequence [H]: shadow spend, incidents blocking agent programs.
- Why now [H]: pressure to move agents from demo to action.
- Why PayFlow [H]: gives security and finance an inspection path.
- Objection [H]: procurement and legal review timelines; vendor viability.
- Proof: security review pack, a named internal sponsor. No enterprise has been identified (see PROSPECTS.md).

## 5. Fintech / PSP / commerce infrastructure

- First buyer [H]: product lead for agentic commerce.
- Technical user [H]: integration/payments engineer.
- Problem [H]: PSP receives agent-originated requests and cannot verify delegated authority.
- Alternative [H]: card network tokens, internal risk rules.
- Consequence [H]: disputes, fraud losses, unclear liability.
- Why now [H]: vendors list agentic-commerce products.
- Why PayFlow [H]: verifiable authority and merchant verification kit (MERCHANT-PSP-PILOT-KIT).
- Objection [H]: network standards will dominate; adding a dependency.
- Proof: interoperability profile test against their sandbox; a pilot verify hook.

## 6. AI-native operations tools

- First buyer [H]: product lead; finance ops leader.
- Technical user [H]: backend engineer.
- Problem [H]: ops agents (close, spend, payouts) act with broad credentials.
- Alternative [H]: human review of outputs, service accounts.
- Consequence [H]: wrong postings or payments, weak audit trail.
- Why now [H]: agents marketed as doing finance workflows.
- Why PayFlow [H]: scoped authority and evidence.
- Objection [H]: our agents do not move money directly.
- Proof: discovery confirms money-moving actions exist; otherwise drop the segment.

## Prioritization (hypothesis)

Agent infrastructure and fintech/PSP first (closest to the SDK and technical buyers), AP/procurement second, enterprise AI last. Revisit after the first 10 interviews.
