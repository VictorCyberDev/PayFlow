# Contractor checks, offers and contracts (M49)

PayFlow coordinates; it is **not** a party to any engagement and **sends nothing**. Every outward step is a person's act, recorded here.

- **Checks.** A person records findings about a candidate (`IDENTITY_VERIFIED`, `PORTFOLIO_REVIEWED`, `REFERENCES_CHECKED`,
  `WORK_AUTHORIZATION_CONFIRMED`, `CLASSIFICATION_REVIEWED`), each `PASSED` or `FAILED` with evidence. The log is append-only and the
  **latest finding per kind counts**. Agents can read the standing; they record none.
- **Draft.** For a candidate on the active shortlist of the scope in force: milestones (title, amount, due date) between a start and end
  date, in the scope's currency, in order, in total no more than the role's budget; hourly roles need a rate not above the role's maximum and
  hours not above its maximum; the offer must expire before the scope does. An agent with DRAFT or a person drafts. Terms never change
  afterwards, and a candidate has at most one live offer per role.
- **Approve** (owner): every check the scope requires must be `PASSED` (missing or failed ones are named) and the scope the offer was drafted
  under must still be in force.
- **Send and answer** (a person): `sent` records that the offer went out (by the person, outside PayFlow); `answer` records the candidate's
  reply with evidence. An offer must have been sent before it can be accepted, and every end state is final. An expired offer can no longer
  be approved or answered.
- **Acceptance** commits each milestone in the budget ledger (kind `CONTRACTOR_MILESTONE`, stage `COMMITTED`, owner-reported because the
  commitment is made outside PayFlow) under fixed per-offer keys, then records the contract. If the budget cannot hold every milestone the
  acceptance is refused and no contract is recorded. Accepting pays no one; payment is M50.
- **Not handled here:** employment or contractor classification advice, tax forms, background-check providers, e-signature. The
  `CLASSIFICATION_REVIEWED` check is a person's attestation that someone competent reviewed it, not a determination by PayFlow.
