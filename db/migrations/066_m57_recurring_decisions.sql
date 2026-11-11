-- V3 M57: the owner's answer to a recurrence that came due. Additive only.
--
-- Until now `DUE_FOR_OWNER` was a dead end: the check said "your decision is needed" and there was nothing to decide with.
-- A due check now takes exactly one answer, recorded here once and never changed.
--
-- WHAT A DECISION IS NOT: it is not an authorization to spend, and approving one moves no money. The Mission Contract and
-- the Authority are still the only things that can authorize a payment, and a renewal the owner approved still goes the
-- normal approved path (quote, order, Authority) like any other purchase. This table records what the owner WANTS, so the
-- item stops asking and the intent is on the record. That is why there is no amount here: the amount that matters is the
-- one on the eventual purchase, checked against the contract in force at that moment, not the one guessed at setup.
CREATE TABLE recurring_decisions (
  decision_id text PRIMARY KEY CHECK (decision_id ~ '^rcd_[a-f0-9]{24}$'),
  -- one answer per due check: a double submit, a replay or two people clicking at once records once
  check_id text NOT NULL UNIQUE REFERENCES recurring_checks(check_id),
  organization_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  decision text NOT NULL CHECK (decision IN ('APPROVED','DECLINED')),
  decided_by text NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 500),
  decided_at timestamptz NOT NULL
);
CREATE INDEX recurring_decisions_mission ON recurring_decisions (organization_id, environment, mission_id, decided_at DESC);

-- Append-only, like the checks themselves: an answer is a record of what someone decided at a moment, so it is never
-- edited or withdrawn. Changing your mind is a new renewal, not a rewritten past.
CREATE FUNCTION recurring_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recurring_decisions is append-only'; END $$;
CREATE TRIGGER recurring_decisions_guard BEFORE UPDATE OR DELETE ON recurring_decisions
  FOR EACH ROW EXECUTE FUNCTION recurring_decisions_guard();
