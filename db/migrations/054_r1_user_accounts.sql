-- R1a: customer accounts and browser sessions. Additive only.
--
-- A person signs in with an email and a password and receives an opaque, server-side session carried in an HttpOnly cookie.
-- A session is NOT a new kind of authority: it resolves to exactly one existing organization member (organization, environment,
-- role), and every route then applies the same server-side role checks it applies to a member bearer token. Only digests of the
-- session secret and of the CSRF token are stored. Passwords are stored only as salted scrypt hashes.
CREATE TABLE user_accounts (
  user_id text PRIMARY KEY CHECK (user_id ~ '^pfu_[a-f0-9]{24}$'),
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 5 AND 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL,
  last_login_at timestamptz
);
CREATE UNIQUE INDEX user_accounts_email ON user_accounts (email);

-- Which organization member a user acts as. One user may belong to several organizations; one member row belongs to one user.
CREATE TABLE user_memberships (
  user_id text NOT NULL REFERENCES user_accounts(user_id),
  member_id text NOT NULL UNIQUE REFERENCES organization_members(member_id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, member_id)
);

CREATE TABLE user_sessions (
  session_hash char(64) PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES user_accounts(user_id),
  member_id text NOT NULL REFERENCES organization_members(member_id),
  csrf_hash char(64) NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_user ON user_sessions (user_id) WHERE revoked_at IS NULL;
