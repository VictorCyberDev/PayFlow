-- V3 M29: links from an approved Mission Contract version to the stored Authorities compiled from it. Additive only.
--
-- A mission never decides anything. When an owner approves a version, each purchase-capable agent gets stored Authorities
-- (existing `mandates`) that are never broader than the contract; the Trust Kernel remains the only decision-maker. This table
-- records which Authority came from which mission version so that pausing, revoking, completing, expiring or superseding a
-- mission can revoke exactly those Authorities, in the same transaction.
CREATE TABLE mission_authorities (
  mission_id text NOT NULL REFERENCES missions(mission_id),
  mission_version integer NOT NULL,
  authority_id text NOT NULL REFERENCES mandates(id),
  agent_id text NOT NULL,
  category text NOT NULL,
  -- the share of the mission budget this Authority may spend, after what earlier Authorities for the same agent already spent
  allocation_minor bigint NOT NULL CHECK (allocation_minor >= 1),
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  revoked_reason text,
  compiled_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (authority_id),
  FOREIGN KEY (mission_id, mission_version) REFERENCES mission_versions (mission_id, version)
);
CREATE INDEX mission_authorities_mission ON mission_authorities (mission_id, status);
-- At most one ACTIVE Authority per mission, agent and category, so compilation is idempotent.
CREATE UNIQUE INDEX mission_authorities_active ON mission_authorities (mission_id, agent_id, category) WHERE status = 'ACTIVE';
