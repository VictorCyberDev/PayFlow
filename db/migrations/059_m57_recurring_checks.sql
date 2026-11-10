-- V3 M57 (a slice): recurring renewal checks. Additive only.
-- Each time a recurrence comes due it is checked against the mission as it is then, and the OUTCOME is written here once. A recurrence never spends:
-- DUE_FOR_OWNER means the owner is asked. One row per schedule and slot, so a replayed or duplicated job records nothing twice. Rows are append-only.
CREATE TABLE recurring_checks (
  check_id text PRIMARY KEY CHECK (check_id ~ '^rck_[a-f0-9]{24}$'),
  organization_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  mission_id text NOT NULL REFERENCES missions(mission_id),
  schedule_id text NOT NULL REFERENCES automation_schedules(schedule_id),
  slot timestamptz NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('DUE_FOR_OWNER','SKIPPED_MISSION_NOT_ACTIVE','SKIPPED_MISSION_EXPIRED','SKIPPED_ABOVE_PURCHASE_LIMIT','SKIPPED_NO_BUDGET_LEFT','SKIPPED_CURRENCY_CHANGED')),
  checked_at timestamptz NOT NULL,
  UNIQUE (schedule_id, slot)
);
CREATE INDEX recurring_checks_mission ON recurring_checks (mission_id, slot DESC);
CREATE FUNCTION recurring_checks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recurring_checks is append-only'; END $$;
CREATE TRIGGER recurring_checks_guard BEFORE UPDATE OR DELETE ON recurring_checks FOR EACH ROW EXECUTE FUNCTION recurring_checks_guard();
