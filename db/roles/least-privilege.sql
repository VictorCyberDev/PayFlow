-- M14 least-privilege database roles. Re-runnable: run it as the schema owner after every migration.
--
--   payflow_migrator  DDL. Used ONLY by the migration job. Never by the running app.
--   payflow_runtime   The running app: reads and writes tenant data, appends evidence.
--                     Cannot create, alter, drop or truncate anything, cannot rewrite append-only
--                     ledgers, and cannot read credential/member secret digests back out in bulk.
--   payflow_readonly  Status, Verify and reporting: SELECT only, and never the secret digest columns.
--
-- These are NOLOGIN group roles so no password lives in this repository. Create a login per
-- service with a secret from your secret store and grant it ONE group, for example:
--   CREATE ROLE svc_app LOGIN PASSWORD '<from the secret store>' IN ROLE payflow_runtime;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payflow_migrator') THEN CREATE ROLE payflow_migrator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payflow_runtime')  THEN CREATE ROLE payflow_runtime  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payflow_readonly') THEN CREATE ROLE payflow_readonly NOLOGIN; END IF;
END $$;

-- The role that runs this script must be a member of the group roles to set default privileges for the
-- migrator and to be able to SET ROLE for verification. (A superuser already is.)
GRANT payflow_migrator, payflow_runtime, payflow_readonly TO CURRENT_USER WITH SET TRUE;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO payflow_runtime, payflow_readonly;
GRANT USAGE, CREATE ON SCHEMA public TO payflow_migrator;

-- Reset, then grant exactly what each role needs.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM payflow_runtime, payflow_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM payflow_runtime, payflow_readonly;

-- migrator: owns schema changes.
GRANT ALL ON ALL TABLES IN SCHEMA public TO payflow_migrator;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO payflow_migrator;

-- runtime: data manipulation only (no TRUNCATE, no REFERENCES, no TRIGGER).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO payflow_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO payflow_runtime;

-- Append-only ledgers: the app may add and read, never update or delete.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organization_audit_events','evidence_events'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM payflow_runtime', t);
    END IF;
  END LOOP;
END $$;

-- readonly: SELECT on every column EXCEPT secret digests, and nothing at all on the account-recovery tables.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name, string_agg(format('%I', c.column_name), ', ' ORDER BY c.ordinal_position) AS cols
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.column_name NOT IN ('secret_hash', 'password_hash', 'session_hash', 'csrf_hash', 'token_hash')
      -- Account-recovery material (live reset links, recipient addresses, sign-in digests) is for the running app only.
      AND c.table_name NOT IN ('email_outbox', 'user_tokens', 'user_sessions')
    GROUP BY c.table_name
  LOOP
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO payflow_readonly', r.cols, r.table_name);
  END LOOP;
END $$;

-- Future tables created by the migration job inherit the same split.
ALTER DEFAULT PRIVILEGES FOR ROLE payflow_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO payflow_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE payflow_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO payflow_runtime;
