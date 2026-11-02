-- M12/M15: additive design-partner pilot and billing/invoice state.
-- No row in these tables constitutes customer, revenue, or payment evidence by itself.

CREATE TABLE design_partner_pilots (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  workspace_id text NOT NULL,
  environment text NOT NULL CHECK (environment = 'SANDBOX'),
  status text NOT NULL CHECK (status IN ('DRAFT','ONBOARDING','SANDBOX_ACTIVE','READY_FOR_EXTERNAL_REVIEW','PAUSED','COMPLETED','CANCELLED')),
  sponsor_principal_id text NOT NULL REFERENCES principals(id),
  workflow_name text NOT NULL,
  metric_targets jsonb NOT NULL DEFAULT '[]'::jsonb,
  integration_checklist_completed boolean NOT NULL DEFAULT false,
  security_questionnaire_completed boolean NOT NULL DEFAULT false,
  deployment_checklist_completed boolean NOT NULL DEFAULT false,
  agreement_requirements_reviewed boolean NOT NULL DEFAULT false,
  external_partner_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_id)
);

CREATE TABLE design_partner_feedback (
  id text PRIMARY KEY,
  pilot_id text NOT NULL REFERENCES design_partner_pilots(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('INTEGRATION','SECURITY','PRODUCT','OPERATIONS','COMMERCIAL')),
  source text NOT NULL CHECK (source IN ('INTERNAL','EXTERNAL_PARTNER')),
  message text NOT NULL,
  captured_at timestamptz NOT NULL
);
CREATE INDEX design_partner_feedback_pilot_time ON design_partner_feedback (pilot_id, captured_at);

CREATE TABLE billing_invoices (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  plan_id text NOT NULL CHECK (plan_id IN ('DEVELOPER','PLATFORM','ENTERPRISE')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  status text NOT NULL CHECK (status IN ('DRAFT','FINALIZED','VOID')),
  provider_id text,
  provider_invoice_id text,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  UNIQUE (organization_id, environment, period_start, period_end, plan_id)
);
