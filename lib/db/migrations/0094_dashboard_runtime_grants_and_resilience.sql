-- =============================================================================
-- 0094_dashboard_runtime_grants_and_resilience.sql
--
-- Production repair migration:
-- Ensure the runtime DB role used for tenant-scoped RLS queries has the minimal
-- privileges required by /api/dashboard (including optional dashboard sections)
-- and dashboard cache table access. Idempotent and safe to re-run.
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
  IF to_regclass('public.case_billing_entries') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.case_billing_entries TO app_user';
  END IF;
  IF to_regclass('public.case_ledgers') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.case_ledgers TO app_user';
  END IF;
  IF to_regclass('public.case_communications') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.case_communications TO app_user';
  END IF;

  IF to_regclass('public.firm_dashboard_stats_cache') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.firm_dashboard_stats_cache TO app_user';
  END IF;
END $do$;

SELECT pg_notify('pgrst', 'reload schema');

