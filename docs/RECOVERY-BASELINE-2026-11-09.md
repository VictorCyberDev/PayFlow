# Recovery baseline — 2026-11-09

Dated record at the start of the V3 production-recovery program (waves R0–R5). It does not rewrite earlier reports
(`V3-FINAL-REPORT.md`, `V3-EXECUTION-LEDGER.md`); it corrects how they should be read.

## Verified state (read-only)

| Item                       | Observed                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `main`                     | `eec9c68` (M26–M50 merged, PRs #43–#59)                                                                       |
| Open PRs                   | #17, #32 (drafts, not merged; #32 is an older branch — ideas only)                                            |
| Vercel `payflow-public`    | project exists, **zero deployments**                                                                          |
| Public Neon DB             | pre-M26 tables only; **no `mission_*` tables**; migrations 030–053 are applied nowhere public                 |
| Neon role `svc_public_app` | still privileged (neon_superuser, CREATEDB, CREATEROLE, BYPASSRLS, can log in). **Owner-gated; not touched.** |
| Neon role `svc_public_rt`  | correctly restricted (`payflow_runtime`), no password configured (owner action)                               |

## Capability matrix (what each layer honestly is today)

Legend: ✔ yes · ◐ partial · ✘ no. "Browser" = exercised in a real browser; "Provider" = exercised against a real third-party service.

| Capability                                                                    | In code                      | Wired | Local tests | Browser         | Provider                                                   | Public | Commissioned | Customer-validated | Known defects                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------- | ----- | ----------- | --------------- | ---------------------------------------------------------- | ------ | ------------ | ------------------ | ----------------------------------------------------------------------------- |
| Trust Kernel / Authority / reservations / grants / Proof                      | ✔                            | ✔     | ✔           | ◐               | PayPal Sandbox (earlier phase)                             | ✘      | ✘            | ✘                  | –                                                                             |
| Mission contract, versions, authority compiler (M26–M29)                      | ✔                            | ✔     | ✔           | ◐ (M30 console) | ✘                                                          | ✘      | ✘            | ✘                  | –                                                                             |
| Commitment ledger (M27/M28)                                                   | ✔                            | ✔     | ✔           | ◐               | ✘                                                          | ✘      | ✘            | ✘                  | –                                                                             |
| Discovery, qualification, quotes, optimizer (M31–M35)                         | ✔                            | ✔     | ✔           | ✘               | ✘ (connectors are deterministic doubles / manual evidence) | ✘      | ✘            | ✘                  | M34 link race fix was incomplete (R0 P1)                                      |
| Negotiation, communication, counteroffers, acceptance (M36–M39)               | ✔                            | ✔     | ✔           | ✘               | ✘ (nothing is sent)                                        | ✘      | ✘            | ✘                  | M39 acceptance split write (R0 P1)                                            |
| Purchase orders + reconciliation (M40)                                        | ✔                            | ✔     | ✔           | ✘               | PayPal Sandbox rail only                                   | ✘      | ✘            | ✘                  | **P0: payment not bound to the PO at the Gateway (fixed in R0, this branch)** |
| Orders, fulfillment, disputes/refunds, obligations, portfolio (M41–M45)       | ✔                            | ✔     | ✔           | ✘               | ✘                                                          | ✘      | ✘            | ✘                  | refund/dispute split writes to be audited (R0)                                |
| Talent scope → candidates → shortlist → offers → contracts (M46–M49)          | ✔                            | ✔     | ✔           | ✘               | ✘ (no talent adapter)                                      | ✘      | ✘            | ✘                  | **P0: offer acceptance not one transaction (R0)**                             |
| Deliverables + contractor payment instructions (M50)                          | ✔                            | ✔     | ✔           | ✘               | ✘ (no payout rail; instructions only)                      | ✘      | ✘            | ✘                  | –                                                                             |
| Authenticated customer product (sessions, onboarding, wizard, control center) | ◐ (operator console only)    | ◐     | ◐           | ◐               | ✘                                                          | ✘      | ✘            | ✘                  | R1                                                                            |
| Real catalog / talent / communication adapters                                | ✘                            | ✘     | ✘           | ✘               | ✘                                                          | ✘      | ✘            | ✘                  | R2                                                                            |
| AI orchestration                                                              | ✘ (planner is deterministic) | ✘     | ✘           | ✘               | ✘                                                          | ✘      | ✘            | ✘                  | R3                                                                            |

No milestone M26–M50 is `COMPLETE_REAL`. Green CI is not external acceptance.

## Reading rule for the earlier reports

"Merged and tested locally" in `V3-FINAL-REPORT.md` means `COMPLETE_LOCAL` at best. Where this document or a later R-wave PR records a defect, the later record wins.
