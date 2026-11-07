-- V3 M37: supplier communication. Additive only.
--
-- A CONTACT is an address a person registered for a supplier (and said how they know it is the supplier's). Agents never choose a
-- recipient. A MESSAGE is outbound (drafted, approved by a person, then sent through a channel) or inbound (recorded, untrusted).
-- A message's content never changes; only its status moves, one legal step at a time, and every step is an event. A message whose
-- delivery cannot be confirmed is DELIVERY_UNKNOWN and is resolved by a person, never retried automatically.
CREATE TABLE mission_supplier_contacts (
  contact_id text PRIMARY KEY CHECK (contact_id ~ '^cnt_[a-f0-9]{24}$'),
  supplier_id text NOT NULL REFERENCES mission_suppliers(supplier_id),
  channel text NOT NULL CHECK (channel IN ('EMAIL')),
  address text NOT NULL CHECK (length(address) BETWEEN 3 AND 254 AND address !~ '[\r\n\s,;<>]'),
  basis text NOT NULL CHECK (length(basis) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DO_NOT_CONTACT')),
  added_by text NOT NULL,
  added_at timestamptz NOT NULL,
  status_by text,
  status_at timestamptz
);
CREATE UNIQUE INDEX mission_supplier_contacts_unique ON mission_supplier_contacts (supplier_id, channel, lower(address));
CREATE FUNCTION mission_supplier_contacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contacts are never deleted'; END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.supplier_id <> OLD.supplier_id OR NEW.channel <> OLD.channel
     OR NEW.address <> OLD.address OR NEW.basis <> OLD.basis OR NEW.added_by <> OLD.added_by OR NEW.added_at <> OLD.added_at THEN
    RAISE EXCEPTION 'only the status of a contact may change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_supplier_contacts_guard_trg BEFORE UPDATE OR DELETE ON mission_supplier_contacts
  FOR EACH ROW EXECUTE FUNCTION mission_supplier_contacts_guard();

CREATE TABLE mission_messages (
  message_id text PRIMARY KEY CHECK (message_id ~ '^msg_[a-f0-9]{24}$'),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  supplier_id text NOT NULL REFERENCES mission_suppliers(supplier_id),
  contact_id text REFERENCES mission_supplier_contacts(contact_id),
  direction text NOT NULL CHECK (direction IN ('OUTBOUND','INBOUND')),
  kind text NOT NULL CHECK (kind IN ('INQUIRY','NEGOTIATION','NOTICE','REPLY')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 150 AND subject !~ '[\r\n]'),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  move jsonb,
  negotiation_id text REFERENCES mission_negotiations(negotiation_id),
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED','SENDING','SENT','DELIVERY_UNKNOWN','FAILED','RECEIVED')),
  authored_by_kind text NOT NULL CHECK (authored_by_kind IN ('MEMBER','AGENT')),
  authored_by text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  channel_ref text,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  UNIQUE (mission_id, authored_by, idempotency_key),
  CHECK ((direction = 'INBOUND') = (status = 'RECEIVED')),
  CHECK (direction = 'INBOUND' OR contact_id IS NOT NULL),
  CHECK (kind <> 'NEGOTIATION' OR (move IS NOT NULL AND negotiation_id IS NOT NULL))
);
CREATE INDEX mission_messages_mission ON mission_messages (mission_id, created_at);
CREATE FUNCTION mission_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'messages are never deleted'; END IF;
  IF NEW.message_id <> OLD.message_id OR NEW.mission_id <> OLD.mission_id OR NEW.supplier_id <> OLD.supplier_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.direction <> OLD.direction OR NEW.kind <> OLD.kind
     OR NEW.subject <> OLD.subject OR NEW.body <> OLD.body OR NEW.move IS DISTINCT FROM OLD.move
     OR NEW.negotiation_id IS DISTINCT FROM OLD.negotiation_id OR NEW.authored_by <> OLD.authored_by
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_digest <> OLD.request_digest OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the content of a message never changes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_messages_guard_trg BEFORE UPDATE OR DELETE ON mission_messages
  FOR EACH ROW EXECUTE FUNCTION mission_messages_guard();

CREATE TABLE mission_message_events (
  seq bigserial PRIMARY KEY,
  message_id text NOT NULL REFERENCES mission_messages(message_id),
  from_status text,
  to_status text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT','SYSTEM')),
  actor_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX mission_message_events_message ON mission_message_events (message_id, seq);
CREATE FUNCTION mission_message_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'message events are append-only'; END $$;
CREATE TRIGGER mission_message_events_append_only BEFORE UPDATE OR DELETE ON mission_message_events
  FOR EACH ROW EXECUTE FUNCTION mission_message_events_guard();
