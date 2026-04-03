-- =============================================================================
-- apply-rls.sql  —  Row-Level Security for all firm-scoped tables
-- Idempotent: safe to run multiple times.
-- Run with: psql "$DATABASE_URL" -f lib/db/scripts/apply-rls.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Create the limited-privilege application role
-- ---------------------------------------------------------------------------
DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

GRANT CONNECT ON DATABASE heliumdb TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- Firm-scoped DML tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
  audit_logs, case_billing_entries, case_communications, case_documents,
  case_tasks, cases, clients, communication_threads, credit_notes,
  developers, document_templates, firm_bank_accounts, invoices,
  ledger_entries, payment_vouchers, platform_documents, projects,
  quotations, receipts, roles, time_entries, users
TO app_user;

-- Read-only on supporting tables
GRANT SELECT ON
  case_assignments, case_notes, case_purchasers, case_workflow_steps,
  communication_read_status, invoice_items, payment_voucher_items,
  quotation_items, receipt_allocations, sessions, firms, support_sessions,
  permissions, platform_messages, platform_message_attachments,
  regulatory_rule_sets, regulatory_rule_versions, system_folders
TO app_user;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS
-- ---------------------------------------------------------------------------
ALTER TABLE audit_logs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_billing_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_communications   ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_documents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients               ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE developers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_bank_accounts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_vouchers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects              ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Drop existing policies (idempotency)
-- ---------------------------------------------------------------------------
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
DROP POLICY IF EXISTS tenant_isolation ON firm_bank_accounts;
DROP POLICY IF EXISTS tenant_isolation ON invoices;
DROP POLICY IF EXISTS tenant_isolation ON ledger_entries;
DROP POLICY IF EXISTS tenant_isolation ON payment_vouchers;
DROP POLICY IF EXISTS tenant_isolation ON platform_documents;
DROP POLICY IF EXISTS tenant_isolation ON projects;
DROP POLICY IF EXISTS tenant_isolation ON quotations;
DROP POLICY IF EXISTS tenant_isolation ON receipts;
DROP POLICY IF EXISTS tenant_isolation ON roles;
DROP POLICY IF EXISTS tenant_isolation ON time_entries;
DROP POLICY IF EXISTS tenant_isolation ON users;

-- ---------------------------------------------------------------------------
-- 4. Create tenant isolation policies for app_user
--    Row visible when: firm_id matches app.current_firm_id  OR  is_founder=true
-- ---------------------------------------------------------------------------
CREATE POLICY tenant_isolation ON audit_logs FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_billing_entries FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_communications FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_documents FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON case_tasks FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON cases FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON clients FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON communication_threads FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON credit_notes FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON developers FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON document_templates FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON firm_bank_accounts FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON invoices FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON ledger_entries FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON payment_vouchers FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON platform_documents FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON projects FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON quotations FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON receipts FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON roles FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON time_entries FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

CREATE POLICY tenant_isolation ON users FOR ALL TO app_user
  USING ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((current_setting('app.current_firm_id',true) IS NOT NULL AND current_setting('app.current_firm_id',true)<>'' AND firm_id = NULLIF(current_setting('app.current_firm_id',true), '')::integer) OR current_setting('app.is_founder',true)='true');

-- ---------------------------------------------------------------------------
-- 5. Final verification query
-- ---------------------------------------------------------------------------
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'audit_logs','case_billing_entries','case_communications','case_documents',
    'case_tasks','cases','clients','communication_threads','credit_notes',
    'developers','document_templates','firm_bank_accounts','invoices',
    'ledger_entries','payment_vouchers','platform_documents','projects',
    'quotations','receipts','roles','time_entries','users'
  )
ORDER BY tablename;

-- ---------------------------------------------------------------------------
-- Phase 2 — Compliance + Conflict tables (idempotent)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

ALTER TABLE parties          ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_parties     ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdd_checks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdd_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE beneficial_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE sanctions_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pep_flags        ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_of_funds_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_of_wealth_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE suspicious_review_notes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_retention_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_checks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON parties;
CREATE POLICY tenant_isolation ON parties FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON case_parties;
CREATE POLICY tenant_isolation ON case_parties FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON compliance_profiles;
CREATE POLICY tenant_isolation ON compliance_profiles FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON cdd_checks;
CREATE POLICY tenant_isolation ON cdd_checks FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON cdd_documents;
CREATE POLICY tenant_isolation ON cdd_documents FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON beneficial_owners;
CREATE POLICY tenant_isolation ON beneficial_owners FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON sanctions_screenings;
CREATE POLICY tenant_isolation ON sanctions_screenings FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON pep_flags;
CREATE POLICY tenant_isolation ON pep_flags FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON risk_assessments;
CREATE POLICY tenant_isolation ON risk_assessments FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON source_of_funds_records;
CREATE POLICY tenant_isolation ON source_of_funds_records FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON source_of_wealth_records;
CREATE POLICY tenant_isolation ON source_of_wealth_records FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON suspicious_review_notes;
CREATE POLICY tenant_isolation ON suspicious_review_notes FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON compliance_retention_records;
CREATE POLICY tenant_isolation ON compliance_retention_records FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON conflict_checks;
CREATE POLICY tenant_isolation ON conflict_checks FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON conflict_matches;
CREATE POLICY tenant_isolation ON conflict_matches FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON conflict_overrides;
CREATE POLICY tenant_isolation ON conflict_overrides FOR ALL TO app_user
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');
