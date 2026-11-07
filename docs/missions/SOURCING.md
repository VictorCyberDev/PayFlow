# Sourcing optimization (V3 M35)

Given a demand (for example 10 × SKU `KB`) and the quotes on file, a **sourcing run** recommends which quotes to rely on to cover it at the least landed cost.

> A run is a recommendation. It is optimal **only for the quotes recorded in this mission and the constraints you gave**. It says nothing about quotes nobody has obtained, it is not an approval, and it commits nothing.

## What it chooses from

Only quotes that are genuinely usable: **current** (not expired, not superseded), **complete** (no unknown part), in the **mission's currency**, from a supplier who is **qualified** (M33; a supplier with a failure or barred by the contract is always out, and "not yet qualified" is out unless you pass `requireQualified: false`). Each quote left out says why. Quotes are used **whole, as stated**: a different quantity could change shipping, tax or price in ways the supplier never stated, so a plan is a set of whole quotes.

## Constraints

- **Coverage**: every demanded SKU is covered (matched on the quote line's `sku` exactly; no guessing).
- **Budget**: the plan's total fits what the ledger still has available (if that cannot be known, the result says the budget was not enforced).
- **Largest commitment**: each quote's total is within the contract's single-commitment ceiling.
- **Surplus**: units beyond the demand are limited (`maxSurplusUnits`, default 0). Quotes with items nobody asked for are out unless `allowExtras` (their units then count as surplus).
- Plans that include a quote above the contract's human-approval threshold are flagged.

## How it searches

Exhaustively over the eligible quotes (at most 20; beyond that the run is refused and you narrow with `quoteIds`), so "optimal" is a proof and not a heuristic. Order: lowest total, then fewer surplus units, then fewer suppliers, then quote ids. The best plan and up to two alternatives are returned. When nothing fits, the reasons are exact: `COVERAGE:KB needs 11, eligible quotes offer 10`, `BUDGET_SHORTFALL:5000` (with the cheapest plan's cost), or the surplus limit.

## Recording and adopting

Every run is stored immutably with its demand, constraints, a snapshot of the quotes considered and the result, so a decision can be reproduced and audited (same data gives the same answer and the same inputs digest). **Adopting** a run is a person's act: it puts the chosen quotes in the budget as `QUOTED` items (M34; idempotent, holding no budget until a person approves them in the ledger). If a chosen quote has since expired or been superseded, adoption stops and records nothing as adopted; run again.

## Status

COMPLETE_LOCAL. Migration 038 pending on the public database. 10 tests: the optimizer is checked against an independent brute-force oracle on 1,000 random instances (600 general, 400 tie-heavy); 18 mutation checks each fail a test (one survivor, ties at the third-best plan being pruned, was closed by the tie-heavy test).
