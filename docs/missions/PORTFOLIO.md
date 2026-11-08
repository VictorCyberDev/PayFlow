# Multi-vendor portfolio (M45)

When a mission buys from several suppliers, `GET …/missions/{id}/portfolio` answers the questions one quote cannot. It is computed when
asked from the ledger, orders, disputes, obligations and receipts, stored nowhere, and decides and moves nothing.

- **Spend by supplier.** `spentMinor` (paid and not refunded), `pendingMinor` (approved, committed, reserved, in flight or unknown),
  `refundedMinor`. Shares are **integer basis points**, rounded down, computed with BigInt (no float loss).
- **Concentration.** A supplier is listed when its share is strictly above `maxShareBps` (default 5000, set with `?maxShareBps=1..10000`;
  anything else is refused with 400). With a single supplier there is nothing to compare, so there is no warning.
- **Flags per supplier.** `OPEN_DISPUTES`, `OVERDUE_OBLIGATIONS` (due before today), `DELIVERY_ISSUES` (computed fulfillment outcome
  `HAS_ISSUES`), `UNKNOWN_PAYMENT_OUTCOME`.
- **Close-out.** `ready` only when nothing blocks: no open disputes, no overdue obligations, no unknown or pending payment, and every order
  delivered or cancelled. Otherwise each blocker is named as `<supplierId>:<CODE>`.

Agents need READ on the mission. The view is the same for them.
