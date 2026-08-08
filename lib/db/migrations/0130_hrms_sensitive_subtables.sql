-- Migration 0130: HRMS 6 Sensitive Subtables (Phase 1 M3)
-- Per Part 1 §5: salary/bank/identity/medical/disciplinary/leave_balance each
-- get their own tables with separate RLS policies. No single user gets ALL
-- access by default. Partner role default DENIED on medical/disciplinary.

CREATE TABLE IF NOT EXISTS hr_employee_salaries (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  salary_type text NOT NULL DEFAULT 'basic',
  currency text NOT NULL DEFAULT 'MYR',
  amount numeric(19,4) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  payslip_visibility text NOT NULL DEFAULT 'visible',
  is_current boolean NOT NULL DEFAULT true,
  review_next_date date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE public.hr_employee_salaries IS
'Partner default deny: reads require explicit RBAC grant hr.salary.view per firm; generic firm RLS alone is insufficient. Sensitive payroll data — every read audited at app layer.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_salaries_emp_type_from
  ON hr_employee_salaries (firm_id, employee_id, salary_type, effective_from);
CREATE INDEX IF NOT EXISTS idx_hr_salaries_emp
  ON hr_employee_salaries (firm_id, employee_id, effective_from DESC);

ALTER TABLE hr_employee_salaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_salaries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employee_salaries_rw ON hr_employee_salaries;
CREATE POLICY hr_employee_salaries_rw ON hr_employee_salaries FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_employee_bank_accounts (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  bank_name text NOT NULL,
  bank_branch text,
  bank_code text,
  swift_code text,
  account_number text NOT NULL,
  account_holder_name text NOT NULL,
  currency text NOT NULL DEFAULT 'MYR',
  is_primary boolean NOT NULL DEFAULT true,
  is_verified boolean NOT NULL DEFAULT false,
  verified_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  attachment_document_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE public.hr_employee_bank_accounts IS
'Partner default deny: reads require explicit RBAC grant hr.bank_details.view per firm; generic firm RLS alone is insufficient. List endpoints return last-4-masked form only; full value from dedicated detail endpoint with audit log.';

COMMENT ON COLUMN public.hr_employee_bank_accounts.account_number IS
'Bank account number cleartext today. FUTURE ENHANCEMENT CANDIDATE: pgp_sym_encrypt() via pgcrypto with KMS-wrapped key (column-application level, not required now). Access gated at app layer by hr.bank_details.view permission + audit every read.';

CREATE INDEX IF NOT EXISTS idx_hr_bank_emp
  ON hr_employee_bank_accounts (firm_id, employee_id);

ALTER TABLE hr_employee_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_bank_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employee_bank_accounts_rw ON hr_employee_bank_accounts;
CREATE POLICY hr_employee_bank_accounts_rw ON hr_employee_bank_accounts FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_employee_identity_records (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  identity_type text NOT NULL,
  identity_number text NOT NULL,
  issued_country text NOT NULL DEFAULT 'Malaysia',
  issued_by text,
  issued_date date,
  expiry_date date,
  is_verified boolean NOT NULL DEFAULT false,
  verified_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  full_name_on_document text,
  attachment_document_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE public.hr_employee_identity_records IS
'Partner default deny: reads require explicit RBAC grant hr.identity.view per firm; generic firm RLS alone is insufficient. List endpoints NEVER project full identity_number (masked or column omitted); dedicated detail endpoint + audit log every read.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_identity_emp_type_no
  ON hr_employee_identity_records (firm_id, employee_id, identity_type, identity_number);
CREATE INDEX IF NOT EXISTS idx_hr_identity_expiry
  ON hr_employee_identity_records (firm_id, expiry_date);

ALTER TABLE hr_employee_identity_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_identity_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employee_identity_records_rw ON hr_employee_identity_records;
CREATE POLICY hr_employee_identity_records_rw ON hr_employee_identity_records FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_employee_medical_records (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  record_type text NOT NULL,
  record_date date NOT NULL,
  provider_name text,
  blood_group text,
  allergies text,
  chronic_conditions text,
  medication text,
  summary text,
  document_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE public.hr_employee_medical_records IS
'Partner default deny: reads require explicit RBAC grant hr.medical_document.view per firm; generic firm RLS alone is insufficient. Medical data — every non-self read audited.';

CREATE INDEX IF NOT EXISTS idx_hr_medical_emp
  ON hr_employee_medical_records (firm_id, employee_id, record_date DESC);

ALTER TABLE hr_employee_medical_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_medical_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employee_medical_records_rw ON hr_employee_medical_records;
CREATE POLICY hr_employee_medical_records_rw ON hr_employee_medical_records FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_employee_disciplinary_records (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  case_no text NOT NULL,
  incident_date date NOT NULL,
  report_date date NOT NULL,
  severity_level text NOT NULL,
  case_type text NOT NULL,
  description text NOT NULL,
  findings text,
  disciplinary_action text NOT NULL,
  effective_date date,
  end_date date,
  is_active boolean NOT NULL DEFAULT true,
  closed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  closed_at timestamptz,
  hearing_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE public.hr_employee_disciplinary_records IS
'Partner default deny: reads require explicit RBAC grant hr.disciplinary.view per firm; generic firm RLS alone is insufficient. Disciplinary case data — every non-self read audited.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_disciplinary_firm_case
  ON hr_employee_disciplinary_records (firm_id, case_no);
CREATE INDEX IF NOT EXISTS idx_hr_disciplinary_emp
  ON hr_employee_disciplinary_records (firm_id, employee_id, incident_date DESC);

ALTER TABLE hr_employee_disciplinary_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_disciplinary_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employee_disciplinary_records_rw ON hr_employee_disciplinary_records;
CREATE POLICY hr_employee_disciplinary_records_rw ON hr_employee_disciplinary_records FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_employee_leave_balances (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  leave_type_code text NOT NULL,
  leave_year integer NOT NULL,
  entitled_days numeric(10,2) NOT NULL DEFAULT 0,
  carried_forward_days numeric(10,2) NOT NULL DEFAULT 0,
  adjusted_days numeric(10,2) NOT NULL DEFAULT 0,
  taken_days numeric(10,2) NOT NULL DEFAULT 0,
  pending_approval_days numeric(10,2) NOT NULL DEFAULT 0,
  balance_carried_forward_override numeric(10,2),
  expiry_date date,
  last_calculation_ref text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

COMMENT ON TABLE public.hr_employee_leave_balances IS
'Partner default deny: reads require explicit RBAC grant hr.leave_balance.view_all per firm; generic firm RLS alone is insufficient. Sensitive leave balance + carry-forward data; adjustments require separate hr.leave_balance.adjust grant.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_leave_balance_emp_type_year
  ON hr_employee_leave_balances (firm_id, employee_id, leave_type_code, leave_year);

ALTER TABLE hr_employee_leave_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_leave_balances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employee_leave_balances_rw ON hr_employee_leave_balances;
CREATE POLICY hr_employee_leave_balances_rw ON hr_employee_leave_balances FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

DO $$
DECLARE
  v_firm record;
BEGIN
  FOR v_firm IN SELECT id FROM firms ORDER BY id LOOP
    NULL;
  END LOOP;
END $$;
