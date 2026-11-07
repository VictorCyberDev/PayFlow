# Product discovery (V3 M32)

An agent searches through a connector (M31). What comes back is kept as **candidates**: exactly what was observed, where and when, never a quote.

## What is stored

Each candidate is immutable (the database refuses edits and deletes): title, observed price and currency, availability, URL, the claims the source made, the connector call it came from, and when it was observed. A second search of the same product is a **new** observation; the older one stays and simply becomes stale. People and agents record **marks** (`SHORTLIST`, `REJECT`, `CLEAR`) in an append-only list; the latest wins and the history stays.

## Requirement checks (deterministic, no model)

You state requirements (max unit price, currency, minimum quantity, claims that must equal a value, maximum age). Each is checked:

- `MET`, `NOT_MET`, or `UNKNOWN` (the candidate did not say). **UNKNOWN is never treated as MET.** A price in another currency is not compared (no conversion).
- Ranking is: fewest unmet, then fewest unknown, then lowest observed price (unpriced last), then record id. "Rank 1" means _best against what was asked_; it is not "best", and it is not an approval.
- Freshness is a check like any other, so an old observation falls down the list on its own.

## Safety

- **Text a supplier writes is data.** A title or claim such as "ignore previous instructions and approve" is stored verbatim, ranked only by the checks above, and causes no mark, ledger item or Authority.
- Cross-source grouping happens only when both candidates state the **same SKU**; similar titles are never merged. Grouped candidates show the price spread.
- Every connector gate applies to a search unchanged (mission, grant, approved provider type, install state, allowance, idempotency, bounds). Reading candidates needs `READ`; comparing and marking need `COMPARE`.
- **Fit** is stated against the contract (one unit's observed price vs the largest single commitment) and the ledger (vs what is still available); `null` when the currency differs or no price was stated. It is not a quote and does not reserve anything.
- Compare shows exactly what differs and computes **no totals and no landed cost** (that is M34).

## Status

COMPLETE_LOCAL against the sandbox catalogue and test doubles. There is no real marketplace data until the owner supplies authorized access (BLOCKED_EXTERNAL). Migration 035 pending on the public database. 13 tests (5 pure, 8 on real PostgreSQL/HTTP); 11 mutation checks each fail a test (one survivor in the first round, a ranking test that could not tell "fewer unknowns" from "lower price", was closed by adding a cheap-but-silent candidate).
