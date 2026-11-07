-- V3 M32: product discovery. Additive only.
--
-- A CANDIDATE is one thing an agent's search observed, kept exactly as observed (immutable) together with where it came from
-- (the connector call), when it was seen and how. Nothing here is a quote or a commitment. People and agents record working
-- decisions about candidates (shortlist / reject / clear) in an append-only list of MARKS; the current decision is the latest mark.
CREATE TABLE mission_candidates (
  candidate_id text PRIMARY KEY CHECK (candidate_id ~ '^cnd_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  mission_version integer NOT NULL,
  call_id text NOT NULL REFERENCES connector_calls(call_id),
  connector_id text NOT NULL,
  record_id text NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN ('OFFER','PRODUCT','PROVIDER','STATUS')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  unit_price_minor bigint CHECK (unit_price_minor IS NULL OR unit_price_minor >= 0),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  available_quantity integer CHECK (available_quantity IS NULL OR available_quantity >= 0),
  url text,
  observed_at timestamptz NOT NULL,
  claims jsonb NOT NULL,
  -- candidates seen through different connectors are grouped ONLY when both state the same SKU; otherwise never merged
  match_key text,
  found_by_agent text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (mission_id, call_id, record_id),
  CHECK ((unit_price_minor IS NULL) = (currency IS NULL))
);
CREATE INDEX mission_candidates_mission ON mission_candidates (mission_id, created_at, candidate_id);
CREATE INDEX mission_candidates_match ON mission_candidates (mission_id, match_key) WHERE match_key IS NOT NULL;
CREATE TABLE mission_candidate_marks (
  seq bigserial PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES mission_candidates(candidate_id),
  decision text NOT NULL CHECK (decision IN ('SHORTLIST','REJECT','CLEAR')),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  UNIQUE (candidate_id, actor_id, idempotency_key)
);
CREATE FUNCTION mission_discovery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER mission_candidates_append_only BEFORE UPDATE OR DELETE ON mission_candidates
  FOR EACH ROW EXECUTE FUNCTION mission_discovery_guard();
CREATE TRIGGER mission_candidate_marks_append_only BEFORE UPDATE OR DELETE ON mission_candidate_marks
  FOR EACH ROW EXECUTE FUNCTION mission_discovery_guard();
