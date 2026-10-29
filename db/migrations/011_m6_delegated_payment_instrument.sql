-- M6 only: durable, owner-bound storage for the tokenized PayPal instrument approved once
-- by the Sandbox payer. The stored bytes are AES-256-GCM ciphertext; no PayPal credential,
-- raw setup token, access token, or execution grant is persisted here.
create table if not exists console_demo_payment_instruments (
  principal_id text primary key,
  provider text not null check (provider = 'PAYPAL_SANDBOX'),
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (octet_length(iv) = 12),
  check (octet_length(auth_tag) = 16),
  check (octet_length(ciphertext) between 1 and 512)
);

comment on table console_demo_payment_instruments is
  'NON-PRODUCTION M6 acceptance only: encrypted pre-approved Sandbox payment instrument reference, owner-bound and server-side.';
