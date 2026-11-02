-- M7: revocable, scoped, tenant/environment-bound developer-preview credentials.
-- Only a SHA-256 digest of a 256-bit random secret is stored; the secret is shown once at issue.
CREATE TABLE agent_credentials (
  credential_id text PRIMARY KEY CHECK (credential_id ~ '^pfc_[a-f0-9]{24}$'),
  secret_hash char(64) NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  agent_id text NOT NULL REFERENCES agent_passports(id),
  principal_id text NOT NULL REFERENCES principals(id),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 128),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 5
    AND scopes <@ ARRAY['authority:read','action:request','verify:read','proof:read','reconcile:request']::text[]),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 128),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE INDEX agent_credentials_org ON agent_credentials (organization_id, environment, agent_id);
