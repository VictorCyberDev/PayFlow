-- V3 M56/M57: durable automation and recurring schedules. Additive only.
--
-- A JOB is work the system does on its own. The hard rule is the product's rule: an outcome we cannot see is UNKNOWN, and UNKNOWN is never
-- retried. A job with effect NONE is safe to run again (it only reads or is idempotent), so a lost worker's job is re-queued. A job with effect
-- EXTERNAL may already have done something outside PayFlow, so a lost worker's job becomes UNKNOWN and only a person settles it.
CREATE TABLE automation_jobs (
  job_id text PRIMARY KEY CHECK (job_id ~ '^job_[a-f0-9]{24}$'),
  organization_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  effect text NOT NULL CHECK (effect IN ('NONE','EXTERNAL')),
  payload jsonb NOT NULL CHECK (pg_column_size(payload) <= 8192),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','UNKNOWN','CANCELLED')),
  run_after timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  lease_owner text,
  lease_expires_at timestamptz,
  last_note text CHECK (last_note IS NULL OR length(last_note) <= 300),
  settled_by text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (organization_id, environment, kind, dedupe_key),
  CHECK (state <> 'RUNNING' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX automation_jobs_due ON automation_jobs (run_after) WHERE state = 'QUEUED';
CREATE INDEX automation_jobs_leases ON automation_jobs (lease_expires_at) WHERE state = 'RUNNING';
CREATE FUNCTION automation_jobs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'automation_jobs is append-only'; END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.organization_id <> OLD.organization_id OR NEW.environment <> OLD.environment
     OR NEW.kind <> OLD.kind OR NEW.effect <> OLD.effect OR NEW.payload <> OLD.payload OR NEW.dedupe_key <> OLD.dedupe_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a job''s identity and payload never change';
  END IF;
  IF OLD.state IN ('SUCCEEDED','FAILED','CANCELLED') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'a finished job cannot change';
  END IF;
  IF OLD.state = 'UNKNOWN' AND NEW.state NOT IN ('UNKNOWN','SUCCEEDED','FAILED') THEN
    RAISE EXCEPTION 'an unknown job is never retried; only a person settles it';
  END IF;
  IF NEW.state = 'QUEUED' AND OLD.state = 'RUNNING' AND OLD.effect = 'EXTERNAL' THEN
    RAISE EXCEPTION 'a job with an external effect is never re-queued after it started';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_jobs_guard BEFORE UPDATE OR DELETE ON automation_jobs FOR EACH ROW EXECUTE FUNCTION automation_jobs_guard();

-- RECURRING SCHEDULES create jobs. Each slot becomes at most one job (the dedupe key is schedule + slot), so a restarted or duplicated
-- ticker cannot run a slot twice.
CREATE TABLE automation_schedules (
  schedule_id text PRIMARY KEY CHECK (schedule_id ~ '^sch_[a-f0-9]{24}$'),
  organization_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  effect text NOT NULL CHECK (effect IN ('NONE','EXTERNAL')),
  payload jsonb NOT NULL CHECK (pg_column_size(payload) <= 8192),
  every_seconds integer NOT NULL CHECK (every_seconds BETWEEN 60 AND 31536000),
  next_slot timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL
);
