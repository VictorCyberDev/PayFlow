-- V3 M46: talent scope. Additive only.
--
-- A TALENT SCOPE says what kind of contractor work a mission may look for and under what limits: roles, required and preferred skills,
-- engagement type, a budget cap per role, deliverables, and which checks a person must complete before any offer. Versions are immutable.
-- An agent or a person proposes; only the owner approves, and the scope is checked again against the mission at that moment. At most one
-- version is in force per mission. The scope may not screen on protected attributes.
CREATE TABLE mission_talent_scopes (
  scope_id text PRIMARY KEY CHECK (scope_id ~ '^tsc_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL,
  document_digest char(64) NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED','SUPERSEDED','REVOKED')),
  proposed_by_kind text NOT NULL CHECK (proposed_by_kind IN ('MEMBER','AGENT')),
  proposed_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  proposed_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) <= 300),
  UNIQUE (mission_id, version),
  UNIQUE (mission_id, proposed_by, idempotency_key)
);
CREATE UNIQUE INDEX mission_talent_scopes_in_force ON mission_talent_scopes (mission_id) WHERE status = 'APPROVED';
CREATE FUNCTION mission_talent_scopes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'talent scopes are never deleted'; END IF;
  IF NEW.scope_id <> OLD.scope_id OR NEW.mission_id <> OLD.mission_id OR NEW.version <> OLD.version OR NEW.document <> OLD.document
     OR NEW.document_digest <> OLD.document_digest OR NEW.proposed_by <> OLD.proposed_by THEN
    RAISE EXCEPTION 'a talent scope version is immutable';
  END IF;
  IF OLD.status IN ('REJECTED','SUPERSEDED','REVOKED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % talent scope cannot change', OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_talent_scopes_guard_t BEFORE UPDATE OR DELETE ON mission_talent_scopes FOR EACH ROW EXECUTE FUNCTION mission_talent_scopes_guard();
