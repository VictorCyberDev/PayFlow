# EXPERIENCE-002: X1–X8 customer-experience evaluation record

Status: **CLOSED — feeds BRAND-001 (X9)**

Baseline: `main` at `3a4cc3499026e42caa083fde53d2064d897bbdc3` (M1–M5 merged, EXPERIENCE-001 locked).

This record is the working evidence for gates X1–X8 of `docs/EXPERIENCE-001-payflow-experience-architecture.md`. It changes no financial semantics. The final authority for the shipped identity is `docs/BRAND-001-payflow-experience-and-visual-system.md`.

> **Evaluation honesty.** No independent human participants were available. Every "test" below is an **INTERNAL RECOGNITION + COMPREHENSION EVALUATION** performed by the implementing engineer against rendered boards. It is an informed design review, not user research, and no percentage of "users" is claimed.

| Gate                        | Status | Evidence                           |
| --------------------------- | ------ | ---------------------------------- |
| X1 Customer mental model    | PASS   | §1                                 |
| X2 Information architecture | PASS   | §2, implemented routes             |
| X3 Disclosure architecture  | PASS   | §3, `ProofPanel`, `lib/present.ts` |
| X4 Language system          | PASS   | §4, `lib/language.ts` + tests      |
| X5 Core product structure   | PASS   | §5, route map, E2E                 |
| X6 Future-state validation  | PASS   | §6, `tests/future-states.test.tsx` |
| X7 Visual territories       | PASS   | §7, `docs/brand/x7-territories/`   |
| X8 Comparative evaluation   | PASS   | §8                                 |

---

## 1. X1 — Customer mental model

### Audiences

| Audience                           | Wants to know                                                                                                                                    | Must never have to learn first                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Consumer**                       | What can my AI do? How much? Do I need to approve again? Did money move? Can I stop it? What if PayFlow is unsure?                               | Mandates, grants, reservations, reason codes                        |
| **Judge**                          | What is new here? Is the AI interpretation separate from financial authority? Is the money outcome visible at a glance? Can I inspect the proof? | A developer console to find the point                               |
| **Enterprise / operational buyer** | Which agent acted, under which policy, within which budget and merchant boundary, with what audit trail, and how do I stop it?                   | Consumer onboarding copy; but must reach dense evidence in one step |

### The four customer concepts

**Authority** (what the Agent may do) · **Agent** (who acts) · **Activity** (what happened to my money) · **Proof** (why PayFlow allowed, blocked, held or verified it).

### Audit of the M5 experience (`apps/console` at `3a4cc34`)

Each current information class, assigned to its correct layer. _Outcome_ = what happened / where I stand. _Explanation_ = enough to understand or act. _Proof_ = technical or evidentiary.

| #   | Information class (as found)                                                       | Where found                                                | Correct layer                                                         | Defect                                                          |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | "Up to $100 · $16 remaining"                                                       | Authority card                                             | Outcome                                                               | OK, but led by a fixture                                        |
| 2   | Example Authority ($84 used / $16 left) beside real Authorities                    | Home                                                       | — (remove)                                                            | **Example resembled real money state** (§13.12)                 |
| 3   | Five "non-production / fixture / demo" notices                                     | banner, topbar, sidebar, ask, activation, footnote, wallet | Environment badge + About                                             | **Repeated disclaimer** (§13.5)                                 |
| 4   | Operator access-code form inside "Give your agent exact authority"                 | Activation panel                                           | Access gate (separate)                                                | **Authentication mechanics define Authority creation** (§13.13) |
| 5   | "Refresh saved state" / "Refresh authority" buttons                                | Management, activation                                     | System responsibility                                                 | **Maintenance control as customer control** (§13.7)             |
| 6   | `Expires Sat, 24 Oct 2026 00:00:00 GMT`                                            | Everywhere                                                 | Outcome: "Friday at 6:00 PM"; exact UTC in Proof                      | **Machine time** (§13.8)                                        |
| 7   | Committed / Currently reserved / Human approval threshold                          | Authority details                                          | Explanation: Used / Pending / "Asks you above $X"                     | **Backend vocabulary** (§13.3)                                  |
| 8   | Operation / Authority / Agent identifiers, payment attempt, provider order/capture | Technical references                                       | Proof                                                                 | Three disclosure levels deep (§13.6)                            |
| 9   | `State: VALID_DRAFT`, draft fingerprint, reason codes                              | Ask review details                                         | Proof                                                                 | Leaked into normal flow                                         |
| 10  | Stage list `provider: incomplete · provider uncertain`                             | Activity verification                                      | Proof (summarised in Explanation)                                     | State-machine terms                                             |
| 11  | "Money moved: yes / Your money didn't move" in a paragraph under timestamp         | Activity row                                               | **Outcome — must lead the row**                                       | **Financial outcome lacks dominance** (§13.4)                   |
| 12  | Verification verdict words (VERIFIED / INCOMPLETE / INVALID / LEGACY)              | Activity                                                   | Explanation sentence ("Verified" / "Checking"); verdict code in Proof | Jargon                                                          |
| 13  | Home = hero + composer + sample button + example + saved + activity + agents       | `page.tsx`                                                 | Four separate destinations                                            | **One-page accumulation** (§13.1, §13.11)                       |
| 14  | Horizontal-scroll anchor nav on mobile                                             | sidebar → `.mobile`                                        | Bottom tab bar                                                        | **Responsive, not mobile-designed** (§13.14)                    |
| 15  | "Why?" → "View verification details" → "Technical references"                      | Activity                                                   | Outcome → Explanation → Proof (≤2 expansions)                         | **Nested disclosure** (§13.6)                                   |

### X1 result

Audiences explicit; four concepts explicit; all fifteen current information classes assigned a layer; implementation leakage identified (rows 3–5, 7–10, 12–15). Implementation corrections land in X2–X5 and are listed in §5.

---

## 2. X2 — Information architecture

Real destinations replace the single anchor-driven page. The app is a Next.js static export, so destinations are real files (`trailingSlash`), selectors use query strings (a static export cannot enumerate runtime ids).

| Destination     | Route                                    | Customer question                    | Contents                                                                                |
| --------------- | ---------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| Home            | `/`                                      | Is everything okay?                  | Attention headline; the single most relevant Authority; ≤3 recent outcomes; one action  |
| New Authority   | `/new/`                                  | What may my Agent do?                | Describe → Understand → Confirm → Created, one decision per step                        |
| Authorities     | `/authorities/` and `/authorities/?id=…` | What can my Agents do with my money? | List; detail with controls; `proof=1` opens Proof                                       |
| Activity        | `/activity/` and `/activity/?id=…`       | What happened to my money?           | Journal; detail; `proof=1` opens Proof                                                  |
| About this demo | `/about/`                                | What is real here?                   | The one place environment limits are explained                                          |
| Agent context   | within Authority and Activity detail     | Who acted?                           | Agent identity line with its capabilities; no top-level destination (EXPERIENCE-001 §4) |
| Proof           | `?proof=1` on any detail                 | Why was this allowed / blocked?      | Deliberate full-width evidentiary mode with a back link; **not** a nested disclosure    |

Navigation: desktop left rail (Home, New Authority, Authorities, Activity); mobile bottom tab bar with the same four jobs plus a persistent top bar carrying the environment badge. The destination for the signed-out visitor is Home, which explains the product and exposes **Demo access** as a compact, separate panel (not part of Authority creation).

Pass: real destinations ✔, nav equals customer jobs ✔, single page retired ✔, mobile nav designed ✔, Proof deliberate ✔, no customer flow requires scrolling past unrelated areas ✔.

---

## 3. X3 — Disclosure architecture

**Outcome → Explanation → Proof.** At most two expansions precede Proof; in practice zero for Outcome, one tap for Explanation ("Why?"), one tap for Proof ("View proof").

| Record              | Outcome (always visible)                               | Explanation (one tap)                               | Proof (deliberate mode)                                                    |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------- |
| Active Authority    | "$16 left of $100" · Agent · Expires Friday at 6:00 PM | What it may buy, where, condition, asks/doesn't ask | Authority id, agent id, thresholds, created/observed (UTC), dispatch state |
| Revoked             | "Revoked — can't start new purchases"                  | "Completed payments are not reversed."              | Same as above                                                              |
| Expired             | "Expired"                                              | Same wording                                        | Same                                                                       |
| Paid                | "$84 paid once"                                        | Which Authority applied, what remains               | Decision, reservation, grant, order, capture, Trace                        |
| Blocked             | "$0 moved"                                             | "Price exceeded your $100 maximum."                 | Reason codes, evaluated terms, zero-effect counts                          |
| Unknown             | "Checking what happened — don't retry yet"             | "We haven't confirmed whether money moved…"         | Provider observation, reconciliation state                                 |
| Agent               | name + status line                                     | capabilities in plain words                         | agent id                                                                   |
| M6 delegated action | as Paid / Blocked, plus "Done without asking you"      | the Authority clause that permitted it              | full chain                                                                 |

Pass: a first-time consumer can read _what happened_, _why_, and _what to do_ from Outcome + Explanation without seeing an identifier.

---

## 4. X4 — Language system

The canonical map is code: `apps/console/lib/language.ts` (tests: `tests/language.test.mjs`). Summary:

| Backend                   | Customer                                                     |
| ------------------------- | ------------------------------------------------------------ |
| Mandate                   | Authority                                                    |
| AgentPassport             | Agent                                                        |
| autonomous threshold      | "Can spend without asking up to $X"                          |
| human approval threshold  | "Asks you above $X"                                          |
| cumulative limit          | Total budget                                                 |
| committed                 | Used                                                         |
| reserved                  | Pending                                                      |
| freshDispatchBlocked      | "Can't start new purchases"                                  |
| provider conformance      | Payment verified                                             |
| reconciliation            | Checking what happened                                       |
| UNKNOWN_FINANCIAL_OUTCOME | "We haven't confirmed whether money moved. Don't retry yet." |
| money moved NO            | **$0 moved**                                                 |
| money moved YES           | **$84 paid once**                                            |

Tone: calm, factual, controlled, human. No exclamation marks, confetti or emoji. Money movement is never celebrated.

Time: `lib/present.ts` — "Friday at 6:00 PM", "Today at 3:42 PM", "2 days remaining", "Updated just now"; exact UTC in Proof only.

Demo disclosure: one persistent **SANDBOX** badge in the shell; one **About this demo** page; safety-critical messages (e.g. "Nothing is authorized yet.") remain where an action requires them.

---

## 5. X5 — Core product structure

All eighteen jobs have a real implementation: Home; New Authority; request; interpretation; boundary review; confirmation; Authority created; Authorities list; Authority detail; Activity list; Activity detail; Agent context; Proof; revoke; ambiguous outcome; empty state; loading; failure; mobile.

Preserved functionality: every M5 behaviour (recorded interpretation, exact confirmation, durable Authority read, revoke with verification read, Activity, stale/expiry correction, CSRF/origin/session) is retained because the controllers in `apps/console/lib/*-client.mjs` are unchanged; only presentation and routing were rebuilt. Corrections made from the §1 audit: rows 2–15.

---

## 6. X6 — Future-state validation

The IA and components are exercised with representative fixtures in `apps/console/tests/future-states.test.tsx` (rendered with the production components). These are _presentation_ fixtures; no product claim is made for unbuilt milestones.

| State                                                                       | How it fits                                                                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **M6 valid delegated purchase** — "$84 paid once · Done without asking you" | `ActivityRow` + `FlowTrace` (all stages resolved); Authority clause "Won't ask you again" in Explanation             |
| **M6 price drift** — "$0 moved · Price exceeded your $100 maximum"          | `FlowTrace` stops at the Gate; Payment node "not started"                                                            |
| **M7 external agent**                                                       | `AgentIdentity` shows display name + "External agent"; OAuth/MCP terms confined to Proof                             |
| **M8 read-only verification**                                               | Proof block "Independently verified (read-only)" — visually distinct from Authority controls, no money-moving button |
| **M9 Break PayFlow**                                                        | Row leads "$0 moved", Explanation names the attack, Proof lists blocked stages; same Frame→Flow→Gate→Trace grammar   |

No change to X2–X5 was required.

---

## 7. X7 — Three visual territories

Boards rendered from one shared markup so all three show the **same screens** (marketing hero, Home, Authority, mobile Authority, New Authority, Activity paid/blocked/unknown, Proof). Source: `docs/brand/x7-territories/build.mjs`; renders: `t1.png`, `t2.png`, `t3.png`.

|                | **T1 Crop Mark**                                                                                                               | **T2 Ledger**                                                       | **T3 Blueprint**                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------- |
| Idea           | Authority is the area inside registration/crop marks; the Gate is a break in the line                                          | Authority is a double-ruled ledger entry; the Gate is a notary seal | Authority is a dimensioned drawing; the Gate is a bar |
| Palette        | Ink `#12161B`, paper `#F2EFE6`, signal amber `#F5B301`                                                                         | Ink-brown, cream, oxblood `#6E1F2F`                                 | Navy, cool grey, cobalt `#1B3FD6`                     |
| Type           | Bricolage Grotesque + Instrument Sans + Plex Mono (Proof)                                                                      | Fraunces + Plex Sans + Plex Mono                                    | Space Grotesk + Plex Mono                             |
| Frame          | Four corner crop marks, square corners                                                                                         | Double rule, no radius                                              | Thin cobalt rectangle with dimension line             |
| Flow           | Dashed ink line → solid amber                                                                                                  | Dotted leader line                                                  | Arrow                                                 |
| Gate           | Open break in the right edge; state glyphs: filled square (paid), barred square (blocked), dashed square + amber dot (unknown) | Circle seal; filled / struck / dotted circle                        | Arrow / arrow to bar / dotted arrow                   |
| Logo direction | Square frame with a gate gap and a through-line                                                                                | Seal monogram                                                       | Bracketed P-line                                      |
| Motion         | Marks seal inward; line stops at the bar                                                                                       | Stamp                                                               | Dimension draws                                       |
| Mobile         | Frame scales; tab bar                                                                                                          | Frame scales                                                        | Frame scales                                          |
| Marketing      | Black plate, amber Flow line                                                                                                   | Double-rule plate                                                   | Solid cobalt plate                                    |

Territory notes from viewing the renders: T1's glyph set and crop-mark Frame are legible and repeat across every screen; T2 is warm and credible but reads "heritage private bank", and its seal collided with the agent label at 340 px; T3's Authority drawing is clever but the cobalt/grey system is visually adjacent to PayPal, Stripe and generic fintech blue.

---

## 8. X8 — Comparative evaluation (internal)

### Rubric (100)

| Criterion                                                                                        | Max     | T1     | T2     | T3  |
| ------------------------------------------------------------------------------------------------ | ------- | ------ | ------ | --- |
| Distinctiveness (ownable memory structures; logo-hidden)                                         | 25      | **21** | 18     | 12  |
| Five-second comprehension (what may it do, boundary, did money move)                             | 25      | **21** | 19     | 20  |
| Trust (appropriate for real financial authority, no false celebration, unknown stays unresolved) | 20      | 16     | **17** | 14  |
| Roadmap extensibility (M6 delegation, M7, M8, M9, enterprise Proof)                              | 15      | **13** | 10     | 12  |
| Accessibility + mobile                                                                           | 10      | **8**  | 8      | 8   |
| Engineering quality (clean, not a fragile bespoke mess)                                          | 5       | **4**  | 4      | 4   |
| **Total**                                                                                        | **100** | **83** | 76     | 70  |

### Name-hidden test (logo and name covered)

- **T1:** Corner crop marks around a quantity, a split-square "barred" glyph for a blocked action, amber appearing only as the moving line. Three repeatable structures survive; none needs the wordmark. Closest category neighbours: Binance/Bumble yellow (different category and geometry).
- **T2:** Double rules and serif amounts remain identifiable, but the editorial register is shared with several private-banking and newsletter brands.
- **T3:** Cobalt on cool grey reads as one of many fintech/dev-tool systems; only the dimension line is ownable.

### Colour-collision map

Wise/Cash App green, Monzo coral, Klarna pink/eggplant, PayPal blue, generic fintech navy and AI violet were treated as occupied. T1's ink + amber avoids all; amber also signals _caution_, which PayFlow uses sparingly and **never alone** (every state has a shape and a word). T3 collides with PayPal/Stripe blue and was penalised accordingly. T2's oxblood sits next to Klarna's eggplant region.

### Decision

**T1 · Crop Mark wins (83/100).** Strengths: most ownable memory structures (Frame, barred-square Gate state glyph, amber Flow), the strongest scale from consumer Home to attack proof (M9: crop marks and barred squares are identical in a dense Proof table), square geometry that explicitly avoids wallet/card shapes. Weaknesses: amber text contrast requires a dark companion (`--signal-ink`) and amber must never carry meaning alone; square geometry can feel severe, softened here with generous spacing and a warm paper ground. Rejected: T2 (weaker extensibility and category neighbours), T3 (least distinctive). One idea from T3 — an explicit **maximum annotation** on the Frame — is kept as a text line, not a drawing.
