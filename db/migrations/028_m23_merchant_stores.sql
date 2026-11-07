-- M23: shared, durable stores for the Merchant Verify SDK. Additive only.
--
-- A merchant runs several instances; these tables make "a challenge is single use", "a presentation nonce is single use"
-- and "one payment pays one order" true ACROSS instances and restarts. Each row is namespaced by the merchant's id so one
-- database can serve several merchants. Challenges are stored only as a SHA-256 hash: a database leak yields no usable
-- challenge. Atomicity comes from single statements (UPDATE ... WHERE consumed_at IS NULL, INSERT ... ON CONFLICT).
CREATE TABLE merchant_challenges (
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 200),
  challenge_hash char(64) NOT NULL CHECK (challenge_hash ~ '^[a-f0-9]{64}$'),
  order_digest char(64) NOT NULL CHECK (order_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, challenge_hash)
);
CREATE INDEX merchant_challenges_expiry ON merchant_challenges (expires_at);

CREATE TABLE merchant_nonces (
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 200),
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 600),
  nonce text NOT NULL CHECK (length(nonce) BETWEEN 1 AND 300),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (namespace, scope, nonce)
);
CREATE INDEX merchant_nonces_expiry ON merchant_nonces (expires_at);

-- One payment (Proof action id) pays one order, and one order is paid by one payment. Never deleted: it is the
-- merchant's record against double fulfilment.
CREATE TABLE merchant_proof_claims (
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 200),
  action_id text NOT NULL CHECK (length(action_id) BETWEEN 1 AND 300),
  order_id text NOT NULL CHECK (length(order_id) BETWEEN 1 AND 300),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, action_id),
  UNIQUE (namespace, order_id)
);
