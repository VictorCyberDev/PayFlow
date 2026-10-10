-- Additive: old mandate JSON and fingerprints are untouched. Legacy reservations
-- keep NULL quantity; only quantity-limited mandates use the new accounting.
ALTER TABLE principals ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE','DISABLED','REVOKED'));
ALTER TABLE principals ADD COLUMN security_epoch bigint NOT NULL DEFAULT 0 CHECK(security_epoch>=0);
ALTER TABLE agent_passports ADD COLUMN security_epoch bigint NOT NULL DEFAULT 0 CHECK(security_epoch>=0);
ALTER TABLE authorization_reservations ADD COLUMN quantity bigint CHECK(quantity>0 AND quantity<=1000);

CREATE TABLE intent_activation_policies (
  principal_id text PRIMARY KEY REFERENCES principals(id),
  document jsonb NOT NULL,
  document_hash char(64) NOT NULL,
  status text NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
  security_epoch bigint NOT NULL DEFAULT 0 CHECK(security_epoch>=0)
);
CREATE FUNCTION advance_intent_security_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Any update is conservatively stale, even if an operator restores old values.
  NEW.security_epoch := OLD.security_epoch + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER principal_security_epoch BEFORE UPDATE OF status ON principals FOR EACH ROW EXECUTE FUNCTION advance_intent_security_epoch();
CREATE TRIGGER passport_security_epoch BEFORE UPDATE ON agent_passports FOR EACH ROW EXECUTE FUNCTION advance_intent_security_epoch();
CREATE TRIGGER policy_security_epoch BEFORE UPDATE ON intent_activation_policies FOR EACH ROW EXECUTE FUNCTION advance_intent_security_epoch();

CREATE TABLE intent_reviews (
  id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES principals(id),
  agent_id text NOT NULL REFERENCES agent_passports(id),
  draft_fingerprint char(64) NOT NULL CHECK(draft_fingerprint ~ '^[a-f0-9]{64}$'),
  reviewed_document jsonb NOT NULL,
  reviewed_hash char(64) NOT NULL CHECK(reviewed_hash ~ '^[a-f0-9]{64}$'),
  challenge_hash char(64) NOT NULL UNIQUE CHECK(challenge_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACTIVATED','CANCELLED')),
  mandate_id text UNIQUE REFERENCES mandates(id),
  confirmed_at timestamptz,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
  CHECK((status='ACTIVATED' AND mandate_id IS NOT NULL AND confirmed_at IS NOT NULL) OR (status IN ('PENDING','CANCELLED') AND mandate_id IS NULL AND confirmed_at IS NULL))
);
CREATE INDEX intent_reviews_pending_expiry ON intent_reviews(expires_at) WHERE status='PENDING';
ALTER TABLE mandates ADD COLUMN intent_review_id text UNIQUE REFERENCES intent_reviews(id);
