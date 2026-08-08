-- Migration 0134: HR RBAC Roles + Permissions per Firm (Phase 1 M7)
-- Creates HR Manager / HR Admin / Employee system roles per existing firm.
-- Seeds hr_* module/action permissions per role as per Part 1 §7 permission matrix.
-- All permissions are additive; uses existing roles + permissions tables from migration 0003.
-- Uses idempotent pattern: no firm receives duplicate roles/permissions on re-run.

DO $$
DECLARE
  v_firm record;
  v_hr_manager_role_id integer;
  v_hr_admin_role_id integer;
  v_hr_employee_role_id integer;
  v_partner_role_id integer;
  v_perm record;
BEGIN
  FOR v_firm IN SELECT id FROM firms ORDER BY id LOOP

    -- ---------------------------------------------------------------------
    -- HR Roles (idempotent via firm_id + name unique; is_system_role=true)
    -- CORRECTIVE GATE 11 REVISION:
    --   Partner = HR FULL ACCESS (same as HR Manager, firm-scoped, audited, RLS enforced)
    --   HR Manager = HR FULL ACCESS
    --   HR Admin = HR FULL ACCESS
    --   All other firm roles (Lawyer, Clerk, Account Admin, ordinary Employee) = ESS only + explicit delegation if configured
    -- ---------------------------------------------------------------------
    INSERT INTO roles (firm_id, name, is_system_role, description, created_at, updated_at)
    VALUES
      (v_firm.id, 'HR Manager', true, 'Full HR authorisation including final salary, payroll run/lock/reverse, offboarding final approval, disciplinary setup, settings management.', now(), now()),
      (v_firm.id, 'HR Admin', true, 'Full HR authorisation including final salary, payroll run/lock/reverse, offboarding final approval, disciplinary setup, settings management.', now(), now()),
      (v_firm.id, 'HR Employee', true, 'Self-service employee role: own data, leave apply, claim submit, payslip view.', now(), now())
    ON CONFLICT (firm_id, name) DO NOTHING;

    SELECT id INTO v_hr_manager_role_id FROM roles WHERE firm_id = v_firm.id AND name = 'HR Manager';
    SELECT id INTO v_hr_admin_role_id   FROM roles WHERE firm_id = v_firm.id AND name = 'HR Admin';
    SELECT id INTO v_hr_employee_role_id FROM roles WHERE firm_id = v_firm.id AND name = 'HR Employee';
    SELECT id INTO v_partner_role_id     FROM roles WHERE firm_id = v_firm.id AND name = 'Partner';

    -- ---------------------------------------------------------------------
    -- Permission list. format (module, action, manager_can, admin_can, emp_can, partner_can)
    -- HR FULL ACCESS RULE (Corrective Gate 11):
    --   manager_can AND admin_can AND partner_can = true for every non-ESS permission
    --   ESS: all four can self_view/self_apply/self_submit/self_edit
    -- ---------------------------------------------------------------------
    FOR v_perm IN SELECT module, action, manager_allowed, admin_allowed, emp_allowed, partner_allowed FROM (
      VALUES
        ('hr_dashboard',           'view',                  true,  true,  false, true),

        ('hr_employee',            'list',                  true,  true,  false, true),
        ('hr_employee',            'view',                  true,  true,  false, true),
        ('hr_employee',            'create',                true,  true,  false, true),
        ('hr_employee',            'edit',                  true,  true,  false, true),
        ('hr_employee',            'terminate',             true,  true,  false, true),
        ('hr_employee',            'reactivate',            true,  true,  false, true),
        ('hr_employee',            'status_change',         true,  true,  false, true),
        ('hr_employee',            'self_view',             true,  true,  true,  true),
        ('hr_employee',            'self_edit',             true,  true,  true,  true),

        ('hr_salary',              'view',                  true,  true,  false, true),
        ('hr_salary',              'create',                true,  true,  false, true),
        ('hr_salary',              'adjustment_approve',    true,  true,  false, true),
        ('hr_salary',              'self_view_payslip',     true,  true,  true,  true),

        ('hr_bank_details',        'view',                  true,  true,  false, true),
        ('hr_bank_details',        'edit',                  true,  true,  false, true),
        ('hr_bank_details',        'self_view',             true,  true,  true,  true),
        ('hr_bank_details',        'self_edit',             true,  true,  true,  true),

        ('hr_identity_records',    'view',                  true,  true,  false, true),
        ('hr_identity_records',    'edit',                  true,  true,  false, true),
        ('hr_identity_records',    'self_view',             true,  true,  true,  true),
        ('hr_identity_records',    'self_upload',           true,  true,  true,  true),

        ('hr_medical_records',     'view',                  true,  true,  false, true),
        ('hr_medical_records',     'edit',                  true,  true,  false, true),
        ('hr_medical_records',     'self_view',             true,  true,  true,  true),
        ('hr_medical_records',     'self_upload',           true,  true,  true,  true),

        ('hr_disciplinary',        'view',                  true,  true,  false, true),
        ('hr_disciplinary',        'create',                true,  true,  false, true),
        ('hr_disciplinary',        'close',                 true,  true,  false, true),

        ('hr_leave_balance',       'view_all',              true,  true,  false, true),
        ('hr_leave_balance',       'adjust',                true,  true,  false, true),
        ('hr_leave_balance',       'self_view',             true,  true,  true,  true),

        ('hr_leave',               'view_all',              true,  true,  false, true),
        ('hr_leave',               'apply',                 true,  true,  true,  true),
        ('hr_leave',               'cancel',                true,  true,  true,  true),
        ('hr_leave',               'approve_level_1',       true,  true,  false, true),
        ('hr_leave',               'approve_final',         true,  true,  false, true),
        ('hr_leave',               'reject',                true,  true,  false, true),

        ('hr_claim',               'view_all',              true,  true,  false, true),
        ('hr_claim',               'submit',                true,  true,  true,  true),
        ('hr_claim',               'cancel',                true,  true,  true,  true),
        ('hr_claim',               'approve_level_1',       true,  true,  false, true),
        ('hr_claim',               'approve_final',         true,  true,  false, true),
        ('hr_claim',               'send_to_payroll',       true,  true,  false, true),
        ('hr_claim',               'send_to_accounting',    true,  true,  false, true),
        ('hr_claim',               'mark_paid',             true,  true,  false, true),
        ('hr_claim',               'reject',                true,  true,  false, true),

        ('hr_attendance',          'view_all',              true,  true,  false, true),
        ('hr_attendance',          'clock',                 true,  true,  true,  true),
        ('hr_attendance',          'adjust',                true,  true,  false, true),
        ('hr_attendance',          'approve_exception',     true,  true,  false, true),

        ('hr_payroll',             'list',                  true,  true,  false, true),
        ('hr_payroll',             'calculate',             true,  true,  false, true),
        ('hr_payroll',             'submit',                true,  true,  false, true),
        ('hr_payroll',             'approve',               true,  true,  false, true),
        ('hr_payroll',             'lock',                  true,  true,  false, true),
        ('hr_payroll',             'request_payment',       true,  true,  false, true),
        ('hr_payroll',             'reverse',               true,  true,  false, true),
        ('hr_payroll',             'adjust',                true,  true,  false, true),
        ('hr_payroll',             'supplementary_create',  true,  true,  false, true),
        ('hr_payroll',             'self_view',             true,  true,  true,  true),

        ('hr_recruitment',         'view',                  true,  true,  false, true),
        ('hr_recruitment',         'manage',                true,  true,  false, true),
        ('hr_recruitment',         'hire',                  true,  true,  false, true),

        ('hr_onboarding',          'manage',                true,  true,  false, true),
        ('hr_onboarding',          'self_complete',         true,  true,  true,  true),

        ('hr_offboarding',         'initiate',              true,  true,  false, true),
        ('hr_offboarding',         'manage',                true,  true,  false, true),
        ('hr_offboarding',         'final_approve',         true,  true,  false, true),
        ('hr_offboarding',         'self_handover',         true,  true,  true,  true),

        ('hr_assets',              'manage',                true,  true,  false, true),
        ('hr_assets',              'assign',                true,  true,  false, true),
        ('hr_assets',              'receive_return',        true,  true,  false, true),
        ('hr_assets',              'self_view',             true,  true,  true,  true),

        ('hr_training',            'manage',                true,  true,  false, true),
        ('hr_training',            'self_view',             true,  true,  true,  true),
        ('hr_training',            'self_apply',            true,  true,  true,  true),

        ('hr_performance',         'manage',                true,  true,  false, true),
        ('hr_performance',         'view_all',              true,  true,  false, true),
        ('hr_performance',         'self_view',             true,  true,  true,  true),

        ('hr_documents',           'manage',                true,  true,  false, true),
        ('hr_documents',           'view_confidential',     true,  true,  false, true),
        ('hr_documents',           'view_sensitive',        true,  true,  false, true),
        ('hr_documents',           'self_view',             true,  true,  true,  true),
        ('hr_documents',           'self_upload',           true,  true,  true,  true),

        ('hr_approval',            'delegate',              true,  true,  false, true),
        ('hr_approval',            'reassign',              true,  true,  false, true),
        ('hr_approval',            'override',              true,  true,  false, true),

        ('hr_reports',             'view_headcount',        true,  true,  false, true),
        ('hr_reports',             'view_turnover',         true,  true,  false, true),
        ('hr_reports',             'view_leave_summary',    true,  true,  false, true),
        ('hr_reports',             'view_payroll_summary',  true,  true,  false, true),
        ('hr_reports',             'view_cost_analysis',    true,  true,  false, true),

        ('hr_settings',            'manage_organisation',   true,  true,  false, true),
        ('hr_settings',            'manage_approval_flow',  true,  true,  false, true),
        ('hr_settings',            'manage_feature_flags',  true,  true,  false, true),
        ('hr_settings',            'view',                  true,  true,  false, true)
    ) AS p(module, action, manager_allowed, admin_allowed, emp_allowed, partner_allowed)
    LOOP
      IF v_perm.manager_allowed THEN
        INSERT INTO permissions (role_id, module, action, allowed)
        VALUES (v_hr_manager_role_id, v_perm.module, v_perm.action, true)
        ON CONFLICT (role_id, module, action) DO UPDATE SET allowed = EXCLUDED.allowed;
      END IF;

      IF v_perm.admin_allowed THEN
        INSERT INTO permissions (role_id, module, action, allowed)
        VALUES (v_hr_admin_role_id, v_perm.module, v_perm.action, true)
        ON CONFLICT (role_id, module, action) DO UPDATE SET allowed = EXCLUDED.allowed;
      END IF;

      IF v_perm.emp_allowed THEN
        INSERT INTO permissions (role_id, module, action, allowed)
        VALUES (v_hr_employee_role_id, v_perm.module, v_perm.action, true)
        ON CONFLICT (role_id, module, action) DO UPDATE SET allowed = EXCLUDED.allowed;
      END IF;

      IF v_perm.partner_allowed AND v_partner_role_id IS NOT NULL THEN
        INSERT INTO permissions (role_id, module, action, allowed)
        VALUES (v_partner_role_id, v_perm.module, v_perm.action, true)
        ON CONFLICT (role_id, module, action) DO UPDATE SET allowed = EXCLUDED.allowed;
      END IF;
    END LOOP;

  END LOOP;
END $$;
