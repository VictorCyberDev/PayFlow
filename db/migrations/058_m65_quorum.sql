-- V3 M65: approval quorum. Additive only. With NO policy row, mission approval behaves exactly as before (one owner approves).
-- A policy makes approvals above a threshold need N distinct owners other than the requester. Votes are append-only: the first vote of a member counts.
CREATE TABLE org_quorum_policies (
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  policy jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, environment)
);
CREATE TABLE mission_approval_votes (
  mission_id text NOT NULL REFERENCES missions(mission_id),
  version integer NOT NULL CHECK (version >= 1),
  member_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE')),
  voted_at timestamptz NOT NULL,
  PRIMARY KEY (mission_id, version, member_id)
);
CREATE FUNCTION mission_approval_votes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'mission_approval_votes is append-only'; END $$;
CREATE TRIGGER mission_approval_votes_guard BEFORE UPDATE OR DELETE ON mission_approval_votes FOR EACH ROW EXECUTE FUNCTION mission_approval_votes_guard();
