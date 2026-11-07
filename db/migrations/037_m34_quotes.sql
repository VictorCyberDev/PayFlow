-- V3 M34: supplier quotes and landed cost. Additive only.
--
-- A QUOTE is what a supplier stated about price and terms, kept exactly as recorded and never edited. A newer quote for the same
-- supplier SUPERSEDES an older one (the old row stays). Every money component says how it is known (stated, estimated, unknown);
-- the landed total is computed on read and is only called complete when nothing is unknown. A quote is not an acceptance, a
-- reservation or a commitment, and PayFlow cannot make a supplier's quote binding.
CREATE TABLE mission_quotes (
  quote_id text PRIMARY KEY CHECK (quote_id ~ '^qte_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  supplier_id text NOT NULL REFERENCES mission_suppliers(supplier_id),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_until timestamptz NOT NULL,
  document jsonb NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('CONNECTOR_CALL','DOCUMENT_REF','SUPPLIER_STATED','OWNER_REPORTED')),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 500),
  supersedes_quote_id text REFERENCES mission_quotes(quote_id),
  recorded_by_kind text NOT NULL CHECK (recorded_by_kind IN ('MEMBER','AGENT')),
  recorded_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  UNIQUE (mission_id, recorded_by, idempotency_key),
  -- a quote can be superseded once, so history is a line and not a tree
  UNIQUE (supersedes_quote_id)
);
CREATE INDEX mission_quotes_supplier ON mission_quotes (mission_id, supplier_id, recorded_at);
-- At most one ledger item per quote, so recording a quote in the budget is idempotent.
CREATE TABLE mission_quote_ledger (
  quote_id text PRIMARY KEY REFERENCES mission_quotes(quote_id),
  item_id text NOT NULL UNIQUE REFERENCES mission_ledger_items(item_id),
  linked_by text NOT NULL,
  linked_at timestamptz NOT NULL
);
CREATE FUNCTION mission_quotes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER mission_quotes_append_only BEFORE UPDATE OR DELETE ON mission_quotes
  FOR EACH ROW EXECUTE FUNCTION mission_quotes_guard();
CREATE TRIGGER mission_quote_ledger_append_only BEFORE UPDATE OR DELETE ON mission_quote_ledger
  FOR EACH ROW EXECUTE FUNCTION mission_quotes_guard();
