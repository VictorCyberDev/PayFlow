-- V3 M39: offer acceptance and escalation. Additive only.
--
-- An ACCEPTANCE is the decision to rely on one supplier quote at its landed total: immutable, with the checks that held at that moment
-- and who decided. It approves the quote's ledger item (so the budget is committed) and concludes the negotiation. It does not tell
-- the supplier and does not pay. It can be WITHDRAWN once, by a person, before anything is built on it.
-- An ESCALATION is something an agent hands to a person: a request to accept, or to walk away. A person resolves it.
CREATE TABLE mission_acceptances (
  acceptance_id text PRIMARY KEY CHECK (acceptance_id ~ '^acc_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  supplier_id text NOT NULL REFERENCES mission_suppliers(supplier_id),
  quote_id text NOT NULL UNIQUE REFERENCES mission_quotes(quote_id),
  negotiation_id text REFERENCES mission_negotiations(negotiation_id),
  negotiation_version integer,
  total_minor bigint NOT NULL CHECK (total_minor >= 1),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  basis text NOT NULL CHECK (basis IN ('PERSON','AGENT_WITHIN_LIMITS')),
  accepted_by_kind text NOT NULL CHECK (accepted_by_kind IN ('MEMBER','AGENT')),
  accepted_by text NOT NULL,
  checks jsonb NOT NULL,
  override_reason text CHECK (override_reason IS NULL OR length(override_reason) BETWEEN 1 AND 300),
  ledger_item_id text NOT NULL REFERENCES mission_ledger_items(item_id),
  status text NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED','WITHDRAWN')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL,
  withdrawn_by text,
  withdrawn_at timestamptz,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) <= 300),
  UNIQUE (mission_id, accepted_by, idempotency_key),
  CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL)),
  CHECK (basis <> 'AGENT_WITHIN_LIMITS' OR (accepted_by_kind = 'AGENT' AND override_reason IS NULL))
);
-- A negotiation concludes in at most one LIVE acceptance; withdrawing it reopens the negotiation. A quote is accepted once, ever.
CREATE UNIQUE INDEX mission_acceptances_live_negotiation ON mission_acceptances (negotiation_id) WHERE status = 'ACCEPTED' AND negotiation_id IS NOT NULL;
CREATE FUNCTION mission_acceptances_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'acceptances are never deleted'; END IF;
  IF OLD.status = 'WITHDRAWN' THEN RAISE EXCEPTION 'a withdrawn acceptance cannot change'; END IF;
  IF NEW.acceptance_id <> OLD.acceptance_id OR NEW.mission_id <> OLD.mission_id OR NEW.supplier_id <> OLD.supplier_id OR NEW.quote_id <> OLD.quote_id
     OR NEW.negotiation_id IS DISTINCT FROM OLD.negotiation_id OR NEW.total_minor <> OLD.total_minor OR NEW.currency <> OLD.currency
     OR NEW.basis <> OLD.basis OR NEW.accepted_by <> OLD.accepted_by OR NEW.checks <> OLD.checks OR NEW.ledger_item_id <> OLD.ledger_item_id
     OR NEW.created_at <> OLD.created_at OR NEW.override_reason IS DISTINCT FROM OLD.override_reason THEN
    RAISE EXCEPTION 'only withdrawal may change an acceptance';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_acceptances_guard_trg BEFORE UPDATE OR DELETE ON mission_acceptances
  FOR EACH ROW EXECUTE FUNCTION mission_acceptances_guard();

CREATE TABLE mission_escalations (
  escalation_id text PRIMARY KEY CHECK (escalation_id ~ '^esc_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  kind text NOT NULL CHECK (kind IN ('ACCEPTANCE_REQUEST','WALK_AWAY_REQUEST')),
  quote_id text REFERENCES mission_quotes(quote_id),
  negotiation_id text REFERENCES mission_negotiations(negotiation_id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  snapshot jsonb NOT NULL,
  requested_by_kind text NOT NULL CHECK (requested_by_kind IN ('MEMBER','AGENT')),
  requested_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACCEPTED','DECLINED','DISMISSED')),
  resolved_by text,
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 300),
  created_at timestamptz NOT NULL,
  UNIQUE (mission_id, requested_by, idempotency_key),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
  CHECK (kind <> 'ACCEPTANCE_REQUEST' OR quote_id IS NOT NULL)
);
CREATE FUNCTION mission_escalations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'escalations are never deleted'; END IF;
  IF OLD.status <> 'OPEN' THEN RAISE EXCEPTION 'a resolved escalation cannot change'; END IF;
  IF NEW.escalation_id <> OLD.escalation_id OR NEW.mission_id <> OLD.mission_id OR NEW.kind <> OLD.kind OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.negotiation_id IS DISTINCT FROM OLD.negotiation_id OR NEW.reason <> OLD.reason OR NEW.snapshot <> OLD.snapshot
     OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'only the resolution of an open escalation may be set';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_escalations_guard_trg BEFORE UPDATE OR DELETE ON mission_escalations
  FOR EACH ROW EXECUTE FUNCTION mission_escalations_guard();
