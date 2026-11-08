-- V3 M48: shortlists. Additive only.
--
-- A SHORTLIST is a person's adoption of up to five candidates for one role of the talent scope in force, with the computed ranking and
-- checks at that moment stored beside it. The ranking is deterministic and uses nothing that stands in for a protected attribute. An agent
-- computes and recommends; only a person adopts. Adopting contacts no one and offers nothing.
CREATE TABLE mission_talent_shortlists (
  seq bigserial NOT NULL UNIQUE,
  shortlist_id text PRIMARY KEY CHECK (shortlist_id ~ '^tsl_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  scope_id text NOT NULL REFERENCES mission_talent_scopes(scope_id),
  role_id text NOT NULL,
  candidate_ids jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WITHDRAWN')),
  adopted_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  adopted_at timestamptz NOT NULL,
  withdrawn_by text,
  withdrawn_at timestamptz,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) <= 300),
  UNIQUE (mission_id, adopted_by, idempotency_key),
  CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL))
);
CREATE UNIQUE INDEX mission_talent_shortlists_active ON mission_talent_shortlists (scope_id, role_id) WHERE status = 'ACTIVE';
CREATE FUNCTION mission_talent_shortlists_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'shortlists are never deleted'; END IF;
  IF OLD.status = 'WITHDRAWN' THEN RAISE EXCEPTION 'a withdrawn shortlist cannot change'; END IF;
  IF NEW.shortlist_id <> OLD.shortlist_id OR NEW.scope_id <> OLD.scope_id OR NEW.role_id <> OLD.role_id OR NEW.candidate_ids <> OLD.candidate_ids
     OR NEW.snapshot <> OLD.snapshot OR NEW.adopted_by <> OLD.adopted_by THEN
    RAISE EXCEPTION 'a shortlist''s content cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_talent_shortlists_guard_t BEFORE UPDATE OR DELETE ON mission_talent_shortlists FOR EACH ROW EXECUTE FUNCTION mission_talent_shortlists_guard();
