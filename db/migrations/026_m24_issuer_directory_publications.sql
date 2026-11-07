-- M24: published issuer directory. Additive only.
--
-- One row per published sequence. A published document is IMMUTABLE and re-served byte for byte until it nears expiry or the
-- key set changes, so two requests (or two instances, or a restart) can never show a verifier two different documents under
-- the same sequence. The signed document is public; it carries only public keys.
CREATE TABLE issuer_directory_publications (
  issuer text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  keys_digest char(64) NOT NULL CHECK (keys_digest ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL,
  -- The exact bytes served. jsonb reorders keys, so identical-bytes-forever is guaranteed by this column, not by jsonb.
  document_text text NOT NULL,
  issued_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  signed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, sequence),
  CHECK (valid_until > issued_at)
);

-- A key can be announced (NEXT) before it signs: it is trusted by the directory chain but is neither the signing key nor
-- published for Proof verification. At most one ACTIVE key per issuer is unchanged.
ALTER TABLE proof_signing_keys DROP CONSTRAINT proof_signing_keys_status_check;
ALTER TABLE proof_signing_keys ADD CONSTRAINT proof_signing_keys_status_check
  CHECK (status IN ('ACTIVE','RETIRED','REVOKED','NEXT'));
