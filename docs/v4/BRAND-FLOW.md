# PayFlow — the Flow brand

One page, on purpose. A brand you cannot hold in your head is a brand nobody
applies. (The practice is borrowed from Willie; see
`WILLIE-EXPERIENCE-TRANSFER.md` §1.)

Implemented in `apps/console/app/flow.css` and `apps/console/app/ui/flow.tsx`.
Asserted in `apps/console/tests/boundary.test.mjs`.

---

## The idea

**PayFlow is one moving line.** It runs level while PayFlow works, rises
through the hard part, and settles on a filled point when something is
genuinely finished. When a decision belongs to the founder, **the line stops
and changes colour.** That is the whole system: progress you can see, and a
full stop you cannot miss.

Primary action: **Make it happen.**
Closing line: _PayFlow asks before taking actions that matter._

## Relationship to BRAND-001

`docs/BRAND-001-payflow-experience-and-visual-system.md` (the ink-and-paper
system) is **preserved as history and superseded for the consumer surfaces**,
as the V4 mandate §5.1 directs. It still governs `/app/`, `/developer/`,
`/enterprise/`, `/verify/`, `/proof/` and the marketing pages through
`globals.css` and `company.css`, and its assertions in `boundary.test.mjs`
remain in force for those files. The Flow system governs `/`, `/try/` and
`/partner/`. The split is a migration boundary, not an accident, and it is the
first thing to close when the console surfaces are rebuilt.

## Colour

| Token                  | Value     | Role                                                               |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| `--blue` Flow Blue     | `#2457FF` | The line, primary actions, links                                   |
| `--ink` Deep Ink       | `#111A32` | Text, dark background                                              |
| `--ivory` Soft Ivory   | `#FAF8F2` | Light background                                                   |
| `--coral` Signal Coral | `#FF7049` | **Graphics only** — card edges, decorative rules                   |
| `--alert`              | `#C43C17` | Anything that must be _read_ as attention: chips, the stopped line |
| `--lime` Energy Lime   | `#D5F779` | Accent on dark only                                                |

Measured, not assumed (WCAG 2.1 relative luminance, computed from these hex
values):

| Pair                | Ratio     | Verdict                                                             |
| ------------------- | --------- | ------------------------------------------------------------------- |
| Ink on Ivory        | **16.24** | AAA                                                                 |
| `--text-2` on Ivory | **7.55**  | AAA                                                                 |
| `--text-3` on Ivory | **5.09**  | AA                                                                  |
| Blue on Ivory       | **5.09**  | AA                                                                  |
| White on Blue       | **5.41**  | AA                                                                  |
| `--alert` on Ivory  | **4.94**  | AA                                                                  |
| Lime on Ink         | **14.30** | AAA                                                                 |
| **Coral on Ivory**  | **2.58**  | **Fails. Graphics only, never text, never a sole state indicator.** |

Dark theme (`prefers-color-scheme: dark`): text 16.82, accent 7.12, alert 8.66
— all AA or better.

The coral result is why the mandate's palette could not be used as given. It
was proposed as a hypothesis (§5.2) and tested; it survives as a graphic
colour and is replaced by `--alert` wherever meaning depends on it. The Flow
object's _deciding_ state uses `--alert` for exactly this reason — a founder
must never miss a stop because their screen, their eyes or their lighting
washed out a 2.58:1 line.

## Type

Self-hosted, already in the repository, so the CSP stays `'self'` and nothing
new is downloaded:

- **Bricolage Grotesque** — display. Headlines only.
- **Instrument Sans** — everything a founder reads.
- **IBM Plex Mono** — only identifiers, amounts in a ledger, and state labels.
  Mono is a signal that something is a value, not prose.

## The mark

One stroke that enters level, rises, and ends on a filled dot, drawn inline in
`FlowGlyph`. No raster, no request, legible at 16px, and it inherits
`currentColor` so it works on every background the system defines.

## Motion

| Name   | Duration | Used for                                              |
| ------ | -------- | ----------------------------------------------------- |
| settle | 220ms    | Hover, focus, a control responding                    |
| move   | 320ms    | A colour or weight change that signals a state change |
| arrive | 460ms    | The line completing                                   |

Easing is `cubic-bezier(0.2, 0.7, 0.3, 1)` throughout.

**The rule that outranks all of them:** every state is legible from its static
form and its text label alone. `prefers-reduced-motion: reduce` removes every
animation and transition, and a reader who never sees one loses no
information. The state also reaches assistive technology as words, through
`aria-label="PayFlow: <state>"`, which a test asserts for all eleven states.

## The eleven states

Ready · Listening · Working out a plan · Searching · Comparing options ·
Negotiating · **Waiting for your decision** · Carrying out what you approved ·
Confirmed · Paused · **Not able to confirm this yet**

The two in bold are the ones the product exists for. They are visually
distinct from every other state and from each other: _deciding_ stops the line
and turns it red; _unverified_ breaks the line into dashes and greys it,
because a broken line is what an unknown truth looks like.

**No surface may set a state the application is not actually in.** There is no
"look busy" animation anywhere in the system.
