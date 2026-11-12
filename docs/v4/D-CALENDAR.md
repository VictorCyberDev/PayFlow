# PayFlow's own calendar

**State: built, proved against real PostgreSQL and in a real browser. Not yet deployed.**

The mandate asks for a calendar. There are two ways to give a product one: connect
somebody else's, or own it. PayFlow owns this one, for three reasons.

1. A connected calendar makes the product's usefulness conditional on an account the
   founder may not have, an OAuth consent screen, and a provider's scopes. A judge
   opening PayFlow for the first time has none of those.
2. PayFlow already knows things no external calendar does — which flight offer was
   selected, which plan moves money and when. Writing those into the product's own
   store keeps the evidence attached to the entry.
3. It is the only version that can be demonstrated end to end here, today, without
   asking the owner for credentials.

## What it is

`workspace_events` (migration `068_v4_workspace_calendar.sql`): a table of events
scoped by `organization_id`, with a `source` naming where the entry came from
(`MANUAL`, `FLIGHT`) and a `source_ref` holding the provider's own identifier.

A partial unique index on `(organization_id, source, source_ref)` makes the
provider-sourced writes idempotent: adding the same flight twice adds one entry, so
a double-clicked button or a retried request cannot duplicate an itinerary.

## The access rules, enforced in code

- **No session, no calendar.** `api/calendar.ts` resolves the session first and
  refuses outright when there is none. The browser journey asserts this against a
  signed-out client, not only in a unit test.
- **The organization comes from the session, never from the request.** A caller
  cannot name someone else's workspace, because the request has no field in which to
  name one. Every statement in `WorkspaceCalendar` is scoped by the id the session
  resolved to.
- **Writes carry CSRF.** Same `csrfFor(sessionToken)` scheme as the account door.
- **The body is schema-checked before it reaches SQL.** `NewEventSchema` is strict;
  unknown keys are rejected rather than ignored.

## The flight link

Selecting a Duffel itinerary offers "Add to calendar". The entry is built by
`eventFromFlight()` from the offer PayFlow actually read — carrier, route, departure
and arrival as the provider stated them — and stamped `source: "FLIGHT"` with the
offer id as `source_ref`. The calendar therefore shows what the provider said, not
what the model proposed, and the entry can be traced back to the offer it came from.

A calendar entry is not a booking and does not claim to be one. Booking rules are in
`src/partner/flights.ts`; adding an itinerary to the calendar performs no order.

## Evidence

- `tests/calendar.integration.test.ts` — 9 tests against real PostgreSQL: the
  signed-out refusal, cross-organization isolation, CSRF rejection, idempotent
  flight writes, and removal.
- Browser journey against a real server and real database: signed out refuses; an
  event added appears; it survives a reload; axe reports zero violations at 1180px
  and 320px; no horizontal overflow at either width; removal works; no console
  errors.
- Gate A (`scripts/a11y-acceptance.mjs`): 50 routes x 6 widths, 300 page checks,
  0 failures, with `/calendar/` among them.
- `scripts/migration-rehearsal.mjs`: 12 checks, 0 failures, including 068.

## What it does not do

It does not sync with Google Calendar, Outlook or anything else, and nothing in the
interface suggests it does. It is PayFlow's calendar, and it says so.

## Production requirement

`/calendar/` needs `DATABASE_URL` on the **payflow** Vercel project's production
target. It is absent there today, so the surface will refuse rather than appear to
work. This is the same blocker recorded for accounts in `docs/v4/D3-ACCOUNTS.md`.
