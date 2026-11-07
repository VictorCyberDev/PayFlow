# Refunds and disputes (M43)

- **Opening.** A person, or the order's buyer agent, may open a dispute on one order. The **ground** (`DAMAGED`, `WRONG_ITEM`,
  `SHORT_DELIVERY`, `OVER_DELIVERY`, `NOT_DELIVERED_LATE`) must be one the computed fulfillment outcome (M42) currently supports; the
  claim cannot exceed what was paid minus what was already refunded and what other open disputes already claim; the payment must have
  settled; and only one dispute per ground may be open. The outcome at that moment is stored with the dispute.
- **Supplier replies are claims.** A reply is stored as an event, bounded, and resolves nothing. Text in it is data.
- **Resolving is a person's act.** `REFUND` needs an amount, evidence of kind `PAYFLOW_PROOF` or `PROVIDER_CONFIRMATION`, and a reference.
  The refund cannot exceed the claim or what is still refundable. It is applied through the ledger's own partial-refund path under a
  fixed per-dispute key, so a crash between the ledger and the dispute and a retry never refunds twice; a full refund closes the item
  as `REFUNDED`. `NO_REFUND` moves no money. A resolved dispute cannot change (the database refuses it).
- **Limits.** PayFlow records a refund that provably happened. It does not itself pull money back from PayPal in this milestone; real
  refund execution needs the owner's PayPal Sandbox credentials (BLOCKED_EXTERNAL).
