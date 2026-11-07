-- V3 M42: fulfillment. Additive only.
--
-- A SHIPMENT is something said about how the goods are travelling (carrier, tracking). An agent's or supplier's word is a CLAIM; only a
-- person with evidence VERIFIES it. A RECEIPT is a person's count of what physically arrived for one line of the purchase order, with its
-- condition and evidence. Receipts add up; the outcome (complete, short, damaged, wrong, over) is computed, never stored or declared.
CREATE TABLE mission_shipments (
  seq bigserial NOT NULL UNIQUE,
  shipment_id text PRIMARY KEY CHECK (shipment_id ~ '^shp_[a-f0-9]{24}$'),
  order_id text NOT NULL REFERENCES mission_orders(order_id),
  carrier text NOT NULL CHECK (length(carrier) BETWEEN 1 AND 80),
  tracking_ref text NOT NULL CHECK (length(tracking_ref) BETWEEN 1 AND 120),
  expected_delivery date,
  verification text NOT NULL CHECK (verification IN ('CLAIMED','VERIFIED')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('NONE','OWNER_ATTESTATION','DOCUMENT_REF','CONNECTOR_CALL')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 500),
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  occurred_at timestamptz NOT NULL,
  UNIQUE (order_id, actor_id, idempotency_key),
  CHECK (verification = 'CLAIMED' OR (actor_kind = 'MEMBER' AND evidence_kind <> 'NONE'))
);
CREATE TABLE mission_receipts (
  seq bigserial NOT NULL UNIQUE,
  receipt_id text PRIMARY KEY CHECK (receipt_id ~ '^rcp_[a-f0-9]{24}$'),
  order_id text NOT NULL REFERENCES mission_orders(order_id),
  line_index integer NOT NULL CHECK (line_index >= 0),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  condition text NOT NULL CHECK (condition IN ('OK','DAMAGED','WRONG_ITEM')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('OWNER_ATTESTATION','DOCUMENT_REF')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 500),
  note text CHECK (note IS NULL OR length(note) <= 300),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  occurred_at timestamptz NOT NULL,
  UNIQUE (order_id, actor_id, idempotency_key)
);
CREATE FUNCTION mission_fulfillment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER mission_shipments_append_only BEFORE UPDATE OR DELETE ON mission_shipments FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();
CREATE TRIGGER mission_receipts_append_only BEFORE UPDATE OR DELETE ON mission_receipts FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();
