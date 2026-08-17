-- =========================================================================
-- p10_hr_tenant_fk_additive.sql
-- PART 3B-1B §13/§14/§15: HR Tenant Integrity + Additive Foreign Keys
--
-- RULES (non-negotiable per spec §14):
--   NO DROP.  NO TRUNCATE.  NO DESTRUCTIVE CASCADE.
--   Every FK = ON DELETE RESTRICT.
--   Every FK = ADD CONSTRAINT ... NOT VALID, then VALIDATE CONSTRAINT.
--
-- PRE-FLIGHT ORPHAN COUNT CHECKS (§14 MANDATORY — run against live Supabase
-- BEFORE applying this migration; address any non-zero counts first, or
-- rely on NOT VALID to skip validation until orphans cleaned):
--
--   -- firms orphans (should all be 0)
--   SELECT 'hr_branches' AS t, COUNT(*) AS orphans FROM hr_branches b WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=b.firm_id);
--   SELECT 'hr_departments' AS t, COUNT(*) AS orphans FROM hr_departments d WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=d.firm_id);
--   SELECT 'hr_positions' AS t, COUNT(*) AS orphans FROM hr_positions p WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=p.firm_id);
--   SELECT 'hr_organisation_settings' AS t, COUNT(*) AS orphans FROM hr_organisation_settings s WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=s.firm_id);
--   SELECT 'hr_employees' AS t, COUNT(*) AS orphans FROM hr_employees e WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=e.firm_id);
--   SELECT 'hr_employee_salaries' AS t, COUNT(*) AS orphans FROM hr_employee_salaries s WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=s.firm_id);
--   SELECT 'hr_employee_bank_accounts' AS t, COUNT(*) AS orphans FROM hr_employee_bank_accounts a WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=a.firm_id);
--   SELECT 'hr_employee_identity_records' AS t, COUNT(*) AS orphans FROM hr_employee_identity_records r WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=r.firm_id);
--   SELECT 'hr_employee_medical_records' AS t, COUNT(*) AS orphans FROM hr_employee_medical_records r WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=r.firm_id);
--   SELECT 'hr_employee_disciplinary_records' AS t, COUNT(*) AS orphans FROM hr_employee_disciplinary_records r WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=r.firm_id);
--   SELECT 'hr_employee_leave_balances' AS t, COUNT(*) AS orphans FROM hr_employee_leave_balances b WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=b.firm_id);
--   SELECT 'hr_attendance_records' AS t, COUNT(*) AS orphans FROM hr_attendance_records a WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=a.firm_id);
--   SELECT 'hr_attendance_corrections' AS t, COUNT(*) AS orphans FROM hr_attendance_corrections c WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=c.firm_id);
--   SELECT 'hr_claims' AS t, COUNT(*) AS orphans FROM hr_claims c WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=c.firm_id);
--   SELECT 'hr_leave_types' AS t, COUNT(*) AS orphans FROM hr_leave_types t WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=t.firm_id);
--   SELECT 'hr_leave_requests' AS t, COUNT(*) AS orphans FROM hr_leave_requests r WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=r.firm_id);
--   SELECT 'hr_payroll_runs' AS t, COUNT(*) AS orphans FROM hr_payroll_runs r WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=r.firm_id);
--   SELECT 'hr_payroll_employee_results' AS t, COUNT(*) AS orphans FROM hr_payroll_employee_results r WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=r.firm_id);
--   SELECT 'hr_approval_process_definitions' AS t, COUNT(*) AS orphans FROM hr_approval_process_definitions d WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=d.firm_id);
--   SELECT 'hr_approval_requests' AS t, COUNT(*) AS orphans FROM hr_approval_requests r WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=r.firm_id);
--   SELECT 'hr_approval_request_steps' AS t, COUNT(*) AS orphans FROM hr_approval_request_steps s WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=s.firm_id);
--   SELECT 'hr_approval_delegations' AS t, COUNT(*) AS orphans FROM hr_approval_delegations d WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=d.firm_id);
--   SELECT 'hr_approval_action_logs' AS t, COUNT(*) AS orphans FROM hr_approval_action_logs l WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=l.firm_id);
--   SELECT 'hr_reporting_lines' AS t, COUNT(*) AS orphans FROM hr_reporting_lines l WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=l.firm_id);
--   SELECT 'hr_employment_records' AS t, COUNT(*) AS orphans FROM hr_employment_records r WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=r.firm_id);
--   SELECT 'hr_documents' AS t, COUNT(*) AS orphans FROM hr_documents d WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=d.firm_id);
--   SELECT 'hr_user_employee_memberships' AS t, COUNT(*) AS orphans FROM hr_user_employee_memberships m WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=m.firm_id);
--   SELECT 'hr_firm_feature_flags' AS t, COUNT(*) AS orphans FROM hr_firm_feature_flags ff WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=ff.firm_id);
--   SELECT 'hr_employee_position_authorizations' AS t, COUNT(*) AS orphans FROM hr_employee_position_authorizations a WHERE NOT EXISTS (SELECT 1 FROM firms f WHERE f.id=a.firm_id);
--
--   -- employee → hr_employees orphans (should be 0)
--   SELECT 'salaries_emp' AS t, COUNT(*) AS orphans FROM hr_employee_salaries s WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=s.employee_id AND e.firm_id=s.firm_id);
--   SELECT 'bank_emp' AS t, COUNT(*) AS orphans FROM hr_employee_bank_accounts a WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=a.employee_id AND e.firm_id=a.firm_id);
--   SELECT 'ident_emp' AS t, COUNT(*) AS orphans FROM hr_employee_identity_records r WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=r.employee_id AND e.firm_id=r.firm_id);
--   SELECT 'med_emp' AS t, COUNT(*) AS orphans FROM hr_employee_medical_records r WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=r.employee_id AND e.firm_id=r.firm_id);
--   SELECT 'disc_emp' AS t, COUNT(*) AS orphans FROM hr_employee_disciplinary_records r WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=r.employee_id AND e.firm_id=r.firm_id);
--   SELECT 'lvbal_emp' AS t, COUNT(*) AS orphans FROM hr_employee_leave_balances b WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=b.employee_id AND e.firm_id=b.firm_id);
--   SELECT 'att_emp' AS t, COUNT(*) AS orphans FROM hr_attendance_records a WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=a.employee_id AND e.firm_id=a.firm_id);
--   SELECT 'attcorr_emp' AS t, COUNT(*) AS orphans FROM hr_attendance_corrections c WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=c.employee_id AND e.firm_id=c.firm_id);
--   SELECT 'claims_emp' AS t, COUNT(*) AS orphans FROM hr_claims c WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=c.employee_id AND e.firm_id=c.firm_id);
--   SELECT 'leavereq_emp' AS t, COUNT(*) AS orphans FROM hr_leave_requests r WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=r.employee_id AND e.firm_id=r.firm_id);
--   SELECT 'payempres_emp' AS t, COUNT(*) AS orphans FROM hr_payroll_employee_results r WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=r.employee_id AND e.firm_id=r.firm_id);
--   SELECT 'reportinglines_emp' AS t, COUNT(*) AS orphans FROM hr_reporting_lines l WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=l.employee_id AND e.firm_id=l.firm_id);
--   SELECT 'emprecords_emp' AS t, COUNT(*) AS orphans FROM hr_employment_records r WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=r.employee_id AND e.firm_id=r.firm_id);
--   SELECT 'docs_emp' AS t, COUNT(*) AS orphans FROM hr_documents d WHERE d.employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=d.employee_id AND e.firm_id=d.firm_id);
--   SELECT 'memberships_emp' AS t, COUNT(*) AS orphans FROM hr_user_employee_memberships m WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=m.employee_id AND e.firm_id=m.firm_id);
--   SELECT 'posauth_emp' AS t, COUNT(*) AS orphans FROM hr_employee_position_authorizations a WHERE NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.id=a.employee_id AND e.firm_id=a.firm_id);
-- =========================================================================

SET search_path TO public;

-- -------------------------------------------------------------------------
-- 1. HR CORE (hr_branches / hr_departments / hr_positions / org_settings / business_events)
-- -------------------------------------------------------------------------

-- 1a. hr_branches → firms
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_branches_firm') THEN
  ALTER TABLE public.hr_branches
    ADD CONSTRAINT fk_hr_branches_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_branches VALIDATE CONSTRAINT fk_hr_branches_firm;

-- 1b. hr_departments → firms + hr_branches
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_departments_firm') THEN
  ALTER TABLE public.hr_departments
    ADD CONSTRAINT fk_hr_departments_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_departments VALIDATE CONSTRAINT fk_hr_departments_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_departments_branch') THEN
  ALTER TABLE public.hr_departments
    ADD CONSTRAINT fk_hr_departments_branch
    FOREIGN KEY (firm_id, branch_id) REFERENCES public.hr_branches(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_departments VALIDATE CONSTRAINT fk_hr_departments_branch;

-- 1c. hr_positions → firms + hr_departments + self(reports_to)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_positions_firm') THEN
  ALTER TABLE public.hr_positions
    ADD CONSTRAINT fk_hr_positions_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_positions VALIDATE CONSTRAINT fk_hr_positions_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_positions_dept') THEN
  ALTER TABLE public.hr_positions
    ADD CONSTRAINT fk_hr_positions_dept
    FOREIGN KEY (firm_id, department_id) REFERENCES public.hr_departments(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_positions VALIDATE CONSTRAINT fk_hr_positions_dept;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_positions_reports_to') THEN
  ALTER TABLE public.hr_positions
    ADD CONSTRAINT fk_hr_positions_reports_to
    FOREIGN KEY (firm_id, reports_to_position_id) REFERENCES public.hr_positions(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_positions VALIDATE CONSTRAINT fk_hr_positions_reports_to;

-- 1d. hr_organisation_settings → firms (PK = firm_id)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_org_settings_firm') THEN
  ALTER TABLE public.hr_organisation_settings
    ADD CONSTRAINT fk_hr_org_settings_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_organisation_settings VALIDATE CONSTRAINT fk_hr_org_settings_firm;

-- 1e. hr_business_events → firms
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_business_events_firm') THEN
  ALTER TABLE public.hr_business_events
    ADD CONSTRAINT fk_hr_business_events_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_business_events VALIDATE CONSTRAINT fk_hr_business_events_firm;

-- -------------------------------------------------------------------------
-- 2. EMPLOYEES + SENSITIVE SUBTABLES
-- -------------------------------------------------------------------------

-- 2a. hr_employees → firms + branch + dept + position + self(manager)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_employees_firm') THEN
  ALTER TABLE public.hr_employees
    ADD CONSTRAINT fk_hr_employees_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employees VALIDATE CONSTRAINT fk_hr_employees_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_employees_branch') THEN
  ALTER TABLE public.hr_employees
    ADD CONSTRAINT fk_hr_employees_branch
    FOREIGN KEY (firm_id, branch_id) REFERENCES public.hr_branches(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employees VALIDATE CONSTRAINT fk_hr_employees_branch;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_employees_dept') THEN
  ALTER TABLE public.hr_employees
    ADD CONSTRAINT fk_hr_employees_dept
    FOREIGN KEY (firm_id, department_id) REFERENCES public.hr_departments(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employees VALIDATE CONSTRAINT fk_hr_employees_dept;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_employees_position') THEN
  ALTER TABLE public.hr_employees
    ADD CONSTRAINT fk_hr_employees_position
    FOREIGN KEY (firm_id, position_id) REFERENCES public.hr_positions(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employees VALIDATE CONSTRAINT fk_hr_employees_position;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_employees_manager') THEN
  ALTER TABLE public.hr_employees
    ADD CONSTRAINT fk_hr_employees_manager
    FOREIGN KEY (firm_id, reporting_manager_employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employees VALIDATE CONSTRAINT fk_hr_employees_manager;

-- 2b. hr_employee_salaries → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_salaries_firm') THEN
  ALTER TABLE public.hr_employee_salaries
    ADD CONSTRAINT fk_hr_salaries_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_salaries VALIDATE CONSTRAINT fk_hr_salaries_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_salaries_employee') THEN
  ALTER TABLE public.hr_employee_salaries
    ADD CONSTRAINT fk_hr_salaries_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_salaries VALIDATE CONSTRAINT fk_hr_salaries_employee;

-- 2c. hr_employee_bank_accounts → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_bank_firm') THEN
  ALTER TABLE public.hr_employee_bank_accounts
    ADD CONSTRAINT fk_hr_bank_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_bank_accounts VALIDATE CONSTRAINT fk_hr_bank_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_bank_employee') THEN
  ALTER TABLE public.hr_employee_bank_accounts
    ADD CONSTRAINT fk_hr_bank_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_bank_accounts VALIDATE CONSTRAINT fk_hr_bank_employee;

-- 2d. hr_employee_identity_records → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_identity_firm') THEN
  ALTER TABLE public.hr_employee_identity_records
    ADD CONSTRAINT fk_hr_identity_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_identity_records VALIDATE CONSTRAINT fk_hr_identity_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_identity_employee') THEN
  ALTER TABLE public.hr_employee_identity_records
    ADD CONSTRAINT fk_hr_identity_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_identity_records VALIDATE CONSTRAINT fk_hr_identity_employee;

-- 2e. hr_employee_medical_records → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_medical_firm') THEN
  ALTER TABLE public.hr_employee_medical_records
    ADD CONSTRAINT fk_hr_medical_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_medical_records VALIDATE CONSTRAINT fk_hr_medical_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_medical_employee') THEN
  ALTER TABLE public.hr_employee_medical_records
    ADD CONSTRAINT fk_hr_medical_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_medical_records VALIDATE CONSTRAINT fk_hr_medical_employee;

-- 2f. hr_employee_disciplinary_records → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_disciplinary_firm') THEN
  ALTER TABLE public.hr_employee_disciplinary_records
    ADD CONSTRAINT fk_hr_disciplinary_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_disciplinary_records VALIDATE CONSTRAINT fk_hr_disciplinary_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_disciplinary_employee') THEN
  ALTER TABLE public.hr_employee_disciplinary_records
    ADD CONSTRAINT fk_hr_disciplinary_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_disciplinary_records VALIDATE CONSTRAINT fk_hr_disciplinary_employee;

-- 2g. hr_employee_leave_balances → firms + hr_employees + hr_leave_types
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_leave_balance_firm') THEN
  ALTER TABLE public.hr_employee_leave_balances
    ADD CONSTRAINT fk_hr_leave_balance_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_leave_balances VALIDATE CONSTRAINT fk_hr_leave_balance_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_leave_balance_employee') THEN
  ALTER TABLE public.hr_employee_leave_balances
    ADD CONSTRAINT fk_hr_leave_balance_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_leave_balances VALIDATE CONSTRAINT fk_hr_leave_balance_employee;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_leave_balance_leave_type') THEN
  ALTER TABLE public.hr_employee_leave_balances
    ADD CONSTRAINT fk_hr_leave_balance_leave_type
    FOREIGN KEY (firm_id, leave_type_code) REFERENCES public.hr_leave_types(firm_id, leave_type_code) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_leave_balances VALIDATE CONSTRAINT fk_hr_leave_balance_leave_type;

-- -------------------------------------------------------------------------
-- 3. ATTENDANCE
-- -------------------------------------------------------------------------

-- 3a. hr_attendance_records → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_attendance_firm') THEN
  ALTER TABLE public.hr_attendance_records
    ADD CONSTRAINT fk_hr_attendance_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_attendance_records VALIDATE CONSTRAINT fk_hr_attendance_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_attendance_employee') THEN
  ALTER TABLE public.hr_attendance_records
    ADD CONSTRAINT fk_hr_attendance_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_attendance_records VALIDATE CONSTRAINT fk_hr_attendance_employee;

-- 3b. hr_attendance_corrections → firms + hr_attendance_records + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_att_corr_firm') THEN
  ALTER TABLE public.hr_attendance_corrections
    ADD CONSTRAINT fk_hr_att_corr_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_attendance_corrections VALIDATE CONSTRAINT fk_hr_att_corr_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_att_corr_attendance') THEN
  ALTER TABLE public.hr_attendance_corrections
    ADD CONSTRAINT fk_hr_att_corr_attendance
    FOREIGN KEY (firm_id, attendance_id) REFERENCES public.hr_attendance_records(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_attendance_corrections VALIDATE CONSTRAINT fk_hr_att_corr_attendance;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_att_corr_employee') THEN
  ALTER TABLE public.hr_attendance_corrections
    ADD CONSTRAINT fk_hr_att_corr_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_attendance_corrections VALIDATE CONSTRAINT fk_hr_att_corr_employee;

-- -------------------------------------------------------------------------
-- 4. CLAIMS (§1-6: accounting_payable_id FK to payment_vouchers — source_link)
-- -------------------------------------------------------------------------

-- 4a. hr_claims → firms + hr_employees + payment_vouchers (nullable accounting)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_claims_firm') THEN
  ALTER TABLE public.hr_claims
    ADD CONSTRAINT fk_hr_claims_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_claims VALIDATE CONSTRAINT fk_hr_claims_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_claims_employee') THEN
  ALTER TABLE public.hr_claims
    ADD CONSTRAINT fk_hr_claims_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_claims VALIDATE CONSTRAINT fk_hr_claims_employee;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_claims_payment_voucher') THEN
  ALTER TABLE public.hr_claims
    ADD CONSTRAINT fk_hr_claims_payment_voucher
    FOREIGN KEY (firm_id, accounting_payable_id) REFERENCES public.payment_vouchers(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_claims VALIDATE CONSTRAINT fk_hr_claims_payment_voucher;

-- -------------------------------------------------------------------------
-- 5. LEAVE
-- -------------------------------------------------------------------------

-- 5a. hr_leave_types → firms
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_leave_types_firm') THEN
  ALTER TABLE public.hr_leave_types
    ADD CONSTRAINT fk_hr_leave_types_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_leave_types VALIDATE CONSTRAINT fk_hr_leave_types_firm;

-- 5b. hr_leave_requests → firms + hr_employees + hr_leave_types
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_leave_requests_firm') THEN
  ALTER TABLE public.hr_leave_requests
    ADD CONSTRAINT fk_hr_leave_requests_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_leave_requests VALIDATE CONSTRAINT fk_hr_leave_requests_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_leave_requests_employee') THEN
  ALTER TABLE public.hr_leave_requests
    ADD CONSTRAINT fk_hr_leave_requests_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_leave_requests VALIDATE CONSTRAINT fk_hr_leave_requests_employee;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_leave_requests_leave_type') THEN
  ALTER TABLE public.hr_leave_requests
    ADD CONSTRAINT fk_hr_leave_requests_leave_type
    FOREIGN KEY (firm_id, leave_type_code) REFERENCES public.hr_leave_types(firm_id, leave_type_code) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_leave_requests VALIDATE CONSTRAINT fk_hr_leave_requests_leave_type;

-- -------------------------------------------------------------------------
-- 6. PAYROLL (§7/§8: accounting_journal_entry_id nullable — no FK yet,
--    downstream = ledger_entries.id but sourceType/sourceId enforce link)
-- -------------------------------------------------------------------------

-- 6a. hr_payroll_runs → firms
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_payroll_runs_firm') THEN
  ALTER TABLE public.hr_payroll_runs
    ADD CONSTRAINT fk_hr_payroll_runs_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_payroll_runs VALIDATE CONSTRAINT fk_hr_payroll_runs_firm;

-- 6b. hr_payroll_employee_results → firms + hr_payroll_runs + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_payroll_results_firm') THEN
  ALTER TABLE public.hr_payroll_employee_results
    ADD CONSTRAINT fk_hr_payroll_results_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_payroll_employee_results VALIDATE CONSTRAINT fk_hr_payroll_results_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_payroll_results_run') THEN
  ALTER TABLE public.hr_payroll_employee_results
    ADD CONSTRAINT fk_hr_payroll_results_run
    FOREIGN KEY (firm_id, payroll_run_id) REFERENCES public.hr_payroll_runs(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_payroll_employee_results VALIDATE CONSTRAINT fk_hr_payroll_results_run;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_payroll_results_employee') THEN
  ALTER TABLE public.hr_payroll_employee_results
    ADD CONSTRAINT fk_hr_payroll_results_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_payroll_employee_results VALIDATE CONSTRAINT fk_hr_payroll_results_employee;

-- -------------------------------------------------------------------------
-- 7. APPROVALS
-- -------------------------------------------------------------------------

-- 7a. hr_approval_process_definitions → firms
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_approval_proc_def_firm') THEN
  ALTER TABLE public.hr_approval_process_definitions
    ADD CONSTRAINT fk_hr_approval_proc_def_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_approval_process_definitions VALIDATE CONSTRAINT fk_hr_approval_proc_def_firm;

-- 7b. hr_approval_requests → firms + process_definitions
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_approval_requests_firm') THEN
  ALTER TABLE public.hr_approval_requests
    ADD CONSTRAINT fk_hr_approval_requests_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_approval_requests VALIDATE CONSTRAINT fk_hr_approval_requests_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_approval_requests_proc_def') THEN
  ALTER TABLE public.hr_approval_requests
    ADD CONSTRAINT fk_hr_approval_requests_proc_def
    FOREIGN KEY (firm_id, process_definition_id) REFERENCES public.hr_approval_process_definitions(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_approval_requests VALIDATE CONSTRAINT fk_hr_approval_requests_proc_def;

-- 7c. hr_approval_request_steps → firms + approval_requests
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_approval_steps_firm') THEN
  ALTER TABLE public.hr_approval_request_steps
    ADD CONSTRAINT fk_hr_approval_steps_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_approval_request_steps VALIDATE CONSTRAINT fk_hr_approval_steps_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_approval_steps_request') THEN
  ALTER TABLE public.hr_approval_request_steps
    ADD CONSTRAINT fk_hr_approval_steps_request
    FOREIGN KEY (firm_id, approval_request_id) REFERENCES public.hr_approval_requests(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_approval_request_steps VALIDATE CONSTRAINT fk_hr_approval_steps_request;

-- 7d. hr_approval_delegations → firms
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_approval_delegations_firm') THEN
  ALTER TABLE public.hr_approval_delegations
    ADD CONSTRAINT fk_hr_approval_delegations_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_approval_delegations VALIDATE CONSTRAINT fk_hr_approval_delegations_firm;

-- 7e. hr_approval_action_logs → firms + approval_requests (nullable)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_approval_action_logs_firm') THEN
  ALTER TABLE public.hr_approval_action_logs
    ADD CONSTRAINT fk_hr_approval_action_logs_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_approval_action_logs VALIDATE CONSTRAINT fk_hr_approval_action_logs_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_approval_action_logs_request') THEN
  ALTER TABLE public.hr_approval_action_logs
    ADD CONSTRAINT fk_hr_approval_action_logs_request
    FOREIGN KEY (firm_id, approval_request_id) REFERENCES public.hr_approval_requests(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_approval_action_logs VALIDATE CONSTRAINT fk_hr_approval_action_logs_request;

-- -------------------------------------------------------------------------
-- 8. MEMBERSHIPS + DOCUMENTS + REPORTING + POSITION AUTH + FEATURE FLAGS
-- -------------------------------------------------------------------------

-- 8a. hr_reporting_lines → firms + hr_employees (emp + manager)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_reporting_lines_firm') THEN
  ALTER TABLE public.hr_reporting_lines
    ADD CONSTRAINT fk_hr_reporting_lines_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_reporting_lines VALIDATE CONSTRAINT fk_hr_reporting_lines_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_reporting_lines_employee') THEN
  ALTER TABLE public.hr_reporting_lines
    ADD CONSTRAINT fk_hr_reporting_lines_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_reporting_lines VALIDATE CONSTRAINT fk_hr_reporting_lines_employee;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_reporting_lines_manager') THEN
  ALTER TABLE public.hr_reporting_lines
    ADD CONSTRAINT fk_hr_reporting_lines_manager
    FOREIGN KEY (firm_id, reporting_manager_employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_reporting_lines VALIDATE CONSTRAINT fk_hr_reporting_lines_manager;

-- 8b. hr_employment_records → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_employment_records_firm') THEN
  ALTER TABLE public.hr_employment_records
    ADD CONSTRAINT fk_hr_employment_records_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employment_records VALIDATE CONSTRAINT fk_hr_employment_records_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_employment_records_employee') THEN
  ALTER TABLE public.hr_employment_records
    ADD CONSTRAINT fk_hr_employment_records_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employment_records VALIDATE CONSTRAINT fk_hr_employment_records_employee;

-- 8c. hr_documents → firms + hr_employees (nullable)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_documents_firm') THEN
  ALTER TABLE public.hr_documents
    ADD CONSTRAINT fk_hr_documents_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_documents VALIDATE CONSTRAINT fk_hr_documents_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_documents_employee') THEN
  ALTER TABLE public.hr_documents
    ADD CONSTRAINT fk_hr_documents_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_documents VALIDATE CONSTRAINT fk_hr_documents_employee;

-- 8d. hr_user_employee_memberships → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_memberships_firm') THEN
  ALTER TABLE public.hr_user_employee_memberships
    ADD CONSTRAINT fk_hr_memberships_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_user_employee_memberships VALIDATE CONSTRAINT fk_hr_memberships_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_memberships_employee') THEN
  ALTER TABLE public.hr_user_employee_memberships
    ADD CONSTRAINT fk_hr_memberships_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_user_employee_memberships VALIDATE CONSTRAINT fk_hr_memberships_employee;

-- 8e. hr_firm_feature_flags → firms (PK = firm_id)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_firm_feature_flags_firm') THEN
  ALTER TABLE public.hr_firm_feature_flags
    ADD CONSTRAINT fk_hr_firm_feature_flags_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_firm_feature_flags VALIDATE CONSTRAINT fk_hr_firm_feature_flags_firm;

-- 8f. hr_employee_position_authorizations → firms + hr_employees
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_pos_auth_firm') THEN
  ALTER TABLE public.hr_employee_position_authorizations
    ADD CONSTRAINT fk_hr_pos_auth_firm
    FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_position_authorizations VALIDATE CONSTRAINT fk_hr_pos_auth_firm;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_hr_pos_auth_employee') THEN
  ALTER TABLE public.hr_employee_position_authorizations
    ADD CONSTRAINT fk_hr_pos_auth_employee
    FOREIGN KEY (firm_id, employee_id) REFERENCES public.hr_employees(firm_id, id) ON DELETE RESTRICT NOT VALID;
END IF; END $$;
ALTER TABLE public.hr_employee_position_authorizations VALIDATE CONSTRAINT fk_hr_pos_auth_employee;

-- -------------------------------------------------------------------------
-- 9. SOURCE LINK INDEXES (§5: drill-through both ways)
--    ledger_entries + payment_vouchers source_type/source_id lookups
-- -------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ledger_entries_source_hr_claim
  ON public.ledger_entries (firm_id, source_type, source_id)
  WHERE source_type = 'hr_claim';

CREATE INDEX IF NOT EXISTS idx_ledger_entries_source_hr_payroll
  ON public.ledger_entries (firm_id, source_type, source_id)
  WHERE source_type = 'hr_payroll';

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_client_request_hr_claim
  ON public.payment_vouchers (firm_id, client_request_id)
  WHERE client_request_id LIKE 'HR_CLAIM_APPROVED:%';
