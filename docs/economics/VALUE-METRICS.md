# Value metric evaluation

**HYPOTHESIS - NOT VALIDATED.** This is a reasoned comparison, not customer evidence. Ratings are the author's qualitative judgement (High / Medium / Low) and should be replaced by interview findings. No customers exist.

## Candidates and scoring

Criteria: **Understand** (customer understanding), **Value** (correlation with value received), **Predict** (budget predictability for the customer), **Margin** (correlation with PayFlow's cost to serve), **Measure** (ease and reliability of measurement), **Incentive** (does it align incentives or create perverse ones).

| Metric                                                       | Understand                                           | Value                                                                              | Predict                                        | Margin                                            | Measure                                                       | Incentive                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Governed actions (Authority evaluations that gate an action) | High: "each decision the system makes"               | Medium-High: each is a decision the customer would otherwise have to make or audit | Medium: tracks agent activity, which can spike | High: CPU, DB writes and storage scale per action | High if emitted at one point (Gateway), currently not emitted | Mostly good. Risk: customers may batch or bypass governance to cut cost, which weakens safety |
| Active agents                                                | High                                                 | Low-Medium: an idle agent gets no value; a busy one gets a lot                     | High                                           | Low: cost does not track agent count              | Medium: definition of "active" needs a rule                   | Penalises deploying more governed agents, discouraging adoption of governance                 |
| Active Authorities                                           | Medium: requires understanding the Authority concept | Medium                                                                             | High                                           | Low-Medium                                        | High (rows in a table)                                        | Penalises granular, least-privilege Authorities, the opposite of the safe behaviour           |
| Verification requests                                        | High                                                 | Low for the payer: value accrues to the verifier                                   | Low: driven by third parties                   | Medium: cheap, stateless                          | High                                                          | Charging verifiers reduces trust-network use. Most useful as free or abuse-limited            |
| Governed economic volume (value of money flow)               | High                                                 | High in appearance: bigger payments, bigger risk                                   | Medium                                         | Low: cost does not scale with amount              | High                                                          | See risks below. Not recommended without counsel                                              |
| Enterprise platform fee (fixed)                              | High                                                 | Medium: pays for access, controls, support                                         | High                                           | Medium: covers human-heavy cost                   | High                                                          | Neutral; no usage disincentive, but gives less revenue upside                                 |

## Reasoned recommendation (tentative)

1. **Primary usage metric: governed actions.** It correlates best with cost to serve, is intuitive, and is measurable at a single point. It must be defined precisely first (does a denied or escalated evaluation count? does a replay-blocked request count? the code treats `GOVERNED_ACTION` as a meter but has no definition in use).
2. **Enterprise: a platform fee** covering governance entitlements and support, with an allowance of governed actions. The cost model shows support time dominates infrastructure cost, so a fixed fee that covers it is better aligned with cost than a purely per-action price.
3. **Verification: free or volume-capped.** Its main function is trust, not revenue.
4. **Do not use active agents or active Authorities as the sole metric.** They discourage the safe behaviour the product promotes. Report them as informational telemetry and, at most, enterprise entitlements.
5. **Do not default to governed economic volume.** See below.

## Risks

- **Volume-based pricing on money flow has regulatory and incentive implications. FLAG FOR COUNSEL; no conclusion is reached here.** A fee that scales with the value of payments governed may bear on how PayFlow is characterised (for example, as something closer to a payment service than a software tool) in some jurisdictions. Whether it does, and what the consequences would be, is a question for qualified counsel. The existing docs already state that percentage-of-payment-volume is not the default.
- **Incentive**: a volume fee gains when the system permits more spend, which is in tension with a product whose job is to say no. Per-action pricing has a milder form of the same concern (a denied action may or may not be billed).
- **Definition risk**: each metric needs a written definition (what counts, idempotency, sandbox vs production) or disputes follow.
- **Bypass risk**: usage pricing can push customers to evaluate less often.
- **Measurement risk**: the live path emits no meters today (METERING-AUDIT.md).
- **Unvalidated**: none of this has been tested with a buyer.
