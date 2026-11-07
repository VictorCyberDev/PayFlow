-- M22: portable Authority credentials issued from stored Gateway Authorities. Additive only.
--
-- A row records one issued credential: who asked, which stored Authority it came from (and that Authority's
-- fingerprint at issuance), exactly what it says, and its lifecycle. The signed credential is a public document (it
-- carries no secret) and is stored so an idempotent retry returns byte-identical output.
CREATE TABLE portable_credentials (
  jti text PRIMARY KEY CHECK (jti ~ '^pac_[a-f0-9]{24}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  authority_id text NOT NULL REFERENCES mandates(id),
  authority_fingerprint char(64) NOT NULL CHECK (authority_fingerprint ~ '^[a-f0-9]{64}$'),
  agent_id text NOT NULL,
  principal_id text NOT NULL,
  issuer text NOT NULL,
  kid text NOT NULL,
  holder_thumbprint text NOT NULL,
  audience text[],
  scope jsonb NOT NULL,
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  credential jsonb NOT NULL,
  issued_by_member_id text NOT NULL,
  issued_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_member_id text,
  revoked_reason text,
  CHECK (expires_at > not_before),
  CHECK ((revoked_at IS NULL) = (revoked_by_member_id IS NULL)),
  UNIQUE (organization_id, environment, idempotency_key)
);
CREATE INDEX portable_credentials_org ON portable_credentials (organization_id, environment, authority_id);
CREATE INDEX portable_credentials_status ON portable_credentials (issuer, expires_at) WHERE revoked_at IS NOT NULL;
