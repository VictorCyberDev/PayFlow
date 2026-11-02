-- M31-M35: additive enterprise delegation, approvals, lifecycle and connector state.

CREATE TABLE agent_delegations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  authority_id text NOT NULL REFERENCES mandates(id),
  parent_agent_id text NOT NULL REFERENCES agent_passports(id),
  child_agent_id text NOT NULL REFERENCES agent_passports(id),
  parent_delegation_id text REFERENCES agent_delegations(id),
  scope jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('ACTIVE','REVOKED','EXPIRED')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (parent_agent_id <> child_agent_id),
  CHECK (expires_at > issued_at)
);
CREATE INDEX agent_delegations_child ON agent_delegations (organization_id, environment, child_agent_id, state);
CREATE INDEX agent_delegations_parent ON agent_delegations (parent_delegation_id);

CREATE TABLE enterprise_approval_requests (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  authority_id text NOT NULL REFERENCES mandates(id),
  requester_principal_id text NOT NULL REFERENCES principals(id),
  action_digest char(64) NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('PENDING','APPROVED','DENIED','EXPIRED','CANCELLED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE enterprise_approval_evidence (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES enterprise_approval_requests(id),
  approver_principal_id text NOT NULL REFERENCES principals(id),
  approver_role text NOT NULL CHECK (approver_role IN ('FINANCE_OWNER','SECURITY_OWNER','ORG_OWNER')),
  action_digest char(64) NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  authentication_evidence_hash char(64) NOT NULL CHECK (authentication_evidence_hash ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz NOT NULL,
  UNIQUE (request_id, approver_principal_id)
);

CREATE TABLE agent_lifecycle_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  agent_id text NOT NULL REFERENCES agent_passports(id),
  from_state text,
  to_state text NOT NULL CHECK (to_state IN ('REGISTERED','ACTIVE','SUSPENDED','REVOKED','RETIRED')),
  sponsor_principal_id text NOT NULL REFERENCES principals(id),
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX agent_lifecycle_history ON agent_lifecycle_events (organization_id, agent_id, sequence);

CREATE TABLE enterprise_integrations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  connector_kind text NOT NULL,
  external_tenant_reference text NOT NULL,
  secret_reference text,
  status text NOT NULL CHECK (status IN ('ACTIVE','PAUSED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, connector_kind, external_tenant_reference)
);

CREATE TABLE enterprise_integration_events (
  id text PRIMARY KEY,
  integration_id text NOT NULL REFERENCES enterprise_integrations(id),
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  source_reference text NOT NULL,
  action_id text,
  proof_reference text,
  state text NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (integration_id, direction, source_reference, state)
);
