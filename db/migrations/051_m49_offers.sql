-- V3 M49: contractor checks, offers and contracts. Additive only.
--
-- CHECKS are a person's findings about one candidate (identity verified, portfolio reviewed, references checked, work authorization
-- confirmed, classification reviewed): append-only, each with evidence; the latest per kind counts. An OFFER is drafted for a shortlisted
-- candidate within the scope's limits and moves DRAFT -> APPROVED -> SENT -> ACCEPTED/DECLINED only by a person's act; PayFlow sends
-- nothing and is not the employer or the contracting party. A CONTRACT exists once a person records the candidate's acceptance and then
-- commits each milestone in the budget ledger. Terms never change after drafting.
CREATE TABLE mission_talent_checks (
  seq bigserial PRIMARY KEY,
  check_id text NOT NULL UNIQUE CHECK (check_id ~ '^tck_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  candidate_id text NOT NULL REFERENCES mission_talent_candidates(candidate_id),
  kind text NOT NULL CHECK (kind IN ('IDENTITY_VERIFIED','PORTFOLIO_REVIEWED','REFERENCES_CHECKED','WORK_AUTHORIZATION_CONFIRMED','CLASSIFICATION_REVIEWED')),
  result text NOT NULL CHECK (result IN ('PASSED','FAILED')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('OWNER_ATTESTATION','DOCUMENT_REF')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 500),
  note text CHECK (note IS NULL OR length(note) <= 300),
  recorded_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  recorded_at timestamptz NOT NULL,
  UNIQUE (mission_id, recorded_by, idempotency_key)
);
CREATE TRIGGER mission_talent_checks_append_only BEFORE UPDATE OR DELETE ON mission_talent_checks FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();

CREATE TABLE mission_talent_offers (
  offer_id text PRIMARY KEY CHECK (offer_id ~ '^ofr_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  scope_id text NOT NULL REFERENCES mission_talent_scopes(scope_id),
  role_id text NOT NULL,
  candidate_id text NOT NULL REFERENCES mission_talent_candidates(candidate_id),
  shortlist_id text NOT NULL REFERENCES mission_talent_shortlists(shortlist_id),
  terms jsonb NOT NULL,
  terms_digest char(64) NOT NULL CHECK (terms_digest ~ '^[a-f0-9]{64}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 1),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','SENT','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED')),
  drafted_by_kind text NOT NULL CHECK (drafted_by_kind IN ('MEMBER','AGENT')),
  drafted_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  drafted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_by text, approved_at timestamptz,
  sent_by text, sent_at timestamptz, sent_note text CHECK (sent_note IS NULL OR length(sent_note) <= 300),
  resolved_by text, resolved_at timestamptz,
  resolution_evidence_kind text CHECK (resolution_evidence_kind IS NULL OR resolution_evidence_kind IN ('OWNER_ATTESTATION','DOCUMENT_REF')),
  resolution_evidence_ref text CHECK (resolution_evidence_ref IS NULL OR length(resolution_evidence_ref) <= 500),
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 300),
  UNIQUE (mission_id, drafted_by, idempotency_key)
);
-- one live offer per candidate and role
CREATE UNIQUE INDEX mission_talent_offers_live ON mission_talent_offers (scope_id, role_id, candidate_id) WHERE status IN ('DRAFT','APPROVED','SENT');
CREATE FUNCTION mission_talent_offers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offers are never deleted'; END IF;
  IF NEW.offer_id <> OLD.offer_id OR NEW.mission_id <> OLD.mission_id OR NEW.scope_id <> OLD.scope_id OR NEW.role_id <> OLD.role_id
     OR NEW.candidate_id <> OLD.candidate_id OR NEW.terms <> OLD.terms OR NEW.terms_digest <> OLD.terms_digest OR NEW.total_minor <> OLD.total_minor
     OR NEW.drafted_by <> OLD.drafted_by THEN
    RAISE EXCEPTION 'offer terms never change';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED','WITHDRAWN','EXPIRED')) OR
       (OLD.status = 'APPROVED' AND NEW.status IN ('SENT','WITHDRAWN','EXPIRED')) OR
       (OLD.status = 'SENT' AND NEW.status IN ('ACCEPTED','DECLINED','WITHDRAWN','EXPIRED'))) THEN
    RAISE EXCEPTION 'illegal offer move % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = OLD.status AND OLD.status IN ('ACCEPTED','DECLINED','WITHDRAWN','EXPIRED') THEN
    RAISE EXCEPTION 'a % offer cannot change', OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_talent_offers_guard_t BEFORE UPDATE OR DELETE ON mission_talent_offers FOR EACH ROW EXECUTE FUNCTION mission_talent_offers_guard();

CREATE TABLE mission_talent_contracts (
  contract_id text PRIMARY KEY CHECK (contract_id ~ '^tct_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  offer_id text NOT NULL UNIQUE REFERENCES mission_talent_offers(offer_id),
  candidate_id text NOT NULL REFERENCES mission_talent_candidates(candidate_id),
  role_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 1),
  milestones jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TRIGGER mission_talent_contracts_append_only BEFORE UPDATE OR DELETE ON mission_talent_contracts FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();
