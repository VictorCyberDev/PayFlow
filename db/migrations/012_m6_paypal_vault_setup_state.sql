-- M6 acceptance hardening: server-owned, session-bound PayPal setup-token state.
-- The browser never receives or stores the PayPal setup token. Only a random callback state
-- leaves the server; its SHA-256 digest is persisted. The setup token itself is AES-256-GCM
-- ciphertext, bound to the authenticated console session and consumed at most once.
create table if not exists console_demo_paypal_vault_setups (
  state_hash char(64) primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  owner_session_hash char(64) not null
    references console_demo_sessions (session_hash) on delete cascade,
  principal_id text not null check (length(principal_id) between 1 and 128),
  setup_ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  check (octet_length(iv) = 12),
  check (octet_length(auth_tag) = 16),
  check (octet_length(setup_ciphertext) between 1 and 512),
  check (expires_at > created_at)
);

create index if not exists console_demo_paypal_vault_setups_owner
  on console_demo_paypal_vault_setups (owner_session_hash);
create index if not exists console_demo_paypal_vault_setups_expiry
  on console_demo_paypal_vault_setups (expires_at);

comment on table console_demo_paypal_vault_setups is
  'NON-PRODUCTION M6 acceptance only: encrypted one-time PayPal setup token bound to one authenticated console session; browser receives only random callback state.';
