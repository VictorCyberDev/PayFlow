-- V3 M41: orders. Additive only.
--
-- An ORDER is what a SETTLED purchase order turned into: the thing the supplier now owes. Its status moves only on VERIFIED events
-- (a person, with evidence). What an agent or the supplier says is recorded as a CLAIM beside it and never moves the status.
-- Events are append-only; the status is derived from them and stored for lookups by a guard that only allows legal forward moves.
CREATE TABLE mission_orders (
  order_id text PRIMARY KEY CHECK (order_id ~ '^ord_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  po_id text NOT NULL UNIQUE REFERENCES mission_purchase_orders(po_id),
  supplier_id text NOT NULL REFERENCES mission_suppliers(supplier_id),
  status text NOT NULL CHECK (status IN ('PLACED','CONFIRMED','SHIPPED','DELIVERED','CANCELLED','IN_DISPUTE')),
  supplier_order_ref text CHECK (supplier_order_ref IS NULL OR length(supplier_order_ref) BETWEEN 1 AND 120),
  expected_delivery date,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('MEMBER','AGENT')),
  created_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (mission_id, created_by, idempotency_key)
);
CREATE TABLE mission_order_events (
  seq bigserial PRIMARY KEY,
  order_id text NOT NULL REFERENCES mission_orders(order_id),
  kind text NOT NULL CHECK (kind IN ('STATUS','REFERENCE','DELIVERY_DATE','NOTE')),
  verification text NOT NULL CHECK (verification IN ('CLAIMED','VERIFIED')),
  status text CHECK (status IS NULL OR status IN ('PLACED','CONFIRMED','SHIPPED','DELIVERED','CANCELLED','IN_DISPUTE')),
  value text CHECK (value IS NULL OR length(value) <= 500),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('NONE','OWNER_ATTESTATION','DOCUMENT_REF','CONNECTOR_CALL')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 500),
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  occurred_at timestamptz NOT NULL,
  UNIQUE (order_id, actor_id, idempotency_key),
  CHECK (verification = 'CLAIMED' OR (actor_kind = 'MEMBER' AND evidence_kind <> 'NONE'))
);
CREATE FUNCTION mission_order_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'mission_order_events is append-only'; END $$;
CREATE TRIGGER mission_order_events_append_only BEFORE UPDATE OR DELETE ON mission_order_events
  FOR EACH ROW EXECUTE FUNCTION mission_order_events_guard();
CREATE FUNCTION mission_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'orders are never deleted'; END IF;
  IF NEW.order_id <> OLD.order_id OR NEW.mission_id <> OLD.mission_id OR NEW.po_id <> OLD.po_id OR NEW.supplier_id <> OLD.supplier_id THEN
    RAISE EXCEPTION 'an order''s identity cannot change';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PLACED' AND NEW.status IN ('CONFIRMED','SHIPPED','CANCELLED','IN_DISPUTE')) OR
       (OLD.status = 'CONFIRMED' AND NEW.status IN ('SHIPPED','CANCELLED','IN_DISPUTE')) OR
       (OLD.status = 'SHIPPED' AND NEW.status IN ('DELIVERED','IN_DISPUTE')) OR
       (OLD.status = 'DELIVERED' AND NEW.status = 'IN_DISPUTE') OR
       (OLD.status = 'IN_DISPUTE' AND NEW.status IN ('DELIVERED','CANCELLED'))) THEN
    RAISE EXCEPTION 'illegal order move % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_orders_guard_t BEFORE UPDATE OR DELETE ON mission_orders FOR EACH ROW EXECUTE FUNCTION mission_orders_guard();
