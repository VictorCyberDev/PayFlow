-- M55 (slice): launch runs. A run is a durable, ordered list of READ-ONLY discovery steps for one mission (workspace search, services search),
-- executed by the automation worker so it survives restarts. A run never books, buys, hires, pays or contacts anyone; it ends READY and a person
-- decides what to do with what it found. Steps are idempotent observations, so the automation framework may safely re-queue a lost run.
CREATE TABLE launch_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^lrn_[a-f0-9]{24}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  mission_id text NOT NULL,
  created_by text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','READY','FAILED','CANCELLED')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK ((state IN ('READY','FAILED','CANCELLED')) = (finished_at IS NOT NULL))
);
CREATE INDEX launch_runs_mission ON launch_runs (organization_id, environment, mission_id, created_at DESC);
-- At most one unfinished run per mission.
CREATE UNIQUE INDEX launch_runs_one_open ON launch_runs (organization_id, environment, mission_id) WHERE state IN ('QUEUED','RUNNING');

CREATE TABLE launch_run_steps (
  run_id text NOT NULL REFERENCES launch_runs(run_id),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 7),
  area text NOT NULL CHECK (area IN ('WORKSPACE','SERVICES')),
  request jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','RUNNING','DONE','REFUSED','FAILED')),
  refusal text CHECK (refusal IS NULL OR length(refusal) <= 100),
  summary jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (run_id, position)
);

-- A finished run, and a finished step, never change again.
CREATE FUNCTION launch_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'launch runs are never deleted'; END IF;
  IF OLD.state IN ('READY','FAILED','CANCELLED') THEN RAISE EXCEPTION 'a finished launch run cannot change'; END IF;
  IF NEW.mission_id <> OLD.mission_id OR NEW.organization_id <> OLD.organization_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a launch run''s mission and owner never change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER launch_runs_guard BEFORE UPDATE OR DELETE ON launch_runs FOR EACH ROW EXECUTE FUNCTION launch_runs_guard();
CREATE FUNCTION launch_run_steps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'launch steps are never deleted'; END IF;
  IF OLD.state IN ('DONE','REFUSED','FAILED') THEN RAISE EXCEPTION 'a finished launch step cannot change'; END IF;
  IF NEW.request IS DISTINCT FROM OLD.request OR NEW.area <> OLD.area THEN RAISE EXCEPTION 'a launch step''s request never changes'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER launch_run_steps_guard BEFORE UPDATE OR DELETE ON launch_run_steps FOR EACH ROW EXECUTE FUNCTION launch_run_steps_guard();
