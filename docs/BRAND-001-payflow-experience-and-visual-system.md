# BRAND-001: PayFlow experience and visual system

Status: **LOCKED (X9)** · Selected territory: **T1 · Crop Mark** · Lock date: 2026-10-23

Supersedes the "visual choices intentionally left open" list in `docs/EXPERIENCE-001-payflow-experience-architecture.md` §19. The evaluation that selected this system is `docs/EXPERIENCE-002-x1-x8-evaluation.md`. Implementation: `apps/console` (tokens in `app/globals.css`, components in `app/ui/`, language in `lib/language.ts`, presentation helpers in `lib/present.ts`).

This document is the experience design authority for M6 onward. It does not alter financial semantics.

---

## 1. Brand

**Positioning.** PayFlow is _verifiable financial authority for AI agents_.

**Promise.** _Give AI agents permission to spend — not control of your money._ Used in marketing and the signed-out Home. _Your AI. Your authority._ was evaluated and is retained only as a short secondary line (it is accurate but generic beside the promise); it is never a headline.

**Brand idea — Bounded Flow.** Authority is a bounded area; an Agent's action flows toward it; PayFlow's Gate decides deterministically; the Trace records what actually happened.

**Memory structures** (the repeatable, ownable parts):

1. **The Frame** — an area marked by four corner crop marks (never a closed rounded card).
2. **The Gate glyph** — a square whose state is read by _shape_: filled = paid, barred = blocked, dashed with a dot = unresolved, struck = revoked.
3. **The Flow line** — a dashed ink line that becomes solid amber only as far as the Gate allowed it.
4. **Outcome-first money line** — `$0 moved` / `$84 paid once` set large in the display face.
5. **Ink + paper + amber** — amber appears only as Flow or caution.

**Principles.** Financial truth before decoration · calm precision · outcome before proof · state by shape and word, never colour alone · nothing celebrates money moving.

### Logo and wordmark

- **Mark**: a square frame open at the right (the Gate) with a through-line passing the gap. Master geometry (32×32): frame `M28 11V4H4v24h24v-7`, stroke 3, mitre joins; flow `M11 16h21`, stroke 3. Files: `apps/console/app/icon.svg` (favicon), `app/ui/brand.tsx`.
- **Wordmark**: "PayFlow" in Bricolage Grotesque 700, tracking −0.02em.
- **Usage**: ink on paper, paper on ink; flow bar may be amber on ink. Minimum mark size 16 px; clear space = stroke width × 2. Must remain recognisable in monochrome and at favicon size; no gradient dependency.
- **Prohibited**: shield, checkmark, card, wallet, a generic "P" in a rounded square, gradients, glows, outlines in colours other than ink/paper, rotating or squashing the mark, placing amber text on paper.

---

## 2. Colour

| Token           | Value                | Use                                                                     |
| --------------- | -------------------- | ----------------------------------------------------------------------- |
| `--paper`       | `#F2EFE6`            | page ground                                                             |
| `--surface`     | `#FBFAF6`            | Frames, panels                                                          |
| `--ink`         | `#12161B`            | text, Frame marks, primary actions                                      |
| `--ink-2`       | `#3A4048`            | secondary text (9.5:1 on paper)                                         |
| `--ink-3`       | `#5B626B`            | tertiary text (5.6:1 on surface)                                        |
| `--rule`        | `rgba(18,22,27,.16)` | hairlines                                                               |
| `--signal`      | `#F5B301`            | Flow line, focus ring accent, unresolved dot, large fills with ink text |
| `--signal-ink`  | `#7A5600`            | amber-family _text_ on paper (6.9:1)                                    |
| `--signal-wash` | `#FBEFC8`            | attention background (always with a word and a glyph)                   |

Contrast rules: body text ≥ 4.5:1; large text and UI components ≥ 3:1; ink on amber 10.9:1; amber is never text on paper (use `--signal-ink`). State is communicated by **glyph + word**; colour only reinforces. Light mode only: **dark mode is intentionally out of scope** and must not be added half-finished.

Collision decisions: no green-for-money, no PayPal blue, no coral, no pink, no violet/cyan gradient (see §11).

---

## 3. Typography

| Role                        | Family                                             | Notes                                                                |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| Display, headlines, amounts | **Bricolage Grotesque** (variable, 200–800, latin) | amounts in 600–700; `font-variant-numeric: tabular-nums lining-nums` |
| Interface and body          | **Instrument Sans** (variable, 400–700, latin)     | replaces Inter; slightly warmer, still highly legible                |
| Proof                       | **IBM Plex Mono** (400)                            | Proof only — consumer surfaces never look like a terminal            |

All fonts are SIL OFL 1.1, self-hosted from `apps/console/app/fonts/` (no third-party requests; CSP `font-src 'self'`). Fallback stacks are system sans/mono. The latin subset has no arrow glyphs — use `›`, `·` and SVG, not `→` or `✓`.

Scale (rem): `--t-hero` clamp(2.25–3.75); `--t-money` clamp(2.5–4) for Frame/Outcome amounts; `--t-h1` 1.75; `--t-h2` 1.25; body 1; small 0.875; label 0.75 uppercase, tracking 0.08em.

---

## 4. Geometry

- **Corners**: 0 radius on Frames, panels, buttons and inputs. The only round shape in the system is the unresolved dot.
- **Frame**: `AuthorityFrame` — surface fill, 1px hairline, four 14px, 2px ink crop marks offset −6px at the corners; a Gate notch on the right edge between ~38–62% of the height.
- **Gate**: a 12×30 notch drawn with two vertical ink strokes; glyph forms below.
- **Spacing**: 4px base unit; steps 4/8/12/16/24/32/48; page gutter 16 (mobile) / 32 (desktop); content max-width 880.
- **Borders**: hairlines 1px; emphasis 2px; never shadows for hierarchy (a single focus ring is the only "glow").

### Gate glyphs (34×34, outlines 2.5)

| State      | Shape                                                 | Word                     |
| ---------- | ----------------------------------------------------- | ------------------------ |
| Paid       | filled square                                         | "$84 paid once"          |
| Blocked    | square with a solid horizontal bar through the middle | "$0 moved"               |
| Unresolved | dashed square with amber dot                          | "Checking what happened" |
| Failed     | square with diagonal cross                            | "Didn't go through"      |
| Revoked    | square with a strike line                             | "Revoked"                |
| Expired    | hollow square with hatch                              | "Expired"                |

---

## 5. Motion (CSS only)

| Primitive     | Behaviour                                                                                   | Duration                 |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| **Constrain** | interpreted boundary rows resolve in sequence (opacity + 6px translate) from loose to ruled | 180ms each, 60ms stagger |
| **Seal**      | Frame crop marks travel 10px inward onto the corners when an Authority is created           | 320ms ease-out           |
| **Dispatch**  | the Flow line draws from the Agent node toward the Gate                                     | 400ms linear             |
| **Deny**      | the Flow line stops at the Gate; the bar scales in; Payment node stays dashed               | 220ms                    |
| **Verify**    | only after durable proof exists, the Trace nodes fill left to right                         | 240ms each               |

Never animate success before financial truth exists; the unresolved state is static (no spinner implying progress). **Reduced motion** (`prefers-reduced-motion: reduce`): all of the above are removed; the final shape and words carry the same information.

---

## 6. Product structure

| Destination     | Route                    | Rule                                                                       |
| --------------- | ------------------------ | -------------------------------------------------------------------------- |
| Home            | `/`                      | State-aware headline; at most one Authority and three outcomes; one action |
| New Authority   | `/new/`                  | One decision per step: Describe → Understand → Confirm → Created           |
| Authorities     | `/authorities/` (`?id=`) | Frame first; control last                                                  |
| Activity        | `/activity/` (`?id=`)    | Journal rows lead with the money line                                      |
| About this demo | `/about/`                | The only home for environment explanation                                  |
| Proof           | `?proof=1` on a detail   | Dedicated mode with back link; Plex Mono; never nested                     |

Agent identity appears as a line inside Authority and Activity detail, not as a top-level destination (until a milestone justifies it).

### Components (`apps/console/app/ui/`)

`Brand` (mark + wordmark) · `EnvironmentBadge` · `GateGlyph` · `AuthorityFrame` · `OutcomeHero` · `ActivityRow` · `FlowTrace` · `BoundarySummary` · `AgentIdentity` · `ProofPanel` · `AppShell`/`AppNav`.

New milestones compose these; they do not introduce a second set of tokens.

---

## 7. Language

Canonical in code: `lib/language.ts`. Highlights:

- Mandate → **Authority**; AgentPassport → **Agent**; committed → **Used**; reserved → **Pending**; freshDispatchBlocked → **"Can't start new purchases"**; reconciliation → **"Checking what happened"**; provider conformance → **"Payment verified"**.
- Money line: **`$0 moved`**, **`$84 paid once`**, **`Checking what happened — don't retry yet`**.
- Unknown outcome body: **"We haven't confirmed whether money moved. Don't retry yet."**
- Time: "Friday at 6:00 PM", "2 days remaining", "Updated just now"; UTC only in Proof.
- Never: "Transaction complete!", exclamation marks, emoji, confetti, "UNKNOWN", "Payment denied" as a headline.
- Demo disclosure: one `SANDBOX` badge + `About this demo`.

---

## 8. Mobile

- Top bar: mark + wordmark + `SANDBOX` badge. Bottom tab bar (Home, New, Authorities, Activity), ≥ 56px high including safe-area inset, each target ≥ 44×44.
- The Frame is full-width; the money line is first; controls (Revoke) are last and ≥ 44px.
- Authority front shows purpose, remaining amount, boundaries, ask/no-ask, expiry and revoke without horizontal scroll at 375px.
- Proof stacks key/value rows; long identifiers wrap (`overflow-wrap:anywhere`).

---

## 9. Accessibility

- Visible focus on every control: 3px ink outline, 2px offset, 5px amber ring.
- Skip link; landmarks (`header`, `nav`, `main`); one `h1` per page; `aria-current="page"` on navigation.
- Live regions for async states; `aria-busy` while loading; focus moves to a sheet's heading when it opens.
- Touch targets ≥ 44px; reduced-motion honoured; no state by colour alone; contrast per §2.
- E2E asserts: tab order reaches the primary action, targets ≥ 44px at 375px, no horizontal overflow.

---

## 10. Marketing

The same system extends to README, Devpost, deck and video without new tokens: black plate with paper type and an amber Flow line; Frame crop marks around the quantity; state glyphs as chapter markers. Authority illustrations are constructed from Frames, Gates and Flow lines — never robots, brains, orbs or coin graphics. Any deterministic visual pattern derived from an Authority must carry zero security significance.

---

## 11. Forbidden patterns

purple/cyan AI gradients · glowing orbs · neural-network art · robot mascots · shield or checkmark as the identity · generic SOC/cyber dark dashboards · credit-card, wallet or pass metaphors · glassmorphism · rounded-card stacks · green-because-money · PayPal blue · coral/pink fintech palettes · Linear-style dark clone · colour as the only state signal · celebration of money movement · second token sets or parallel stylesheets · dark mode without a full design.

---

## 12. Extension rules for M6–M10

- **M6** delegated actions: the Flow line starts at the Agent node, stops at the Gate on deny, resolves to solid amber + filled square only after durable capture evidence. "Done without asking you" appears in Explanation.
- **M7** external agents: `AgentIdentity` gains an "External agent" tag; protocol vocabulary lives in Proof.
- **M8** verification: a read-only Proof block; never a money-moving control.
- **M9** Break PayFlow: leads `Money moved: $0`; each attempt is an Activity row with the barred glyph; density increases only inside Proof.
- Enterprise density lives in Proof, not consumer defaults.
