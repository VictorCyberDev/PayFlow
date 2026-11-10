# Internal heuristic review of the customer app (builder's walk-through, NOT a usability study)

Reviewer: the builder, who knows the product and is not a representative user. Method: Nielsen's ten heuristics applied to the screens as built, using the screenshots and browser tests from this work. Date: 2026-11-10. It finds things to fix. It does not show that anyone can use the product.

## Findings that were fixed because of this kind of review

- Action buttons gave no confirmation: the success message was erased by the page redraw (heuristic 1, visibility of system status). Fixed; every record action now says "Recorded." and the quote screen says nothing was paid.
- A booking confirmed only on the owner's word was badged "Confirmed" beside the line "PayFlow has no proof" (heuristic 2, match between system and the real world, and honesty). The badge now reads "Confirmed by you".
- Raw agent identifiers, system date formats and a nested frame were visible (heuristics 2 and 8). Fixed earlier.

## Open findings (not fixed)

1. **Navigation has nine items** (Home, Missions, Templates, Approvals, Needs checking, Agents, Notifications, Settings, Help). It wraps at narrow widths without overflowing, but a first-time user may not know where to start (heuristic 6, recognition rather than recall; heuristic 8). Candidate: group into three.
2. **Records screens use one generic renderer.** Field names are humanised from the data, so some labels are rough ("Max purchase", "At risk now" are fine; others may not be). No wording has been reviewed with a person (heuristic 2).
3. **No undo and no confirmation step** on settling a dispute or accepting a quote. The server refuses unsafe moves, but a mis-click on a legitimate one is final (heuristic 3, user control; heuristic 5, error prevention). Candidate: a review step before the irreversible actions.
4. **Help is a glossary, not contextual.** The state words are explained only on the Help page (heuristic 10). Candidate: a small explanation beside each state badge.
5. **Empty states are plain but not guiding** on several records screens (heuristic 7, flexibility and efficiency; heuristic 10).
6. **Notifications is an in-app list only.** A person is told nothing when something needs them unless they open the app. This is a product gap, not a wording problem.
7. **Accessibility** has been checked only with an automated tool (axe) at six widths. No keyboard-only walk-through, no screen reader test and no check with real assistive-technology users has been done. Automated checks catch a minority of problems.

## What this review cannot tell us

Whether a stranger can sign up and finish a mission; whether the state words mean what they are meant to mean; whether anyone wants this. Those need the plan in `USABILITY-TEST-PLAN.md`.
