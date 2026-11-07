# PayFlow × PayPal AI Hackathon — winning-product strategy
**Research cut: 2026-11-07. Status: proposal / implementation requirements, NOT delivered functionality.**

This is a source-grounded product decision document, not an acceptance certificate or a claim about judges' private preferences.

## Executive decision
**Keep the company:** PayFlow, financial authority for autonomous systems.
**Put a user-facing product on top:** **PayFlow Spend Desk** — an AI-assisted purchasing and accounts-payable experience for small teams where a human defines which agent may buy what, from whom, for how much, and when.
**Value proposition:** *Let AI handle approved purchases. Keep the authority, the payment outcome, and the proof.*
**Hackathon demonstration:** an agent proposes a real, bounded purchase; PayFlow's Trust Kernel either refuses or issues a one-time grant; **PayPal Sandbox** performs the authorized payment; PayFlow reconciles the provider result and creates independently verifiable proof. A substituted merchant, excess amount or replay is refused.

Spend Desk is a proposed product mode, **not a separate payment processor**, not a wallet, and not a live-money product. It must reuse the existing canonical Trust Kernel / Gateway / DelegatedCommerceService / PayPal adapter. Never fork financial authority for a judge demo.

## Why this positioning, rather than another infrastructure landing page?
The Qloo hackathon winners presented **observable outcomes**: Undertow presented numerical backtesting, Backline an end-to-end travel journey, and Roomful a visible personalized result. Their judging scores and why they were chosen are not public; the analogy is editorial analysis, not a causal claim. TastePolicy's technical sophistication did not translate into a top-three award. In the GitLab competition, ProdPermit had an entry in the public gallery but Devpost support expressly said it was excluded from judging because the deadline was missed. Neither case proves PayFlow will win if the changes below ship.

### Anchor PayPal rather than compete with it
PayPal provides the payment infrastructure, provider-side security controls, server-side idempotency, capture records and merchant capabilities. PayFlow adds **purpose-bound business authority, agent identity and delegation, counterparty scope, cross-request aggregate limits, fail-closed decisions, exact one-use grants, unresolved-outcome discipline, and independent Proof**. Do **not** suggest PayPal lacks idempotency, fraud tooling or payment credentials protections.

PayPal Agent Ready / Store Sync and new agent-oriented checkout methods have access requirements. They are adjacent ecosystem developments, not already commissioned integrations or hackathon dependencies. Use the existing PayPal Sandbox path documented at \`docs/evidence/live/m7-sandbox-acceptance-2026-11-02.json\`. It records a genuine hosted sandbox capture and several denials; do not depict this as a publicly available self-service product.

## One buyer, one vivid moment, one commercial wedge
**Initial user:** founder, office manager or finance operator of an AI-native agency / small distributed team whose agents might place approved supplier orders.
**Economic buyer hypothesis:** finance/operations leader or an agent-platform product leader. **Not validated** by customer interviews.
**Promise to test:** let agents finish standard authorized purchases without the owner approving every line item, while preventing changed merchants/amounts, duplicate effects, and unverifiable outcomes.

**First real task:** "Buy the approved $84 keyboard for our team." Show a human's $100 purchase ceiling, an approved merchant, a bounded agent, PayPal Sandbox authorization/capture, and Proof. Change the merchant or the amount to $184 and show refusal with zero new provider calls. Then show an idempotent replay attempt. If the app cannot show this end-to-end against PayPal Sandbox, label the missing segment as unverified; do not splice a fake-rail clip into live-payment footage.

**User surfaces, in decreasing priority:**
1. Spend Desk owner view: "What can my agent spend?" Current bounded authority, merchant, amount, currency, expiry, safe pause/revoke.
2. Agent action view: "What does the agent want to buy?" Quote/invoice, AI interpretation (explicitly untrusted), exact merchant/amount vs trusted quote, approval/denial.
3. PayPal execution view: one sandbox order/capture, provider IDs and state; do not equate an API timeout with $0 moved.
4. Proof view: readable decision receipt, audit trail and independent verification.
5. Developer integration: shortest working SDK/API example; developer infrastructure is the technical depth beneath the narrative, not the home page pitch.

**Not the wedge this week:** cross-border remittances, investment trading, new rails, loans, a general-purpose PayPal competitor, all-of-commerce shopping, a full ERP, or Agent Ready production access.

## Competition acceptance is the critical path
Official rules: https://paypalaihackathon.devpost.com/rules
- Deadline: **2026-11-12 20:00 UTC / 21:00 Africa/Lagos**. Aim for **2026-11-11** submission to preserve a buffer.
- Stage 1: baseline viability, genuine PayPal plus AI integration.
- Stage 2: equally weighted technical implementation, design, potential impact, idea and presentation.
- A working demo that judges can run or interact with: either hosted demo **or reproducible build instructions**. Static mockups do not qualify.
- Public repository, approved open-source licence detectable on repository homepage, documented tools and new-vs-existing development.
- Public YouTube demo **under three minutes**, showing the actual functioning app.
- Demo/test access must remain usable through judging.
- A Devpost *project marked published* is not itself proof the hackathon submission was finalized. The current PayFlow project has no demo video URL, and its hackathon record returned no confirmed \`submitted_at\`. Obtain an explicit successful submission receipt.
- The current project legitimately predates the hackathon; the submission must distinguish pre-existing capabilities from work built during the entry period.

## Provenance ledger — prevent proof inflation
| Evidence / capability | Observed state as of research | Can we show/claim? |
|---|---|---|
| Trust Kernel, delegation, one-time grants, verification, SDKs | Source/tests on main; many internal tests | Show with precise test coverage and limitations |
| Real PayPal Sandbox capture via hosted M7 preview, 2026-11-02 | Evidence file with order/capture IDs and one new capture from that test | Yes, historical Sandbox evidence, **not a currently public sandbox** |
| 1,000 adversarial integrated test scenarios, 0 uncontained | Own deterministic fake-rail suite, \`docs/BREAK-AUTHORITY.md\` | Yes, scoped as *internal simulated test*, not PayPal/provider proof or certification |
| AgentBench v1 | Self-validating 17-task harness; **no verified real-model run** | Show harness, not fabricated model performance |
| UNKNOWN reconciliation example | Fake-rail reference \`examples/procurement-ap-agent.ts\` | Show labelled simulation only, not a live PayPal UNKNOWN result |
| Public self-serve judge environment | \`docs/OWNER-ACTIONS.md\` says not commissioned; privileged DB role must be removed | No public-use claim before verified safe access |
| Security certification, customers, paid users, pilot outcomes | None | Never imply they exist |

## Product expansion beyond the initial hackathon
Do not build it all now. The category is a **Payment Authority OS** across agent spend, not a single procurement demo:
- **Now: controlled spend:** procurement/AP first-party actions with PayPal Sandbox.
- **Next: delegated team budgets:** multi-agent pools, merchant/price context, owner approval for over-ceiling actions; verify actual completeness before marketing.
- **Then: merchant Verify:** payment-integrity and delegated-authority receipts verifiable read-only by counterparties. This is an interoperability proposal, not a universal merchant acceptance claim.
- **Later: outcome operations:** UNKNOWN queue, controlled lookup-only reconciliation, possible disputes/audit support where evidence exists.
- **Eventually: platform SDK:** infrastructure for agent builders / AP providers with usage-based fees and enterprise controls after paid pilots and applicable legal review.

PayFlow must complement PayPal and network protections. The long-term moat is the auditable **business decision/authority context**, not a claim that only PayFlow can enforce a card limit.

## Critical path — acceptance gates
**P0 (eligibility, can block entry):**
1. Fix known privileged role \`svc_public_app\` in the public sandbox as documented in \`docs/OWNER-ACTIONS.md\` with the owner's explicit authorization; do not deploy while it remains exposed.
2. Complete safe real PayPal Sandbox re-run: model/intent -> trusted quotes -> gate -> execute -> provider observation -> Proof. Use test merchants, not live-money or consumer PayPal accounts.
3. Video under 180s, PUBLIC on YouTube, actual recorded app. Final Devpost submission and timestamp verified before deadline.
4. Working demo either properly isolated public sandbox with no secrets visible, or proven one-command reproduction with test fixtures and clear optional provider credentials.

**P1 (judges see the differentiation):**
5. Present simple owner/agent/payment/proof story with visible merchant, max amount, real provider state, DENY and no extra effects.
6. Run fair PayPal + AI comparisons described in \`PAYPAL-2026-BASELINE-METHOD.md\`.
7. Independent stranger test: can a non-builder explain the product in under one minute, find the live demo and complete a legitimate action with no assistance? Log real participants and failures rather than guessing.

**P2 (credible commercial thesis):**
8. Ten permission-based customer/problem interviews, prioritizing teams already piloting money-moving agents. Record exact pain, existing controls, access requirements, buying authority, and counterevidence. No fabricated testimonials or savings.
9. Invite 1–2 appropriate design partners to a bounded sandbox-only pilot **after** security/access prerequisites. Do not describe an invite as a contract or customer.

## 5-day plan (Nov 7–11)
- **Nov 7:** position/scope freeze, confirm code truth, resolve security and submission blockers; identify minimum working PayPal path.
- **Nov 8:** integrate/verify model-driven intent, canonical quote, deterministic authority and real PayPal Sandbox capture. Record exact provider and source revision.
- **Nov 9:** complete owner/agent/proof demo and repeatable judge runbook; test fresh account/browser, mobile and inaccessible states.
- **Nov 10:** controlled baseline with real measurements + independent user comprehension; edit 2:45 proof-centered footage.
- **Nov 11:** truth audit, public video, repo/docs/licence, all required submission fields, FINAL receipt and secondary confirmation. Nov 12 only for urgent contingency, before 21:00 WAT.

**Stop conditions:** any real-money API key, unreviewed production authorization expansion, unremediated compromised DB credential, unsafely exposed admin tool, fake PayPal receipt, fabricated test results or misleading "independent" validation. The owner controls destructive account actions, new secrets and public deployments.

## Source references (external; checked 2026-11-07)
- [PayPal hackathon rules](https://paypalaihackathon.devpost.com/rules)
- [PayPal AI hackathon developer blog](https://developer.paypal.com/community/blog/PayPal_AI_Hackathon/)
- [PayPal Agent Ready](https://developer.paypal.com/agent-ready/overview/)
- [PayPal Store Sync access requirements](https://developer.paypal.com/store-sync/overview)
- [PayPal MCP](https://developer.paypal.com/ai-tools/mcp-server)
- [PayPal REST idempotency guidance](https://developer.paypal.com/api/make-api-requests)
- [PayPal 2026 merchant research](https://www.paypal.com/us/enterprise/agentic-commerce-report): enterprise-merchant survey data, **not PayFlow evidence**.
- [2026 AFP fraud survey](https://www.financialprofessionals.org/about/learn-more/press-releases/Details/over-75-percent-of-us-firms-experienced-payments-fraud-in-2025-while-ai-adoption-for-fraud-mitigation-lags): general B2B market context, **not agent-caused fraud or PayFlow impact**.
