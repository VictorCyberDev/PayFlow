# Mission Workspace (V3 M30)

A read-only view of missions in the console at `/missions/`. It shows what the member API returns and nothing else.

## What it shows

- **List**: each mission's objective, status, budget, and whether an owner decision is waiting.
- **Detail**: the version in force (never the proposed one), a banner for a pending change and why it needs an owner, the budget (ceiling, committed or spent, still available, outcome unknown, not independently verified, refunded) with the commitments behind it, the active plan's tasks with their readiness and estimates (labelled "not a quote"), the spending authority compiled from the mission and any agent that has none (with the reason), what was asked for, and the history.

## What it does not do

It cannot change anything. Creating, revising, approving, pausing and stopping a mission are done through the API or SDK, where the owner gate applies. This is deliberate for v1: a UI that could approve would be a second approval surface to defend.

## Truthfulness rules

- Every figure comes from the API. A section that fails to load says it is unavailable and shows nothing in its place; the other sections still show.
- Responses are validated before they are shown. One that is not the expected shape is refused as unsafe to display.
- Money uses the contract's own currency and that currency's own number of minor digits. There is no conversion.
- "Not independently verified" is shown, not hidden: an amount an owner reported is not the same as one a provider or Proof confirmed.

## Credentials

The member API key is typed into the page, held in memory for that tab only, sent only as a Bearer header to the address entered (https, or http on localhost), and never put in a URL, local storage or session storage. "Forget the key and close" drops it. A host that serves the console from a different origin than the API must allow that origin in CORS; the hosted gateway does not enable CORS today, so the supported deployment is same-origin (leave the address empty). The acceptance test forwards requests to the real gateway and adds CORS headers itself.

## Acceptance

`tests/m30-mission-workspace.browser.test.ts` drives Chromium against the built console and a real gateway on PostgreSQL: six widths (320, 375, 430, 768, 1024, 1440) with no horizontal overflow, one h1 and no axe violations (WCAG 2.0/2.1/2.2 A and AA); each labelled figure equals the API's; a failed section degrades alone; a wrong key and another organization reveal nothing; a widening proposal is shown as waiting and not in force. A mutation that displays the wrong ledger field turns it red. It runs in the browser CI job (it skips locally unless the console is built and a database is configured, and fails instead of skipping when `REQUIRE_BROWSER=1`).

## Status

The read-only workspace is COMPLETE_LOCAL. Against the ADR-018 scope (create, review, approve, control) the milestone is PARTIAL: those actions are API/SDK only. Not deployed. Not yet tested with a screen reader or on a physical phone; the checks above are automated.
