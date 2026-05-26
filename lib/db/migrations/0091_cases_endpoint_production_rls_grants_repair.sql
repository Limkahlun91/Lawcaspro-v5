-- =============================================================================
-- 0091_cases_endpoint_production_rls_grants_repair.sql
--
-- Production repair migration for /api/cases endpoint:
-- Ensure the runtime DB role has SELECT privileges on tables commonly used by
-- the cases list endpoint. This is idempotent and safe to re-run.
-- =============================================================================

DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

GRANT USAGE ON SCHEMA public TO app_user;

GRANT SELECT ON TABLE public.cases TO app_user;
GRANT SELECT ON TABLE public.clients TO app_user;
GRANT SELECT ON TABLE public.projects TO app_user;
GRANT SELECT ON TABLE public.developers TO app_user;
GRANT SELECT ON TABLE public.users TO app_user;

-- Optional tables used by list filters / joins. If they do not exist in an
-- environment, the migrate runner should skip with a missing-relation error,
-- and the API layer also has compatibility fallback.
DO $do$ BEGIN
  IF to_regclass('public.case_assignments') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.case_assignments TO app_user';
  END IF;
  IF to_regclass('public.case_purchasers') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.case_purchasers TO app_user';
  END IF;
  IF to_regclass('public.case_key_dates') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.case_key_dates TO app_user';
  END IF;
  IF to_regclass('public.case_workflow_steps') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.case_workflow_steps TO app_user';
  END IF;
END $do$;

