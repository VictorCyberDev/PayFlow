-- V3 M47: talent candidates. Additive only.
--
-- A CANDIDATE is an immutable snapshot of what some source said about a person's profile, imported for one role of the talent scope in
-- force. Everything in it is a claim by the source or the candidate: it is stored bounded and strictly parsed, never believed and never
-- executed. Nothing here contacts anyone. Verification of identity, portfolio and references is a person's act in M49.
CREATE TABLE mission_talent_candidates (
  candidate_id text PRIMARY KEY CHECK (candidate_id ~ '^tcd_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  scope_id text NOT NULL REFERENCES mission_talent_scopes(scope_id),
  role_id text NOT NULL,
  source_id text NOT NULL CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('SANDBOX_FIXTURE','MANUAL_ENTRY','LIVE_MARKETPLACE')),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 500),
  handle text NOT NULL CHECK (length(handle) BETWEEN 1 AND 80),
  profile jsonb NOT NULL,
  profile_digest char(64) NOT NULL CHECK (profile_digest ~ '^[a-f0-9]{64}$'),
  imported_by_kind text NOT NULL CHECK (imported_by_kind IN ('MEMBER','AGENT')),
  imported_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  imported_at timestamptz NOT NULL,
  UNIQUE (mission_id, imported_by, idempotency_key, handle),
  -- the same profile snapshot is stored once per role
  UNIQUE (mission_id, role_id, source_id, profile_digest)
);
CREATE INDEX mission_talent_candidates_role ON mission_talent_candidates (mission_id, role_id);
CREATE TRIGGER mission_talent_candidates_append_only BEFORE UPDATE OR DELETE ON mission_talent_candidates
  FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();
