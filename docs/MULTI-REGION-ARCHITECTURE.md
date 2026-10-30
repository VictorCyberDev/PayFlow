# Multi-region active/active architecture

Status: **COMPLETE_LOCAL** architecture/simulation; real multi-region infrastructure is not provisioned or claimed.

Region is an operational property, not a source of financial Authority. IDs are deterministic from stable namespace/material. Authority replica conflicts prefer higher versions and, on equal version, the more restrictive lifecycle state so revocation/suspension cannot lose to availability. Reservation ownership is single-region per epoch and may transfer only after lease expiry with a strictly higher epoch.

Key material remains region-scoped through secret-management references; private keys are never replicated through the public directory. Reconciliation ownership follows the durable attempt/reservation owner so failover cannot race a fresh execution.

Real active/active deployment requires tested database replication semantics, key custody, regional incident procedures, latency measurement, failover drills and jurisdiction-specific data controls. None of those infrastructure expenditures are made by this milestone.
