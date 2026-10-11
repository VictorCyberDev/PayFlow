-- Forward-only commerce records. No historical proposal or grant is rewritten.
ALTER TABLE mandates ADD CONSTRAINT mandates_commerce_owner_unique UNIQUE(id,principal_id,authorized_agent_id);

CREATE TABLE commerce_merchant_bindings (
  merchant_id text NOT NULL CHECK(merchant_id='payflow.demo.merchant'),
  revision bigint NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
  checkout_source_id text NOT NULL CHECK(checkout_source_id='payflow.demo.checkout'),
  environment text NOT NULL CHECK(environment='sandbox'),
  expected_recipient text NOT NULL CHECK(expected_recipient ~ '^[A-Z0-9]{13}$'),
  active boolean NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
  document_hash text NOT NULL CHECK(document_hash=encode(sha256(convert_to(document::text,'UTF8')),'hex')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(merchant_id,revision), UNIQUE(merchant_id,revision,fingerprint)
);
CREATE TABLE commerce_merchant_heads (
  merchant_id text PRIMARY KEY,
  revision bigint NOT NULL,
  FOREIGN KEY(merchant_id,revision) REFERENCES commerce_merchant_bindings(merchant_id,revision)
);
CREATE FUNCTION commerce_advance_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merchant_id<>OLD.merchant_id OR NEW.revision<=OLD.revision THEN
    RAISE EXCEPTION 'MERCHANT_BINDING_REVISION_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_binding_monotonic BEFORE UPDATE ON commerce_merchant_heads FOR EACH ROW EXECUTE FUNCTION commerce_advance_binding();

CREATE TABLE commerce_quotes (
  id text PRIMARY KEY,
  merchant_id text NOT NULL,
  binding_revision bigint NOT NULL,
  binding_fingerprint text NOT NULL,
  principal_id text NOT NULL REFERENCES principals(id),
  agent_id text NOT NULL REFERENCES agent_passports(id),
  mandate_id text NOT NULL,
  mandate_fingerprint text NOT NULL CHECK(mandate_fingerprint ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  document_hash text NOT NULL CHECK(document_hash=encode(sha256(convert_to(document::text,'UTF8')),'hex')),
  offer_document jsonb NOT NULL,
  offer_document_hash text NOT NULL CHECK(offer_document_hash=encode(sha256(convert_to(offer_document::text,'UTF8')),'hex')),
  quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
  unit_minor bigint NOT NULL CHECK(unit_minor BETWEEN 1 AND 9007199254740991),
  subtotal_minor bigint NOT NULL CHECK(subtotal_minor BETWEEN 1 AND 9007199254740991),
  tax_minor bigint NOT NULL CHECK(tax_minor BETWEEN 0 AND 9007199254740991),
  shipping_minor bigint NOT NULL CHECK(shipping_minor BETWEEN 0 AND 9007199254740991),
  discount_minor bigint NOT NULL CHECK(discount_minor BETWEEN 0 AND 9007199254740991),
  fee_minor bigint NOT NULL CHECK(fee_minor BETWEEN 0 AND 9007199254740991),
  total_minor bigint NOT NULL CHECK(total_minor BETWEEN 1 AND 9007199254740991),
  currency text NOT NULL CHECK(currency IN ('USD','EUR','GBP','AUD','CAD','JPY')),
  quoted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(merchant_id,binding_revision,binding_fingerprint) REFERENCES commerce_merchant_bindings(merchant_id,revision,fingerprint),
  FOREIGN KEY(mandate_id,principal_id,agent_id) REFERENCES mandates(id,principal_id,authorized_agent_id),
  CHECK(subtotal_minor::numeric=unit_minor::numeric*quantity),
  CHECK(subtotal_minor::numeric+tax_minor+shipping_minor+fee_minor<=9007199254740991),
  CHECK(total_minor::numeric=subtotal_minor::numeric+tax_minor+shipping_minor+fee_minor-discount_minor),
  CHECK(expires_at>quoted_at AND expires_at<=quoted_at+interval '5 minutes')
);
CREATE INDEX commerce_quotes_expiry ON commerce_quotes(expires_at);
CREATE TABLE commerce_quote_expirations (
  quote_id text PRIMARY KEY REFERENCES commerce_quotes(id),
  observed_at timestamptz NOT NULL
);
CREATE TABLE checkout_manifests (
  id text PRIMARY KEY,
  quote_id text NOT NULL UNIQUE REFERENCES commerce_quotes(id),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL,
  document_hash text NOT NULL CHECK(document_hash=encode(sha256(convert_to(document::text,'UTF8')),'hex')),
  sealed_at timestamptz NOT NULL
);
CREATE TABLE checkout_manifest_proposals (
  manifest_id text PRIMARY KEY REFERENCES checkout_manifests(id),
  proposal_id text NOT NULL UNIQUE REFERENCES transaction_proposals(id),
  proposal_digest text NOT NULL CHECK(proposal_digest ~ '^[a-f0-9]{64}$'),
  linked_at timestamptz NOT NULL
);
CREATE FUNCTION commerce_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_COMMERCE_RECORD'; END $$;
CREATE TRIGGER immutable_merchant_binding BEFORE UPDATE OR DELETE ON commerce_merchant_bindings FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER immutable_binding_head_delete BEFORE DELETE ON commerce_merchant_heads FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER immutable_commerce_quote BEFORE UPDATE OR DELETE ON commerce_quotes FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER immutable_quote_expiration BEFORE UPDATE OR DELETE ON commerce_quote_expirations FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER immutable_checkout_manifest BEFORE UPDATE OR DELETE ON checkout_manifests FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();
CREATE TRIGGER immutable_manifest_proposal BEFORE UPDATE OR DELETE ON checkout_manifest_proposals FOR EACH ROW EXECUTE FUNCTION commerce_immutable_record();

-- Only new commerce-linked proposals are frozen. Foundation historical mutation
-- detection remains unchanged and its tests can still attack historical rows.
CREATE FUNCTION commerce_freeze_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM checkout_manifest_proposals WHERE proposal_id=OLD.id) THEN
    RAISE EXCEPTION 'IMMUTABLE_COMMERCE_PROPOSAL';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER immutable_commerce_proposal BEFORE UPDATE OR DELETE ON transaction_proposals FOR EACH ROW EXECUTE FUNCTION commerce_freeze_proposal();

-- The trusted compiler inserts proposal + link atomically. An arbitrary insert
-- cannot claim server-owned metadata without its exact durable relationship.
CREATE FUNCTION commerce_check_proposal_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb; q commerce_quotes; metadata jsonb;
BEGIN
  metadata := NEW.document->'metadata';
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(metadata,'{}'::jsonb)) k WHERE k LIKE 'payflow.commerce.%') THEN
    SELECT cm.document INTO m FROM checkout_manifest_proposals l
      JOIN checkout_manifests cm ON cm.id=l.manifest_id JOIN commerce_quotes cq ON cq.id=cm.quote_id
      WHERE l.proposal_id=NEW.id;
    SELECT cq.* INTO q FROM checkout_manifest_proposals l JOIN checkout_manifests cm ON cm.id=l.manifest_id JOIN commerce_quotes cq ON cq.id=cm.quote_id WHERE l.proposal_id=NEW.id;
    IF m IS NULL OR metadata IS DISTINCT FROM jsonb_build_object(
      'payflow.commerce.manifestId',m->>'manifestId',
      'payflow.commerce.manifestVersion',m->>'version',
      'payflow.commerce.manifestFingerprint',(SELECT fingerprint FROM checkout_manifests WHERE id=m->>'manifestId'))
      OR NEW.mandate_id<>q.mandate_id OR NEW.agent_id<>q.agent_id
      OR NEW.document->>'mandateFingerprint' IS DISTINCT FROM q.mandate_fingerprint
      OR NEW.amount_minor<>q.total_minor OR NEW.currency::text<>q.currency
      OR NEW.document->>'requestedCapability' IS DISTINCT FROM 'CAPTURE_PAYMENT'
      OR NEW.document->'merchant'->>'id' IS DISTINCT FROM q.merchant_id
      OR NEW.document->>'category' IS DISTINCT FROM 'KEYBOARD'
      OR NEW.document->>'condition' IS DISTINCT FROM m->>'condition'
      OR (NEW.document->>'quantity')::bigint IS DISTINCT FROM q.quantity THEN
      RAISE EXCEPTION 'COMMERCE_PROPOSAL_LINK_INVALID';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER commerce_proposal_link_valid AFTER INSERT OR UPDATE ON transaction_proposals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce_check_proposal_link();
