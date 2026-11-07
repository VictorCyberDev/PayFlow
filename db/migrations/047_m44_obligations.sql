-- V3 M44: obligations. Additive only.
--
-- An OBLIGATION is something with a date that the mission must not forget: a delivery the supplier promised by, a return window that
-- closes, a warranty that ends, a renewal, a payment due, or a reminder a person or agent adds. Dates DERIVED from a quote's terms are
-- computed from verified facts (the verified delivery date) and stored once per order and kind. Whether one is due soon or late is
-- computed at read time, never stored. Only a person marks one DONE or WAIVED. Obligations are reminders: they move no money.
CREATE TABLE mission_obligations (
  obligation_id text PRIMARY KEY CHECK (obligation_id ~ '^obl_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  order_id text REFERENCES mission_orders(order_id),
  kind text NOT NULL CHECK (kind IN ('DELIVERY_DEADLINE','RETURN_WINDOW','WARRANTY_END','RENEWAL','PAYMENT_DUE','CUSTOM')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  due_date date NOT NULL,
  derived_from text CHECK (derived_from IS NULL OR length(derived_from) <= 80),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 1),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','WAIVED')),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('MEMBER','AGENT','SYSTEM')),
  created_by text NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL,
  resolved_by text,
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 300),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
  CHECK (derived_from IS NULL OR order_id IS NOT NULL)
);
-- A derived obligation exists once per order and kind: deriving again changes nothing.
CREATE UNIQUE INDEX mission_obligations_derived ON mission_obligations (order_id, kind) WHERE derived_from IS NOT NULL;
CREATE UNIQUE INDEX mission_obligations_idem ON mission_obligations (mission_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX mission_obligations_due ON mission_obligations (mission_id, status, due_date);
CREATE FUNCTION mission_obligations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'obligations are never deleted'; END IF;
  IF OLD.status <> 'OPEN' THEN RAISE EXCEPTION 'a resolved obligation cannot change'; END IF;
  IF NEW.obligation_id <> OLD.obligation_id OR NEW.mission_id <> OLD.mission_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.kind <> OLD.kind OR NEW.title <> OLD.title OR NEW.due_date <> OLD.due_date OR NEW.derived_from IS DISTINCT FROM OLD.derived_from
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    RAISE EXCEPTION 'an obligation''s terms cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_obligations_guard_t BEFORE UPDATE OR DELETE ON mission_obligations FOR EACH ROW EXECUTE FUNCTION mission_obligations_guard();
