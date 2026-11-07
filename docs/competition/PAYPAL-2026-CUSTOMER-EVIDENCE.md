# PayFlow Spend Desk — evidence-first buyer discovery and first revenue path
**Research cut: 2026-11-07. No interviews, partners, customers, revenue or willingness to pay have been established in this plan.**

## Market proof is NOT product-market fit
- PayPal's 2026 Agentic Commerce Pulse Report reports large-enterprise interest and support needs. That supports a growing category, not PayFlow buying intent. Large-enterprise sample: 189 US merchants, as stated in the report.
- AFP's April 2026 payments-fraud survey reports 76% of surveyed organizations faced attempted or actual payment fraud in 2025. The fraud included many **non-AI** methods; none of this is a measured PayFlow problem or a claim of money saved.
- PayPal Agent Ready, Stripe SPT, Visa Intelligent Commerce, Mastercard Agent Pay, Skyfire and Catena overlap with adjacent controls. Do not sell on "no one else controls agent spend". Explore business-purpose constraints, multi-agent lifecycle, unknown-provider effect handling and portable Proof as a **testable** differentiation.

## One practical beachhead — investigate both sides
**Demand-side operational buyer (fastest validation):** founder/COO/finance operator at an AI-native studio, automation agency or small buying team that has actually authorized software to purchase supplies/services or pay approved suppliers. If their agents only draft invoices and humans always execute payment, they are NOT the first paying ICP.

**Product-side integration buyer (longer-term distribution):** engineering or product manager at an agent-action platform, small procurement/AP vendor, or merchant automation developer seeking a financial authority API. This person may distribute PayFlow to many business customers, but one integration may require a substantial security review.

**Do not target banks as first pilots** without a qualified partner, legal review, and credible security controls. The capital, compliance and integration costs are too high for a five-day hackathon.

## Interview proof ladder
| Evidence class | What counts | What it does NOT prove |
|---|---|---|
| Public research | source-linked announcement of agentic purchasing work | company has this pain, is a lead or will buy |
| Discovery interview | dated, consensual response from a relevant person describing a real current workflow | purchase intent |
| Problem-qualified | specific recent/anticipated payment action, named control owner, current workaround and serious pain | PayFlow is an acceptable solution |
| Pilot-qualified | scope, internal sponsor, sandbox access process, security/legal review owner and success measures agreed | contract, production user or payment |
| Pilot underway | both sides explicitly agree and the isolated sandbox is provisioned | commercial revenue |
| Paying | legitimate contract and payment evidence | stable retention or product-market fit |

Never auto-advance CRM stages after an unsent email or website visit. Ask for consent for publication of any quote or company name.

## The first ten interviews: not a vanity outreach blast
Aim for 10 *completed conversations*, not 10 message drafts:
- 4 founders/ops or finance leads at small teams **already using agents that can initiate expenses**;
- 3 procurement/AP automation product or engineering leads;
- 2 agent-platform integration engineers;
- 1 merchant/payments risk or verification lead.

The existing \`docs/gtm/PROSPECTS.md\` is a research list, not a pipeline. Some names (Skyfire, Payman AI, Catena, Crossmint) directly compete or overlap: use them as peers/possible partners, NOT claimed customers. Zip, Levelpath, Tipalti and Stampli are possible enterprise discovery targets, but likely have their own controls and long procurement cycles. Build a separate smaller-company target list before outbound.

### Five non-leading questions
1. "Tell me the last time software—not a person—initiated a purchase, payout or invoice payment in your team."
2. "Where did the spending permission come from and where was it enforced? Can the same agent change those limits?"
3. "What happened on the last duplicate, changed-supplier, timeout or uncertain payment?"
4. "How do you answer who authorized a payment and what the provider actually did?"
5. "If you wanted to trial a stricter boundary in a sandbox, who would need to review it and what must be measured?"

Only then ask for an optional five-minute guided demo and structured feedback. Do not open by pitching an "AI financial authority operating system". Ask whether the customer has the actual problem.

## Interview and demo outcomes to capture
- Role and buyer influence (validated or unknown).
- Whether agents may initiate payment TODAY; which provider; payment rail; amount tier (do not collect secrets).
- Current controls: human approval, provider limits, token scope, application policy, logs.
- Last concrete friction or incident and approximate *self-reported* time wasted (not independently quantified).
- Walkthrough comprehension: in under 30 seconds, can they name the owner, agent, payment processor and verifier?
- Time to complete a safe sandbox task, errors and abandonment.
- Interest in a 2-week/4-week **sandbox-only** pilot, with named integration owner and explicit boundaries.
- Willingness-to-pay evidence: a *budget owner, figure or process*, not a compliment.
- Strongest counterexample: "Why would you use your existing provider controls instead?"

## Pilot offer — specific and honest
**PayFlow Spend Desk Sandbox Pilot** (hypothesis). Two-to-four-week program for one authorized procurement flow.
- Input: one pre-approved supplier, one order type and a safe spend limit.
- Controls: agent identity, business owner, merchant scope, budget, action expiry and revocation.
- Rail: **PayPal Sandbox only**; neither pilot party moves real money.
- Outcomes to measure: valid-task success; unauthorized-action containment; redundant attempts; proof verification; staff approval burden; time to integrate and residual failure modes.
- Delivered: signed/anonymized proof examples, experiment sheet, tested integration and written unresolved risks.
- No payment-service licensing, certification, SLA, real-money execution or regulatory conclusion is represented.
- Prior to onboarding a partner, complete necessary secret management, security remediation, legal review, data handling terms and environment isolation.

**Pricing hypothesis:** free sandbox developer starter; later charge by governed action and platform controls, with an enterprise contract for integrated permissions. Do NOT put a fabricated ARR, conversion rate, gross margin or validated price on Devpost.

## Distribution hypothesis
1. Find a public, reproducible "PayPal Sandbox + AI + PayFlow" starter that takes an integrator from policy to Proof without requesting their production credentials.
2. Use short educational material: "AI payment versus actual permission", "What happens after a capture timeout?" and "How do you prove a supplier didn't change?" Each should link executable evidence.
3. Target technical communities already building agent payment integrations; avoid broad outreach to people with no money-moving agents.
4. Conversion stages: reproducible sample -> developer tries with test data -> discovery/technical evaluation -> written sandbox pilot -> production requirements assessment -> paid contract only if accepted.
5. Track real referral and conversion events; report both successes and losses.

## Practical 2026-11-07 to 2026-11-11 fieldwork
- Day 1: qualify 15 potential interviews from source-backed public workflows, with no invented personal contacts.
- Day 2: invite a carefully selected first 5, respecting existing opted-out channels and request permission to share results.
- Day 3: run willing interviews and observe the first-time demo; record the entire funnel (approached, replied, booked, completed).
- Day 4: update positioning based on actual wording; run another external usability test; publish only consenting quotes.
- Day 5: Devpost may state "customer discovery interviews completed" only if they actually happened; otherwise state "validation plan and initial hypotheses," not fabricated demand.

## Market sources
- [PayPal 2026 agentic-merchant research](https://www.paypal.com/us/enterprise/agentic-commerce-report)
- [PayPal survey methods](https://www.paypal.com/us/brc/article/agentic-commerce-pulse-report-findings)
- [AFP 2026 US payments-fraud survey](https://www.financialprofessionals.org/about/learn-more/press-releases/Details/over-75-percent-of-us-firms-experienced-payments-fraud-in-2025-while-ai-adoption-for-fraud-mitigation-lags)
- [PayPal Agent Ready](https://developer.paypal.com/agent-ready/overview/)
- [Stripe SPTs](https://stripe.com/blog/supporting-additional-payment-methods-for-agentic-commerce)
- [Mastercard Agent Pay for Machines](https://investor.mastercard.com/investor-news/investor-news-details/2026/Mastercard-Launches-Agent-Pay-for-Machines-to-Unlock-Super-Fast-Always-On-Payments/default.aspx)

Related project material: \`docs/gtm/ICP.md\`, \`docs/gtm/DISCOVERY-GUIDE.md\`, \`docs/gtm/PILOT-PACK.md\`, and \`docs/gtm/PROSPECTS.md\`.
