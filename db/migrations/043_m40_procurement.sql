-- V3 M40: procurement to payment. Additive only.
--
-- A PURCHASE ORDER is the exact spending instruction derived from an accepted quote: the merchant, the total, the lines, the category,
-- the purpose, the Authority it must be paid under and the agent that may pay it. It is immutable and bound by a digest. PayFlow does
-- not pay from it: the PURCHASE agent still goes through the one decision path (credential -> Authority -> Trust Kernel -> reservation
-- -> grant -> rail -> reconciliation -> Proof). A RECONCILIATION then reads PayFlow's own operation trace for the payment the agent
-- made, checks it matches the order exactly, and moves the budget item with the evidence the ledger requires. Nothing an agent says
-- about the payment is believed.
CREATE TABLE mission_purchase_orders (
  po_id text PRIMARY KEY CHECK (po_id ~ '^po_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  acceptance_id text NOT NULL UNIQUE REFERENCES mission_acceptances(acceptance_id),
  supplier_id text NOT NULL REFERENCES mission_suppliers(supplier_id),
  quote_id text NOT NULL REFERENCES mission_quotes(quote_id),
  agent_id text NOT NULL,
  authority_id text NOT NULL REFERENCES mandates(id),
  category text NOT NULL CHECK (category ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  merchant text NOT NULL CHECK (merchant ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 1),
  document jsonb NOT NULL,
  document_digest char(64) NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
  issued_by_kind text NOT NULL CHECK (issued_by_kind IN ('MEMBER','AGENT')),
  issued_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (mission_id, issued_by, idempotency_key)
);
CREATE FUNCTION mission_procurement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER mission_purchase_orders_append_only BEFORE UPDATE OR DELETE ON mission_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION mission_procurement_guard();

CREATE TABLE mission_purchase_reconciliations (
  seq bigserial PRIMARY KEY,
  po_id text NOT NULL REFERENCES mission_purchase_orders(po_id),
  proposal_id text NOT NULL CHECK (length(proposal_id) BETWEEN 1 AND 128),
  classification text NOT NULL CHECK (classification IN ('SETTLED','UNKNOWN','FAILED_NO_EFFECT','MISMATCH','INCOMPLETE','DUPLICATE')),
  trace_status text NOT NULL,
  financial_outcome text NOT NULL,
  refs jsonb NOT NULL,
  problems jsonb NOT NULL,
  ledger_steps jsonb NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT')),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (po_id, proposal_id, classification)
);
CREATE TRIGGER mission_purchase_reconciliations_append_only BEFORE UPDATE OR DELETE ON mission_purchase_reconciliations
  FOR EACH ROW EXECUTE FUNCTION mission_procurement_guard();
