-- ============================================================================
-- LAWCASPRO-V5 — p8 HR Workflow Schema Parity (ADDITIVE ONLY)
-- Targets: Employees parity + Attendance + Leave (Types/Requests) + Claims
--          + Payroll (Runs / EmployeeResults) + LeaveBalances parity
-- All CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- NO DROP, NO TRUNCATE, NO DESTRUCTIVE REWRITE.
-- ============================================================================

SET search_path TO public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='hr_employees') THEN
    RAISE NOTICE 'Creating hr_employees table (drizzle parity)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. hr_employees (Employee Master — DRIZZLE existed but LIVE/MIG missing)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hr_employees (
  id                              SERIAL PRIMARY KEY,
  firm_id                         INTEGER NOT NULL,
  employee_no                     TEXT NOT NULL,
  linked_user_id                  INTEGER,
  preferred_name                  TEXT,
  legal_full_name                 TEXT NOT NULL,
  common_email                    TEXT,
  common_mobile                   TEXT,
  employment_status               TEXT NOT NULL DEFAULT 'draft',
  ic_passport_no_masked           TEXT,
  nationality                     TEXT,
  gender                          TEXT,
  marital_status                  TEXT,
  date_of_birth                   DATE,
  address_1                       TEXT,
  address_2                       TEXT,
  city                            TEXT,
  state                           TEXT,
  postcode                        TEXT,
  emergency_contact_name          TEXT,
  emergency_contact_relation      TEXT,
  emergency_contact_phone         TEXT,
  join_date                       DATE,
  confirmation_date               DATE,
  notice_start_date               DATE,
  termination_date                DATE,
  last_working_date               DATE,
  rehire_original_join_date       DATE,
  branch_id                       INTEGER,
  department_id                   INTEGER,
  position_id                     INTEGER,
  work_location                   TEXT,
  employment_type                 TEXT,
  reporting_manager_employee_id   INTEGER,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminated_at                   TIMESTAMPTZ,
  last_status_change_at           TIMESTAMPTZ,
  created_by_user_id              INTEGER,
  updated_by_user_id              INTEGER,
  version                         INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_employees_firm_employee_no ON public.hr_employees (firm_id, employee_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_employees_firm_user_id    ON public.hr_employees (firm_id, linked_user_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_firm_status           ON public.hr_employees (firm_id, employment_status);
CREATE INDEX IF NOT EXISTS idx_hr_employees_dept                  ON public.hr_employees (firm_id, department_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_position              ON public.hr_employees (firm_id, position_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_branch                ON public.hr_employees (firm_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_manager               ON public.hr_employees (firm_id, reporting_manager_employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_employees_join_date             ON public.hr_employees (firm_id, join_date);
CREATE INDEX IF NOT EXISTS idx_hr_employees_name                  ON public.hr_employees (firm_id, legal_full_name);
CREATE INDEX IF NOT EXISTS idx_hr_employees_created               ON public.hr_employees (firm_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. hr_employee_leave_balances (DRIZZLE existed already, LIVE/MIG missing)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hr_employee_leave_balances (
  id                                  SERIAL PRIMARY KEY,
  firm_id                             INTEGER NOT NULL,
  employee_id                         INTEGER NOT NULL,
  leave_type_code                     TEXT NOT NULL,
  leave_year                          INTEGER NOT NULL,
  entitled_days                       NUMERIC(10,2) NOT NULL DEFAULT 0,
  carried_forward_days                NUMERIC(10,2) NOT NULL DEFAULT 0,
  adjusted_days                       NUMERIC(10,2) NOT NULL DEFAULT 0,
  taken_days                          NUMERIC(10,2) NOT NULL DEFAULT 0,
  pending_approval_days               NUMERIC(10,2) NOT NULL DEFAULT 0,
  balance_carried_forward_override    NUMERIC(10,2),
  expiry_date                         DATE,
  last_calculation_ref                TEXT,
  note                                TEXT,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id                  INTEGER,
  updated_by_user_id                  INTEGER,
  version                             INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_leave_balance_emp_type_year ON public.hr_employee_leave_balances (firm_id, employee_id, leave_type_code, leave_year);
CREATE INDEX IF NOT EXISTS idx_hr_leave_balance_firm                ON public.hr_employee_leave_balances (firm_id);
CREATE INDEX IF NOT EXISTS idx_hr_leave_balance_emp                 ON public.hr_employee_leave_balances (firm_id, employee_id);

-- ---------------------------------------------------------------------------
-- 3. hr_attendance_records (NEW)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hr_attendance_records (
  id                          SERIAL PRIMARY KEY,
  firm_id                     INTEGER NOT NULL,
  employee_id                 INTEGER NOT NULL,
  attendance_date             DATE NOT NULL,
  shift_start                 TIMESTAMPTZ,
  shift_end                   TIMESTAMPTZ,
  clock_in_at                 TIMESTAMPTZ,
  clock_out_at                TIMESTAMPTZ,
  clock_in_source             TEXT,
  clock_out_source            TEXT,
  clock_in_location_lat       NUMERIC(10,7),
  clock_in_location_lng       NUMERIC(10,7),
  clock_out_location_lat      NUMERIC(10,7),
  clock_out_location_lng      NUMERIC(10,7),
  work_status                 TEXT NOT NULL DEFAULT 'normal',
  source                      TEXT NOT NULL DEFAULT 'manual',
  note                        TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id          INTEGER,
  updated_by_user_id          INTEGER,
  version                     INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_attendance_firm_emp_date ON public.hr_attendance_records (firm_id, employee_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_firm                 ON public.hr_attendance_records (firm_id);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_firm_date            ON public.hr_attendance_records (firm_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_firm_emp            ON public.hr_attendance_records (firm_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_firm_status         ON public.hr_attendance_records (firm_id, work_status);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_firm_created        ON public.hr_attendance_records (firm_id, created_at);

-- 3b. hr_attendance_corrections (NEW)
CREATE TABLE IF NOT EXISTS public.hr_attendance_corrections (
  id                      SERIAL PRIMARY KEY,
  firm_id                 INTEGER NOT NULL,
  attendance_id           INTEGER NOT NULL,
  employee_id             INTEGER NOT NULL,
  requested_clock_in      TIMESTAMPTZ,
  requested_clock_out     TIMESTAMPTZ,
  reason                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending',
  reviewed_by_user_id     INTEGER,
  reviewed_at             TIMESTAMPTZ,
  rejection_reason        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id      INTEGER,
  updated_by_user_id      INTEGER,
  version                 INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_hr_att_corr_firm        ON public.hr_attendance_corrections (firm_id);
CREATE INDEX IF NOT EXISTS idx_hr_att_corr_attendance  ON public.hr_attendance_corrections (firm_id, attendance_id);
CREATE INDEX IF NOT EXISTS idx_hr_att_corr_emp         ON public.hr_attendance_corrections (firm_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_att_corr_status      ON public.hr_attendance_corrections (firm_id, status);

-- ---------------------------------------------------------------------------
-- 4. hr_leave_types + hr_leave_requests (NEW)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hr_leave_types (
  id                        SERIAL PRIMARY KEY,
  firm_id                   INTEGER NOT NULL,
  leave_type_code           TEXT NOT NULL,
  leave_type_name           TEXT NOT NULL,
  default_entitled_days     NUMERIC(10,2) NOT NULL DEFAULT 0,
  carry_forward_allowed     BOOLEAN NOT NULL DEFAULT false,
  max_carry_forward_days    NUMERIC(10,2),
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  description               TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id        INTEGER,
  updated_by_user_id        INTEGER,
  version                   INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_leave_types_firm_code ON public.hr_leave_types (firm_id, leave_type_code);
CREATE INDEX IF NOT EXISTS idx_hr_leave_types_firm            ON public.hr_leave_types (firm_id);
CREATE INDEX IF NOT EXISTS idx_hr_leave_types_active          ON public.hr_leave_types (firm_id, is_active);

CREATE TABLE IF NOT EXISTS public.hr_leave_requests (
  id                      SERIAL PRIMARY KEY,
  firm_id                 INTEGER NOT NULL,
  employee_id             INTEGER NOT NULL,
  leave_type_code         TEXT NOT NULL,
  start_date              DATE NOT NULL,
  end_date                DATE NOT NULL,
  days                    NUMERIC(10,2) NOT NULL DEFAULT 0,
  reason                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending',
  idempotency_key         TEXT,
  submitted_at            TIMESTAMPTZ,
  reviewed_by_user_id     INTEGER,
  reviewed_at             TIMESTAMPTZ,
  final_approver_user_id  INTEGER,
  rejection_reason        TEXT,
  balance_deducted        BOOLEAN NOT NULL DEFAULT false,
  attached_document_ref   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id      INTEGER,
  updated_by_user_id      INTEGER,
  version                 INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_leave_req_idem   ON public.hr_leave_requests (firm_id, idempotency_key) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_hr_leave_req_firm          ON public.hr_leave_requests (firm_id);
CREATE INDEX IF NOT EXISTS idx_hr_leave_req_emp           ON public.hr_leave_requests (firm_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_leave_req_status        ON public.hr_leave_requests (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_leave_req_dates         ON public.hr_leave_requests (firm_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_hr_leave_req_type          ON public.hr_leave_requests (firm_id, leave_type_code);
CREATE INDEX IF NOT EXISTS idx_hr_leave_req_created       ON public.hr_leave_requests (firm_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. hr_claims (NEW)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hr_claims (
  id                        SERIAL PRIMARY KEY,
  firm_id                   INTEGER NOT NULL,
  employee_id               INTEGER NOT NULL,
  claim_type_code           TEXT NOT NULL,
  amount                    NUMERIC(19,4) NOT NULL DEFAULT 0,
  currency                  TEXT NOT NULL DEFAULT 'MYR',
  description               TEXT,
  claim_date                DATE NOT NULL,
  receipt_document_ref      TEXT,
  status                    TEXT NOT NULL DEFAULT 'draft',
  idempotency_key           TEXT,
  submitted_at              TIMESTAMPTZ,
  reviewed_by_user_id       INTEGER,
  reviewed_at               TIMESTAMPTZ,
  rejection_reason          TEXT,
  accounting_created        BOOLEAN NOT NULL DEFAULT false,
  accounting_payable_id     INTEGER,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id        INTEGER,
  updated_by_user_id        INTEGER,
  version                   INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_claims_idem   ON public.hr_claims (firm_id, idempotency_key) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_hr_claims_firm          ON public.hr_claims (firm_id);
CREATE INDEX IF NOT EXISTS idx_hr_claims_emp           ON public.hr_claims (firm_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_claims_status        ON public.hr_claims (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_claims_type          ON public.hr_claims (firm_id, claim_type_code);
CREATE INDEX IF NOT EXISTS idx_hr_claims_date          ON public.hr_claims (firm_id, claim_date);
CREATE INDEX IF NOT EXISTS idx_hr_claims_created       ON public.hr_claims (firm_id, created_at);

-- ---------------------------------------------------------------------------
-- 6. hr_payroll_runs + hr_payroll_employee_results (NEW)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hr_payroll_runs (
  id                            SERIAL PRIMARY KEY,
  firm_id                       INTEGER NOT NULL,
  period_name                   TEXT NOT NULL,
  period_start_date             DATE NOT NULL,
  period_end_date               DATE NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'draft',
  payroll_type                  TEXT NOT NULL DEFAULT 'monthly',
  idempotency_key               TEXT,
  total_employees               INTEGER NOT NULL DEFAULT 0,
  gross_total                   NUMERIC(19,4) NOT NULL DEFAULT 0,
  deductions_total              NUMERIC(19,4) NOT NULL DEFAULT 0,
  net_total                     NUMERIC(19,4) NOT NULL DEFAULT 0,
  created_by_user_id            INTEGER,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at                  TIMESTAMPTZ,
  approved_at                   TIMESTAMPTZ,
  approved_by_user_id           INTEGER,
  finalised_at                  TIMESTAMPTZ,
  finalised_by_user_id          INTEGER,
  accounting_posted             BOOLEAN NOT NULL DEFAULT false,
  accounting_journal_entry_id   INTEGER,
  note                          TEXT,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id            INTEGER,
  version                       INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_payroll_runs_firm_period ON public.hr_payroll_runs (firm_id, period_name, payroll_type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_payroll_runs_idem        ON public.hr_payroll_runs (firm_id, idempotency_key) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_firm               ON public.hr_payroll_runs (firm_id);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_status             ON public.hr_payroll_runs (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_period_dates       ON public.hr_payroll_runs (firm_id, period_start_date, period_end_date);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_created            ON public.hr_payroll_runs (firm_id, created_at);

CREATE TABLE IF NOT EXISTS public.hr_payroll_employee_results (
  id                    SERIAL PRIMARY KEY,
  firm_id               INTEGER NOT NULL,
  payroll_run_id        INTEGER NOT NULL,
  employee_id           INTEGER NOT NULL,
  gross_pay             NUMERIC(19,4) NOT NULL DEFAULT 0,
  deductions            NUMERIC(19,4) NOT NULL DEFAULT 0,
  net_pay               NUMERIC(19,4) NOT NULL DEFAULT 0,
  breakdown_json        JSONB,
  status                TEXT NOT NULL DEFAULT 'draft',
  calculation_note      TEXT,
  payslip_issued_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    INTEGER,
  updated_by_user_id    INTEGER,
  version               INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_payroll_emp_results_run_emp ON public.hr_payroll_employee_results (payroll_run_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_emp_results_firm          ON public.hr_payroll_employee_results (firm_id);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_emp_results_run           ON public.hr_payroll_employee_results (payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_emp_results_emp           ON public.hr_payroll_employee_results (firm_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_emp_results_status        ON public.hr_payroll_employee_results (firm_id, status);
