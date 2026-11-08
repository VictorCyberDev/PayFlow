-- V3 M50: deliverables and contractor payment. Additive only.
--
-- A DELIVERABLE is a claim that a milestone's work is done (a summary and references). Only a person accepts or rejects it, and accepting
-- needs evidence. A PAYMENT INSTRUCTION is derived from an accepted deliverable, like a purchase order: it says exactly what may be paid, to
-- which payee, by which agent, under which stored Authority. PayFlow does not pay from it: the agent still goes through the one decision path.
-- A RECONCILIATION then reads PayFlow's own operation trace for that payment, compares it to the instruction and moves the milestone's budget
-- item with the evidence the ledger requires. TERMINATION cancels the milestones that have no payment instruction yet and releases their budget.
CREATE TABLE mission_deliverables (
  deliverable_id text PRIMARY KEY CHECK (deliverable_id ~ '^dlv_[a-f0-9]{24}$'),
  seq bigserial NOT NULL UNIQUE,
  mission_id text NOT NULL REFERENCES missions(mission_id),
  contract_id text NOT NULL REFERENCES mission_talent_contracts(contract_id),
  milestone_index integer NOT NULL CHECK (milestone_index >= 1),
  submission jsonb NOT NULL,
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACCEPTED','REJECTED')),
  submitted_by_kind text NOT NULL CHECK (submitted_by_kind IN ('MEMBER','AGENT')),
  submitted_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  submitted_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  evidence_kind text CHECK (evidence_kind IS NULL OR evidence_kind IN ('OWNER_ATTESTATION','DOCUMENT_REF')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 500),
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  UNIQUE (mission_id, submitted_by, idempotency_key),
  CHECK ((status = 'SUBMITTED') = (decided_at IS NULL)),
  CHECK (status <> 'ACCEPTED' OR evidence_kind IS NOT NULL)
);
-- one open submission and one accepted deliverable per milestone
CREATE UNIQUE INDEX mission_deliverables_open ON mission_deliverables (contract_id, milestone_index) WHERE status = 'SUBMITTED';
CREATE UNIQUE INDEX mission_deliverables_accepted ON mission_deliverables (contract_id, milestone_index) WHERE status = 'ACCEPTED';
CREATE FUNCTION mission_deliverables_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'deliverables are never deleted'; END IF;
  IF OLD.status <> 'SUBMITTED' THEN RAISE EXCEPTION 'a decided deliverable cannot change'; END IF;
  IF NEW.deliverable_id <> OLD.deliverable_id OR NEW.contract_id <> OLD.contract_id OR NEW.milestone_index <> OLD.milestone_index
     OR NEW.submission <> OLD.submission OR NEW.submitted_by <> OLD.submitted_by THEN
    RAISE EXCEPTION 'a submission cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_deliverables_guard_t BEFORE UPDATE OR DELETE ON mission_deliverables FOR EACH ROW EXECUTE FUNCTION mission_deliverables_guard();

CREATE TABLE mission_contractor_payments (
  payment_id text PRIMARY KEY CHECK (payment_id ~ '^cpy_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  contract_id text NOT NULL REFERENCES mission_talent_contracts(contract_id),
  milestone_index integer NOT NULL,
  deliverable_id text NOT NULL UNIQUE REFERENCES mission_deliverables(deliverable_id),
  agent_id text NOT NULL,
  authority_id text NOT NULL REFERENCES mandates(id),
  category text NOT NULL,
  payee text NOT NULL CHECK (payee ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 1),
  document jsonb NOT NULL,
  document_digest char(64) NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
  issued_by_kind text NOT NULL CHECK (issued_by_kind IN ('MEMBER','AGENT')),
  issued_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (contract_id, milestone_index),
  UNIQUE (mission_id, issued_by, idempotency_key)
);
CREATE TRIGGER mission_contractor_payments_append_only BEFORE UPDATE OR DELETE ON mission_contractor_payments FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();

CREATE TABLE mission_contractor_payment_reconciliations (
  seq bigserial PRIMARY KEY,
  payment_id text NOT NULL REFERENCES mission_contractor_payments(payment_id),
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
  UNIQUE (payment_id, proposal_id, classification)
);
CREATE TRIGGER mission_contractor_payment_recs_append_only BEFORE UPDATE OR DELETE ON mission_contractor_payment_reconciliations FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();

CREATE TABLE mission_contract_terminations (
  contract_id text PRIMARY KEY REFERENCES mission_talent_contracts(contract_id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  cancelled_milestones jsonb NOT NULL,
  kept_milestones jsonb NOT NULL,
  terminated_by text NOT NULL,
  terminated_at timestamptz NOT NULL
);
CREATE TRIGGER mission_contract_terminations_append_only BEFORE UPDATE OR DELETE ON mission_contract_terminations FOR EACH ROW EXECUTE FUNCTION mission_fulfillment_guard();
