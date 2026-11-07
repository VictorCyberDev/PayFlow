-- V3 M27: Mission planning. Additive only.
--
-- A plan is a versioned, dependency-aware set of tasks for one mission. A plan PROPOSED by an agent or a model is inert until a
-- member activates it. Plans and tasks are bookkeeping about work: they never move money, and an estimate is never a quote.
CREATE TABLE mission_plans (
  mission_id text NOT NULL REFERENCES missions(mission_id),
  plan_version integer NOT NULL CHECK (plan_version >= 1),
  based_on_mission_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('PROPOSED','ACTIVE','SUPERSEDED','REJECTED')),
  -- who produced it: a person, the deterministic template planner, or a model (always labelled)
  source text NOT NULL CHECK (source IN ('HUMAN','DETERMINISTIC_TEMPLATE','MODEL')),
  source_label text,
  rationale text NOT NULL DEFAULT '',
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('MEMBER','AGENT')),
  created_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  activated_by text,
  activated_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (mission_id, plan_version),
  UNIQUE (mission_id, idempotency_key)
);

CREATE TABLE mission_tasks (
  task_id text PRIMARY KEY CHECK (task_id ~ '^tsk_[a-f0-9]{24}$'),
  mission_id text NOT NULL,
  plan_version integer NOT NULL,
  task_key text NOT NULL CHECK (task_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  title text NOT NULL,
  intended_outcome text NOT NULL,
  task_type text NOT NULL,
  required_capabilities text[] NOT NULL CHECK (cardinality(required_capabilities) >= 1),
  provider_types text[] NOT NULL DEFAULT '{}',
  estimated_cost_minor bigint CHECK (estimated_cost_minor IS NULL OR estimated_cost_minor >= 0),
  -- an estimate is labelled; only the quote engine (M34) may ever write VERIFIED_QUOTE
  estimate_source text NOT NULL CHECK (estimate_source IN ('NONE','HUMAN_ESTIMATE','AI_ESTIMATE','VERIFIED_QUOTE')),
  expected_duration_minutes integer CHECK (expected_duration_minutes IS NULL OR expected_duration_minutes > 0),
  required_evidence text[] NOT NULL DEFAULT '{}',
  assigned_agent_id text,
  priority text NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH')),
  deadline timestamptz,
  state text NOT NULL CHECK (state IN
    ('BLOCKED','READY','AWAITING_APPROVAL','IN_PROGRESS','HANDED_OFF','COMPLETED','FAILED','SKIPPED','INVALIDATED')),
  block_reason text,
  -- EXECUTABLE (a granted agent can do it with what is connected), PREPARED_HANDOFF (a person or provider step is needed), UNAVAILABLE (no honest path)
  readiness text NOT NULL CHECK (readiness IN ('EXECUTABLE','PREPARED_HANDOFF','UNAVAILABLE')),
  readiness_reason text,
  requires_owner_approval boolean NOT NULL DEFAULT false,
  approved_by text,
  approved_at timestamptz,
  run_key text,
  result jsonb,
  failure jsonb,
  explanation text NOT NULL DEFAULT '',
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (mission_id, plan_version) REFERENCES mission_plans (mission_id, plan_version),
  UNIQUE (mission_id, plan_version, task_key)
);
CREATE INDEX mission_tasks_agent ON mission_tasks (assigned_agent_id, state);

CREATE TABLE mission_task_deps (
  mission_id text NOT NULL,
  plan_version integer NOT NULL,
  task_key text NOT NULL,
  depends_on_key text NOT NULL,
  -- HARD: the other task must be COMPLETED. CONDITIONAL: COMPLETED or SKIPPED.
  kind text NOT NULL CHECK (kind IN ('HARD','CONDITIONAL')),
  PRIMARY KEY (mission_id, plan_version, task_key, depends_on_key),
  FOREIGN KEY (mission_id, plan_version, task_key) REFERENCES mission_tasks (mission_id, plan_version, task_key),
  FOREIGN KEY (mission_id, plan_version, depends_on_key) REFERENCES mission_tasks (mission_id, plan_version, task_key),
  CHECK (task_key <> depends_on_key)
);

CREATE TABLE mission_task_events (
  task_id text NOT NULL REFERENCES mission_tasks(task_id),
  seq integer NOT NULL CHECK (seq >= 1),
  from_state text,
  to_state text NOT NULL,
  event text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT','SYSTEM')),
  actor_id text NOT NULL,
  detail text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE FUNCTION mission_task_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'task events are append-only'; END $$;
CREATE TRIGGER mission_task_events_append_only BEFORE UPDATE OR DELETE ON mission_task_events
  FOR EACH ROW EXECUTE FUNCTION mission_task_events_guard();
