-- V3 M26: Mission Contract v1. Additive only. (Migration number is a database version, not the product milestone number.)
--
-- A mission is a durable, versioned planning and PERMISSION boundary. It never moves money. Contract versions are immutable;
-- only their decision fields change. Every status change is an append-only transition row.
CREATE TABLE missions (
  mission_id text PRIMARY KEY CHECK (mission_id ~ '^msn_[a-f0-9]{24}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  created_by_member_id text NOT NULL,
  status text NOT NULL CHECK (status IN
    ('DRAFT','PENDING_OWNER_APPROVAL','ACTIVE','PAUSED','COMPLETED','CANCELLED','EXPIRED','REVOKED','FAILED')),
  -- highest version stored (may be proposed or draft), the owner-approved version in force, and a version awaiting approval
  latest_version integer NOT NULL CHECK (latest_version >= 1),
  active_version integer,
  pending_version integer,
  -- optimistic-concurrency counter for the mission row; bumped on every change
  row_version integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (organization_id, environment, idempotency_key),
  CHECK (active_version IS NULL OR active_version <= latest_version),
  CHECK (pending_version IS NULL OR pending_version <= latest_version)
);
CREATE INDEX missions_tenant ON missions (organization_id, environment, created_at, mission_id);

CREATE TABLE mission_versions (
  mission_id text NOT NULL REFERENCES missions(mission_id),
  version integer NOT NULL CHECK (version >= 1),
  contract jsonb NOT NULL,
  contract_digest char(64) NOT NULL CHECK (contract_digest ~ '^[a-f0-9]{64}$'),
  authored_by_kind text NOT NULL CHECK (authored_by_kind IN ('MEMBER','AGENT')),
  authored_by text NOT NULL,
  -- why this version needed (or did not need) an owner decision, from the widening analysis
  widening jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision text NOT NULL CHECK (decision IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (mission_id, version),
  UNIQUE (mission_id, idempotency_key)
);

-- Capabilities granted per agent per version: what `authorizeCapability` reads for the version in force.
CREATE TABLE mission_agent_grants (
  mission_id text NOT NULL,
  version integer NOT NULL,
  agent_id text NOT NULL,
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) >= 1),
  PRIMARY KEY (mission_id, version, agent_id),
  FOREIGN KEY (mission_id, version) REFERENCES mission_versions (mission_id, version)
);
CREATE INDEX mission_agent_grants_agent ON mission_agent_grants (agent_id);

CREATE TABLE mission_transitions (
  mission_id text NOT NULL REFERENCES missions(mission_id),
  seq integer NOT NULL CHECK (seq >= 1),
  from_status text,
  to_status text NOT NULL,
  event text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('MEMBER','AGENT','SYSTEM')),
  actor_id text NOT NULL,
  version integer,
  reason text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (mission_id, seq)
);

-- A contract version never changes after it is written; only its decision columns may. Transitions are append-only.
CREATE FUNCTION mission_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mission versions cannot be deleted'; END IF;
  IF NEW.contract IS DISTINCT FROM OLD.contract OR NEW.contract_digest IS DISTINCT FROM OLD.contract_digest
     OR NEW.authored_by IS DISTINCT FROM OLD.authored_by OR NEW.authored_by_kind IS DISTINCT FROM OLD.authored_by_kind
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
     OR NEW.widening IS DISTINCT FROM OLD.widening OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'mission contract versions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mission_versions_immutable BEFORE UPDATE OR DELETE ON mission_versions
  FOR EACH ROW EXECUTE FUNCTION mission_versions_guard();

CREATE FUNCTION mission_transitions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mission transitions are append-only';
END $$;
CREATE TRIGGER mission_transitions_append_only BEFORE UPDATE OR DELETE ON mission_transitions
  FOR EACH ROW EXECUTE FUNCTION mission_transitions_guard();
