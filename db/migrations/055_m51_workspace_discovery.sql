-- V3 M51/M52: workspace discovery and qualification. Additive only.
--
-- A SEARCH records what was asked (the need and the stay) and what a source returned. Listings are OBSERVATIONS: untrusted, bounded,
-- parsed and stored append-only with the source's provenance. Nothing here books, reserves or contacts anyone. Assessments (total
-- liability, problems, ranking) are computed from the stored listing and need on every read, so a rule change never rewrites history.
CREATE TABLE mission_workspace_searches (
  search_id text PRIMARY KEY CHECK (search_id ~ '^wsq_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  source_id text NOT NULL CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('SANDBOX_FIXTURE','LIVE_PROVIDER')),
  need jsonb NOT NULL,
  stay jsonb NOT NULL,
  cancel_at timestamptz NOT NULL,
  rejected integer NOT NULL CHECK (rejected >= 0),
  truncated boolean NOT NULL,
  searched_by_kind text NOT NULL CHECK (searched_by_kind IN ('MEMBER','AGENT')),
  searched_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  searched_at timestamptz NOT NULL,
  UNIQUE (mission_id, searched_by, idempotency_key)
);
CREATE INDEX mission_workspace_searches_mission ON mission_workspace_searches (mission_id, searched_at);
CREATE TABLE mission_workspace_listings (
  seq bigserial PRIMARY KEY,
  search_id text NOT NULL REFERENCES mission_workspace_searches(search_id),
  listing_id text NOT NULL CHECK (listing_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  document jsonb NOT NULL,
  document_digest char(64) NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  UNIQUE (search_id, listing_id)
);
CREATE FUNCTION mission_workspace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER mission_workspace_searches_append_only BEFORE UPDATE OR DELETE ON mission_workspace_searches
  FOR EACH ROW EXECUTE FUNCTION mission_workspace_guard();
CREATE TRIGGER mission_workspace_listings_append_only BEFORE UPDATE OR DELETE ON mission_workspace_listings
  FOR EACH ROW EXECUTE FUNCTION mission_workspace_guard();
