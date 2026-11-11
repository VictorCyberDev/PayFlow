-- B3: organization invitations. A person with member-management rights invites an email address into their organization with a role; the invitee
-- accepts while signed in as that address, with the address verified. The link carries a random token stored only as a digest.
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_template_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_template_check CHECK (template IN ('VERIFY_EMAIL','RESET_PASSWORD','INVITE'));

CREATE TABLE organization_invitations (
  invitation_id text PRIMARY KEY CHECK (invitation_id ~ '^inv_[a-f0-9]{24}$'),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 5 AND 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- An invitation never grants OWNER: ownership is not handed out by email.
  role text NOT NULL CHECK (role IN ('FINANCE_ADMIN','SECURITY_ADMIN','DEVELOPER','APPROVER','AUDITOR','VIEWER')),
  invited_by_member_id text NOT NULL REFERENCES organization_members(member_id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_user_id text REFERENCES user_accounts(user_id),
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL))
);
-- At most one open invitation per address and organization: inviting again replaces the earlier one.
CREATE UNIQUE INDEX organization_invitations_open ON organization_invitations (organization_id, environment, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX organization_invitations_org ON organization_invitations (organization_id, created_at DESC);

-- A finished invitation never changes again, and the role, address, organization and token never change.
CREATE FUNCTION organization_invitations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'invitations are never deleted'; END IF;
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'a finished invitation cannot change'; END IF;
  IF NEW.token_hash <> OLD.token_hash OR NEW.email <> OLD.email OR NEW.role <> OLD.role OR NEW.organization_id <> OLD.organization_id
     OR NEW.environment <> OLD.environment OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'an invitation''s token, address, role and organization never change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_invitations_guard BEFORE UPDATE OR DELETE ON organization_invitations FOR EACH ROW EXECUTE FUNCTION organization_invitations_guard();
