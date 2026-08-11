-- 0162: Supporting Documents + Batch Print RLS Repair (ONLY IF MISSING)
-- Idempotent safe: checks current RLS state before applying anything.
-- If policies already in place = clean NOOP.

BEGIN;

-- ==============================================================
-- 1. supporting_documents RLS repair (only if MISSING)
-- ==============================================================
DO $$
DECLARE
  rls_enabled BOOLEAN;
  policy_exists BOOLEAN;
BEGIN
  -- Check if table exists first
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'supporting_documents' AND table_schema = 'public'
  ) THEN
    RAISE NOTICE 'supporting_documents table does not exist yet - skipping (NOOP).';
    RETURN;
  END IF;

  -- Check RLS enabled status
  SELECT c.relrowsecurity INTO rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'supporting_documents';

  -- Check tenant isolation policy existence
  SELECT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'supporting_documents'
      AND p.polname IN ('tenant_isolation', 'supporting_documents_firm_isolation_policy')
  ) INTO policy_exists;

  IF NOT rls_enabled OR NOT policy_exists THEN
    RAISE NOTICE 'supporting_documents RLS incomplete - applying repair.';

    -- Enable RLS
    EXECUTE 'ALTER TABLE supporting_documents ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE supporting_documents FORCE ROW LEVEL SECURITY';

    -- Drop old policy variants if any
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON supporting_documents';
    EXECUTE 'DROP POLICY IF EXISTS supporting_documents_firm_isolation_policy ON supporting_documents';
    EXECUTE 'DROP POLICY IF EXISTS supporting_docs_firm_select ON supporting_documents';
    EXECUTE 'DROP POLICY IF EXISTS supporting_docs_firm_insert ON supporting_documents';
    EXECUTE 'DROP POLICY IF EXISTS supporting_docs_firm_update ON supporting_documents';

    -- Unified RLS policy (firm-isolated ALL)
    EXECUTE 'CREATE POLICY supporting_documents_firm_isolation_policy
      ON supporting_documents FOR ALL TO PUBLIC
      USING (firm_id = (current_setting(''app.current_firm_id'', true))::INTEGER)
      WITH CHECK (firm_id = (current_setting(''app.current_firm_id'', true))::INTEGER)';

    -- Defensive app_firms.enforce_company_id_v2 if proc exists
    PERFORM 1
     WHERE EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_firms' AND table_name = 'rls_firms'
     )
       AND EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app_firms' AND p.proname = 'enforce_company_id_v2'
       );
    IF FOUND THEN
      EXECUTE 'DROP POLICY IF EXISTS supporting_documents_company_rls ON supporting_documents';
      PERFORM app_firms.enforce_company_id_v2('supporting_documents', 'firm_id');
    END IF;

    -- Grants (safe if already granted)
    IF to_regrole('app_user') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE ON supporting_documents TO app_user';
      EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE supporting_documents_id_seq TO app_user';
    END IF;
  ELSE
    RAISE NOTICE 'supporting_documents RLS already complete - skipping (NOOP).';
  END IF;
END $$;

-- ==============================================================
-- 2. batch_operations RLS repair: enforce_company_id_v2 only if MISSING
--    Migration 0151 has standard policies but lacks the defensive DO block.
-- ==============================================================
DO $$
DECLARE
  company_policy_exists BOOLEAN;
BEGIN
  -- Check if table exists first
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'batch_operations' AND table_schema = 'public'
  ) THEN
    RAISE NOTICE 'batch_operations table does not exist yet - skipping (NOOP).';
    RETURN;
  END IF;

  -- Check if company_rls policy has been applied already
  SELECT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'batch_operations'
      AND p.polname = 'batch_operations_company_rls'
  ) INTO company_policy_exists;

  IF NOT company_policy_exists THEN
    RAISE NOTICE 'batch_operations enforce_company_id_v2 missing - applying defensive DO block.';

    PERFORM 1
     WHERE EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_firms' AND table_name = 'rls_firms'
     )
       AND EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app_firms' AND p.proname = 'enforce_company_id_v2'
       );
    IF FOUND THEN
      EXECUTE 'DROP POLICY IF EXISTS batch_operations_company_rls ON batch_operations';
      PERFORM app_firms.enforce_company_id_v2('batch_operations', 'firm_id');
    ELSE
      RAISE NOTICE 'app_firms.enforce_company_id_v2 not installed - skipping defensive block (NOOP).';
    END IF;
  ELSE
    RAISE NOTICE 'batch_operations enforce_company_id_v2 already present - skipping (NOOP).';
  END IF;
END $$;

COMMIT;
