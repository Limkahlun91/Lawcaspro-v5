-- Part B: case_assignments Data API hardening
-- Canonical case_assignments is required for tenant isolation.
-- Zero browser consumers. No anonymous/authenticated direct REST access.
-- app_user is the only DML role for runtime case assignments.

-- Ensure app_user exists (idempotent; same pattern as reconcile_pv_idempotency_and_actions.sql).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;

-- (1) Remove direct table access from anon/authenticated/PUBLIC.
-- No browser consumer exists for case_assignments; direct Data API access is not required.
REVOKE ALL PRIVILEGES ON TABLE public.case_assignments FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.case_assignments FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.case_assignments FROM PUBLIC;

-- (2) app_user DML only — no TRUNCATE/TRIGGER/REFERENCES without a proven caller.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.case_assignments TO app_user;

-- (3) Sequence usage for id generator.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'case_assignments_id_seq' AND c.relkind = 'S') THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.case_assignments_id_seq TO app_user';
  END IF;
END $$;

-- (4) Enable RLS (force=on preferred). Owner retention unchanged.
ALTER TABLE public.case_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_assignments FORCE ROW LEVEL SECURITY;

-- (5) Tenant isolation policy via existing Lawcaspro GUC model:
--     SET LOCAL ROLE app_user + SET LOCAL app.current_firm_id = <firm_id>
-- Owner/service_role bypass RLS by default; app_user is NOT BYPASSRLS.
DROP POLICY IF EXISTS case_assignments_firm_isolation ON public.case_assignments;

CREATE POLICY case_assignments_firm_isolation
ON public.case_assignments
FOR ALL
TO app_user
USING (
  EXISTS (
    SELECT 1
    FROM public.cases c
    WHERE
      c.id = case_assignments.case_id
      AND c.firm_id = NULLIF(
        current_setting('app.current_firm_id', true),
        ''
      )::integer
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.cases c
    WHERE
      c.id = case_assignments.case_id
      AND c.firm_id = NULLIF(
        current_setting('app.current_firm_id', true),
        ''
      )::integer
  )
);

-- (6) Policy comment.
COMMENT ON POLICY case_assignments_firm_isolation ON public.case_assignments IS
  'Lawcaspro tenant isolation: rows scoped by cases.firm_id == app.current_firm_id SET LOCAL. Cross-firm reads/writes blocked. Firmwide roles are allowed/denied at the canonical auth canAccessCase layer.';
