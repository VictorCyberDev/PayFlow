-- R0: payment-time purchase-order binding. Additive only.
--
-- A mission-governed purchase is no longer "whatever the Authority allows": the Gateway must be told WHICH approved purchase order the
-- payment is for, loads that order from PayFlow's own tables (the id the agent names is only a lookup key), compares it with the
-- trusted checkout quote BEFORE any manifest, reservation, grant or provider call, and records a durable EXECUTION INTENT here.
-- At most one intent per order (purchase order or contractor payment instruction) may be live (PENDING / DISPATCHING / COMPLETED / UNKNOWN), enforced by a partial unique index, so two
-- competing purchases for one order cannot both reach the provider. Reconciliation (M40) remains a second line of defense.
CREATE TABLE mission_execution_intents (
  intent_id text PRIMARY KEY CHECK (intent_id ~ '^xin_[a-f0-9]{24}$'),
  -- a purchase order (`po_...`) or a contractor milestone payment instruction (`cpy_...`); checked by the binding service
  order_kind text NOT NULL CHECK (order_kind IN ('PURCHASE_ORDER','CONTRACTOR_PAYMENT')),
  order_ref text NOT NULL CHECK (order_ref ~ '^(po|cpy)_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  mission_version integer NOT NULL,
  authority_id text NOT NULL REFERENCES mandates(id),
  agent_id text NOT NULL,
  po_digest char(64) NOT NULL CHECK (po_digest ~ '^[a-f0-9]{64}$'),
  nonce_digest char(64) NOT NULL CHECK (nonce_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING','DISPATCHING','COMPLETED','NO_EFFECT','UNKNOWN','ABANDONED')),
  refusal text CHECK (refusal IS NULL OR refusal ~ '^[A-Z0-9_]{3,96}$'),
  proposal_id text CHECK (proposal_id IS NULL OR length(proposal_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  resolved_at timestamptz
);
CREATE UNIQUE INDEX mission_execution_intents_live ON mission_execution_intents (order_ref)
  WHERE status IN ('PENDING','DISPATCHING','COMPLETED','UNKNOWN');
CREATE UNIQUE INDEX mission_execution_intents_nonce ON mission_execution_intents (authority_id, nonce_digest);
CREATE INDEX mission_execution_intents_order ON mission_execution_intents (order_ref, created_at);
-- Status only moves forward; identity columns never change.
CREATE FUNCTION mission_execution_intents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mission_execution_intents is append-only'; END IF;
  IF NEW.intent_id <> OLD.intent_id OR NEW.order_ref <> OLD.order_ref OR NEW.order_kind <> OLD.order_kind OR NEW.mission_id <> OLD.mission_id
     OR NEW.mission_version <> OLD.mission_version OR NEW.authority_id <> OLD.authority_id OR NEW.agent_id <> OLD.agent_id
     OR NEW.po_digest <> OLD.po_digest OR NEW.nonce_digest <> OLD.nonce_digest OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'mission_execution_intents identity is immutable';
  END IF;
  IF OLD.status IN ('COMPLETED','NO_EFFECT','ABANDONED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'mission_execution_intents terminal status is final';
  END IF;
  IF OLD.status = 'UNKNOWN' AND NEW.status NOT IN ('UNKNOWN','COMPLETED','NO_EFFECT') THEN
    RAISE EXCEPTION 'mission_execution_intents UNKNOWN resolves only by reconciliation';
  END IF;
  IF OLD.status = 'DISPATCHING' AND NEW.status IN ('PENDING','ABANDONED') THEN
    RAISE EXCEPTION 'a dispatched intent cannot be abandoned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_execution_intents_guard BEFORE UPDATE OR DELETE ON mission_execution_intents
  FOR EACH ROW EXECUTE FUNCTION mission_execution_intents_guard();
