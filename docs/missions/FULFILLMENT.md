# Fulfillment (M42)

What actually arrived, and what that supports.

- **Receipts.** A person counts what physically arrived for one line of the purchase order: quantity, condition (`OK`, `DAMAGED`,
  `WRONG_ITEM`), and evidence (owner attestation or a document). Receipts add up and are append-only. They are accepted only once a person
  has verified the order as shipped (M41). Agents have no receipt route.
- **Outcome is computed, never declared.** Per line: `PENDING`, `COMPLETE` (good units equal the ordered quantity), `SHORT`, `DAMAGED`,
  `WRONG_ITEM` (beats damaged), `OVER` (more than ordered arrived). Per order: `PENDING`, `PARTIAL` (some lines still short or pending —
  more may arrive), `COMPLETE`, `HAS_ISSUES`. The result does not depend on the order in which receipts were entered.
- **Dispute grounds** follow from the outcome (`DAMAGED`, `WRONG_ITEM`, `SHORT_DELIVERY`, `OVER_DELIVERY`, and `NOT_DELIVERED_LATE` when
  the verified expected date has passed). M43 offers exactly these and no others.
- **Shipments** (carrier, tracking) reported by the buyer agent or by a supplier are **claims**; a person verifies one with evidence.
