-- V3 M33: supplier qualification. Additive only.
--
-- A SUPPLIER is a merchant or provider a mission may deal with. Its dossier is a history of FACTS about named criteria
-- (identity, accepts PayPal, return policy, ...). Facts are append-only; the latest fact per criterion is the current one.
-- An agent may record what it CLAIMS or what FAILED; only a person may mark a fact VERIFIED, and only with evidence that is
-- acceptable for that criterion. Whether a supplier is QUALIFIED is computed from the facts and the mission's required
-- criteria; it is never stored, and it is never an approval to buy.
CREATE TABLE mission_suppliers (
  supplier_id text PRIMARY KEY CHECK (supplier_id ~ '^sup_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  external_ref text NOT NULL CHECK (external_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  source_candidate_id text REFERENCES mission_candidates(candidate_id),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('MEMBER','AGENT')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (mission_id, external_ref)
);
CREATE TABLE mission_supplier_facts (
  seq bigserial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES mission_suppliers(supplier_id),
  criterion text NOT NULL,
  status text NOT NULL CHECK (status IN ('CLAIMED','VERIFIED','FAILED','UNKNOWN')),
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('NONE','CONNECTOR_CALL','DOCUMENT_REF','OWNER_ATTESTATION')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 500),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  UNIQUE (supplier_id, actor_id, idempotency_key)
);
CREATE INDEX mission_supplier_facts_latest ON mission_supplier_facts (supplier_id, criterion, seq DESC);
-- Which criteria this mission requires. Append-only; the latest row is the policy in force.
CREATE TABLE mission_qualification_policy (
  seq bigserial PRIMARY KEY,
  mission_id text NOT NULL REFERENCES missions(mission_id),
  required jsonb NOT NULL,
  set_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  set_at timestamptz NOT NULL,
  UNIQUE (mission_id, idempotency_key)
);
CREATE FUNCTION mission_qualification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER mission_supplier_facts_append_only BEFORE UPDATE OR DELETE ON mission_supplier_facts
  FOR EACH ROW EXECUTE FUNCTION mission_qualification_guard();
CREATE TRIGGER mission_qualification_policy_append_only BEFORE UPDATE OR DELETE ON mission_qualification_policy
  FOR EACH ROW EXECUTE FUNCTION mission_qualification_guard();
CREATE TRIGGER mission_suppliers_no_delete BEFORE DELETE ON mission_suppliers
  FOR EACH ROW EXECUTE FUNCTION mission_qualification_guard();
