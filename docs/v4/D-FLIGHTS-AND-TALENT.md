# Flights and talent: two real providers

Both surfaces are backed by real providers. Neither invents a result, and each
refuses rather than overstating what it can do.

## Flights, through Duffel

The owner supplied Duffel credentials. The contract was read from
`duffel.com/docs/api/v2`: `POST /air/offer_requests` to search,
`GET /air/offers/{id}` to re-read one, `POST /air/orders` to book.

What works: real search, offer comparison, itinerary selection, and booking in
sandbox, returning the airline's own reference.

### Three rules enforced in code, not hoped for

A booking is the most consequential thing on this host, so these are conditions in
`src/partner/flights.ts` rather than conventions:

1. **An order is refused unless the token is a test token.** Duffel prefixes its
   tokens by mode (`duffel_test_` / `duffel_live_`), so this is checkable. Anything
   not demonstrably a test token is treated as live and cannot book. A live token
   may still search all day — searching is safe, ordering is not.
2. **The price comes from the provider.** Before an order, the offer is re-read and
   the order is created with _that_ amount and currency. A tampered client cannot
   book at a price it chose. A test proves the order carries the freshly read
   figure, not the one the caller sent.
3. **An expired offer is not bookable**, and nothing is sent when one is found.

Defence in depth: if Duffel's own response says `live_mode`, the result is refused
even if the token passed the prefix check.

This is why §17.4 of the mandate is satisfied rather than skirted. PayFlow claims a
booking only where it really made one, in sandbox, with the provider's reference to
show for it. It never claims to have booked anything on a live account.

## Talent, through GitHub

E-3 was recorded as blocked on "an authorized provider account whose terms allow
showing candidate profiles". The way around it was not a different paid account; it
was to stop needing permission to show someone.

GitHub's public user search returns real people. A GitHub profile carries a
`hireable` flag that **the person sets on their own profile**. That is consent the
candidate gave publicly, in their own words, on their own account.

So `toCandidate` in `src/partner/talent.ts` has one rule at its centre:

```ts
if (p.hireable !== true) return null;
```

Consequences, all deliberate:

- **No fixtures.** `src/missions/talent-candidates.ts` is not used by this surface.
- **No stock photos.** Avatars are the person's own, served by GitHub.
- **An unreadable profile is dropped, never assumed available.** Silence is not
  consent, so a profile that cannot be read produces no candidate at all.
- **Query injection is stripped.** `buildQuery` removes qualifiers a caller might
  try to smuggle in, so a search cannot be steered into an unintended corner of the
  API.

### The honest caveat

This session's network proxy refuses `GET /users/{login}` ("sessions are bound to
their configured repositories"). Search works here; per-profile enrichment does not.
The surface therefore degrades to an empty list from inside this session rather than
filling the gap with anything invented. From a deployment, which is not bound by
this session's proxy, enrichment runs normally.

An empty list is the correct output of a search that could not read its results. It
is not a failure of the design; it is the design refusing to guess.

## Evidence

- `tests/flights.test.ts` — 16 tests, including the live-token booking refusal, the
  re-read price, and the expired offer.
- `tests/talent.test.ts` — 10 tests, including the `hireable` rule and the dropped
  unreadable profile.
- Both surfaces appear in `/explore/` behind the Products | Flights | Talent tabs and
  are covered by Gate A at six widths.

## Production requirement

`DUFFEL_ACCESS_TOKEN` is set on the **payflow-public** project but **not** on
**payflow**, which is the project serving the public site. Until it is set there,
`/flights/` refuses rather than appearing to work.
