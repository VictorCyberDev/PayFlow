-- M5E-HOST: additive NON-PRODUCTION demo host state only. This is not financial authority:
-- no foreign key to, and no write to, any mandate, passport, reservation, grant, payment or
-- evidence table. Migrations 001-009 and all historical rows are untouched.
-- Raw session tokens are never stored (only their SHA-256); CSRF values are derived, not stored.
CREATE TABLE console_demo_sessions (
  session_hash char(64) PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  window_started_at timestamptz NOT NULL,
  window_requests integer NOT NULL DEFAULT 0 CHECK (window_requests >= 0),
  CHECK (expires_at > created_at)
);
CREATE INDEX console_demo_sessions_expiry ON console_demo_sessions (expires_at);

-- Single-row bounded login-guessing window shared by every host instance.
CREATE TABLE console_demo_login_window (
  id smallint PRIMARY KEY CHECK (id = 1),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0)
);
INSERT INTO console_demo_login_window (id, window_started_at, attempts)
VALUES (1, 'epoch', 0);

-- Server-only pending exact-confirmation material. The raw activation challenge is stored only
-- as authenticated ciphertext (AES-256-GCM, key derived from the operator bootstrap secret).
-- consumed_at is set by one conditional UPDATE, so a pending action is consumable at most once.
CREATE TABLE console_pending_actions (
  review_id text PRIMARY KEY CHECK (length(review_id) BETWEEN 1 AND 128),
  owner_session_hash char(64) NOT NULL
    REFERENCES console_demo_sessions (session_hash) ON DELETE CASCADE,
  display_hash char(64) NOT NULL CHECK (display_hash ~ '^[a-f0-9]{64}$'),
  agent_id text NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  draft_fingerprint text NOT NULL CHECK (length(draft_fingerprint) <= 128),
  reviewed_hash text NOT NULL CHECK (length(reviewed_hash) <= 128),
  challenge_protected text NOT NULL CHECK (length(challenge_protected) <= 2048),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX console_pending_actions_expiry ON console_pending_actions (expires_at);
CREATE INDEX console_pending_actions_owner ON console_pending_actions (owner_session_hash);
