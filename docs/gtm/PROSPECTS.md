# Qualified Prospects (research list, not a pipeline)

Status: RESEARCHED only. **No contact has been made with any company below. No relationship, reply or interest is claimed.**
Research date: 2026-11-02. Each evidence URL was opened on that date and the product description below paraphrases what that page said. Anything not shown on that page is marked `unverified`. Use-case fit, buyer roles and angles are **hypotheses**, not facts about the company.
No individuals are named: no public page opened for this list named a person. Roles are role types only.

Caveat: a company's marketing page proves what they say they do, not that they have an agent-payments problem PayFlow solves. Fit is to be tested in discovery.

Direct-adjacent note: items 1-4 sell agent payments or agent finance governance themselves. They may be competitors, integration partners or both. Treat as peer/partner conversations, not customers.

| #   | Company         | ICP segment          |
| --- | --------------- | -------------------- |
| 1   | Skyfire         | Agent infrastructure |
| 2   | Payman AI       | Agent infrastructure |
| 3   | Catena Labs     | Agent infrastructure |
| 4   | Crossmint       | Agent infrastructure |
| 5   | Arcade.dev      | Agent infrastructure |
| 6   | Composio        | Agent infrastructure |
| 7   | Browserbase     | Agent infrastructure |
| 8   | LangChain       | Agent infrastructure |
| 9   | Zip             | AI procurement       |
| 10  | Levelpath       | AI procurement       |
| 11  | Tipalti         | AP automation        |
| 12  | Stampli         | AP automation        |
| 13  | Ramp            | AI-native operations |
| 14  | Brex            | AI-native operations |
| 15  | Basis           | AI-native operations |
| 16  | Lithic          | Fintech/PSP/commerce |
| 17  | Modern Treasury | Fintech/PSP/commerce |
| 18  | Moov            | Fintech/PSP/commerce |
| 19  | Increase        | Fintech/PSP/commerce |
| 20  | Paid            | Agent infrastructure |

Enterprise AI as a segment has no named company here: no enterprise was verified with a public page showing agents that spend money. See ICP.md.

---

## 1. Skyfire

- Website: https://www.skyfire.xyz
- Evidence (opened): https://www.skyfire.xyz - page says it gives AI agents "verified identity and payment credentials", with a built-in wallet for card and stablecoin payments and recorded user approval per purchase.
- Product: agent identity and payment network/wallet.
- Agent/economic use case: agents paying for web access and purchases.
- Why PayFlow (hypothesis): overlapping layer; possible rail/credential source behind a PayFlow Authority, or a competitor.
- Likely buyer role: product or partnerships lead. Likely technical user: payments/platform engineer. (hypotheses)
- Outreach angle: peer comparison of where limits are enforced vs where credentials are issued.

## 2. Payman AI

- Website: https://www.paymanai.com
- Evidence (opened): https://www.paymanai.com - page says it deploys "AI agents that handle money" for banks and credit unions, with the institution keeping control. Page lists Visa, Coinbase, Circle as partners (first 100k characters read only).
- Product: AI agents for financial institutions.
- Agent/economic use case: money-handling agents inside regulated institutions.
- Why PayFlow (hypothesis): institution-side need to prove which action was authorized; possible overlap.
- Buyer: product/partnership lead; technical user: engineering. (hypotheses)
- Angle: peer conversation on proof and unknown-outcome handling. Treat as possible competitor.

## 3. Catena Labs

- Website: https://catena.com/
- Evidence (opened): https://catena.com/ - says it provides governance and banking infrastructure so AI agents can make payments with humans setting the rules; "The Trust Layer for Agentic Finance"; verifiable identities, policy controls, audit trails.
- Product: agent finance trust/banking layer.
- Use case: agents paying contractors, managing funds.
- Why PayFlow (hypothesis): closest category overlap; competitor or standards peer.
- Buyer/technical roles: unverified.
- Angle: low-priority peer exchange; not a pilot target until positioning is clear.

## 4. Crossmint

- Website: https://www.crossmint.com
- Evidence (opened): https://www.crossmint.com - says it provides wallet and payment infrastructure for AI agents; "Issue virtual cards for AI agents"; programmable wallets.
- Product: agent wallets and virtual cards.
- Use case: agents holding funds and transacting.
- Why PayFlow (hypothesis): enforcement before a card or wallet spends; possible complement.
- Buyer: product lead; technical user: platform/payments engineer. (hypotheses)
- Angle: ask how spend limits on agent cards are enforced and proven.

## 5. Arcade.dev

- Website: https://www.arcade.dev
- Evidence (opened): https://www.arcade.dev - actions runtime between agents and business systems; enforces authentication, authorization and policy per action; logs every action; "Govern every action for every AI agent."
- Product: agent action runtime with authorization.
- Use case: agent tool calls; money movement as a high-risk action class (hypothesis).
- Why PayFlow: PayFlow could act as the financial-action authority behind a financial tool (hypothesis).
- Buyer: product/platform lead; technical user: agent/platform engineer. (hypotheses)
- Angle: financial actions as a special class needing exact-bound one-time authorization.

## 6. Composio

- Website: https://composio.dev
- Evidence (opened): https://composio.dev - gives agents access to 1,500+ apps; stores credentials so the AI does not hold tokens; users can limit actions, require approval, review a record.
- Product: agent tool/integration layer.
- Use case: agents calling payment/billing app actions (hypothesis; not shown on the page).
- Why PayFlow: stronger guarantees for payment-class tools than generic approval.
- Buyer/technical roles: platform/product, integration engineer (hypotheses).
- Angle: payment tools through Composio and what "approval" proves.

## 7. Browserbase

- Website: https://www.browserbase.com
- Evidence (opened): https://www.browserbase.com - cloud browsers for AI agents to fill forms and complete actions; Agent Identity for bot checks and logins; "Give your agents access to the whole web."
- Product: browser infrastructure for agents.
- Use case: browser agents reaching checkout pages (hypothesis).
- Why PayFlow: checkout is where an agent could spend; authority needed before submission (hypothesis).
- Buyer/technical: product lead / developer relations; customer engineers (hypotheses).
- Angle: lower priority; ask if customers ask about payments at all.

## 8. LangChain

- Website: https://www.langchain.com
- Evidence (opened): https://www.langchain.com - open-source agent frameworks (LangChain, LangGraph, deepagents) and LangSmith platform; governance feature "Require human approval for sensitive agent actions."
- Product: agent framework and observability.
- Use case: human approval for sensitive actions, including payments (hypothesis).
- Why PayFlow: a payment authority integration pattern for HITL flows.
- Buyer/technical: developer-ecosystem or product lead; framework engineer (hypotheses).
- Angle: reference integration, not a sale.

## 9. Zip

- Website: https://zip.com/
- Evidence (opened): https://zip.com/ - AI platform for enterprise procurement from request through payment; "purpose-built AI agents".
- Product: procurement orchestration.
- Use case: agents progressing purchases through payment.
- Why PayFlow (hypothesis): enforcement and proof at the payment step if agents initiate payment.
- Buyer: product/AI lead, security/finance stakeholders; technical user: platform engineer. (hypotheses)
- Angle: the payment step in agent-driven procurement.

## 10. Levelpath

- Website: https://www.levelpath.com
- Evidence (opened): https://www.levelpath.com - "Ranger" autonomous source-to-pay platform incl. payments; "AI Agents that run each step inside your policies."
- Product: source-to-pay platform.
- Use case: agent-run payment step.
- Why PayFlow (hypothesis): "inside your policies" must be enforced and provable at money movement.
- Buyer/technical: product lead, engineering (hypotheses).
- Angle: where policy is enforced at payment, how it is proven.

## 11. Tipalti

- Website: https://www.tipalti.com
- Evidence (opened): https://www.tipalti.com - AP automation (invoice capture, supplier management, global payments, reconciliation); "Global accounts payable, reimagined with agentic AI"; lists AI agents.
- Product: AP automation and payouts.
- Use case: agentic AP steps up to payment.
- Why PayFlow (hypothesis): pre-execution enforcement and unknown-outcome handling.
- Buyer: product/risk leadership; technical user: payments engineering (hypotheses).
- Angle: unknown payout outcomes and replay in agentic AP.

## 12. Stampli

- Website: https://www.stampli.com
- Evidence (opened): https://www.stampli.com - procure-to-pay platform; ERP remains system of record; AI "Billy performs on average 89% of the work."
- Product: AP / P2P.
- Use case: AI-prepared payments needing authorization boundary.
- Why PayFlow (hypothesis): independent authority check for AI-initiated payments.
- Buyer/technical: product/security; engineering (hypotheses).
- Angle: how AI-prepared payments are authorized and evidenced.

## 13. Ramp

- Website: https://ramp.com
- Evidence (opened): https://ramp.com - corporate cards, expense, bill pay, AP, accounting; "Agents for every workflow, working 24/7."
- Product: finance platform with agents.
- Use case: agents acting on spend and bill pay.
- Why PayFlow (hypothesis): independent proof of authorization; likely built in-house, so low conversion odds.
- Buyer/technical: unverified.
- Angle: peer learning; do not expect a pilot.

## 14. Brex

- Website: https://www.brex.com
- Evidence (opened): https://www.brex.com - cards, banking, expense, bill pay; AI features like automated approvals; journal mentions "Building autonomous agents for technical tasks" (title seen on homepage).
- Product: finance platform.
- Use case: automated approvals and agents on spend.
- Why PayFlow (hypothesis): same as Ramp; likely in-house.
- Buyer/technical: unverified.
- Angle: peer learning only.

## 15. Basis

- Website: https://www.getbasis.ai
- Evidence (opened): https://www.getbasis.ai - AI agents for accounting workflows (close, tax, audit testing); "Agents you can actually rely on."
- Product: accounting agents.
- Use case: payments or journal actions are unverified; page covered accounting workflows, not payments.
- Why PayFlow (hypothesis): weak; included as AI-native ops control case (audit evidence).
- Buyer/technical: unverified.
- Angle: only if discovery shows agents trigger payments.

## 16. Lithic

- Website: https://www.lithic.com
- Evidence (opened): https://www.lithic.com - card issuer processing platform; lists an "Agentic Commerce" solution, "Realtime payments with AI."
- Product: card issuing platform.
- Use case: agent-held cards.
- Why PayFlow (hypothesis): authority decisions upstream of card authorizations.
- Buyer: product lead; technical user: integration engineer (hypotheses).
- Angle: where agent spend limits sit relative to card controls.

## 17. Modern Treasury

- Website: https://www.moderntreasury.com
- Evidence (opened): https://www.moderntreasury.com - single API for ACH, wire, RTP and stablecoins with ledgering; "Build Products That Move Money." Page did not mention AI agents.
- Product: payment operations API.
- Use case: customers' agents initiating payment orders (unverified).
- Why PayFlow (hypothesis): authority layer before payment orders; unknown-outcome handling.
- Buyer/technical: unverified.
- Angle: ask if customers raise agent-initiated payments.

## 18. Moov

- Website: https://moov.io
- Evidence (opened): https://moov.io - payment infrastructure: cards, bank, wallets, payouts, virtual cards. No AI agent mention.
- Product: payment infrastructure.
- Use case: unverified.
- Why PayFlow (hypothesis): PSP partner for authority verification; see MERCHANT-PSP-PILOT-KIT.
- Buyer/technical: unverified.
- Angle: PSP verification-hook conversation.

## 19. Increase

- Website: https://increase.com
- Evidence (opened): https://increase.com - banking via code: ACH, wires, cards, FedNow, push-to-card. No AI agent mention.
- Product: bank infrastructure API.
- Use case: unverified.
- Why PayFlow (hypothesis): developer-first rail where an authority layer could sit on top.
- Buyer/technical: unverified.
- Angle: low priority.

## 20. Paid

- Website: https://www.paid.ai
- Evidence (opened): https://www.paid.ai - monetization platform for companies whose agents sell work; meters activity, invoices, payments, tax; "Your agents sell work. Get paid for it."
- Product: agent billing.
- Use case: revenue side, not agent spend; weak fit.
- Why PayFlow (hypothesis): adjacent; shared concern of provable per-event records.
- Buyer/technical: unverified.
- Angle: adjacency conversation only.

---

## Unverified across the list

Funding, customers, headcount, internal architecture, existing payment systems, and every buyer/technical-user role. Nothing here was checked beyond the one homepage per company.
