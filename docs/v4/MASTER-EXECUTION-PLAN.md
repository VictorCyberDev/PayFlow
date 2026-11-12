# V4 master execution plan and implementation matrix

One ledger, not ten. The mandate (§32.4) lists ten files; it also says to use
existing files rather than maintain contradictory duplicates. Creating eight
near-empty documents would be the padding the mandate warns against, so this
file carries the plan, the matrix and the statuses, and
`PRODUCT-ACCEPTANCE.md`, `EXTERNAL-BLOCKERS.md`, `RELEASE-STATE.md` and
`RECOVERY-CHECKPOINT.md` carry the rest.

Statuses are the mandate's: READY · RUNNING · WAITING_CI · WAITING_PROVIDER ·
WAITING_REVIEW · WAITING_APPROVAL · BLOCKED_EXTERNAL · FAILED · ACCEPTED.

## What was actually delivered

| ID   | Deliverable                                | Status                                             | Where                                                                                                  |
| ---- | ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| D-A1 | Source audit against the live hosts        | **ACCEPTED**                                       | `PRODUCT-SOURCE-AUDIT.md`                                                                              |
| D-A2 | Willie quality transfer                    | **ACCEPTED**                                       | `WILLIE-EXPERIENCE-TRANSFER.md`                                                                        |
| D1   | Consumer brand identity, original          | **ACCEPTED**                                       | `BRAND-FLOW.md`, `apps/console/app/flow.css`, `app/ui/flow.tsx`                                        |
| D2   | Consumer homepage                          | **ACCEPTED**                                       | `app/views/landing.tsx` → `/`                                                                          |
| D4   | One-click judge demo                       | **ACCEPTED**                                       | `app/ui/demo.tsx` → `/try/`                                                                            |
| D5   | Conversational AI business partner         | **ACCEPTED (local)** / **WAITING_PROVIDER (live)** | `api/partner.ts`, `src/partner/founder-plan.ts`, `app/ui/partner.tsx` → `/partner/`                    |
| D25  | Purposeful branded motion                  | **ACCEPTED**                                       | Eleven Flow states, reduced-motion safe, asserted in tests                                             |
| D24  | Accessible responsive experience           | **ACCEPTED**                                       | axe clean at 1280px and 320px on all three routes                                                      |
| D27  | Financial and security regression evidence | **ACCEPTED**                                       | 1407 root tests green; the Trust Kernel is untouched                                                   |
| D28  | Browser and end-to-end verification        | **PARTIAL**                                        | Real Chromium drives all three routes and the full demo journey. The live model path needs production. |
| D29  | Reviewed and integrated release            | **WAITING_CI**                                     | Branch `claude/busy-fermat-xsieoy`                                                                     |
| D30  | Verified production deployment             | **WAITING_APPROVAL**                               | Blockers E-1 and the owner's merge decision                                                            |

## What was deliberately not built

Named here so no reader has to infer it from silence.

| ID      | Deliverable                                              | Status                             | Why                                                                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D3      | Zero-code auth and real accounts                         | **READY, not started**             | `src/network/user-auth.ts` is a correct scrypt/session/CSRF implementation that only needs a deployment. Reaching it from the static export means either deploying the gateway or porting its session handling to functions. Substantial, and it is honest engineering work — not a blocker. |
| D6, D7  | Business memory, persistent workspace                    | **READY, not started**             | Both need D3 first. A "memory" without an account is a lie about persistence.                                                                                                                                                                                                                |
| D8      | Founder decision inbox                                   | **PARTIAL**                        | `/partner/` marks every money-moving step as needing the founder, and `/try/` shows a full approval sheet. There is no durable inbox, because there is nothing durable to put in it (D3).                                                                                                    |
| D9, D10 | Channel3 commerce experience                             | **READY, not started**             | The connector exists and the key is configured. A `/api/explore` function in the same shape as `/api/partner` is the obvious next commit. Not done in this session.                                                                                                                          |
| D11–D13 | PayPal checkout, invoicing, reconciliation               | **WAITING_APPROVAL**               | Blocker E-2. Execution must stay on the isolated host.                                                                                                                                                                                                                                       |
| D14–D17 | Talent, negotiation, growth, outreach                    | **BLOCKED_EXTERNAL**               | Blockers E-3, E-5.                                                                                                                                                                                                                                                                           |
| D18–D22 | Admin assistant, travel, launch workspace, recurring ops | **BLOCKED_EXTERNAL / not started** | Blocker E-4 for travel; the rest need D3.                                                                                                                                                                                                                                                    |
| D23     | Activity, receipts, outcome records                      | **PARTIAL**                        | `/try/` shows the five-state outcome ladder. No live record store on the public app.                                                                                                                                                                                                         |
| D26     | Provider acceptance evidence                             | **PARTIAL**                        | Groq is implemented and contract-tested with an injected model; it has not been run live from this deployment (E-6). Channel3 and PayPal are unchanged from the pre-existing evidence in `docs/`.                                                                                            |

## The dependency that explains the shape of this list

Almost everything not delivered sits behind one of two things: **an account
system on the public host (D3)**, or **a provider the owner has not
authorized**. The audit's section 1 explains why: the public artifact was a
static export with no request-time code at all. This session removed that
constraint — there is now a function boundary, a tested pattern for adding
another, and a design system to render it in. `/api/explore` (D9) followed in the same session, which is the proof that the
pattern generalises: a second provider, a second surface, no new
infrastructure. The next most valuable commit is **D3, accounts on the public
host**, because almost everything still missing is waiting on it.
