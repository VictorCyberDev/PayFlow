-- B1 hardening. A message now carries the digest of the token it contains, an expiry, and a send lease, so a crash can be told apart from
-- a slow send and an expired recovery link does not sit in the database as a readable secret.
ALTER TABLE email_outbox
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN token_hash text CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$');
CREATE INDEX email_outbox_stale ON email_outbox (lease_until) WHERE state = 'SENDING';
CREATE INDEX email_outbox_unknown ON email_outbox (created_at) WHERE state = 'UNKNOWN';

CREATE OR REPLACE FUNCTION email_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'email_outbox is append-only'; END IF;
  IF OLD.state IN ('SENT','FAILED') AND NEW.state <> OLD.state THEN RAISE EXCEPTION 'a finished message cannot change'; END IF;
  IF OLD.state = 'UNKNOWN' AND NEW.state NOT IN ('UNKNOWN','SENT','FAILED') THEN RAISE EXCEPTION 'an unknown message is never sent again'; END IF;
  IF NEW.to_email <> OLD.to_email OR NEW.template <> OLD.template THEN RAISE EXCEPTION 'a message''s recipient and template never change'; END IF;
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'a message''s token and expiry never change'; END IF;
  -- Once a body has been erased it is never written back.
  IF OLD.body IS NULL AND NEW.body IS NOT NULL THEN RAISE EXCEPTION 'an erased body is never restored'; END IF;
  RETURN NEW;
END $$;
