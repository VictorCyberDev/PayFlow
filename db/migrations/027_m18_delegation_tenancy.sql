-- M18: tenant-facing delegation. Additive only.
--
-- A delegation chain is rooted in ONE stored Authority of ONE organization and environment. Every hop inherits that
-- binding, so a delegation can never be used for another Authority or tenant. Rows created before this migration (the local
-- engine, tests) have NULL here and are refused by every tenant API and by the hosted A2A interface.
ALTER TABLE delegations
  ADD COLUMN organization_id text REFERENCES organizations(id),
  ADD COLUMN environment text CHECK (environment IN ('SANDBOX','PRODUCTION')),
  ADD COLUMN authority_id text REFERENCES mandates(id),
  ADD COLUMN created_by text,
  ADD COLUMN created_by_kind text CHECK (created_by_kind IN ('MEMBER','AGENT')),
  ADD COLUMN idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 16 AND 128),
  ADD COLUMN request_digest char(64) CHECK (request_digest IS NULL OR request_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT delegations_tenant_all_or_none CHECK (
    (organization_id IS NULL) = (environment IS NULL) AND (organization_id IS NULL) = (authority_id IS NULL)
  );
CREATE UNIQUE INDEX delegations_idempotency ON delegations (organization_id, environment, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX delegations_authority ON delegations (organization_id, environment, authority_id);
