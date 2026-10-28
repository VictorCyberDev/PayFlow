-- M51-M55: additive region, issuer trust, transparency, and machine Authority state.

CREATE TABLE issuer_trust_profiles (
  issuer text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('TRUSTED','SUSPENDED','REVOKED')),
  profile jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE key_transparency_log (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issuer text NOT NULL,
  key_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','ROTATING','REVOKED')),
  public_key_digest char(64) NOT NULL CHECK (public_key_digest ~ '^[a-f0-9]{64}$'),
  previous_hash char(64),
  entry_hash char(64) NOT NULL UNIQUE CHECK (entry_hash ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX key_transparency_issuer_sequence ON key_transparency_log (issuer, sequence);

CREATE TABLE reservation_region_ownership (
  reservation_id text PRIMARY KEY REFERENCES reservations(id),
  owner_region text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE machine_authorities (
  authority_id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  sponsor_principal_id text NOT NULL REFERENCES principals(id),
  machine_identity text NOT NULL,
  policy jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX machine_authorities_identity ON machine_authorities (machine_identity, status, expires_at);
