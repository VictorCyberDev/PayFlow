# PayFlow Spend Desk — judge demonstration and Devpost release gate
**Created 2026-11-07. PRODUCTION STATUS: NOT VERIFIED LIVE. SCRIPT ≠ RECORDED DEMO.**
This package is a shot plan with proof gates. It must not be narrated as if unfinished capabilities exist.

## One-sentence pitch
**"Your AI agent can buy what your team approved. PayFlow stops anything else before PayPal moves the money — and proves exactly what happened."**

The category remains **financial authority for autonomous systems**. Spend Desk is the first practical experience, not a new payment rail. PayPal provides payments and provider truth. PayFlow provides purpose-bound authority, controls, one-time grants and provenance.

## Real-user journey acceptance
A new judge, on a clean browser/account, must be able to:
1. Understand the owner and agent roles, including what is merely a proposed action.
2. See a human-owned bounded spending policy (approved merchant, max transaction, cumulative budget, expiry).
3. Enter/select one genuine allowed test procurement request; if a Groq model is used, show the actual model interpretation and exact normalized fields.
4. Submit the proposal, observe PayFlow's canonical Trust Kernel approve, grant one-time execution capability and execute the bounded PayPal Sandbox flow.
5. See the returned PayPal Sandbox order/capture references and read-only Proof, with independently checked status.
6. Change merchant/amount in an otherwise similar purchase and see DENY **before** a new PayPal money-moving API call.
7. Attempt replay and verify no second effect from the same logical order.
8. Explain the result in ordinary language and see the limitations (sandbox, preview, no live customers).

**No silent fallback:** if PayPal Sandbox or the real model is unavailable, show an honest "provider unavailable" state and link to a labelled deterministic local reproduction. Do not secretly reroute to fake data and claim a PayPal purchase.

## Under-3-minute actual footage script — 2:42 target
| Time | Visual evidence | Voice / on-screen message | Required provenance |
|---|---|---|---|
| 0:00–0:16 | Clear side-by-side owner rule and AI purchase request | "An AI can decide to buy. But who decided it was allowed?" | Functional application footage |
| 0:16–0:35 | Set agent, approved supplier, $100 ceiling, expiry; show PayPal Sandbox label | "The owner grants one specific authority, not an unlimited payment credential." | Current saved policy / no staged screenshot |
| 0:35–0:53 | Natural language request → real Groq structured candidate, exact amount/merchant | "The model understands the task; PayFlow never treats its words as approval." | Actual model ID and invocation or clearly marked pre-recorded real trace |
| 0:53–1:19 | Trust Kernel ALLOW → one-use grant → PayPal Sandbox order/capture → provider-confirmed outcome | "PayPal handles the sandbox payment. PayFlow constrains the agent and preserves the evidence." | Captured provider IDs and terminal state |
| 1:19–1:43 | Substitute supplier / change amount → DENY; provider call counter unchanged | "Change the deal, and the authorization no longer fits." | Real denied run; zero *additional* PayPal calls verified |
| 1:43–2:01 | Replay original request → refuse or return idempotent existing outcome | "An agent must not turn one approval into two charges." | Both PayFlow and PayPal native idempotency described fairly |
| 2:01–2:23 | Verification screen: signed Proof, actual provider status, audit chain | "Every permitted payment has an outcome a team can inspect and independently verify." | Signed Proof verifier, real PayPal references |
| 2:23–2:42 | Product/payments/team screen + reproducibility link | "PayFlow: let AI work, keep authority human, prove the payment." | Credible current scope and links |

If 2:42 cannot fit without skipping real transitions, remove decoration rather than compressing evidence. Video must be <180s and uploaded PUBLIC to YouTube. No third-party music/trademark use without rights. An edited presentation is not a substitute for functional footage.

## Devpost headline and teaser (candidate copy; verify each feature before final submission)
**Title:** PayFlow — AI Spending With Human Authority and PayPal Proof

**Tagline:** Let AI execute approved purchases through PayPal Sandbox; refuse changed terms and replay, then verify what really happened.

**Opening paragraph:** PayFlow bridges the trust gap between AI payment intent and payment execution. A human sets precise spending permissions. An AI agent turns a purchase request into a candidate action. PayFlow revalidates that action against the actual authority before a one-time grant can reach PayPal Sandbox, and preserves independently verifiable evidence of the decision and provider outcome. This is sandbox-only, developer-preview software; no real money or production customers are claimed.

**How PayPal matters:** The demo must point to actual PayPal Sandbox order/capture and reconciliation evidence, not only to a PayPal logo, a mock checkout or a sandbox login screen. PayPal's own idempotency remains active; PayFlow adds context-specific business authority.

**What AI does:** Groq or another actually commissioned model interprets unstructured purchasing input into a **proposal**. Only the deterministic kernel can authorize the action. If the demo uses a deterministic fixed input, be explicit that no live model inference happened in that segment.

**Why different:** Prompt-level "don't overspend" is not financial authorization. PayFlow enforces the policy at the payment boundary, links one-use grants to exact terms and records an independently verifiable outcome. Do not claim PayFlow is the only system to do this or that existing payment providers have no controls.

**Who needs it:** Hypothesis: teams deploying AI procurement, purchasing and AP automation. This is a problem hypothesis, pending customer interviews.

## Eligibility and submission lock
- Official competition: https://paypalaihackathon.devpost.com/rules
- Deadline: 2026-11-12 20:00 UTC = 21:00 WAT. Internal lock: November 11.
- [ ] Verify existing vs newly built contributions against Oct 1 start date; annotate commit history.
- [ ] Confirm GitHub repository is public, MIT license visible in GitHub's About panel, and one-command setup works in a clean environment.
- [ ] Confirm demo URL or valid reproducible build, with clear instructions for sandbox credentials/test users if needed. Keep judges' access open through the judging period.
- [ ] Real AI capability verified on test input; model name and specific role disclosed.
- [ ] PayPal Sandbox terminal payment executed and independently checked at matching revision.
- [ ] Video <3m uploaded public on YouTube; the \`video_url\` field exists and opens incognito.
- [ ] Complete all Devpost required questions including country, existing-project disclosures, tools, code, working demo link and eligibility checkboxes with truthful answers.
- [ ] Submit before deadline, retrieve explicit \`Submitted\` status and timestamp; public Devpost *published* state alone does not count.
- [ ] Open Devpost entry and video as an outsider, check all links, check no secrets, audit artifact hashes.
- [ ] Freeze the judged revision after submission and avoid post-deadline updates to linked demo/repo without organizer approval.

## Public demo security requirements
- Public test tenancy and accepted PayPal evidence tenancy must be isolated.
- The public \`payflow-public\` Vercel project in \`docs/OWNER-ACTIONS.md\` is not commissioned as of 2026-11-06.
- The documented \`svc_public_app\` privileged exposed credential is unresolved in the latest recorded state; **no opening the public sandbox until the role is removed and least-privilege verification is complete**.
- Never show or transmit secret environment variable values, PayPal credentials, private keys, customer data or privileged admin paths.
- Owner authorization is required for role deletion, environment secret provisioning and public deployment. Do not use the M6 accepted evidence database for public signups.
- It is acceptable under the official rules to use a functional reproducible build instead of a hosted public URL; do not compromise security to impress judges.

## Judge scoring rehearsal
Each of five criteria deserves a pass/fail proof card, not a confident self-score:
1. **Technical:** did both PayPal Sandbox and real AI actually run? Are outputs and code non-trivial?
2. **Design:** can an outsider complete a genuine task and understand every state?
3. **Impact:** is there a clear real user, pain and evidence of testing, rather than market-size slides?
4. **Innovation:** is PayFlow's incremental business authorization demonstrated fairly relative to PayPal native controls?
5. **Presentation:** can a judge understand owner/agent/PayPal/Proof in 30 seconds and follow the complete purchase in under three minutes?

All sections must say **UNVERIFIED** until real tests pass. No red/green theatre.

## References
- Official [rules](https://paypalaihackathon.devpost.com/rules)
- Existing historical [PayPal Sandbox evidence](../evidence/live/m7-sandbox-acceptance-2026-11-02.json)
- Existing [Adversarial results and limits](../BREAK-AUTHORITY.md)
- Existing [Real-model evaluation status](../AGENTBENCH.md)
- [Competition positioning and scope](PAYPAL-2026-WINNING-PRODUCT.md)
- [Fair baseline protocol](PAYPAL-2026-BASELINE-METHOD.md)
