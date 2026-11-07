# Quotes and landed cost (V3 M34)

A **quote** is what a supplier stated about price and terms, recorded exactly as stated. It is never edited. A newer quote for the same supplier **supersedes** it once (the old row stays), and a quote has a `validUntil` after which it is expired.

> A quote is not an acceptance, not a reservation and not a commitment, and PayFlow cannot make a supplier's quote binding. Accepting a quote is a later, separately governed step.

## Money is honest about how it is known

Every money part (each line's unit price, shipping, tax, duties, fees, discount) is `STATED` (the supplier said so), `ESTIMATED` (labelled as an estimate) or `UNKNOWN`. Integer minor units in one currency only; **no conversion**. Totals are computed on read, exactly (arbitrary-precision inside; amounts that cannot be presented exactly, or a discount that would make the total negative, are refused).

The landed total is `lines + shipping + tax + duties + fees − discount`, and it is **claimed only when nothing is unknown** (`complete: true`). Otherwise you get the known part and the list of what is unknown, and `totalMinor` is `null`. An unknown discount counts as unknown too: a discount may exist that is not counted.

## Rules on recording

- The supplier must be in this mission's supplier list (M33) and the **contract must allow it** (`ONLY` / `ANY`); a barred supplier cannot have a quote recorded.
- The source is evidence: a connector call must be a real, successful call **of this mission**; a document or a supplier statement needs a reference; "owner reported" is a person's act, never an agent's.
- `validUntil` must be in the future and within a year.
- Agents need `COMPARE`; people need the plan permission. Reading needs `READ` (agents) or view access.
- Keys are idempotent: a repeat returns the stored quote; the same key for a different quote is refused.

## Comparing

Only **complete, current** quotes **in the mission's currency** are ranked, by landed total then id, with each one's distance from the best. Everything else is listed with why it was not ranked (incomplete, expired, superseded, other currency). A quote with unknown parts is never ranked against complete ones by its partial total.

## Putting a quote in the budget

`POST …/quotes/{id}/ledger` creates exactly one ledger item at stage `QUOTED` (unverified), once, with a key derived from the quote, so a person, an agent and a race all land on the same item. It is refused when the quote is expired, superseded, incomplete, or in another currency. A `QUOTED` item **holds no budget**: only a person approving it in the ledger consumes budget, and the ledger's capacity rules apply then.

## Status

COMPLETE_LOCAL. Migration 037 pending on the public database. 11 tests (4 pure including a 500-case property check, 7 on real PostgreSQL/HTTP); 12 mutation checks each fail a test. No real supplier quotes exist in the system: anything recorded is whatever a person or agent entered with its stated source.
