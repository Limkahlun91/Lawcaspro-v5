-- 0104_migration_idempotency_hardening.sql
-- Hardening for production-safe reruns / partial deploy recoveries.
-- - Ensure job_queue view runs with invoker rights (RLS not bypassed).
-- - Make bank_transactions FK addition idempotent.
-- - Restore firms.subscription_plan as a compatibility mirror.

DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

CREATE OR REPLACE VIEW job_queue
WITH (security_invoker = true)
AS
SELECT
  id AS job_id,
  firm_id,
  job_type,
  status,
  action,
  config AS payload,
  created_by,
  created_at,
  started_at,
  finished_at,
  error_summary,
  download_object_path,
  download_file_name,
  download_mime_type
FROM document_generation_jobs;

GRANT SELECT ON job_queue TO app_user;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_bank_transactions_bank_account'
  ) THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT fk_bank_transactions_bank_account
      FOREIGN KEY (bank_account_id)
      REFERENCES firm_bank_accounts(id)
      ON DELETE SET NULL;
  END IF;
END $do$;

ALTER TABLE firms
  ADD COLUMN IF NOT EXISTS subscription_plan text;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'firms'
      AND column_name = 'subscription_plan_id'
  ) THEN
    EXECUTE $sql$
      UPDATE firms f
      SET subscription_plan = p.name
      FROM subscription_plans p
      WHERE f.subscription_plan_id = p.id
        AND (f.subscription_plan IS NULL OR btrim(f.subscription_plan) = '')
    $sql$;
  END IF;
END $do$;

