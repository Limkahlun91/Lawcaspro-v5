-- Migration 0128: HRMS Core Organisation (Phase 1 M1)
-- Creates hr_branches / hr_departments / hr_positions tables and hr_organisation_settings.
-- These are the top-level HR Master Data tables. Employee references departments
-- and positions in Migration 0129.

CREATE TABLE IF NOT EXISTS hr_branches (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  branch_code text NOT NULL,
  branch_name text NOT NULL,
  address_1 text,
  address_2 text,
  city text,
  state text,
  postcode text,
  country text DEFAULT 'Malaysia',
  phone text,
  email text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_branches_firm_code
  ON hr_branches (firm_id, branch_code);
CREATE INDEX IF NOT EXISTS idx_hr_branches_firm_active
  ON hr_branches (firm_id, is_active);

ALTER TABLE hr_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_branches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_branches_rw ON hr_branches;
CREATE POLICY hr_branches_rw ON hr_branches FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_departments (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  branch_id integer REFERENCES hr_branches(id) ON DELETE SET NULL,
  department_code text NOT NULL,
  department_name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  head_employee_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_departments_firm_code
  ON hr_departments (firm_id, department_code);
CREATE INDEX IF NOT EXISTS idx_hr_departments_firm_active
  ON hr_departments (firm_id, is_active);
CREATE INDEX IF NOT EXISTS idx_hr_departments_branch
  ON hr_departments (firm_id, branch_id);

ALTER TABLE hr_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_departments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_departments_rw ON hr_departments;
CREATE POLICY hr_departments_rw ON hr_departments FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_positions (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  department_id integer REFERENCES hr_departments(id) ON DELETE SET NULL,
  position_code text NOT NULL,
  position_name text NOT NULL,
  description text,
  position_level text,
  pay_grade text,
  reports_to_position_id integer REFERENCES hr_positions(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_positions_firm_code
  ON hr_positions (firm_id, position_code);
CREATE INDEX IF NOT EXISTS idx_hr_positions_firm_active
  ON hr_positions (firm_id, is_active);
CREATE INDEX IF NOT EXISTS idx_hr_positions_department
  ON hr_positions (firm_id, department_id);
CREATE INDEX IF NOT EXISTS idx_hr_positions_reports_to
  ON hr_positions (firm_id, reports_to_position_id);

ALTER TABLE hr_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_positions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_positions_rw ON hr_positions;
CREATE POLICY hr_positions_rw ON hr_positions FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_organisation_settings (
  firm_id integer PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  default_timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  default_currency text NOT NULL DEFAULT 'MYR',
  weekly_off_days jsonb NOT NULL DEFAULT '["Saturday","Sunday"]'::jsonb,
  public_holiday_calendar_code text,
  pay_date_offset_days integer NOT NULL DEFAULT 1,
  payroll_cutoff_day integer NOT NULL DEFAULT 28,
  leave_balance_reset_day integer NOT NULL DEFAULT 1,
  leave_balance_reset_month integer NOT NULL DEFAULT 1,
  document_storage_bucket_prefix text NOT NULL DEFAULT 'hr-documents',
  require_claim_attachment_over_amount numeric(19,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

ALTER TABLE hr_organisation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_organisation_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_organisation_settings_rw ON hr_organisation_settings;
CREATE POLICY hr_organisation_settings_rw ON hr_organisation_settings FOR ALL TO PUBLIC
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
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'hrms_migration_audit'
  ) THEN
    NULL;
  END IF;
END $$;
