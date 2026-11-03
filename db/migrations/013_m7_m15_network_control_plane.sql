-- M7-M15: additive organization, external-agent, replay, webhook and metering state.
-- Historical migrations and accepted financial ledgers remain immutable.

CREATE TABLE organizations (
  id text PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  organization_id text NOT NULL REFERENCES organizations(id),
  principal_id text NOT NULL REFERENCES principals(id),
  role text NOT NULL CHECK (role IN ('ORG_OWNER','FINANCE_OWNER','SECURITY_OWNER','AUTHORITY_ADMIN','AGENT_ADMIN','AUDITOR','VIEWER')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, principal_id, role)
);
CREATE INDEX organization_memberships_principal ON organization_memberships (principal_id, organization_id);

CREATE TABLE organization_agents (
  organization_id text NOT NULL REFERENCES organizations(id),
  agent_id text NOT NULL REFERENCES agent_passports(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  sponsor_principal_id text NOT NULL REFERENCES principals(id),
  lifecycle text NOT NULL DEFAULT 'REGISTERED' CHECK (lifecycle IN ('REGISTERED','ACTIVE','SUSPENDED','REVOKED','RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, agent_id, environment)
);

CREATE TABLE authority_ownership (
  mandate_id text PRIMARY KEY REFERENCES mandates(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  owner_principal_id text NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authority_ownership_org ON authority_ownership (organization_id, environment, mandate_id);

CREATE TABLE organization_authority_templates (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  template_kind text NOT NULL,
  document jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment, id, version)
);

CREATE TABLE external_agent_clients (
  client_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  agent_id text NOT NULL REFERENCES agent_passports(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  token_subject text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_agent_client_scopes (
  client_id text NOT NULL REFERENCES external_agent_clients(client_id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('authority:read','action:request','verify:read','proof:read','reconcile:request')),
  PRIMARY KEY (client_id, scope)
);

CREATE TABLE verification_replay_keys (
  scope text NOT NULL,
  replay_key char(64) NOT NULL CHECK (replay_key ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, replay_key)
);
CREATE INDEX verification_replay_expiry ON verification_replay_keys (expires_at);

CREATE TABLE webhook_subscriptions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://'),
  event_types jsonb NOT NULL,
  secret_reference text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  meter text NOT NULL CHECK (meter IN ('GOVERNED_ACTION','VERIFY_CALL','ACTIVE_AGENT','ENTERPRISE_CONTROL')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX usage_events_org_time ON usage_events (organization_id, occurred_at);

CREATE TABLE reconciliation_queue (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  payment_attempt_id text NOT NULL UNIQUE REFERENCES payment_attempts(id),
  state text NOT NULL CHECK (state IN ('PENDING','INVESTIGATING','RESOLVED','ABANDONED')),
  next_check_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_queue_due ON reconciliation_queue (state, next_check_at);
