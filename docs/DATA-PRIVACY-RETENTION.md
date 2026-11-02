# Data privacy, retention and residency architecture

This is an implementation architecture, **not** a legal or jurisdictional certification.

## Classification

PayFlow classifies data as PUBLIC, OPERATIONAL, PERSONAL, SECRET_REFERENCE or IMMUTABLE_FINANCIAL_EVIDENCE. Raw provider secrets and private signing keys are not evidence and should not be persisted in general application records.

## Retention and deletion

Organization-specific retention policies may shorten ordinary operational/personal retention where lawful. Immutable financial evidence is treated separately: deletion requests must not silently destroy the historical truth needed to explain authorization, provider effect, reconciliation or Proof. A request can therefore be partially fulfilled while preserving the minimum immutable evidence justified by the applicable policy.

## Minimization

Verification responses disclose the minimum required verdict/context. External protocol payloads are normalized before storage. Secret references point to a secret-management system; the raw secret does not belong in audit events, Proof or logs.

## Regional abstraction

Region is deployment metadata, never part of Authority semantics. A later multi-region deployment must preserve deterministic IDs, revocation consistency, reservation ownership and reconciliation ownership. No multi-region production infrastructure is claimed in this document.

## Export

Export workflows should include user/organization-owned configuration and permitted evidence in machine-readable form while excluding secret material and unrelated tenants.
