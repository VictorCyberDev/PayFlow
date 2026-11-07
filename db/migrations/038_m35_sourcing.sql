-- V3 M35: sourcing optimization. Additive only.
--
-- A SOURCING RUN records one recommendation: the demand and constraints asked for, the exact quotes it considered (a snapshot of
-- ids and totals), and what was chosen or why nothing could be. Runs are immutable so a decision can be reproduced and audited.
-- A run recommends; it commits nothing. Adopting a run (a person's act) puts its chosen quotes in the budget as QUOTED items.
CREATE TABLE mission_sourcing_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^src_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  requested_by_kind text NOT NULL CHECK (requested_by_kind IN ('MEMBER','AGENT')),
  requested_by text NOT NULL,
  demand jsonb NOT NULL,
  constraints jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('OPTIMAL','INFEASIBLE')),
  result jsonb NOT NULL,
  inputs_digest char(64) NOT NULL CHECK (inputs_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (mission_id, requested_by, idempotency_key)
);
CREATE INDEX mission_sourcing_runs_mission ON mission_sourcing_runs (mission_id, created_at);
-- A run is adopted at most once.
CREATE TABLE mission_sourcing_adoptions (
  run_id text PRIMARY KEY REFERENCES mission_sourcing_runs(run_id),
  adopted_by text NOT NULL,
  adopted_at timestamptz NOT NULL
);
CREATE FUNCTION mission_sourcing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER mission_sourcing_runs_append_only BEFORE UPDATE OR DELETE ON mission_sourcing_runs
  FOR EACH ROW EXECUTE FUNCTION mission_sourcing_guard();
CREATE TRIGGER mission_sourcing_adoptions_append_only BEFORE UPDATE OR DELETE ON mission_sourcing_adoptions
  FOR EACH ROW EXECUTE FUNCTION mission_sourcing_guard();
