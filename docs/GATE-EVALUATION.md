# Gate A and Gate B evaluation

Last updated 2026-11-02. Status words: `COMPLETE_REAL`, `COMPLETE_LOCAL`, `BLOCKED_EXTERNAL`, `PARTIAL`.
Nothing below is a claim of customers, revenue, certification, audit, legal review or uptime.

## Gate A — can a stranger use PayFlow?

**Result: OPEN.** Every internally controllable piece exists. A stranger still cannot do it, because no
public host is live and nobody outside the project has tried.

| #   | A stranger can…            | Status                                    | Evidence / exact gap                                                                                                                                                                                                  |
| --- | -------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | discover PayFlow           | **Open**                                  | Site is built (home, product, solutions, developers, docs, sandbox, verify, security, research, pricing, company, changelog, status, support, contact, terms, privacy, AUP, subprocessors). **No public deployment.** |
| 2   | understand it              | Built, untested with strangers            | Homepage and procurement page exist; no comprehension test with a real person has been run                                                                                                                            |
| 3   | understand Authority       | Built                                     | Concepts, quickstart, Gate illustration                                                                                                                                                                               |
| 4   | reach sandbox and docs     | Built                                     | `/sandbox/`, `/docs/*`; not public                                                                                                                                                                                    |
| 5   | get a credential           | **Built, not reachable**                  | `POST /v1/sandbox/start` (simulated rail, no account, rate limited). Needs a public host that enables `PAYFLOW_PUBLIC_SANDBOX`                                                                                        |
| 6   | call the Gateway           | Commissioned on a protected preview       | 2026-11-02, PayPal Sandbox, `docs/evidence/live/m7-sandbox-acceptance-2026-11-02.json`. Preview sits behind Vercel Authentication                                                                                     |
| 7   | see ALLOW and DENY         | Commissioned (preview) + tested           | same                                                                                                                                                                                                                  |
| 8   | understand "$0 moved"      | Built                                     | outcome language on site, docs and SDK results                                                                                                                                                                        |
| 9   | inspect Proof              | Commissioned (preview) + browser UI built | `GET /v1/proofs/{id}`; `/verify/` in-browser                                                                                                                                                                          |
| 10  | verify Proof independently | Built + tested; live check pending deploy | offline CLI in a separate process, SDK, browser verifier, parity-tested                                                                                                                                               |
| 11  | inspect M9 trust evidence  | Built                                     | `/research/break-authority/`; 1,000 scenarios, 16 families, 38 distinct outcomes, uncovered families listed                                                                                                           |
| 12  | find docs                  | Built                                     |                                                                                                                                                                                                                       |
| 13  | find support               | Built                                     | `/support/`; owned by the founders, no on-call, no response commitment                                                                                                                                                |
| 14  | find security              | Built                                     | `/security/`, `SECURITY.md`, `security.txt` (placeholder contact, to be replaced)                                                                                                                                     |
| 15  | understand pricing         | Built                                     | hypothesis only; no prices; evidence log empty                                                                                                                                                                        |
| 16  | understand limitations     | Built                                     | every page states its status; changelog separates built / tested / deployed / commissioned / externally validated                                                                                                     |

### What must happen to close Gate A (all external or requires a decision)

1. **A public host.** The existing preview is protected. Either lift protection on a dedicated project or
   create one, on a **separate database** (the M6 acceptance database holds accepted evidence and should
   not receive public sandbox tenants). This is an infrastructure decision, not code.
2. **Enable `PAYFLOW_PUBLIC_SANDBOX=true` on that host.** Off by default.
3. **A timed run by someone who did not build PayFlow**, to measure first-safe-action time. The
   under-five-minutes target remains unmeasured.
4. **Counsel review** of Terms, Privacy and AUP before public launch.
5. **Replace the placeholder security contact** with a real monitored address.

Public-launch controls that now exist in source: per-address and global sandbox start limits that fail
closed, per-credential request limits, isolated `sbx_` tenants, one-hour credentials, an operator pause,
an append-only audit trail. Not built: automatic expiry cleanup of sandbox tenants, alerting.

## Gate B — do we understand how this becomes a business?

**Result: PARTIAL (internal work complete; no market evidence).** The answers below are hypotheses with
sources. None is a customer fact.

| #   | Question                    | Current answer                                                                                                                                               | Evidence quality                                                                                                                |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | First buyer                 | Head of finance operations / AP, or a security or risk lead, at a company running AI agents that can spend (`docs/gtm/ICP.md`)                               | Hypothesis                                                                                                                      |
| 2   | User                        | The engineer integrating agents or procurement automation                                                                                                    | Hypothesis                                                                                                                      |
| 3   | Economic pain               | An agent that can create financial exposure is controlled by prompts or provider-local limits; a duplicate, over-limit or unprovable payment has direct cost | Reasoned, no customer statement                                                                                                 |
| 4   | What they do today          | Prompt rules, wallet or card limits, manual approval, provider controls                                                                                      | Reasoned from public product pages (`docs/gtm/PROSPECTS.md`), unverified for any specific company                               |
| 5   | Why PayFlow is better       | One deterministic Authority across agents and rails, stateful replay and concurrency safety, UNKNOWN handling, signed Proof anyone can verify                | Demonstrated technically (live Sandbox acceptance, 1,000-scenario evidence with stated limits), not tested against alternatives |
| 6   | Why now                     | Agentic commerce providers are shipping agent payments; control and proof are not their focus                                                                | Reasoned from public pages                                                                                                      |
| 7   | First wedge                 | Procurement/AP authority: supplier-scoped budgets, escalation above a limit, finance exposure view, Proof for audit                                          | Built in source; no procurement user                                                                                            |
| 8   | What integration requires   | An SDK call to `actions.execute`, an Authority owned by a human, a rail adapter. Today: PayPal Sandbox or simulated only                                     | Built                                                                                                                           |
| 9   | Security objection          | "Why trust a new control plane with money authority?" Answer today: preview, no audit, no certification, independent verification and limits stated openly   | Open                                                                                                                            |
| 10  | Regulatory concern          | Money-movement and agent-payment perimeter; usage pricing on payment volume                                                                                  | **Escalated to qualified counsel; no conclusion drawn.** No "no licence needed" claim is made                                   |
| 11  | Pricing model that fits     | Usage-based per governed action + enterprise platform fee; Verify free or low-friction                                                                       | Hypothesis; `docs/economics/PRICING-ARCHITECTURE.md`                                                                            |
| 12  | Cost to serve               | Infrastructure about $0.015 per 1,000 evaluations and $0.058 per 1,000 executions (lower bounds, estimated profiles); human support time dominates           | Mixed: vendor prices verified 2026-11-02, usage profiles estimated, one price unverified (`docs/economics/COST-MODEL.md`)       |
| 13  | Likely gross margin         | Modelled only. Small developer tier is negative (-51%) on support time; mid-market and enterprise are high on **hypothetical** revenue                       | Illustrative; not a forecast                                                                                                    |
| 14  | Willingness-to-pay evidence | **None.** 0 interviews. Evidence log is empty                                                                                                                | —                                                                                                                               |
| 15  | External validation missing | Everything in rows 1–6, 9–11, 13 needs real conversations; a pilot; counsel; a production rail                                                               | —                                                                                                                               |

### What is done and what is external

| Milestone                        | Status                                        | Notes                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M11 Procurement                  | `COMPLETE_LOCAL`                              | Finance view, approval escalation, UNKNOWN handling, Proof, procurement page. Not built: ERP/invoice connectors, recurring controls, wiring the full policy pack to live execution, completing payment after approval without the payer present |
| M12 Design-partner engine        | `COMPLETE_LOCAL`; external `BLOCKED_EXTERNAL` | ICP, 20 evidence-linked prospects, CRM schema and template, discovery guide, pilot pack, unsent outreach drafts. 0 conversations                                                                                                                |
| M13 Org control plane            | `COMPLETE_LOCAL`                              | Tenant-isolated agent inventory, finance, security, audit, decisions; no console sign-in and one admin secret instead of enforced roles                                                                                                         |
| M14 Reliability and security ops | `PARTIAL`                                     | Runbooks, threat model, rate limits, pauses, audit, observe-only UNKNOWN view exist. **Not done:** scheduled reconciliation, alerting, restore rehearsal, signing-key rotation, least-privilege DB roles                                        |
| M15 Pricing and economics        | `COMPLETE_LOCAL`                              | Pricing architecture, value-metric analysis, cost model with tests, margin tiers, commercial package, objection map, metering of GOVERNED_ACTION. Validation `BLOCKED_EXTERNAL`                                                                 |
