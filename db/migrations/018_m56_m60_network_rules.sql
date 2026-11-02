-- M56-M60: additive recourse and network acceptance evidence.

CREATE TABLE network_recourse_cases (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  authority_reference text NOT NULL,
  action_reference text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','UNKNOWN')),
  state text NOT NULL CHECK (state IN ('OPEN','EVIDENCE_COMPLETE','RESOLVED','UNRESOLVED')),
  evidence jsonb NOT NULL,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX network_recourse_org_time ON network_recourse_cases (organization_id, opened_at);

CREATE TABLE authority_acceptance_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id),
  verifier_domain text NOT NULL,
  issuer_domain text NOT NULL,
  authority_reference text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('VALID','INVALID','EXPIRED','REVOKED','UNKNOWN')),
  protocol text NOT NULL,
  rail text,
  beneficiary_opened_payflow boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX authority_acceptance_verifier_time ON authority_acceptance_events (verifier_domain, occurred_at);
