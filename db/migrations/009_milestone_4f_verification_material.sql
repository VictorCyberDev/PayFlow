-- Additive proof material only. No old financial rows or hashes are rewritten.
CREATE TABLE authorization_verification_material (
  receipt_id text PRIMARY KEY REFERENCES decision_receipts(id),
  document jsonb NOT NULL CHECK(octet_length(document::text)<=8192),
  fingerprint char(64) NOT NULL
);
CREATE TABLE execution_grant_signatures (
  grant_id text PRIMARY KEY REFERENCES execution_grants(id),
  signed_token text NOT NULL CHECK(length(signed_token)<=8192)
);
CREATE TABLE paypal_provider_observations (
  id uuid PRIMARY KEY,
  payment_attempt_id text NOT NULL REFERENCES payment_attempts(id),
  phase text NOT NULL CHECK(phase IN ('CREATE','GET','CAPTURE')),
  document jsonb NOT NULL CHECK(octet_length(document::text)<=16384),
  fingerprint char(64) NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE INDEX paypal_observations_attempt ON paypal_provider_observations(payment_attempt_id,observed_at,id);
CREATE FUNCTION immutable_verification_material() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'VERIFICATION_MATERIAL_IMMUTABLE'; END $$;
CREATE TRIGGER immutable_authorization_material BEFORE UPDATE OR DELETE ON authorization_verification_material FOR EACH ROW EXECUTE FUNCTION immutable_verification_material();
CREATE TRIGGER immutable_grant_signature BEFORE UPDATE OR DELETE ON execution_grant_signatures FOR EACH ROW EXECUTE FUNCTION immutable_verification_material();
CREATE TRIGGER immutable_provider_observation BEFORE UPDATE OR DELETE ON paypal_provider_observations FOR EACH ROW EXECUTE FUNCTION immutable_verification_material();

CREATE TABLE discovery_ranking_material (
 selection_id uuid PRIMARY KEY REFERENCES commerce_discovery_selections(id),
 document jsonb NOT NULL CHECK(octet_length(document::text)<=65536),
 fingerprint char(64) NOT NULL
);
CREATE TRIGGER immutable_ranking_material BEFORE UPDATE OR DELETE ON discovery_ranking_material FOR EACH ROW EXECUTE FUNCTION immutable_verification_material();

CREATE TABLE commerce_quote_refusals (
 selection_id uuid PRIMARY KEY REFERENCES commerce_discovery_selections(id),
 document jsonb NOT NULL CHECK(octet_length(document::text)<=8192),
 fingerprint char(64) NOT NULL
);
CREATE TRIGGER immutable_quote_refusal BEFORE UPDATE OR DELETE ON commerce_quote_refusals FOR EACH ROW EXECUTE FUNCTION immutable_verification_material();
