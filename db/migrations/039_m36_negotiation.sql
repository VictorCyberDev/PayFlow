-- V3 M36: negotiation contract. Additive only.
--
-- A NEGOTIATION CONTRACT is the rulebook an agent must stay inside when negotiating with one supplier for one mission: the walk-away
-- limit, the terms it will not go below, the concessions it may make, how many rounds, what it may disclose, and how long it lasts.
-- Versions are immutable. A person approves a version before it is in force; a revision is a new version that waits for a person
-- while the previous approved version stays in force. A person can revoke it at any time. This milestone defines and checks the rules;
-- sending anything to a supplier, handling counteroffers and accepting are later milestones, and each must pass through the check.
CREATE TABLE mission_negotiations (
  negotiation_id text PRIMARY KEY CHECK (negotiation_id ~ '^ngt_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  supplier_id text NOT NULL REFERENCES mission_suppliers(supplier_id),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('MEMBER','AGENT')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 300),
  UNIQUE (mission_id, supplier_id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE TABLE mission_negotiation_versions (
  negotiation_id text NOT NULL REFERENCES mission_negotiations(negotiation_id),
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL,
  document_digest char(64) NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
  authored_by_kind text NOT NULL CHECK (authored_by_kind IN ('MEMBER','AGENT')),
  authored_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL,
  decision text NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING','APPROVED','REJECTED')),
  decided_by text,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 300),
  PRIMARY KEY (negotiation_id, version),
  UNIQUE (negotiation_id, authored_by, idempotency_key),
  CHECK ((decision = 'PENDING') = (decided_at IS NULL))
);
-- The document and who wrote it never change; a version is decided exactly once, and never removed.
CREATE FUNCTION mission_negotiation_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'negotiation versions are append-only'; END IF;
  IF OLD.decision <> 'PENDING' THEN RAISE EXCEPTION 'a decided negotiation version cannot change'; END IF;
  IF NEW.negotiation_id <> OLD.negotiation_id OR NEW.version <> OLD.version OR NEW.document <> OLD.document
     OR NEW.document_digest <> OLD.document_digest OR NEW.authored_by_kind <> OLD.authored_by_kind OR NEW.authored_by <> OLD.authored_by
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'only the decision of a pending negotiation version may be set';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_negotiation_versions_guard_trg BEFORE UPDATE OR DELETE ON mission_negotiation_versions
  FOR EACH ROW EXECUTE FUNCTION mission_negotiation_versions_guard();
-- A negotiation may be revoked (one way) but not otherwise rewritten or deleted.
CREATE FUNCTION mission_negotiations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'negotiations are never deleted'; END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'a revoked negotiation cannot change'; END IF;
  IF NEW.negotiation_id <> OLD.negotiation_id OR NEW.mission_id <> OLD.mission_id OR NEW.supplier_id <> OLD.supplier_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'only revocation may change a negotiation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_negotiations_guard_trg BEFORE UPDATE OR DELETE ON mission_negotiations
  FOR EACH ROW EXECUTE FUNCTION mission_negotiations_guard();
