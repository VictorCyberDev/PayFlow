# What PayFlow takes from Willie, and what it deliberately does not

Source inspected: `VictorCyberDev/willie`, shallow clone, 2026-11-12 —
`docs/BRAND_SYSTEM.md`, `docs/MOTION_SPEC.md`, `REAL_VS_SIMULATED.md`,
`apps/web/src/winner*.{tsx,css}`, `FINAL_REVIEW_PACKET.md`.

The mandate (§3) asks for the design _quality_, not the look. PayFlow must be
its own thing. So this records four practices worth stealing, one thing worth
stealing that is not a design practice at all, and three things to leave alone.

---

## 1. Take: a brand stated in one paragraph, not a deck

Willie's entire brand system is a single short paragraph that a person can hold
in their head: one live thing, a six-segment capsule, three named colours, sans
for human language and mono for protocol labels, one primary action, one
closing line. Every screen can be checked against it in seconds.

**Applied:** `docs/v4/BRAND-FLOW.md` is one page. PayFlow is _one moving line_
— the Flow — that thickens as work progresses and stops dead when a decision
is the founder's. Sans for what a founder reads, mono only for identifiers a
founder might have to quote back. One primary action: **Make it happen**.

## 2. Take: motion with named durations tied to state, not decoration

`MOTION_SPEC.md` gives real numbers (lock 200–300ms, compress 250–400ms,
depart 350–500ms) bound to specific state transitions, plus a rule that
reduced motion falls back to opacity and short positioning, and that
_functional states stay legible without motion at all_.

**Applied:** PayFlow's Flow object has eleven named states (§5.4) and a motion
grammar in `flow.css` with the same discipline: each state is legible from its
static form and its text label alone; motion only makes the transition
readable. `prefers-reduced-motion: reduce` drops every transform and keeps
opacity. A reader who never sees an animation loses nothing.

## 3. Take: the judge gets a route of their own

Willie ships a `winner-judge` entry point and a `DEMO_RUNBOOK.md`, so the
demonstration is a first-class artifact rather than a lucky path through the
real app.

**Applied:** `/try/` is a route, not a mode. It needs no account, no code, no
key, and it resets.

## 4. Take — and this is the most valuable thing in the repository: evidence classes

`REAL_VS_SIMULATED.md` defines a ladder — `LIVE_ACCEPTED`, `CLI_ACCEPTED`,
`CONTRACT_TESTED`, `SIMULATED REPLAY` — with one rule above all:

> A stronger-looking demo must never silently upgrade a weaker class.

This is not a design practice. It is the honesty mechanism that makes an
ambitious demo safe to show, and it maps exactly onto what this mandate
demands in §8 ("clearly label simulated results"), §14.4 ("mark estimates
clearly"), §23.3 (proposed / prepared / approved / submitted /
provider-confirmed / completed / failed / unknown) and §34 ("simulated results
labelled as live" is a rejection condition).

**Applied:** PayFlow adopts a four-class ladder, surfaced in the interface and
not only in a document:

| Class                | Means                                                       | Where it may appear                                                      |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PROVIDER_CONFIRMED` | A real provider returned this, and we kept the reference    | Nowhere yet on the public app — PayPal execution is on the isolated host |
| `PROVIDER_OBSERVED`  | A real provider answered, but the value is not a commitment | Live product discovery; prices and stock stay UNKNOWN                    |
| `MODEL_PROPOSED`     | A language model suggested it; nothing was done             | `/partner/` plans — every one carries `authorization: NONE`              |
| `SIMULATED`          | Fixture data, deterministic, for demonstration              | `/try/` only, labelled on every screen                                   |

The rule travels with it: **nothing may be promoted to a stronger class by the
interface.** The `/partner/` endpoint enforces its own class in code — the plan
type carries a literal `authorization: "NONE"` that a test asserts.

---

## 5. Leave: Willie's look

Graphite `#11110f`, warm bone `#f1eadd`, signal orange-red `#ff5934`, the
capsule with rings — these are Willie's identity and copying them would make
PayFlow a second Willie. PayFlow's palette, mark and motion are built from
scratch in `docs/v4/BRAND-FLOW.md`.

## 6. Leave: sound

Willie specs a sound layer (`docs/SOUND_SPEC.md`). A founder using a money
product at a desk does not want one, and it would be one more thing to make
accessible.

## 7. Leave: the raid/community metaphor

Willie's whole story is continuity across communities. PayFlow's is a founder
getting something finished. The narrative devices do not carry over, and
borrowing them would make the product harder to understand, not easier.
