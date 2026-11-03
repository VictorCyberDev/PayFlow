-- M13/M14 closure. Additive only. Accepted financial ledgers are not touched.

-- ---------------------------------------------------------------------------------------------
-- M13: authenticated organization members with roles. Only a SHA-256 digest of the member token
-- is stored. A member is bound to ONE organization and ONE environment.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE organization_members (
  member_id text PRIMARY KEY CHECK (member_id ~ '^pfm_[a-f0-9]{24}$'),
  secret_hash char(64) NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role text NOT NULL CHECK (role IN ('OWNER','FINANCE_ADMIN','SECURITY_ADMIN','DEVELOPER','APPROVER','AUDITOR','VIEWER')),
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE INDEX organization_members_org ON organization_members (organization_id, environment);

-- Member actions are audited under their own actor kind.
ALTER TABLE organization_audit_events DROP CONSTRAINT organization_audit_events_actor_kind_check;
ALTER TABLE organization_audit_events ADD CONSTRAINT organization_audit_events_actor_kind_check
  CHECK (actor_kind IN ('ADMIN','AGENT_CREDENTIAL','SYSTEM','OPERATOR','MEMBER'));

-- ---------------------------------------------------------------------------------------------
-- M14: UNKNOWN reconciliation queue. Observation only. This table never causes a provider
-- create/capture; it records what a read-only provider lookup reported, when to look again,
-- and how old an unresolved outcome is.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE reconciliation_lookups (
  attempt_id text PRIMARY KEY REFERENCES payment_attempts(id),
  organization_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  provider text NOT NULL,
  provider_ref text,
  state text NOT NULL CHECK (state IN
    ('LOOKUP_PENDING','PROVIDER_QUERY','PROVIDER_CAPTURED','PROVIDER_FAILED','STILL_UNKNOWN','NO_PROVIDER_REF')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  consecutive_errors integer NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  lookups_total integer NOT NULL DEFAULT 0 CHECK (lookups_total >= 0),
  lookup_errors_total integer NOT NULL DEFAULT 0 CHECK (lookup_errors_total >= 0),
  next_lookup_at timestamptz NOT NULL,
  last_lookup_at timestamptz,
  last_result text,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 200),
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CHECK ((resolved_at IS NOT NULL) = (state IN ('PROVIDER_CAPTURED','PROVIDER_FAILED')))
);
CREATE INDEX reconciliation_lookups_due ON reconciliation_lookups (next_lookup_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- M14: persisted operational alerts. P0 economic/integrity, P1 operational, P2 degraded.
-- One OPEN alert per dedupe key; repeats increment occurrences.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE operational_alerts (
  alert_id text PRIMARY KEY CHECK (alert_id ~ '^alr_[a-f0-9]{24}$'),
  severity text NOT NULL CHECK (severity IN ('P0','P1','P2')),
  code text NOT NULL CHECK (code ~ '^[A-Z_]{3,64}$'),
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  organization_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  acknowledged_by text,
  resolved_at timestamptz,
  delivered_at timestamptz
);
CREATE UNIQUE INDEX operational_alerts_one_open ON operational_alerts (dedupe_key) WHERE state <> 'RESOLVED';
CREATE INDEX operational_alerts_state ON operational_alerts (state, severity, last_seen_at);

-- ---------------------------------------------------------------------------------------------
-- M14: proof-signing key registry. PUBLIC keys only. A private key never enters the database.
-- RETIRED keys still verify historical Proof. REVOKED keys are withdrawn (compromise).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE proof_signing_keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  issuer text NOT NULL,
  public_jwk jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','RETIRED','REVOKED')),
  created_at timestamptz NOT NULL,
  activated_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  CHECK (NOT (public_jwk ? 'd'))
);
CREATE UNIQUE INDEX proof_signing_keys_one_active ON proof_signing_keys (issuer) WHERE status = 'ACTIVE';
