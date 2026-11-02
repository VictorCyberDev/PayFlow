-- M13/M14: append-only audit trail, request rate-limit windows, operator execution controls.
-- Additive only. Accepted financial ledgers are not touched.

CREATE TABLE organization_audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('ADMIN','AGENT_CREDENTIAL','SYSTEM','OPERATOR')),
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action ~ '^[A-Z_]{3,64}$'),
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX organization_audit_events_org_time ON organization_audit_events (organization_id, environment, sequence);

CREATE FUNCTION organization_audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'organization_audit_events is append-only';
END;
$$;
CREATE TRIGGER organization_audit_events_no_update BEFORE UPDATE OR DELETE ON organization_audit_events
  FOR EACH ROW EXECUTE FUNCTION organization_audit_events_immutable();
CREATE TRIGGER organization_audit_events_no_truncate BEFORE TRUNCATE ON organization_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION organization_audit_events_immutable();

CREATE TABLE rate_limit_windows (
  bucket text NOT NULL,
  key_hash char(64) NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (bucket, key_hash, window_start)
);
CREATE INDEX rate_limit_windows_start ON rate_limit_windows (window_start);

-- Operator-set pauses. There is deliberately no public endpoint that writes this table.
-- scope: GLOBAL | ENV:<SANDBOX|PRODUCTION> | ORG:<organization id>
CREATE TABLE execution_controls (
  scope text PRIMARY KEY CHECK (scope ~ '^(GLOBAL|ENV:(SANDBOX|PRODUCTION)|ORG:.{1,128})$'),
  disabled boolean NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT now()
);
