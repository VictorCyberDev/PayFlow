# Reconciliation Operations Center

UNKNOWN is financial truth, not a dashboard inconvenience. The operations center may inspect the existing provider/rail attempt, append evidence and resolve to success or failure only when evidence supports a single terminal effect.

## Rules

- Investigation calls rail/provider **lookup**, never a fresh execute path.
- A provider timeout after possible effect remains UNKNOWN until observation resolves it.
- A success requires evidence compatible with exactly one effect.
- A failure requires evidence compatible with zero effects.
- Ambiguous or conflicting evidence remains unresolved and can be escalated to a human investigator.
- Human notes are evidence context; they do not create provider truth.
- Concurrent investigators use compare-and-set semantics so one case history cannot be silently overwritten.

## Operational queue

The durable `reconciliation_queue` tracks work ownership and due checks. `reconciliation_observations` is append-oriented provider/rail evidence. Existing provider-specific reconciliation logic remains authoritative for its rail; the network layer normalizes the operational contract rather than rewriting historical payment semantics.
