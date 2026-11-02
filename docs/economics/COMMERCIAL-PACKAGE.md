# Commercial package

**Status: HYPOTHESIS - NOT VALIDATED.** Developer preview. PayPal Sandbox only. No customers, no revenue, no pricing validation, no legal review. No logos, no testimonials, no case studies exist, and none are implied. These briefs are drafts for internal use and discussion with qualified advisers; they are not offers.

## 1. One-page product brief

**What it is.** Economic Authority infrastructure for autonomous systems. A Trust Kernel decides what an AI agent may economically do. An Execution Boundary enforces that decision, so the agent cannot act outside it. A rail executes (today: PayPal Sandbox only). Portable, signed Proof records what happened and can be checked by someone who does not trust PayFlow.

**The problem it addresses.** When software can spend money, "who allowed this, within what limits, and can we prove it?" is not answered by a prompt or a wallet balance alone.

**What exists today.** Authority evaluation, an enforcing gateway, a Sandbox rail, signed Proof and a verifier, in a developer preview.

**What does not exist.** Production money movement, customers, SLAs, third-party security audit, legal review, validated pricing, live metering (see METERING-AUDIT.md).

**Who it might be for (hypothesis).** Teams building agents that initiate payments or purchases.

## 2. Procurement solution brief

| Question                          | Truthful answer today                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Is it in production?              | No. Developer preview, Sandbox only.                                                     |
| Does it move real money?          | No.                                                                                      |
| Customer references               | None.                                                                                    |
| Pricing                           | Not published. Hypothetical structure only (PRICING-ARCHITECTURE.md).                    |
| Contract / SLA / DPA              | None exist yet.                                                                          |
| Certifications (SOC 2, ISO 27001) | None. Do not assume any.                                                                 |
| Regulatory status                 | Open question for qualified counsel.                                                     |
| Data location / retention         | Not decided for production; retention assumed in the cost model only as an estimate.     |
| Exit / portability                | Proof is portable and independently verifiable; wider data export terms are not defined. |
| Support                           | Not defined.                                                                             |

A pilot would be the right first commercial step (section 5), with scope and terms agreed in writing and reviewed by counsel.

## 3. Developer brief

- Start in SANDBOX: no real funds, no payment details.
- Request an action against an Authority; receive ALLOW, DENY or ESCALATE with a machine-readable reason.
- If allowed, the gateway executes on the Sandbox rail and returns a Proof reference.
- Verify a Proof with the open verifier; no account needed.
- The Authority path calls no AI model: decisions are deterministic code.
- Limits and fair-use for the preview are not yet published. Expect breaking changes.

## 4. Security brief

What can be said from the repository, without third-party attestation:

- Enforcement is by a boundary the agent cannot bypass by phrasing: the decision does not depend on model output.
- Requests carry a nonce; replays are blocked atomically and produce no effect.
- Access credentials are bound to one agent and principal; mismatches are refused.
- Proof is signed; verification does not need to trust the issuer's server.
- Evidence artifacts and tests exist in the repository.

What cannot be claimed: independent penetration test, formal audit, certification, production hardening, incident response history, key-management review for production. These are not done. Security claims should be treated as the author's description of design intent plus tests, until reviewed.

## 5. Pilot brief

- Purpose: learn whether the control is useful and what buyers would pay, not to generate revenue.
- Scope: Sandbox workflow chosen by the partner; 4-8 weeks; no real funds.
- Provided: integration support, weekly review of decisions and Proofs.
- Asked in return: honest feedback, a named sponsor, and permission (or not) to record outcomes. No endorsement is requested or assumed.
- Success measures set jointly in advance; the existing pilot model separates internal readiness from external partner confirmation and does not fabricate partner evidence.
- Fee: none proposed. Anything commercial is decided after WTP interviews.
- Paperwork: agreement terms to be reviewed by counsel before any pilot starts.

## 6. ROI worksheet (blanks, not claimed savings)

Fill in with the prospect's own numbers. PayFlow makes no claim about the results.

| Line                                                                 | Value (prospect fills in) |
| -------------------------------------------------------------------- | ------------------------- |
| Agents or automations that can spend                                 | ______                    |
| Spend actions per month                                              | ______                    |
| Share currently reviewed by a person                                 | ______ %                  |
| Minutes per manual review                                            | ______                    |
| Loaded hourly cost of reviewer                                       | ______                    |
| **Manual review cost today (actions x share x minutes / 60 x rate)** | ______                    |
| Incidents (over-spend, wrong merchant, duplicate) per year           | ______                    |
| Average cost per incident (money + time)                             | ______                    |
| **Incident cost today**                                              | ______                    |
| Time to assemble audit evidence per audit                            | ______                    |
| Audits per year                                                      | ______                    |
| **Audit effort today**                                               | ______                    |
| Cost of alternative in use (build, maintain, vendor)                 | ______                    |
| PayFlow cost (price unknown; to be set by evidence)                  | ______                    |
| Assumed reduction in each line (prospect's estimate; mark source)    | ______                    |
| **Net benefit = reductions - PayFlow cost**                          | ______                    |

Rules: every blank is the prospect's number; mark each as measured or guessed; do not present the result as a PayFlow-validated saving.

## 7. Objection map (truthful answers)

**"Visa, Mastercard and PayPal already do this."**
Card networks and PayPal offer controls on their own rails, such as spending limits, tokenization, and agent-oriented programs under development. We should not claim they lack these. The truthful distinction is scope: PayFlow aims to be a neutral layer that expresses and enforces one authority policy across rails and records portable proof independent of any one network. Whether that is valuable enough to buy alongside native controls is unvalidated. Today only PayPal Sandbox is supported, so for the moment PayPal's own controls are a complete alternative for PayPal-only needs.

**"We can put a limit in the prompt."**
A prompt limit is an instruction to a model, which can be misread, overridden by injected content or ignored. It is not enforcement and leaves no independent evidence. Enforcement outside the model (the Execution Boundary) does not depend on model behavior. That does not make a prompt limit useless as an extra layer.

**"Our wallet already has limits."**
Wallet limits are a valid control and may be enough if you need only a per-wallet cap. They typically do not express per-agent, per-purpose, per-merchant authority or escalation, or produce portable proof of who authorized what. Whether you need those is the question to test with you.

**"Why not build it ourselves?"**
You can, and some teams will. The cost is the engineering and ongoing maintenance of policy, replay protection, enforcement, proof format and verification, plus audits. PayFlow's cost to serve is small (COST-MODEL.md) but that is not the customer's build cost, and we have no customer evidence on that trade-off. A reasonable outcome is "build for now."

**"Is this regulated? Do you need a licence?"**
This is an open question for qualified counsel. We have not obtained legal advice, and we do not say that no licence is required. The answer may depend on jurisdiction, on whether funds are held or transmitted, on the rails used, and on how PayFlow is priced and contracted (see the flag in VALUE-METRICS.md on volume-based pricing). Today only Sandbox is used and no real money moves. No production use should start until this is answered.
