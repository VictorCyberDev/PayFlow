-- V3 M53: authorized booking and deposits. Additive only.
--
-- A BOOKING INTENT is what the owner approved to attempt for one workspace listing, with the liability FROZEN at approval. It never says a
-- space is reserved or a deposit is paid on its own word: those states need evidence a person attaches. Approval holds budget in the
-- commitment ledger in the same transaction; confirmation turns that hold into a recorded obligation; ending without confirmation releases it.
CREATE TABLE mission_bookings (
  booking_id text PRIMARY KEY CHECK (booking_id ~ '^bkg_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  search_id text NOT NULL REFERENCES mission_workspace_searches(search_id),
  listing_id text NOT NULL,
  listing jsonb NOT NULL,
  stay jsonb NOT NULL,
  frozen jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('PROPOSED','APPROVED','HANDED_OFF','CONFIRMED','UNKNOWN','DECLINED','CANCELLED','EXPIRED')),
  ledger_item_id text REFERENCES mission_ledger_items(item_id),
  penalty_item_id text REFERENCES mission_ledger_items(item_id),
  deadline timestamptz NOT NULL,
  evidence_kind text CHECK (evidence_kind IN ('PROVIDER_CONFIRMATION_REF','DOCUMENT_REF','OWNER_ATTESTATION')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 300),
  deposit_evidence_kind text CHECK (deposit_evidence_kind IN ('PROVIDER_CONFIRMATION_REF','DOCUMENT_REF','OWNER_ATTESTATION')),
  deposit_evidence_ref text CHECK (deposit_evidence_ref IS NULL OR length(deposit_evidence_ref) <= 300),
  deposit_refunded boolean NOT NULL DEFAULT false,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('MEMBER','AGENT')),
  created_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (mission_id, created_by, idempotency_key),
  CHECK (state NOT IN ('APPROVED','HANDED_OFF','CONFIRMED','UNKNOWN') OR ledger_item_id IS NOT NULL),
  CHECK (state <> 'CONFIRMED' OR evidence_kind IS NOT NULL)
);
-- One live booking per listing per mission: two intents for one space cannot both hold budget.
CREATE UNIQUE INDEX mission_bookings_live ON mission_bookings (mission_id, listing_id)
  WHERE state IN ('PROPOSED','APPROVED','HANDED_OFF','CONFIRMED','UNKNOWN');
CREATE TABLE mission_booking_events (
  seq bigserial PRIMARY KEY,
  booking_id text NOT NULL REFERENCES mission_bookings(booking_id),
  from_state text,
  to_state text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT','SYSTEM')),
  actor_id text NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 300),
  occurred_at timestamptz NOT NULL
);
CREATE FUNCTION mission_bookings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mission_bookings is append-only'; END IF;
  IF NEW.booking_id <> OLD.booking_id OR NEW.mission_id <> OLD.mission_id OR NEW.search_id <> OLD.search_id
     OR NEW.listing_id <> OLD.listing_id OR NEW.listing <> OLD.listing OR NEW.stay <> OLD.stay OR NEW.frozen <> OLD.frozen
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a booking''s identity and frozen terms never change';
  END IF;
  IF OLD.state IN ('DECLINED','CANCELLED','EXPIRED') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'a finished booking cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_bookings_guard BEFORE UPDATE OR DELETE ON mission_bookings FOR EACH ROW EXECUTE FUNCTION mission_bookings_guard();
CREATE FUNCTION mission_booking_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'mission_booking_events is append-only'; END $$;
CREATE TRIGGER mission_booking_events_append_only BEFORE UPDATE OR DELETE ON mission_booking_events FOR EACH ROW EXECUTE FUNCTION mission_booking_events_guard();
