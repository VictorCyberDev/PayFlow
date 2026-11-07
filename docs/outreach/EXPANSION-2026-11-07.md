# M25 — Pipeline expansion (2026-11-07)

Status: **research only. Nothing has been sent, nothing has been replied to, and no evaluation, pilot or integration exists.**
Unsent drafts are not market validation and are not counted as such anywhere.

Evidence for each entry is a public page read on 2026-11-07 (linked). Contact **routes** are public forms or program pages
that were seen on the company's own pages; **no email address was collected or guessed**, and no individual was researched.
"Decision maker" and "technical evaluator" below are **roles that typically own the question, an assumption**, not names.

## What the new evidence says

- Mandates are now the common design: ACI describes an agentic mandate as "approved merchants, spending limits, and the
  conditions under which the agent is authorized to transact"
  ([aciworldwide.com/agentic-payments](https://www.aciworldwide.com/agentic-payments)); Mastercard's Agent Pay says agents
  must be registered and verified before they transact
  ([Mastercard](https://www.mastercard.com/global/en/news-and-trends/stories/2025/agentic-commerce-framework.html)).
- Networks are building their own control and identity layers, so the realistic role for PayFlow is **independent
  verification and a first-class UNKNOWN outcome**, not a replacement for them.
- Access to the large networks is **gated** (Visa: "Become a partner" programme and "contact their Visa representative";
  Mastercard: integrators "must be registered"). A sandbox-stage product with no customers should expect no response.

## New qualified entries (ranked by realistic probability, honest)

### 1. Nevermined — agent payments platform (highest realism, also a competitor)

- **Product / economic exposure:** an "AI-native payments platform" combining "delegated spending, real-time metering, and
  autonomous settlement" ([nevermined.ai](https://nevermined.ai/blog/best-platforms-allowing-agentic-payments)); demos
  show agent-to-agent payment over A2A, AP2 and x402
  ([blog](https://nevermined.ai/blog)). Agents spend and get paid on its rails.
- **Decision maker (role, assumed):** founder/CEO or head of product at a small company. **Technical evaluator (role,
  assumed):** the engineer who owns its A2A/AP2 integration.
- **Why PayFlow:** its delegated spending has to be provable to the merchant side. PayFlow's offline-verifiable Authority
  credential and a Proof that says UNKNOWN when unknown are an independent check, not a rival wallet.
- **Honest risk:** direct overlap (it publishes comparisons that rank itself first); may treat PayFlow as a feature.
- **Verified contact route:** **none verified.** Only blog pages were read. No route to use until one is found on its own
  site; do not guess an address.
- **Bounded sandbox evaluation (offer):** 30 minutes, their engineer runs the offline verifier from the repository against one
  sample Proof and one sample credential; no account, no data from them. (The package is not published to a registry.)

### 2. ACI Worldwide — enterprise payments processor describing agentic mandates

- **Product / exposure:** payment processing for banks and merchants; its page treats the mandate as what makes agentic
  payments different and says out-of-mandate transactions "fail at the fraud and authentication layers before they can
  reach settlement" ([source](https://www.aciworldwide.com/agentic-payments)).
- **Decision maker (assumed):** product owner for agentic payments / fraud. **Evaluator (assumed):** a solutions architect.
- **Why PayFlow:** a worked, open example of pre-execution evaluation plus portable evidence of the mandate that applied.
- **Risk:** large enterprise cycles; no production rail from PayFlow; buyer is a bank, not a startup.
- **Verified route:** **none verified** (only the explainer page was read).

### 3. Visa — Intelligent Commerce partner programme (low probability)

- **Product / exposure:** APIs and "a commercial partner program" for AI platforms, agents and developers
  ([press release](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.21361.html)); an MCP server and
  Acceptance Agent Toolkit, with access via a Visa representative or the developer centre
  ([Visa](https://corporate.visa.com/en/sites/visa-perspectives/innovation/visa-mcp-server-agent-acceptance-toolkit.html)).
- **Verified route:** the "Become a partner" link on [visa.com/en-us/solutions/intelligent-commerce](https://www.visa.com/en-us/solutions/intelligent-commerce)
  (`globalclient.visa.com/AI-Commerce`) and [developer.visa.com/capabilities/visa-intelligent-commerce](https://developer.visa.com/capabilities/visa-intelligent-commerce).
- **Why PayFlow / risk:** a tool in their developer ecosystem that independently verifies agent authority; but programmes at
  this scale target commercial partners with production volume. **Expect nothing.** Listed for completeness, not effort.

### 4. Mastercard — Agent Pay (low probability)

- **Product / exposure:** agents get "verified credentials, tokenized payment information, spending controls and proof of
  user consent" ([Mastercard](https://www.mastercard.com/us/en/news-and-trends/stories/2026/agentic-commerce-identity-know-your-agent.html)).
- **Verified route:** developer documentation states integrators must be registered
  ([Mastercard Checkout Solutions docs](https://developer.mastercard.com/mastercard-checkout-solutions/documentation/use-cases/agent-pay/)).
  That is an account and a programme, not a conversation.
- **Risk:** same as Visa. **Expect nothing.**

## Combined pipeline (all sources)

| Stage                                           | Count | Note                                                                                                    |
| ----------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| Researched with a public evidence page          | 28    | 20 in `docs/gtm`, 4 in `PROSPECTS.md`, 4 here (Crossmint appears in two lists)                          |
| With a **verified** public contact route        | 7     | Crossmint, Tipalti, Marqeta, Medius, Visa, Mastercard (registration), plus none new from Nevermined/ACI |
| Approved drafts                                 | 0     | the owner has approved nothing                                                                          |
| **Sent**                                        | **0** |                                                                                                         |
| **Replies**                                     | **0** |                                                                                                         |
| **Bounded evaluations run by a prospect**       | **0** |                                                                                                         |
| **Pilots**                                      | **0** |                                                                                                         |
| **Integrations**                                | **0** |                                                                                                         |
| Revenue, customers, certification, legal review | none  |                                                                                                         |

Each of the last four lines is tracked separately and moves only on a real event with evidence.

## Individualized drafts (UNSENT; for the owner to approve, edit or reject)

Rules for sending, all required: the public product (`payflow-public`) is live; the owner approves the **exact** text for that
one recipient; the sender identity is one the owner authorizes; the channel is the company's own public form or route. No
bulk send, no follow-up cadence, no invented personalization.

**Nevermined** (send only after a route is verified)

> Hi — I'm working on PayFlow, a sandbox-stage open project for the step _before_ an agent spends and the evidence after:
> a deterministic Authority decision, an offline-verifiable credential of what an agent may do, and a signed Proof that
> reports UNKNOWN as UNKNOWN. Your delegated-spending model looked like the place where a merchant would want to check
> that independently. We have no customers and no production rail. If useful, there's a 30-minute check you can run
> yourselves with our open verifier on a sample Proof and credential, no account needed. [link when live]

**ACI Worldwide** (send only after a route is verified)

> Hello — your agentic-payments page describes the mandate as the thing that sets these payments apart. PayFlow is an open,
> sandbox-stage reference for evaluating a mandate before execution and carrying portable, signed evidence of it afterward
> (including an explicit UNKNOWN outcome). It is not production and has no customers. If a short technical read would help
> your team compare approaches, here's the verifier and a sample: [link when live].

**Visa / Mastercard:** no draft. Their routes are programme applications; writing one would be performative. If the owner
wants to apply, that is a business decision about whether to apply as a developer without production volume.

## What would count as evidence later

A prospect running the open verifier themselves; a written technical question; a named evaluator agreeing to a bounded
sandbox test. A form submission, an auto-reply or a "thanks" is **not** an evaluation.
