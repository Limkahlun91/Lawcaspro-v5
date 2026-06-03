-- 0100_security_rls_repair.sql
-- Add missing RLS + tenant isolation policies for newer tables not covered by 0002_correct_rls_policies.sql.
-- This is additive and idempotent. It does NOT drop old migrations.

-- Helper: firm-scoped policy pattern
DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- Firm-scoped tables with firm_id column
-- ---------------------------------------------------------------------------

ALTER TABLE case_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_messages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON case_messages;
CREATE POLICY tenant_isolation ON case_messages FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE case_message_read_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_message_read_status FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON case_message_read_status;
CREATE POLICY tenant_isolation ON case_message_read_status FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bank_transactions;
CREATE POLICY tenant_isolation ON bank_transactions FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE case_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_ledgers FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON case_ledgers;
CREATE POLICY tenant_isolation ON case_ledgers FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE developer_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_documents FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON developer_documents;
CREATE POLICY tenant_isolation ON developer_documents FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_documents FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_documents;
CREATE POLICY tenant_isolation ON project_documents FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE document_generation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_generation_logs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON document_generation_logs;
CREATE POLICY tenant_isolation ON document_generation_logs FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE document_generation_log_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_generation_log_cases FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON document_generation_log_cases;
CREATE POLICY tenant_isolation ON document_generation_log_cases FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE document_extraction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extraction_jobs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON document_extraction_jobs;
CREATE POLICY tenant_isolation ON document_extraction_jobs FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE firm_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_invoices FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON firm_invoices;
CREATE POLICY tenant_isolation ON firm_invoices FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE case_loan_supp_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_loan_supp_documents FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON case_loan_supp_documents;
CREATE POLICY tenant_isolation ON case_loan_supp_documents FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE platform_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_incidents FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_incidents;
CREATE POLICY tenant_isolation ON platform_incidents FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON templates;
DROP POLICY IF EXISTS templates_select ON templates;
DROP POLICY IF EXISTS templates_insert ON templates;
DROP POLICY IF EXISTS templates_update ON templates;
DROP POLICY IF EXISTS templates_delete ON templates;

CREATE POLICY templates_select ON templates
FOR SELECT TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR (
      firm_id IS NULL
      AND NULLIF(current_setting('app.current_firm_id', true), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM firm_settings s
        WHERE s.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
          AND COALESCE(s.use_master_documents, true) = true
      )
    )
  );

CREATE POLICY templates_insert ON templates
FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
  );

CREATE POLICY templates_update ON templates
FOR UPDATE TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
  );

CREATE POLICY templates_delete ON templates
FOR DELETE TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
  );

-- ---------------------------------------------------------------------------
-- Tables WITHOUT firm_id: isolate via parent table
-- ---------------------------------------------------------------------------

ALTER TABLE document_extraction_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extraction_results FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON document_extraction_results;
CREATE POLICY tenant_isolation ON document_extraction_results FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR EXISTS (
      SELECT 1
      FROM document_extraction_jobs j
      WHERE j.id = document_extraction_results.job_id
        AND (
          j.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
          OR current_setting('app.is_founder', true) = 'true'
        )
    )
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR EXISTS (
      SELECT 1
      FROM document_extraction_jobs j
      WHERE j.id = document_extraction_results.job_id
        AND (
          j.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
          OR current_setting('app.is_founder', true) = 'true'
        )
    )
  );

ALTER TABLE document_extraction_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extraction_suggestions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON document_extraction_suggestions;
CREATE POLICY tenant_isolation ON document_extraction_suggestions FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR EXISTS (
      SELECT 1
      FROM document_extraction_jobs j
      WHERE j.id = document_extraction_suggestions.job_id
        AND (
          j.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
          OR current_setting('app.is_founder', true) = 'true'
        )
    )
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR EXISTS (
      SELECT 1
      FROM document_extraction_jobs j
      WHERE j.id = document_extraction_suggestions.job_id
        AND (
          j.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
          OR current_setting('app.is_founder', true) = 'true'
        )
    )
  );

ALTER TABLE platform_incident_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_incident_notes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_incident_notes;
CREATE POLICY tenant_isolation ON platform_incident_notes FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR EXISTS (
      SELECT 1
      FROM platform_incidents i
      WHERE i.id = platform_incident_notes.incident_id
        AND (
          i.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
          OR current_setting('app.is_founder', true) = 'true'
        )
    )
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR EXISTS (
      SELECT 1
      FROM platform_incidents i
      WHERE i.id = platform_incident_notes.incident_id
        AND (
          i.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
          OR current_setting('app.is_founder', true) = 'true'
        )
    )
  );
