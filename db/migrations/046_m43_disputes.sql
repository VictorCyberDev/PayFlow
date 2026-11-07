-- V3 M43: refunds and disputes. Additive only.
--
-- A DISPUTE is a claim against an order on a ground that M42's computed outcome actually supports. It carries a snapshot of that outcome.
-- Only a person resolves it. A REFUND is recorded only with Proof or a provider confirmation (the ledger demands it) and moves the budget
-- item through the existing partial-refund path; PayFlow does not itself pull money back in this milestone. What a supplier says in reply
-- is a CLAIM stored as an event and never resolves anything.
CREATE TABLE mission_disputes (
  dispute_id text PRIMARY KEY CHECK (dispute_id ~ '^dsp_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  order_id text NOT NULL REFERENCES mission_orders(order_id),
  ground text NOT NULL CHECK (ground IN ('DAMAGED','WRONG_ITEM','SHORT_DELIVERY','OVER_DELIVERY','NOT_DELIVERED_LATE')),
  claimed_minor bigint NOT NULL CHECK (claimed_minor >= 1),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED_REFUNDED','RESOLVED_NO_REFUND','WITHDRAWN')),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  opened_by_kind text NOT NULL CHECK (opened_by_kind IN ('MEMBER','AGENT')),
  opened_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL,
  resolved_by text,
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  UNIQUE (mission_id, opened_by, idempotency_key),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
  CHECK (refunded_minor <= claimed_minor),
  CHECK ((status = 'RESOLVED_REFUNDED') = (refunded_minor > 0))
);
-- One open dispute per order and ground.
CREATE UNIQUE INDEX mission_disputes_open ON mission_disputes (order_id, ground) WHERE status = 'OPEN';
CREATE FUNCTION mission_disputes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'disputes are never deleted'; END IF;
  IF OLD.status <> 'OPEN' THEN RAISE EXCEPTION 'a resolved dispute cannot change'; END IF;
  IF NEW.dispute_id <> OLD.dispute_id OR NEW.order_id <> OLD.order_id OR NEW.ground <> OLD.ground OR NEW.claimed_minor <> OLD.claimed_minor
     OR NEW.snapshot <> OLD.snapshot OR NEW.reason <> OLD.reason OR NEW.opened_by <> OLD.opened_by THEN
    RAISE EXCEPTION 'a dispute''s claim cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_disputes_guard_t BEFORE UPDATE OR DELETE ON mission_disputes FOR EACH ROW EXECUTE FUNCTION mission_disputes_guard();
CREATE TABLE mission_dispute_events (
  seq bigserial PRIMARY KEY,
  dispute_id text NOT NULL REFERENCES mission_disputes(dispute_id),
  kind text NOT NULL CHECK (kind IN ('SUPPLIER_RESPONSE','NOTE')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  occurred_at timestamptz NOT NULL,
  UNIQUE (dispute_id, actor_id, idempotency_key)
);
CREATE TRIGGER mission_dispute_events_append_only BEFORE UPDATE OR DELETE ON mission_dispute_events FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();
