-- Bounded non-authoritative discovery provenance. Existing financial state untouched.
CREATE TABLE commerce_discovery_selections (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  candidate_id char(64) NOT NULL CHECK(candidate_id ~ '^[a-f0-9]{64}$'),
  principal_id text NOT NULL REFERENCES principals(id),
  mandate_id text NOT NULL REFERENCES mandates(id),
  mandate_fingerprint char(64) NOT NULL,
  document jsonb NOT NULL CHECK(octet_length(document::text)<=16384),
  document_hash char(64) NOT NULL,
  selected_at timestamptz NOT NULL
);
CREATE TABLE commerce_discovery_quote_links (
  selection_id uuid PRIMARY KEY REFERENCES commerce_discovery_selections(id),
  quote_id text NOT NULL UNIQUE REFERENCES commerce_quotes(id),
  controlled_offer_fingerprint char(64) NOT NULL,
  mapping_fingerprint char(64) NOT NULL,
  resolved_at timestamptz NOT NULL
);
CREATE FUNCTION immutable_discovery_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'DISCOVERY_PROVENANCE_IMMUTABLE'; END $$;
CREATE TRIGGER immutable_discovery_selection BEFORE UPDATE OR DELETE ON commerce_discovery_selections FOR EACH ROW EXECUTE FUNCTION immutable_discovery_provenance();
CREATE TRIGGER immutable_discovery_quote_link BEFORE UPDATE OR DELETE ON commerce_discovery_quote_links FOR EACH ROW EXECUTE FUNCTION immutable_discovery_provenance();
