-- V3 M28: Project Budget and Commitment Ledger. Additive only.
--
-- One ITEM is one economic obligation unit that moves through stages (estimate -> quote -> approval -> commitment -> reservation ->
-- in-flight -> settled, or cancelled/released/refunded). An item has exactly ONE amount at a time, so a commitment that moves from
-- committed to reserved to settled is never counted twice. Money is integer minor units in one explicit currency (the mission's).
-- Entries are an append-only history; the item row is the current state.
CREATE TABLE mission_ledger_items (
  item_id text PRIMARY KEY CHECK (item_id ~ '^itm_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('MEMBER','AGENT','SYSTEM')),
  created_by text NOT NULL,
  agent_id text,
  kind text NOT NULL CHECK (kind IN ('GOODS','SERVICE','SUBSCRIPTION','DEPOSIT','CONTRACTOR_MILESTONE','FEE','OTHER')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 1),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  stage text NOT NULL CHECK (stage IN
    ('ESTIMATED','QUOTED','APPROVED','COMMITTED','RESERVED','IN_FLIGHT','SETTLED','UNKNOWN','REFUNDED','CANCELLED','RELEASED','FAILED')),
  -- how well the obligation is known: enforced by PayFlow, confirmed by a provider, reported by the owner, or unverified
  verification text NOT NULL CHECK (verification IN ('PAYFLOW_ENFORCED','PROVIDER_CONFIRMED','OWNER_REPORTED','UNVERIFIED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (mission_id, idempotency_key)
);
CREATE INDEX mission_ledger_items_mission ON mission_ledger_items (mission_id, stage);

CREATE TABLE mission_ledger_entries (
  item_id text NOT NULL REFERENCES mission_ledger_items(item_id),
  seq integer NOT NULL CHECK (seq >= 1),
  from_stage text,
  to_stage text NOT NULL,
  amount_minor bigint NOT NULL,
  refunded_minor bigint NOT NULL DEFAULT 0,
  verification text NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN
    ('NONE','AGENT_REPORTED','OWNER_REPORTED','PAYFLOW_AUTHORITY_RECEIPT','PAYFLOW_PROOF','PROVIDER_CONFIRMATION')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT','SYSTEM')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (item_id, seq),
  UNIQUE (item_id, idempotency_key)
);
CREATE FUNCTION mission_ledger_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger entries are append-only'; END $$;
CREATE TRIGGER mission_ledger_entries_append_only BEFORE UPDATE OR DELETE ON mission_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION mission_ledger_entries_guard();
