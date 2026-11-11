-- V3 M55: plan runs. The executor that drives an ACTIVE mission plan's dependency graph.
--
-- M27 already holds the graph: mission_tasks with a nine-state machine, mission_task_deps with HARD/CONDITIONAL edges,
-- per-task readiness (EXECUTABLE / PREPARED_HANDOFF / UNAVAILABLE), owner-approval gates and append-only task events.
-- Nothing drove it: the only executor (launch_runs, 064) ran a flat list of read-only searches and never touched a task.
-- A plan run is that missing bridge.
--
-- What a run may do, and nothing else:
--   * advance tasks the graph says are READY, by driving the SAME authorized transitions an agent uses
--     (claim/handoff/complete through PlanService), so every capability check still runs and no new authority path exists;
--   * hand a task off, naming honestly what is missing, when no specialist is connected for it;
--   * stop at a task awaiting a person's approval, and say so.
-- What a run never does: approve anything, skip anything, widen a contract, or buy, hire, book, pay or contact anyone.
-- Those stay where they are: member actions on their own screens.
--
-- Effect NONE on the automation queue: every action is bookkeeping about work, or a read, so a lost worker may safely be
-- re-queued. A task left IN_PROGRESS by a crash is resumed under the same run key, which claim() treats as idempotent.
CREATE TABLE plan_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^prn_[a-f0-9]{24}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  -- the plan version the run was started against; if the active plan is superseded mid-run, the run stops rather than
  -- acting on tasks from a plan nobody started it for
  plan_version integer NOT NULL CHECK (plan_version >= 1),
  created_by text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','WAITING_ON_PEOPLE','COMPLETE','CANCELLED','FAILED')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  -- how many fixpoint passes the executor made; a pass that changes nothing ends the run
  passes integer NOT NULL DEFAULT 0 CHECK (passes >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK ((state IN ('WAITING_ON_PEOPLE','COMPLETE','CANCELLED','FAILED')) = (finished_at IS NOT NULL))
);
CREATE INDEX plan_runs_mission ON plan_runs (organization_id, environment, mission_id, created_at DESC);
-- At most one unfinished run per mission, so two runs cannot drive the same graph at once.
CREATE UNIQUE INDEX plan_runs_one_open ON plan_runs (organization_id, environment, mission_id)
  WHERE state IN ('QUEUED','RUNNING');

-- Append-only record of every decision the executor made about a task, so a run can be read back as evidence.
CREATE TABLE plan_run_actions (
  run_id text NOT NULL REFERENCES plan_runs(run_id),
  seq integer NOT NULL CHECK (seq >= 1),
  task_key text NOT NULL,
  task_id text NOT NULL,
  action text NOT NULL CHECK (action IN (
    'HANDED_OFF',          -- claimed and handed to a person or a provider step, with a reason
    'COMPLETED',           -- a connected specialist did the work and reported evidence
    'DISPATCH_FAILED',     -- a connected specialist tried and failed; recorded, not retried blindly
    'LEFT_FOR_MEMBER',     -- no honest automated path (UNAVAILABLE, or no agent assigned)
    'WAITING_FOR_APPROVAL',-- a person must approve before anything may happen
    'BLOCKED',             -- a dependency is not satisfied yet
    'REFUSED'              -- the authorized transition refused it (e.g. a capability is not granted)
  )),
  detail text CHECK (detail IS NULL OR length(detail) <= 500),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE FUNCTION plan_run_actions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'plan run actions are append-only'; END $$;
CREATE TRIGGER plan_run_actions_append_only BEFORE UPDATE OR DELETE ON plan_run_actions
  FOR EACH ROW EXECUTE FUNCTION plan_run_actions_guard();

-- A finished run never changes again, and a run's mission, plan version and owner never change.
CREATE FUNCTION plan_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'plan runs are never deleted'; END IF;
  IF OLD.state IN ('WAITING_ON_PEOPLE','COMPLETE','CANCELLED','FAILED') THEN
    RAISE EXCEPTION 'a finished plan run cannot change';
  END IF;
  IF NEW.mission_id <> OLD.mission_id OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_by <> OLD.created_by OR NEW.plan_version <> OLD.plan_version THEN
    RAISE EXCEPTION 'a plan run''s mission, plan version and owner never change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_runs_guard BEFORE UPDATE OR DELETE ON plan_runs FOR EACH ROW EXECUTE FUNCTION plan_runs_guard();
