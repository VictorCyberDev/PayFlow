-- M18: agent-to-agent delegation chains with a shared, conserved budget. Additive only.
--
-- A delegation is a signed-in-server-state grant from a parent agent to a child agent, narrower than (or equal to) its
-- parent on every axis. Spend by a descendant is charged to the descendant AND every ancestor in one transaction, so the
-- sum a subtree can ever move is bounded by the root's cap no matter how it is split or how requests interleave.
-- Revoking any node stops that node and everything below it: a spend must find every ancestor un-revoked.
CREATE TABLE delegations (
  delegation_id text PRIMARY KEY CHECK (delegation_id ~ '^dlg_[a-f0-9]{24}$'),
  root_id text NOT NULL,
  parent_id text REFERENCES delegations(delegation_id),
  depth integer NOT NULL CHECK (depth BETWEEN 0 AND 5),
  principal_id text NOT NULL,
  parent_agent_id text NOT NULL,
  child_agent_id text NOT NULL,
  audience text NOT NULL,
  action_kinds text[] NOT NULL CHECK (cardinality(action_kinds) >= 1),
  currencies text[] NOT NULL CHECK (cardinality(currencies) >= 1),
  counterparty_ids text[] NOT NULL CHECK (cardinality(counterparty_ids) >= 1),
  max_amount_minor bigint NOT NULL CHECK (max_amount_minor > 0),
  spent_minor bigint NOT NULL DEFAULT 0,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  nonce text NOT NULL CHECK (length(nonce) >= 16),
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL,
  CHECK (spent_minor >= 0 AND spent_minor <= max_amount_minor),
  CHECK (expires_at > issued_at),
  CHECK ((parent_id IS NULL) = (depth = 0)),
  CHECK ((parent_id IS NULL) = (root_id = delegation_id))
);
CREATE UNIQUE INDEX delegations_nonce ON delegations (audience, parent_agent_id, child_agent_id, nonce);
CREATE INDEX delegations_parent ON delegations (parent_id);
CREATE INDEX delegations_root ON delegations (root_id);
