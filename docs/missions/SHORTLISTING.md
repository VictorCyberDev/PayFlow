# Ranking and shortlisting (M48)

Candidates (M47) are ranked against one role of the scope in force (M46). No model; the order is the same every time.

- **Checks.** Each required skill is `MET` or `NOT_MET` (matched case-insensitively against the profile's claimed skills). The price check
  compares the stated amount with the cap that applies: an hourly role compares an hourly rate to the role's maximum rate (a fixed quote
  says nothing about an hourly rate), other roles compare a fixed quote to the role's budget cap. A price that was not stated is
  `UNKNOWN`, and **unknown is never met**.
- **Standing.** `ELIGIBLE` (all skills met, price within the cap), `NEEDS_INFO` (all skills met, price not stated), `INELIGIBLE` (a skill
  missing or the price above the cap). Skills and prices are _claims_; a person verifies them in M49.
- **Order.** Standing, then more preferred skills, then lower price (not stated last), then more portfolio items, then handle. Ineligible
  candidates are listed with their reasons but have no rank.
- **Never ranked on:** years of experience (a proxy for age) or anything else that could stand in for a protected attribute. It is shown on
  the profile and ignored by the ranking; a property test checks that changing it never changes the order.
- **Scope changes.** Candidates imported under an older scope version are not ranked under a newer one (`staleExcluded` says how many).
- **Adopting.** Only a person adopts a shortlist: one to five distinct, ranked (not ineligible) candidates for one role, one active
  shortlist per role and scope. The ranking at that moment is stored with it. Withdraw it to change it. Adopting contacts no one and offers
  nothing.
