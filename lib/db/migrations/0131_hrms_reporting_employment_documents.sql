-- Migration 0131: HRMS Reporting Lines, Employment Records, HR Documents (Phase 1 M4)
-- Reporting lines allow historical tracking of org-chart changes.
-- Employment records are job change history (transfer/promotion/demotion etc.)
-- HR documents store metadata for all employee attachments. Object storage path
-- follows the convention: firms/{firm_id}/hr-documents/{employee_id}/{doc_id}/{filename}

CREATE TABLE IF NOT EXISTS hr_reporting_lines (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  reporting_manager_employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  reporting_type text NOT NULL DEFAULT 'primary',
  effective_from date NOT NULL,
  effective_to date,
  is_primary boolean NOT NULL DEFAULT true,
  change_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_hr_reporting_emp
  ON hr_reporting_lines (firm_id, employee_id, effective_from DESC, effective_to);
CREATE INDEX IF NOT EXISTS idx_hr_reporting_manager
  ON hr_reporting_lines (firm_id, reporting_manager_employee_id, effective_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_reporting_primary
  ON hr_reporting_lines (firm_id, employee_id, effective_from)
  WHERE is_primary = true;

ALTER TABLE hr_reporting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_reporting_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_reporting_lines_rw ON hr_reporting_lines;
CREATE POLICY hr_reporting_lines_rw ON hr_reporting_lines FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'hr_reporting_lines'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'reporting_manager_employee_id'
  ) THEN
    ALTER TABLE public.hr_reporting_lines
      DROP CONSTRAINT IF EXISTS hr_reporting_lines_reporting_manager_employee_id_fkey;
  END IF;
  ALTER TABLE public.hr_reporting_lines
    ADD CONSTRAINT hr_reporting_lines_reporting_manager_employee_id_fkey
    FOREIGN KEY (reporting_manager_employee_id)
    REFERENCES public.hr_employees(id)
    ON DELETE SET NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS hr_employment_records (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  record_type text NOT NULL,
  record_no text,
  effective_date date NOT NULL,
  end_date date,

  old_branch_id integer REFERENCES hr_branches(id) ON DELETE SET NULL,
  old_department_id integer REFERENCES hr_departments(id) ON DELETE SET NULL,
  old_position_id integer REFERENCES hr_positions(id) ON DELETE SET NULL,
  old_reporting_manager_employee_id integer REFERENCES hr_employees(id) ON DELETE SET NULL,
  old_employment_type text,
  old_work_location text,

  new_branch_id integer REFERENCES hr_branches(id) ON DELETE SET NULL,
  new_department_id integer REFERENCES hr_departments(id) ON DELETE SET NULL,
  new_position_id integer REFERENCES hr_positions(id) ON DELETE SET NULL,
  new_reporting_manager_employee_id integer REFERENCES hr_employees(id) ON DELETE SET NULL,
  new_employment_type text,
  new_work_location text,

  salary_amount_old numeric(19,4),
  salary_amount_new numeric(19,4),
  salary_currency text DEFAULT 'MYR',
  salary_change_reason text,

  approval_status text DEFAULT 'draft',
  approved_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_hr_emp_records_emp
  ON hr_employment_records (firm_id, employee_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_emp_records_status
  ON hr_employment_records (firm_id, approval_status, created_at DESC);

ALTER TABLE hr_employment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employment_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employment_records_rw ON hr_employment_records;
CREATE POLICY hr_employment_records_rw ON hr_employment_records FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_documents (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer REFERENCES hr_employees(id) ON DELETE SET NULL,
  document_type text NOT NULL,
  document_category text NOT NULL DEFAULT 'general',
  document_name text NOT NULL,
  description text,

  storage_path text NOT NULL,
  storage_bucket text NOT NULL,
  file_name text NOT NULL,
  file_size_bytes bigint,
  file_content_type text,
  file_sha256 text,

  is_signed boolean NOT NULL DEFAULT false,
  signed_signatory_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  signed_at timestamptz,

  effective_date date,
  expiry_date date,
  expiry_notification_sent boolean NOT NULL DEFAULT false,

  view_permission_role_codes text[] NOT NULL DEFAULT '{}',
  view_permission_user_ids integer[] NOT NULL DEFAULT '{}',
  partner_view_allowed boolean NOT NULL DEFAULT false,
  self_view_allowed boolean NOT NULL DEFAULT true,

  archive_status text NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  archived_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,

  upload_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_hr_documents_emp
  ON hr_documents (firm_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_documents_category
  ON hr_documents (firm_id, document_category);
CREATE INDEX IF NOT EXISTS idx_hr_documents_expiry
  ON hr_documents (firm_id, expiry_date) WHERE expiry_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hr_documents_type
  ON hr_documents (firm_id, document_type);

ALTER TABLE hr_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_documents_rw ON hr_documents;
CREATE POLICY hr_documents_rw ON hr_documents FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

COMMENT ON COLUMN public.hr_documents.storage_path IS
'Path MUST match firms/{firm_id}/hr/employees/{employee_id}/{category}/{year}/{month}/{uuid}.{ext}; enforced by buildHrStoragePath() at application layer. Direct INSERT bypassing service = invalid. File lives in private bucket; no public URL ever issued — only short-lived signed URLs.';

COMMENT ON COLUMN public.hr_documents.employee_id IS
'Current semantics: ALL HR documents are tied to a specific employee row. ON DELETE SET NULL today = employee purge leaves document row orphan (audit retention). Planned future split: firm-level policy documents will move to a separate FK column (hr_documents.firm_policy_scope_id) with CASCADE semantics for employee-only docs IF product ratifies purge-on-delete; this file does NOT implement that split yet — FK semantics left as-is, documented explicitly here.';
