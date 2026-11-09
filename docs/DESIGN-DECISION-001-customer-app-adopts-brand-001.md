# DESIGN-DECISION-001 — the customer app adopts BRAND-001

Date: 2026-11-09 · Status: implemented in `app-ui/` · Evidence: Chromium screenshots reviewed at 1280 and 375 px; axe WCAG A/AA clean at 320–1440 px (`tests/r1-customer-app.browser.test.ts`).

## Problem

The R1 workspace shipped with a second visual system: blue accent, rounded generic cards, system fonts and an automatic dark theme. `BRAND-001` (locked) specifies ink/paper/amber, 0-radius Frames with crop marks, Bricolage Grotesque / Instrument Sans / IBM Plex Mono, state by shape and word, and states that dark mode is out of scope. A customer moving from the site to the app would have met two different companies.

## Decision

No departure from BRAND-001. The app now uses its tokens and rules:

- Tokens: `--paper #f3f0e8`, `--surface`, `--ink`, `--signal` amber (never as text on paper), light only.
- Geometry: 0 radius; the **Frame** (four crop marks) for panels; no nested Frames (the optional AI suggestion is a ruled aside, not a second Frame); no shadows except the focus ring (ink outline + amber halo).
- Type: the three self-hosted OFL fonts, embedded in the server module and served from `/workspace/fonts/` (CSP `font-src 'self'`).
- Mark and wordmark in the header (BRAND-001 master geometry).
- State by **glyph + word** (In force, Waiting for you, Paused, Draft, Revoked…), not colour or capitalised enum names.
- Language: plain dates ("Monday, Nov 23, 5:48 PM"), agents by name, the brand promise on the sign-in screen, "Sandbox" as a badge.
- Narrow screens: tables become labelled blocks so no value splits mid-word.

## What this does not claim

It is one consistent visual system, checked by screenshot review and axe. It is not user-tested; no participants have used it, and no usability result exists. The site (`apps/console`) and the app are still two separate builds sharing tokens by copy, not one component library; unifying them is open work.
