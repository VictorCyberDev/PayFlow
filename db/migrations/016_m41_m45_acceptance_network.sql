-- M41-M45: additive embedded Authority and abuse-intelligence records.

CREATE TABLE embedded_authority_sessions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  principal_id text NOT NULL REFERENCES principals(id),
  sponsor_principal_id text REFERENCES principals(id),
  allowed_template_ids jsonb NOT NULL,
  return_url text NOT NULL CHECK (return_url ~ '^https://'),
  status text NOT NULL CHECK (status IN ('OPEN','COMPLETED','CANCELLED','EXPIRED')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_authority_id text REFERENCES mandates(id),
  CHECK (expires_at > issued_at)
);
CREATE INDEX embedded_authority_sessions_org ON embedded_authority_sessions (organization_id, environment, status, expires_at);

CREATE TABLE abuse_signals (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  signal_type text NOT NULL CHECK (signal_type IN ('REPEATED_DENIALS','MERCHANT_SUBSTITUTION','REPLAY_CLUSTER','CREDENTIAL_ANOMALY','DELEGATION_ANOMALY','PROVIDER_ANOMALY')),
  subject_hash char(64) NOT NULL CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at timestamptz NOT NULL
);
CREATE INDEX abuse_signals_subject_time ON abuse_signals (subject_hash, observed_at);
