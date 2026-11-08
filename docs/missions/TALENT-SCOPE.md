# Talent scope (M46)

The rulebook for contractor work. Nothing is shortlisted (M48), offered (M49) or paid (M50) outside it.

- **Content.** A category (one of the mission's spending categories), the currency, 1–10 roles (title, required and preferred skills,
  engagement `FIXED_PRICE`/`HOURLY`/`RETAINER`, a maximum hourly rate for hourly roles, a budget cap, deliverables) and the checks a person
  must record before any offer (`IDENTITY_VERIFIED`, `PORTFOLIO_REVIEWED`, `REFERENCES_CHECKED`, `WORK_AUTHORIZATION_CONFIRMED`,
  `CLASSIFICATION_REVIEWED`). The schema is strict.
- **Checked against the mission** when proposed and again when approved: same currency; category in the mission; the mission approves the
  `TALENT_MARKETPLACE` provider type; not already expired and not outliving the mission; each role cap within the largest single
  commitment; the roles together within the total budget.
- **No protected attributes.** Role text may not contain words naming protected attributes (age, gender, ethnicity, religion,
  nationality, marital status, pregnancy, sexuality …) as whole words. This is a **best-effort screen, not legal compliance**: words with
  ordinary technical meanings (native, race condition, single-page, old code, orientation, disabled users) are deliberately not listed.
- **Proposed by an agent with DRAFT or a person; approved only by the owner.** One version is in force at a time; approving supersedes
  the previous one; rejecting or revoking leaves none. Versions are immutable and never deleted.
