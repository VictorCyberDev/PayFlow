-- V3 M86: make the key transparency log usable and tamper-evident. Additive only; alters, creates nothing.
--
-- `key_transparency_log` has existed since migration 017 and nothing ever wrote to it. Two things stopped it being a
-- transparency log in the sense that word is normally used:
--
--   1. Its status vocabulary ('ACTIVE','ROTATING','REVOKED') could not express what proof_signing_keys actually does.
--      That table gained NEXT (announced, not yet signing) and uses RETIRED where this said ROTATING, so a faithful
--      record of a real key change could not be written at all. ROTATING is kept, because an older entry may use it.
--   2. It had no append-only guard. A transparency log that can be edited is not one: the whole property on offer is
--      that an issuer cannot change the past undetectably, and UPDATE/DELETE hands exactly that back.
--
-- The chain itself is unchanged and remains ONE log across all issuers, each entry naming its issuer, which is what the
-- contiguous `sequence` in verifyTransparencyLog expects and how transparency logs are normally built.
ALTER TABLE key_transparency_log DROP CONSTRAINT key_transparency_log_status_check;
ALTER TABLE key_transparency_log ADD CONSTRAINT key_transparency_log_status_check
  CHECK (status IN ('ACTIVE','ROTATING','REVOKED','RETIRED','NEXT'));

-- The first entry of the chain, and only the first, has no predecessor.
ALTER TABLE key_transparency_log ADD CONSTRAINT key_transparency_log_first_entry
  CHECK ((previous_hash IS NULL) = (sequence = 1));

CREATE FUNCTION key_transparency_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'the key transparency log is append-only'; END $$;
CREATE TRIGGER key_transparency_log_guard BEFORE UPDATE OR DELETE ON key_transparency_log
  FOR EACH ROW EXECUTE FUNCTION key_transparency_log_guard();
