-- =============================================================================
-- apply-rls.sql  —  Row-Level Security for all firm-scoped tables
-- Idempotent: safe to run multiple times.
-- Run with: psql "$DATABASE_URL" -f lib/db/scripts/apply-rls.sql
--
-- IMPORTANT: This script no longer uses TO app_user on policies.
-- All tenant_isolation policies use TO PUBLIC so they apply to every role.
-- The actual tenant check lives entirely in the USING / WITH CHECK expressions:
--   firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
--   OR current_setting('app.is_founder', true) = 'true'
--
-- For RLS to be enforced, the connecting role must NOT have BYPASSRLS.
-- The application pool should call:
--   SET LOCAL ROLE app_user       (drops BYPASSRLS for the transaction)
--   SET LOCAL app.current_firm_id = '<firmId>'
--   SET LOCAL app.is_founder = 'false'
-- inside a transaction per request. See lib/db/src/tenant-context.ts.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Create the limited-privilege application role (idempotent)
-- ---------------------------------------------------------------------------
DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

-- No hard-coded database name — use GRANT on schema + tables instead.
GRANT USAGE ON SCHEMA public TO app_user;

-- Phase 1: Firm-scoped DML tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
  audit_logs, case_billing_entries, case_communications, case_documents,
  case_tasks, cases, clients, communication_threads, credit_notes,
  developers, document_templates, document_template_versions, document_generation_runs, document_batch_jobs, document_batch_job_items, document_variable_definitions, document_template_bindings, document_template_applicability_rules, firm_document_folders, firm_letterheads, firm_bank_accounts, invoices,
  ledger_entries, payment_vouchers, platform_documents, projects,
  quotations, receipts, roles, time_entries, users
TO app_user;

-- Phase 1: Read-only on supporting tables
GRANT SELECT ON
  case_assignments, case_notes, case_purchasers, case_workflow_steps,
  communication_read_status, invoice_items, payment_voucher_items,
  quotation_items, receipt_allocations, sessions, firms, support_sessions,
  permissions, platform_messages, platform_message_attachments,
  regulatory_rule_sets, regulatory_rule_versions, system_folders
TO app_user;

-- Phase 2: Compliance + Conflict DML tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
  parties, case_parties, compliance_profiles, cdd_checks, cdd_documents,
  beneficial_owners, sanctions_screenings, pep_flags, risk_assessments,
  source_of_funds_records, source_of_wealth_records, suspicious_review_notes,
  compliance_retention_records, conflict_checks, conflict_matches,
  conflict_overrides
TO app_user;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS + FORCE ROW LEVEL SECURITY on all firm-scoped tables
--    FORCE ensures policies apply even to the table owner.
--    Note: users with BYPASSRLS (e.g. postgres superuser) still bypass RLS.
--    The application must SET LOCAL ROLE app_user per request.
-- ---------------------------------------------------------------------------

-- Phase 1
ALTER TABLE audit_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs             FORCE ROW LEVEL SECURITY;
ALTER TABLE case_billing_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_billing_entries   FORCE ROW LEVEL SECURITY;
ALTER TABLE case_communications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_communications    FORCE ROW LEVEL SECURITY;
ALTER TABLE case_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_documents         FORCE ROW LEVEL SECURITY;
ALTER TABLE case_tasks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_tasks             FORCE ROW LEVEL SECURITY;
ALTER TABLE cases                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases                  FORCE ROW LEVEL SECURITY;
ALTER TABLE clients                ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients                FORCE ROW LEVEL SECURITY;
ALTER TABLE communication_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_threads  FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_notes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes           FORCE ROW LEVEL SECURITY;
ALTER TABLE developers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE developers             FORCE ROW LEVEL SECURITY;
ALTER TABLE document_templates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates     FORCE ROW LEVEL SECURITY;
ALTER TABLE document_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE document_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_generation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE document_batch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_batch_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE document_batch_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_batch_job_items FORCE ROW LEVEL SECURITY;
ALTER TABLE document_variable_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_variable_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE document_template_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE document_template_applicability_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_applicability_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE firm_document_folders  ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_document_folders  FORCE ROW LEVEL SECURITY;
ALTER TABLE firm_letterheads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_letterheads       FORCE ROW LEVEL SECURITY;
ALTER TABLE firm_bank_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_bank_accounts     FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices               ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices               FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries         FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_vouchers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_vouchers       FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_documents     FORCE ROW LEVEL SECURITY;
ALTER TABLE projects               ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects               FORCE ROW LEVEL SECURITY;
ALTER TABLE quotations             ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations             FORCE ROW LEVEL SECURITY;
ALTER TABLE receipts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts               FORCE ROW LEVEL SECURITY;
ALTER TABLE roles                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles                  FORCE ROW LEVEL SECURITY;
ALTER TABLE time_entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries           FORCE ROW LEVEL SECURITY;
ALTER TABLE users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                  FORCE ROW LEVEL SECURITY;

-- Phase 2
ALTER TABLE parties                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties                        FORCE ROW LEVEL SECURITY;
ALTER TABLE case_parties                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_parties                   FORCE ROW LEVEL SECURITY;
ALTER TABLE compliance_profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_profiles            FORCE ROW LEVEL SECURITY;
ALTER TABLE cdd_checks                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdd_checks                     FORCE ROW LEVEL SECURITY;
ALTER TABLE cdd_documents                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdd_documents                  FORCE ROW LEVEL SECURITY;
ALTER TABLE beneficial_owners              ENABLE ROW LEVEL SECURITY;
ALTER TABLE beneficial_owners              FORCE ROW LEVEL SECURITY;
ALTER TABLE sanctions_screenings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sanctions_screenings           FORCE ROW LEVEL SECURITY;
ALTER TABLE pep_flags                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pep_flags                      FORCE ROW LEVEL SECURITY;
ALTER TABLE risk_assessments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_assessments               FORCE ROW LEVEL SECURITY;
ALTER TABLE source_of_funds_records        ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_of_funds_records        FORCE ROW LEVEL SECURITY;
ALTER TABLE source_of_wealth_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_of_wealth_records       FORCE ROW LEVEL SECURITY;
ALTER TABLE suspicious_review_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE suspicious_review_notes        FORCE ROW LEVEL SECURITY;
ALTER TABLE compliance_retention_records   ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_retention_records   FORCE ROW LEVEL SECURITY;
ALTER TABLE conflict_checks                ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_checks                FORCE ROW LEVEL SECURITY;
ALTER TABLE conflict_matches               ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_matches               FORCE ROW LEVEL SECURITY;
ALTER TABLE conflict_overrides             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_overrides             FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Drop existing policies (idempotency)
-- ---------------------------------------------------------------------------

-- Phase 1
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
DROP POLICY IF EXISTS tenant_isolation ON case_billing_entries;
DROP POLICY IF EXISTS tenant_isolation ON case_communications;
DROP POLICY IF EXISTS tenant_isolation ON case_documents;
DROP POLICY IF EXISTS tenant_isolation ON case_tasks;
DROP POLICY IF EXISTS tenant_isolation ON cases;
DROP POLICY IF EXISTS tenant_isolation ON clients;
DROP POLICY IF EXISTS tenant_isolation ON communication_threads;
DROP POLICY IF EXISTS tenant_isolation ON credit_notes;
DROP POLICY IF EXISTS tenant_isolation ON developers;
DROP POLICY IF EXISTS tenant_isolation ON document_templates;
DROP POLICY IF EXISTS tenant_isolation ON document_template_versions;
DROP POLICY IF EXISTS tenant_isolation ON document_generation_runs;
DROP POLICY IF EXISTS tenant_isolation ON document_batch_jobs;
DROP POLICY IF EXISTS tenant_isolation ON document_batch_job_items;
DROP POLICY IF EXISTS tenant_isolation ON document_template_bindings;
DROP POLICY IF EXISTS tenant_isolation ON document_template_applicability_rules;
DROP POLICY IF EXISTS tenant_isolation ON firm_document_folders;
DROP POLICY IF EXISTS tenant_isolation ON firm_letterheads;
DROP POLICY IF EXISTS tenant_isolation ON firm_bank_accounts;
DROP POLICY IF EXISTS tenant_isolation ON invoices;
DROP POLICY IF EXISTS tenant_isolation ON ledger_entries;
DROP POLICY IF EXISTS tenant_isolation ON payment_vouchers;
DROP POLICY IF EXISTS tenant_isolation ON platform_documents;
DROP POLICY IF EXISTS platform_documents_read ON platform_documents;
DROP POLICY IF EXISTS platform_documents_insert ON platform_documents;
DROP POLICY IF EXISTS platform_documents_update ON platform_documents;
DROP POLICY IF EXISTS platform_documents_delete ON platform_documents;
DROP POLICY IF EXISTS tenant_isolation ON projects;
DROP POLICY IF EXISTS tenant_isolation ON quotations;
DROP POLICY IF EXISTS tenant_isolation ON receipts;
DROP POLICY IF EXISTS tenant_isolation ON roles;
DROP POLICY IF EXISTS tenant_isolation ON time_entries;
DROP POLICY IF EXISTS tenant_isolation ON users;

-- Phase 2
DROP POLICY IF EXISTS tenant_isolation ON parties;
DROP POLICY IF EXISTS tenant_isolation ON case_parties;
DROP POLICY IF EXISTS tenant_isolation ON compliance_profiles;
DROP POLICY IF EXISTS tenant_isolation ON cdd_checks;
DROP POLICY IF EXISTS tenant_isolation ON cdd_documents;
DROP POLICY IF EXISTS tenant_isolation ON beneficial_owners;
DROP POLICY IF EXISTS tenant_isolation ON sanctions_screenings;
DROP POLICY IF EXISTS tenant_isolation ON pep_flags;
DROP POLICY IF EXISTS tenant_isolation ON risk_assessments;
DROP POLICY IF EXISTS tenant_isolation ON source_of_funds_records;
DROP POLICY IF EXISTS tenant_isolation ON source_of_wealth_records;
DROP POLICY IF EXISTS tenant_isolation ON suspicious_review_notes;
DROP POLICY IF EXISTS tenant_isolation ON compliance_retention_records;
DROP POLICY IF EXISTS tenant_isolation ON conflict_checks;
DROP POLICY IF EXISTS tenant_isolation ON conflict_matches;
DROP POLICY IF EXISTS tenant_isolation ON conflict_overrides;

-- ---------------------------------------------------------------------------
-- 4. Create tenant isolation policies — TO PUBLIC
--    Security is in the USING expression, not in role binding.
-- ---------------------------------------------------------------------------

CREATE POLICY tenant_isolation ON audit_logs FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_billing_entries FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_communications FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_documents FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_tasks FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON cases FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON clients FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON communication_threads FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON credit_notes FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON developers FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON document_templates FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON document_template_versions FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON document_generation_runs FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON document_batch_jobs FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON document_batch_job_items FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS variable_registry_read ON document_variable_definitions;
DROP POLICY IF EXISTS variable_registry_manage ON document_variable_definitions;
CREATE POLICY variable_registry_read ON document_variable_definitions FOR SELECT TO PUBLIC
  USING (true);
CREATE POLICY variable_registry_manage ON document_variable_definitions FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder',true)='true')
  WITH CHECK (current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON document_template_bindings FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR firm_id IS NULL
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR (firm_id IS NULL AND current_setting('app.is_founder',true)='true')
  );

CREATE POLICY tenant_isolation ON document_template_applicability_rules FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR firm_id IS NULL
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR (firm_id IS NULL AND current_setting('app.is_founder',true)='true')
  );

CREATE POLICY tenant_isolation ON firm_document_folders FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON firm_letterheads FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON firm_bank_accounts FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON invoices FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON ledger_entries FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON payment_vouchers FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY platform_documents_read ON platform_documents FOR SELECT TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    OR (firm_id IS NULL AND NULLIF(current_setting('app.current_firm_id', true), '') IS NOT NULL)
  );

CREATE POLICY platform_documents_insert ON platform_documents FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE POLICY platform_documents_update ON platform_documents FOR UPDATE TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE POLICY platform_documents_delete ON platform_documents FOR DELETE TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE POLICY tenant_isolation ON projects FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON quotations FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON receipts FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON roles FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON time_entries FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON users FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

-- Phase 2

CREATE POLICY tenant_isolation ON parties FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_parties FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON compliance_profiles FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON cdd_checks FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON cdd_documents FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON beneficial_owners FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON sanctions_screenings FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON pep_flags FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON risk_assessments FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON source_of_funds_records FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON source_of_wealth_records FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON suspicious_review_notes FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON compliance_retention_records FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON conflict_checks FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON conflict_matches FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON conflict_overrides FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

-- ---------------------------------------------------------------------------
-- 5. Verification
-- ---------------------------------------------------------------------------
SELECT
  tablename,
  rowsecurity,
  relforcerowsecurity
FROM pg_class
JOIN pg_tables ON pg_class.relname = pg_tables.tablename
WHERE schemaname = 'public'
  AND rowsecurity = true
ORDER BY tablename;

SELECT tablename, policyname, roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
