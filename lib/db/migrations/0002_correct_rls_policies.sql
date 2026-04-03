-- =============================================================================
-- 0002_correct_rls_policies.sql
--
-- Idempotent repair migration: replaces all broken TO app_user policies
-- with environment-safe TO PUBLIC policies.
--
-- Why this exists:
--   The original apply-rls.sql used `TO app_user` on every tenant_isolation
--   policy.  In production, `app_user` did not exist (the role is created by
--   apply-rls.sql itself, which was never run in production).  Any attempt to
--   apply the policies therefore failed with:
--     ERROR: role "app_user" does not exist
--
--   Additionally, the script hard-coded `GRANT CONNECT ON DATABASE heliumdb`
--   which fails on every non-dev environment.
--
-- This migration is safe on:
--   • Fresh environments where no policies exist yet
--   • Dev environments where broken TO app_user policies already exist
--   • Production after first successful deploy
--
-- Security model after this migration:
--   • Policies are TO PUBLIC — they apply to every role.
--   • The tenant check lives in USING/WITH CHECK:
--       firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::int
--       OR current_setting('app.is_founder',true) = 'true'
--   • For RLS to be enforced the app must connect as a role without BYPASSRLS
--     (app_user) and must SET LOCAL app.current_firm_id per transaction.
--     See lib/db/src/tenant-context.ts and the requireFirmUser middleware.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Ensure app_user role exists (needed for SET ROLE app_user at runtime)
-- ---------------------------------------------------------------------------
DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO app_user;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS + FORCE on every firm-scoped table (idempotent)
-- ---------------------------------------------------------------------------

ALTER TABLE audit_logs                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE case_billing_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_billing_entries         FORCE  ROW LEVEL SECURITY;
ALTER TABLE case_communications          ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_communications          FORCE  ROW LEVEL SECURITY;
ALTER TABLE case_documents               ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_documents               FORCE  ROW LEVEL SECURITY;
ALTER TABLE case_tasks                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_tasks                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE cases                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases                        FORCE  ROW LEVEL SECURITY;
ALTER TABLE clients                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE communication_threads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_threads        FORCE  ROW LEVEL SECURITY;
ALTER TABLE credit_notes                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE developers                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE developers                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE document_templates           ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates           FORCE  ROW LEVEL SECURITY;
ALTER TABLE firm_bank_accounts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_bank_accounts           FORCE  ROW LEVEL SECURITY;
ALTER TABLE invoices                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                     FORCE  ROW LEVEL SECURITY;
ALTER TABLE ledger_entries               ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries               FORCE  ROW LEVEL SECURITY;
ALTER TABLE payment_vouchers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_vouchers             FORCE  ROW LEVEL SECURITY;
ALTER TABLE platform_documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_documents           FORCE  ROW LEVEL SECURITY;
ALTER TABLE projects                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects                     FORCE  ROW LEVEL SECURITY;
ALTER TABLE quotations                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE receipts                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts                     FORCE  ROW LEVEL SECURITY;
ALTER TABLE roles                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles                        FORCE  ROW LEVEL SECURITY;
ALTER TABLE time_entries                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE users                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                        FORCE  ROW LEVEL SECURITY;

-- Phase 2 tables (previously missing FORCE)
ALTER TABLE parties                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE case_parties                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_parties                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE compliance_profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_profiles          FORCE  ROW LEVEL SECURITY;
ALTER TABLE cdd_checks                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdd_checks                   FORCE  ROW LEVEL SECURITY;
ALTER TABLE cdd_documents                ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdd_documents                FORCE  ROW LEVEL SECURITY;
ALTER TABLE beneficial_owners            ENABLE ROW LEVEL SECURITY;
ALTER TABLE beneficial_owners            FORCE  ROW LEVEL SECURITY;
ALTER TABLE sanctions_screenings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sanctions_screenings         FORCE  ROW LEVEL SECURITY;
ALTER TABLE pep_flags                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pep_flags                    FORCE  ROW LEVEL SECURITY;
ALTER TABLE risk_assessments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_assessments             FORCE  ROW LEVEL SECURITY;
ALTER TABLE source_of_funds_records      ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_of_funds_records      FORCE  ROW LEVEL SECURITY;
ALTER TABLE source_of_wealth_records     ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_of_wealth_records     FORCE  ROW LEVEL SECURITY;
ALTER TABLE suspicious_review_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE suspicious_review_notes      FORCE  ROW LEVEL SECURITY;
ALTER TABLE compliance_retention_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_retention_records FORCE  ROW LEVEL SECURITY;
ALTER TABLE conflict_checks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_checks              FORCE  ROW LEVEL SECURITY;
ALTER TABLE conflict_matches             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_matches             FORCE  ROW LEVEL SECURITY;
ALTER TABLE conflict_overrides           ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_overrides           FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Drop all existing tenant_isolation policies (broken TO app_user variants)
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
-- 4. Recreate all policies TO PUBLIC
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

CREATE POLICY tenant_isolation ON platform_documents FOR ALL TO PUBLIC
  USING ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true')
  WITH CHECK ((firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer) OR current_setting('app.is_founder',true)='true');

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
