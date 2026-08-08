-- Migration 0129: HRMS Employees Core (Phase 1 M2)
-- This table stores ONLY non-sensitive employee summary fields (9 columns).
-- Sensitive fields are split into 6 separate tables in migration 0130.
-- Status transitions only: NO hard delete allowed. Router returns 405 DELETE.

CREATE TABLE IF NOT EXISTS hr_employees (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,

  employee_no text NOT NULL,
  linked_user_id integer REFERENCES users(id) ON DELETE SET NULL,

  preferred_name text,
  legal_full_name text NOT NULL,
  common_email text,
  common_mobile text,

  employment_status text NOT NULL DEFAULT 'draft',

  ic_passport_no_masked text,
  nationality text,
  gender text,
  marital_status text,
  date_of_birth date,
  address_1 text,
  address_2 text,
  city text,
  state text,
  postcode text,
  emergency_contact_name text,
  emergency_contact_relation text,
  emergency_contact_phone text,

  join_date date,
  confirmation_date date,
  notice_start_date date,
  termination_date date,
  last_working_date date,
  rehire_original_join_date date,

  branch_id integer REFERENCES hr_branches(id) ON DELETE SET NULL,
  department_id integer REFERENCES hr_departments(id) ON DELETE SET NULL,
  position_id integer REFERENCES hr_positions(id) ON DELETE SET NULL,

  work_location text,
  employment_type text,

  reporting_manager_employee_id integer REFERENCES hr_employees(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminated_at timestamptz,
  last_status_change_at timestamptz,

  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_employees_firm_employee_no
  ON hr_employees (firm_id, employee_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_employees_firm_user_id
  ON hr_employees (firm_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hr_employees_firm_status
  ON hr_employees (firm_id, employment_status);
CREATE INDEX IF NOT EXISTS idx_hr_employees_dept
  ON hr_employees (firm_id, department_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_position
  ON hr_employees (firm_id, position_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_branch
  ON hr_employees (firm_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_manager
  ON hr_employees (firm_id, reporting_manager_employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_join_date
  ON hr_employees (firm_id, join_date);
CREATE INDEX IF NOT EXISTS idx_hr_employees_name
  ON hr_employees (firm_id, legal_full_name);
CREATE INDEX IF NOT EXISTS idx_hr_employees_created
  ON hr_employees (firm_id, created_at);

ALTER TABLE hr_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employees_rw ON hr_employees;
CREATE POLICY hr_employees_rw ON hr_employees FOR ALL TO PUBLIC
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
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_hr_employees_employment_status_valid'
      AND conrelid = 'public.hr_employees'::regclass
  ) THEN
    ALTER TABLE public.hr_employees
      ADD CONSTRAINT chk_hr_employees_employment_status_valid
      CHECK (employment_status IN (
        'draft','probation','active','notice_period',
        'inactive_handover','terminated','reactivated','suspended'
      ));
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
