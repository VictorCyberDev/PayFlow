-- Forward-only: transactionally allocated evidence sequence numbers do not
-- consume a number on rollback. Existing evidence is never rewritten.
ALTER TABLE evidence_events ALTER COLUMN sequence DROP IDENTITY;
ALTER TABLE mandates ADD COLUMN revoked_at timestamptz;
-- Freeze the proposal evaluated by a receipt, not merely its mutable row ID.
ALTER TABLE decision_receipts ADD COLUMN proposal_snapshot jsonb;
UPDATE decision_receipts d SET proposal_snapshot=p.document
  FROM transaction_proposals p WHERE p.id=d.proposal_id;
ALTER TABLE decision_receipts ALTER COLUMN proposal_snapshot SET NOT NULL;
ALTER TABLE decision_receipts ADD COLUMN document_hash text;
UPDATE decision_receipts SET document_hash=encode(sha256(convert_to(document::text,'UTF8')),'hex');
ALTER TABLE decision_receipts ALTER COLUMN document_hash SET NOT NULL;
-- M2A-only test installations have no grant table. Full installations freeze
-- immutable grant columns while leaving lifecycle transitions mutable.
DO $$ BEGIN
  IF to_regclass('execution_grants') IS NOT NULL THEN
    ALTER TABLE execution_grants ADD COLUMN authority_snapshot jsonb;
    UPDATE execution_grants g SET authority_snapshot=to_jsonb(g)-ARRAY['status','claimed_at','consumed_at','failed_at','authority_snapshot'];
  END IF;
END $$;
