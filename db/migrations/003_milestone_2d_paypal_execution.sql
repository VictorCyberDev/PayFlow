ALTER TABLE payment_attempts ALTER COLUMN status DROP DEFAULT;
ALTER TABLE payment_attempts ALTER COLUMN status TYPE text USING status::text;
DROP TYPE payment_attempt_status;

ALTER TABLE payment_attempts
  ADD COLUMN grant_id text REFERENCES execution_grants(id),
  ADD COLUMN proposal_id text REFERENCES transaction_proposals(id),
  ADD COLUMN mandate_id text REFERENCES mandates(id),
  ADD COLUMN principal_id text REFERENCES principals(id),
  ADD COLUMN operation text NOT NULL DEFAULT 'CAPTURE' CHECK (operation = 'CAPTURE'),
  ADD COLUMN amount_minor bigint CHECK (amount_minor > 0),
  ADD COLUMN currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN merchant_reference text,
  ADD COLUMN create_order_request_id text,
  ADD COLUMN capture_request_id text,
  ADD COLUMN provider_capture_id text,
  ADD COLUMN provider_capture_status text,
  ADD COLUMN payer_action_url text,
  ADD COLUMN failure_classification text,
  ADD COLUMN provider_debug_id text,
  ADD COLUMN last_reconciled_at timestamptz,
  ADD COLUMN captured_at timestamptz;

UPDATE payment_attempts SET status='NOT_STARTED' WHERE status IS NULL;
ALTER TABLE payment_attempts ALTER COLUMN status SET DEFAULT 'NOT_STARTED';
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_status_check CHECK (status IN ('NOT_STARTED','ORDER_CREATING','ORDER_CREATE_UNKNOWN','ORDER_CREATED','PAYER_ACTION_REQUIRED','CAPTURE_PENDING','CAPTURE_IN_FLIGHT','CAPTURE_UNKNOWN','CAPTURE_PENDING_PROVIDER','CAPTURED','FAILED','CANCELLED'));
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_provider_check CHECK (provider IN ('PAYPAL','MOCK'));
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_grant_unique UNIQUE (grant_id);
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_reservation_unique UNIQUE (reservation_id);
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_create_request_unique UNIQUE (create_order_request_id);
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_capture_request_unique UNIQUE (capture_request_id);
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_capture_unique UNIQUE (provider_capture_id);
CREATE UNIQUE INDEX payment_attempt_paypal_order_unique ON payment_attempts(provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE INDEX payment_attempt_reconcile_idx ON payment_attempts(status, updated_at) WHERE status IN ('ORDER_CREATE_UNKNOWN','CAPTURE_UNKNOWN','CAPTURE_PENDING_PROVIDER');
