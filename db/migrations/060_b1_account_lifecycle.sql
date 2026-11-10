-- B1: email verification, password reset and a durable email outbox. Additive only.
-- Tokens are random, shown once (in the email), stored only as digests, single-use and short-lived. The outbox holds the message until it is sent; the
-- body (which contains the token link) is erased when the message is SENT, and a message whose delivery outcome is unclear is UNKNOWN and is never
-- sent again by PayFlow.
ALTER TABLE user_accounts ADD COLUMN email_verified_at timestamptz;
CREATE TABLE user_tokens (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES user_accounts(user_id),
  purpose text NOT NULL CHECK (purpose IN ('VERIFY_EMAIL','RESET_PASSWORD')),
  email text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX user_tokens_user ON user_tokens (user_id, purpose) WHERE used_at IS NULL;
CREATE TABLE email_outbox (
  outbox_id text PRIMARY KEY CHECK (outbox_id ~ '^out_[a-f0-9]{24}$'),
  to_email text NOT NULL CHECK (length(to_email) BETWEEN 5 AND 254),
  template text NOT NULL CHECK (template IN ('VERIFY_EMAIL','RESET_PASSWORD')),
  subject text NOT NULL CHECK (length(subject) <= 200),
  body text CHECK (body IS NULL OR length(body) <= 4000),
  state text NOT NULL CHECK (state IN ('QUEUED','SENDING','SENT','FAILED','UNKNOWN')),
  attempts integer NOT NULL DEFAULT 0,
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (state IN ('QUEUED','SENDING','FAILED','UNKNOWN') OR body IS NULL)
);
CREATE INDEX email_outbox_queued ON email_outbox (created_at) WHERE state = 'QUEUED';
CREATE FUNCTION email_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'email_outbox is append-only'; END IF;
  IF OLD.state IN ('SENT','FAILED') AND NEW.state <> OLD.state THEN RAISE EXCEPTION 'a finished message cannot change'; END IF;
  IF OLD.state = 'UNKNOWN' AND NEW.state NOT IN ('UNKNOWN','SENT','FAILED') THEN RAISE EXCEPTION 'an unknown message is never sent again'; END IF;
  IF NEW.to_email <> OLD.to_email OR NEW.template <> OLD.template THEN RAISE EXCEPTION 'a message''s recipient and template never change'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_outbox_guard BEFORE UPDATE OR DELETE ON email_outbox FOR EACH ROW EXECUTE FUNCTION email_outbox_guard();
