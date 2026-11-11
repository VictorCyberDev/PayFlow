-- B6: two-step sign-in with an authenticator app (TOTP). The shared secret is stored only encrypted (AES-256-GCM, key derived from the host key,
-- bound to the user id); recovery codes only as digests; a sign-in that has passed the password but not the second step is a short-lived challenge.
CREATE TABLE user_mfa (
  user_id text PRIMARY KEY REFERENCES user_accounts(user_id),
  secret_enc text NOT NULL CHECK (secret_enc ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  -- NULL while the person is still setting it up: an unconfirmed secret never protects (or blocks) anything.
  enabled_at timestamptz,
  -- the last accepted 30-second step, so one code works once
  last_step bigint NOT NULL DEFAULT 0 CHECK (last_step >= 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE user_recovery_codes (
  user_id text NOT NULL REFERENCES user_accounts(user_id),
  code_hash char(64) NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE user_mfa_challenges (
  challenge_hash char(64) PRIMARY KEY CHECK (challenge_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES user_accounts(user_id),
  member_id text NOT NULL REFERENCES organization_members(member_id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  used_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX user_mfa_challenges_user ON user_mfa_challenges (user_id) WHERE used_at IS NULL;
