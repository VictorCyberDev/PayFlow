-- M17: how an external identity provider's subject becomes a PayFlow tenant identity. Additive only.
--
-- PayFlow is only a RESOURCE SERVER for OAuth. The identity provider authenticates the human or client; this table is the
-- ONLY thing that says which tenant, environment and agent a (issuer, subject) pair acts as, and which gateway scopes it may
-- ever hold. Tenant, agent, principal and scopes are never read from token claims.
CREATE TABLE oauth_identity_mappings (
  mapping_id text PRIMARY KEY CHECK (mapping_id ~ '^oim_[a-f0-9]{24}$'),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 8 AND 300),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  agent_id text NOT NULL,
  max_scopes text[] NOT NULL CHECK (cardinality(max_scopes) BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (organization_id, environment, agent_id)
    REFERENCES organization_agents (organization_id, environment, agent_id)
);
-- One ACTIVE mapping per identity: a subject cannot silently act as two tenants.
CREATE UNIQUE INDEX oauth_identity_active ON oauth_identity_mappings (issuer, subject) WHERE status = 'ACTIVE';
