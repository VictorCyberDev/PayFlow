-- M36-M40: additive reconciliation evidence, retention and assurance administration.

CREATE TABLE reconciliation_observations (
  id text PRIMARY KEY,
  queue_id text NOT NULL REFERENCES reconciliation_queue(id),
  rail text NOT NULL,
  provider_reference text,
  effect_state text NOT NULL CHECK (effect_state IN ('SUCCEEDED','FAILED','UNKNOWN')),
  effect_count smallint CHECK (effect_count IN (0,1) OR effect_count IS NULL),
  reason text NOT NULL,
  observed_at timestamptz NOT NULL,
  raw_evidence_hash char(64),
  UNIQUE (queue_id, rail, observed_at, reason)
);
CREATE INDEX reconciliation_observations_queue ON reconciliation_observations (queue_id, observed_at);

CREATE TABLE data_retention_policies (
  organization_id text NOT NULL REFERENCES organizations(id),
  data_class text NOT NULL CHECK (data_class IN ('PUBLIC','OPERATIONAL','PERSONAL','SECRET_REFERENCE','IMMUTABLE_FINANCIAL_EVIDENCE')),
  retention_days integer CHECK (retention_days > 0),
  indefinite boolean NOT NULL DEFAULT false,
  deletable boolean NOT NULL,
  exportable boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, data_class),
  CHECK ((indefinite AND retention_days IS NULL) OR (NOT indefinite AND retention_days IS NOT NULL))
);

CREATE TABLE data_subject_requests (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  subject_pseudonym text NOT NULL,
  request_kind text NOT NULL CHECK (request_kind IN ('EXPORT','DELETE','RECTIFY')),
  status text NOT NULL CHECK (status IN ('RECEIVED','IN_PROGRESS','PARTIAL','COMPLETED','DENIED')),
  immutable_evidence_preserved boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX data_subject_requests_org ON data_subject_requests (organization_id, created_at);

CREATE TABLE security_audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  event_type text NOT NULL,
  correlation_id text NOT NULL,
  agent_id text,
  authority_id text,
  result text NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX security_audit_events_org_time ON security_audit_events (organization_id, occurred_at);
