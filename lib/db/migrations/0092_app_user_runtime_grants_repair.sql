-- =============================================================================
-- 0092_app_user_runtime_grants_repair.sql
--
-- Production repair migration:
-- Ensure the runtime DB role used for tenant-scoped RLS queries has the minimal
-- privileges required by dashboard, cases messaging, and document generation
-- job runner endpoints. Idempotent and safe to re-run.
-- =============================================================================

DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

DO $do$ BEGIN
  IF to_regclass('public.firm_dashboard_stats_cache') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.firm_dashboard_stats_cache TO app_user';
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

  IF to_regclass('public.case_messages') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.case_messages TO app_user';
  END IF;
  IF to_regclass('public.case_message_read_status') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.case_message_read_status TO app_user';
  END IF;

  IF to_regclass('public.document_templates') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.document_templates TO app_user';
  END IF;
  IF to_regclass('public.document_generation_jobs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.document_generation_jobs TO app_user';
  END IF;
  IF to_regclass('public.document_generation_job_items') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.document_generation_job_items TO app_user';
  END IF;
  IF to_regclass('public.document_generation_runs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.document_generation_runs TO app_user';
  END IF;
  IF to_regclass('public.case_documents') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.case_documents TO app_user';
  END IF;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'GRANT INSERT, SELECT ON TABLE public.audit_logs TO app_user';
  END IF;
END $do$;

