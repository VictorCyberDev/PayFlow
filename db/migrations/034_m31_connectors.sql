-- V3 M31: connector framework. Additive only.
--
-- A CONNECTOR is a governed, read-only way for a mission's agent to observe the outside world (search, read, compare, status,
-- verify). What exists is defined in code (src/missions/connectors.ts); this schema holds only what an organization has done with
-- them: installed/enabled/suspended, and an append-only log of every call. Secrets are never stored here: an install may carry a
-- credential REFERENCE, never a credential. Connectors can never move money, send messages or sign: those capabilities are not
-- invocable through this framework at all.
CREATE TABLE connector_installs (
  organization_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  connector_id text NOT NULL CHECK (connector_id ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  state text NOT NULL CHECK (state IN ('ENABLED','DISABLED','SUSPENDED')),
  -- a reference (name) to a secret held elsewhere. Never the secret itself.
  credential_ref text CHECK (credential_ref IS NULL OR credential_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  installed_by text NOT NULL,
  state_changed_by text NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  breaker_open_until timestamptz,
  row_version integer NOT NULL DEFAULT 1,
  installed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, environment, connector_id)
);
CREATE TABLE connector_calls (
  call_id text PRIMARY KEY CHECK (call_id ~ '^cal_[a-f0-9]{24}$'),
  organization_id text NOT NULL,
  environment text NOT NULL,
  mission_id text NOT NULL REFERENCES missions(mission_id),
  mission_version integer NOT NULL,
  agent_id text NOT NULL,
  connector_id text NOT NULL,
  capability text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('PENDING','OK','ERROR','TIMEOUT','INVALID_OUTPUT','ABANDONED')),
  record_count integer CHECK (record_count IS NULL OR record_count >= 0),
  -- the validated, bounded result (so an idempotent replay returns the same data and does not call out again)
  result jsonb,
  error_code text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (mission_id, agent_id, idempotency_key)
);
CREATE INDEX connector_calls_rate ON connector_calls (mission_id, connector_id, started_at);
CREATE INDEX connector_calls_org ON connector_calls (organization_id, environment, started_at DESC);
-- A call row may be finished exactly once (PENDING -> a final outcome) and never edited or deleted otherwise.
CREATE FUNCTION connector_calls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'connector calls are append-only'; END IF;
  IF OLD.outcome <> 'PENDING' THEN RAISE EXCEPTION 'a finished connector call cannot change'; END IF;
  IF NEW.call_id <> OLD.call_id OR NEW.organization_id <> OLD.organization_id OR NEW.environment <> OLD.environment
     OR NEW.mission_id <> OLD.mission_id OR NEW.mission_version <> OLD.mission_version OR NEW.agent_id <> OLD.agent_id
     OR NEW.connector_id <> OLD.connector_id OR NEW.capability <> OLD.capability OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_digest <> OLD.request_digest OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'only the outcome of a pending connector call may be set';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_calls_guard_trg BEFORE UPDATE OR DELETE ON connector_calls
  FOR EACH ROW EXECUTE FUNCTION connector_calls_guard();
