# Deliverables and contractor payment (M50)

The last step of the talent half: work is delivered, a person accepts it, and the milestone is paid through PayFlow's one decision path.

- **Deliverable** (`submit`): a summary and up to ten references for one milestone of a contract. An agent that can READ or a person submits;
  it is a **claim**. One open submission per milestone; a rejected one can be resubmitted; once one is accepted the milestone takes no more.
- **Decision**: only a person accepts or rejects, once. Accepting **needs evidence** (an attestation or a document reference). Agents have no
  decide route.
- **Payment instruction** (`payment`): derived from an accepted deliverable, like a purchase order. It says exactly what may be paid: the
  milestone's amount, the payee, the one agent that may pay it and the stored Authority it must be paid under. It is refused when the
  milestone's budget item is no longer `COMMITTED`, when the amount is above the Authority's single maximum or allocation, when the Authority
  does not name the payee, or when the agent cannot purchase. One instruction per milestone. **It is not a payment.**
- **Payment**: the agent pays through `actions.execute` under the instruction's Authority, exactly as for a purchase. The Trust Kernel decides.
- **Reconciliation** reads PayFlow's own operation trace for that payment and classifies it with the same classifier as M40: `SETTLED`
  (reserve, in flight, settled with Proof/provider evidence), `UNKNOWN`/`MISMATCH` (the budget is held, never settled or released),
  `FAILED_NO_EFFECT`, `INCOMPLETE`, `DUPLICATE`. A payment under another Authority or by another agent is _foreign_: it moves nothing and its
  references are withheld. Only the instruction's agent, or a person, reconciles.
- **Termination** (a person): cancels the milestones that have **no payment instruction** (their budget is released) and keeps the rest, once.
  New work on a terminated contract is refused.
- **Limits.** The sandbox rail pays catalog purchases; a real payout to a person needs a payout rail, payee onboarding and tax documents
  (W-8/W-9, 1099 or local equivalents), none of which PayFlow provides here (BLOCKED_EXTERNAL). PayFlow is not the contracting party and
  gives no classification or tax advice.
