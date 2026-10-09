CREATE TYPE execution_grant_status AS ENUM ('ISSUED','CLAIMED','CONSUMED','FAILED');

CREATE TABLE execution_grants (
  id text PRIMARY KEY,
  kid text NOT NULL CHECK (length(kid) > 0),
  version text NOT NULL CHECK (version = 'payflow.execution-grant.v1'),
  audience text NOT NULL CHECK (length(audience) > 0),
  principal_id text NOT NULL REFERENCES principals(id),
  agent_id text NOT NULL REFERENCES agent_passports(id),
  mandate_id text NOT NULL REFERENCES mandates(id),
  proposal_id text NOT NULL UNIQUE REFERENCES transaction_proposals(id),
  receipt_id text NOT NULL UNIQUE REFERENCES decision_receipts(id),
  reservation_id text NOT NULL UNIQUE REFERENCES authorization_reservations(id),
  proposal_digest char(64) NOT NULL CHECK (proposal_digest ~ '^[a-f0-9]{64}$'),
  mandate_fingerprint char(64) NOT NULL CHECK (mandate_fingerprint ~ '^[a-f0-9]{64}$'),
  capability text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  merchant_id text NOT NULL CHECK (length(merchant_id) > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status execution_grant_status NOT NULL DEFAULT 'ISSUED',
  claimed_at timestamptz,
  consumed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  CHECK ((status <> 'CLAIMED') OR claimed_at IS NOT NULL),
  CHECK ((status <> 'CONSUMED') OR consumed_at IS NOT NULL),
  CHECK ((status <> 'FAILED') OR failed_at IS NOT NULL)
);
CREATE INDEX execution_grants_reservation_idx ON execution_grants(reservation_id);
CREATE INDEX execution_grants_expires_idx ON execution_grants(expires_at);
