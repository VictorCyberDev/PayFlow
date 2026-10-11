-- Additive metadata only: historical financial state and identities are untouched.
CREATE TABLE payment_resume_capabilities (
  payment_attempt_id text PRIMARY KEY REFERENCES payment_attempts(id),
  principal_id text NOT NULL REFERENCES principals(id),
  proposal_id text NOT NULL REFERENCES transaction_proposals(id),
  paypal_order_id text NOT NULL,
  secret_digest char(64) NOT NULL UNIQUE CHECK(secret_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK(expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE FUNCTION immutable_payment_resume() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PAYMENT_RESUME_IMMUTABLE';
END $$;
CREATE TRIGGER immutable_payment_resume BEFORE UPDATE OR DELETE ON payment_resume_capabilities
FOR EACH ROW EXECUTE FUNCTION immutable_payment_resume();
