import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MONOREPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const HR_FULL_ACCESS_PILLARS = [
  { module: "hr_employee", action: "list", label: "HR employee list" },
  { module: "hr_employee", action: "view", label: "HR employee view" },
  { module: "hr_employee", action: "create", label: "HR employee create" },
  { module: "hr_employee", action: "edit", label: "HR employee edit" },
  { module: "hr_employee", action: "terminate", label: "Employee terminate" },
  { module: "hr_employee", action: "reactivate", label: "Employee reactivate" },
  { module: "hr_employee", action: "status_change", label: "Employee status change" },
  { module: "hr_salary", action: "view", label: "Salary view" },
  { module: "hr_salary", action: "create", label: "Salary create" },
  { module: "hr_salary", action: "adjustment_approve", label: "Salary adjustment approve" },
  { module: "hr_bank_details", action: "view", label: "Bank details view" },
  { module: "hr_bank_details", action: "edit", label: "Bank details edit" },
  { module: "hr_identity_records", action: "view", label: "Identity records view" },
  { module: "hr_identity_records", action: "edit", label: "Identity records edit" },
  { module: "hr_medical_records", action: "view", label: "Medical records view" },
  { module: "hr_medical_records", action: "edit", label: "Medical records edit" },
  { module: "hr_disciplinary", action: "view", label: "Disciplinary view" },
  { module: "hr_disciplinary", action: "create", label: "Disciplinary create" },
  { module: "hr_disciplinary", action: "close", label: "Disciplinary close" },
  { module: "hr_leave_balance", action: "view_all", label: "Leave balance view_all" },
  { module: "hr_leave_balance", action: "adjust", label: "Leave balance adjust" },
  { module: "hr_leave", action: "view_all", label: "Leave view_all" },
  { module: "hr_leave", action: "approve_level_1", label: "Leave approve L1" },
  { module: "hr_leave", action: "approve_final", label: "Leave approve final" },
  { module: "hr_leave", action: "reject", label: "Leave reject" },
  { module: "hr_claim", action: "view_all", label: "Claim view_all" },
  { module: "hr_claim", action: "approve_level_1", label: "Claim approve L1" },
  { module: "hr_claim", action: "approve_final", label: "Claim approve final" },
  { module: "hr_claim", action: "mark_paid", label: "Claim mark_paid" },
  { module: "hr_claim", action: "reject", label: "Claim reject" },
  { module: "hr_attendance", action: "view_all", label: "Attendance view_all" },
  { module: "hr_attendance", action: "adjust", label: "Attendance adjust" },
  { module: "hr_attendance", action: "approve_exception", label: "Attendance approve exception" },
  { module: "hr_payroll", action: "list", label: "Payroll list" },
  { module: "hr_payroll", action: "calculate", label: "Payroll calculate" },
  { module: "hr_payroll", action: "submit", label: "Payroll submit" },
  { module: "hr_payroll", action: "approve", label: "Payroll approve" },
  { module: "hr_payroll", action: "lock", label: "Payroll lock" },
  { module: "hr_payroll", action: "request_payment", label: "Payroll request payment" },
  { module: "hr_payroll", action: "reverse", label: "Payroll reverse" },
  { module: "hr_payroll", action: "adjust", label: "Payroll adjust" },
  { module: "hr_payroll", action: "supplementary_create", label: "Payroll supplementary create" },
  { module: "hr_recruitment", action: "manage", label: "Recruitment manage" },
  { module: "hr_recruitment", action: "hire", label: "Recruitment hire" },
  { module: "hr_onboarding", action: "manage", label: "Onboarding manage" },
  { module: "hr_offboarding", action: "initiate", label: "Offboarding initiate" },
  { module: "hr_offboarding", action: "manage", label: "Offboarding manage" },
  { module: "hr_offboarding", action: "final_approve", label: "Offboarding final approve" },
  { module: "hr_assets", action: "manage", label: "Assets manage" },
  { module: "hr_assets", action: "assign", label: "Assets assign" },
  { module: "hr_assets", action: "receive_return", label: "Assets receive_return" },
  { module: "hr_training", action: "manage", label: "Training manage" },
  { module: "hr_performance", action: "manage", label: "Performance manage" },
  { module: "hr_performance", action: "view_all", label: "Performance view_all" },
  { module: "hr_documents", action: "manage", label: "HR documents manage" },
  { module: "hr_documents", action: "view_confidential", label: "HR documents confidential view" },
  { module: "hr_documents", action: "view_sensitive", label: "HR documents sensitive view" },
  { module: "hr_approval", action: "delegate", label: "Approval delegate" },
  { module: "hr_approval", action: "reassign", label: "Approval reassign" },
  { module: "hr_approval", action: "override", label: "Approval override" },
  { module: "hr_reports", action: "view_turnover", label: "Reports turnover" },
  { module: "hr_reports", action: "view_payroll_summary", label: "Reports payroll summary" },
  { module: "hr_reports", action: "view_cost_analysis", label: "Reports cost analysis" },
  { module: "hr_settings", action: "manage_organisation", label: "HR settings manage_organisation" },
  { module: "hr_settings", action: "manage_approval_flow", label: "HR settings manage_approval_flow" },
  { module: "hr_settings", action: "manage_feature_flags", label: "HR settings manage_feature_flags" },
];

const HR_ESS_ONLY_ACTIONS = [
  { module: "hr_employee", action: "self_view", label: "ESS self view" },
  { module: "hr_employee", action: "self_edit", label: "ESS self edit" },
  { module: "hr_bank_details", action: "self_view", label: "ESS self bank view" },
  { module: "hr_bank_details", action: "self_edit", label: "ESS self bank edit" },
  { module: "hr_identity_records", action: "self_view", label: "ESS self identity view" },
  { module: "hr_identity_records", action: "self_upload", label: "ESS self identity upload" },
  { module: "hr_medical_records", action: "self_view", label: "ESS self medical view" },
  { module: "hr_medical_records", action: "self_upload", label: "ESS self medical upload" },
  { module: "hr_leave_balance", action: "self_view", label: "ESS self leave balance view" },
  { module: "hr_leave", action: "apply", label: "ESS self leave apply" },
  { module: "hr_leave", action: "cancel", label: "ESS self leave cancel" },
  { module: "hr_claim", action: "submit", label: "ESS self claim submit" },
  { module: "hr_claim", action: "cancel", label: "ESS self claim cancel" },
  { module: "hr_attendance", action: "clock", label: "ESS self attendance clock" },
  { module: "hr_payroll", action: "self_view", label: "ESS self payslip view" },
  { module: "hr_onboarding", action: "self_complete", label: "ESS self onboarding complete" },
  { module: "hr_offboarding", action: "self_handover", label: "ESS self offboarding handover" },
  { module: "hr_assets", action: "self_view", label: "ESS self assets view" },
  { module: "hr_training", action: "self_view", label: "ESS self training view" },
  { module: "hr_training", action: "self_apply", label: "ESS self training apply" },
  { module: "hr_performance", action: "self_view", label: "ESS self performance view" },
  { module: "hr_documents", action: "self_view", label: "ESS self documents view" },
  { module: "hr_documents", action: "self_upload", label: "ESS self documents upload" },
  { module: "hr_salary", action: "self_view_payslip", label: "ESS self payslip view (salary)" },
];

const SENSITIVE_FORBIDDEN_FOR_ESS = [
  { module: "hr_salary", action: "view", label: "Salary view (forbidden for ESS)" },
  { module: "hr_salary", action: "create", label: "Salary create (forbidden for ESS)" },
  { module: "hr_payroll", action: "list", label: "Payroll list (forbidden for ESS)" },
  { module: "hr_payroll", action: "calculate", label: "Payroll calculate (forbidden for ESS)" },
  { module: "hr_payroll", action: "lock", label: "Payroll lock (forbidden for ESS)" },
  { module: "hr_payroll", action: "reverse", label: "Payroll reverse (forbidden for ESS)" },
  { module: "hr_payroll", action: "approve", label: "Payroll approve (forbidden for ESS)" },
  { module: "hr_bank_details", action: "view", label: "Other-empl bank view (forbidden for ESS)" },
  { module: "hr_bank_details", action: "edit", label: "Other-empl bank edit (forbidden for ESS)" },
  { module: "hr_employee", action: "terminate", label: "Terminate (forbidden for ESS)" },
  { module: "hr_employee", action: "create", label: "Employee create (forbidden for ESS)" },
  { module: "hr_employee", action: "list", label: "Employee list (forbidden for ESS)" },
  { module: "hr_leave", action: "approve_level_1", label: "Leave approve L1 (forbidden for ESS)" },
  { module: "hr_leave", action: "approve_final", label: "Leave approve final (forbidden for ESS)" },
  { module: "hr_claim", action: "approve_level_1", label: "Claim approve L1 (forbidden for ESS)" },
  { module: "hr_claim", action: "approve_final", label: "Claim approve final (forbidden for ESS)" },
  { module: "hr_attendance", action: "view_all", label: "Attendance view_all (forbidden for ESS)" },
  { module: "hr_attendance", action: "adjust", label: "Attendance adjust (forbidden for ESS)" },
  { module: "hr_documents", action: "manage", label: "HR docs manage (forbidden for ESS)" },
  { module: "hr_documents", action: "view_confidential", label: "HR docs confidential (forbidden for ESS)" },
  { module: "hr_settings", action: "manage_organisation", label: "Settings manage (forbidden for ESS)" },
  { module: "hr_settings", action: "manage_feature_flags", label: "Settings feature flags (forbidden for ESS)" },
  { module: "hr_reports", action: "view_turnover", label: "Reports turnover (forbidden for ESS)" },
  { module: "hr_reports", action: "view_payroll_summary", label: "Reports payroll summary (forbidden for ESS)" },
  { module: "hr_performance", action: "view_all", label: "Performance view_all (forbidden for ESS)" },
  { module: "hr_performance", action: "manage", label: "Performance manage (forbidden for ESS)" },
  { module: "hr_assets", action: "manage", label: "Assets manage (forbidden for ESS)" },
  { module: "hr_offboarding", action: "initiate", label: "Offboarding initiate (forbidden for ESS)" },
  { module: "hr_offboarding", action: "final_approve", label: "Offboarding final approve (forbidden for ESS)" },
  { module: "hr_onboarding", action: "manage", label: "Onboarding manage (forbidden for ESS)" },
  { module: "hr_recruitment", action: "manage", label: "Recruitment manage (forbidden for ESS)" },
  { module: "hr_recruitment", action: "hire", label: "Recruitment hire (forbidden for ESS)" },
  { module: "hr_disciplinary", action: "create", label: "Disciplinary create (forbidden for ESS)" },
  { module: "hr_disciplinary", action: "close", label: "Disciplinary close (forbidden for ESS)" },
  { module: "hr_approval", action: "reassign", label: "Approval reassign (forbidden for ESS)" },
  { module: "hr_approval", action: "override", label: "Approval override (forbidden for ESS)" },
];

function readMigration0134() {
  const migrationFile = path.resolve(
    MONOREPO_ROOT,
    "lib",
    "db",
    "migrations",
    "0134_hrms_rbac_roles_permissions.sql",
  );
  return fs.readFileSync(migrationFile, "utf8");
}

function parsePermissionMatrix(content: string) {
  const valuesRegex = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/gi;
  const rows: Array<{ module: string; action: string; manager: boolean; admin: boolean; emp: boolean; partner: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = valuesRegex.exec(content)) !== null) {
    rows.push({
      module: m[1],
      action: m[2],
      manager: m[3] === "true",
      admin: m[4] === "true",
      emp: m[5] === "true",
      partner: m[6] === "true",
    });
  }
  return rows;
}

describe("CORRECTIVE GATE 12 — HR Role-Permission Matrix Exact Tests (Migration 0134 seed)", () => {
  const content = readMigration0134();
  const matrix = parsePermissionMatrix(content);

  function findRow(module: string, action: string) {
    return matrix.find((r) => r.module === module && r.action === action);
  }

  describe("0134 matrix structure", () => {
    it("migration 0134 VALUES table is parseable with >= 90 permission rows", () => {
      expect(matrix.length).toBeGreaterThanOrEqual(90);
    });

    it("each row has 4 boolean columns (manager/admin/emp/partner)", () => {
      for (const r of matrix) {
        expect(typeof r.manager).toBe("boolean");
        expect(typeof r.admin).toBe("boolean");
        expect(typeof r.emp).toBe("boolean");
        expect(typeof r.partner).toBe("boolean");
      }
    });
  });

  describe("HR Admin — Full Allowed", () => {
    for (const p of HR_FULL_ACCESS_PILLARS) {
      it(`HR Admin: ${p.label} — admin_allowed = true`, () => {
        const row = findRow(p.module, p.action);
        expect(row).toBeDefined();
        expect(row!.admin).toBe(true);
      });
    }
  });

  describe("HR Manager — Full Allowed (symmetric to HR Admin 1:1)", () => {
    for (const p of HR_FULL_ACCESS_PILLARS) {
      it(`HR Manager: ${p.label} — manager_allowed = true`, () => {
        const row = findRow(p.module, p.action);
        expect(row).toBeDefined();
        expect(row!.manager).toBe(true);
      });
    }

    it("HR Manager admin_allowed == HR Admin manager_allowed: 1:1 symmetry on all rows", () => {
      for (const r of matrix) {
        expect(r.manager).toBe(r.admin);
      }
    });
  });

  describe("Partner — Full Allowed (HR Admin = HR Manager = Partner: 1:1:1)", () => {
    for (const p of HR_FULL_ACCESS_PILLARS) {
      it(`Partner: ${p.label} — partner_allowed = true`, () => {
        const row = findRow(p.module, p.action);
        expect(row).toBeDefined();
        expect(row!.partner).toBe(true);
      });
    }

    it("Partner column symmetric to HR Admin on all rows (Admin = Partner)", () => {
      for (const r of matrix) {
        expect(r.partner).toBe(r.admin);
      }
    });

    it("Partner column symmetric to HR Manager on all rows (Manager = Partner)", () => {
      for (const r of matrix) {
        expect(r.partner).toBe(r.manager);
      }
    });
  });

  describe("ESS — HR Employee: ESS actions only", () => {
    for (const e of HR_ESS_ONLY_ACTIONS) {
      it(`HR Employee ESS: ${e.label} — emp_allowed = true`, () => {
        const row = findRow(e.module, e.action);
        expect(row).toBeDefined();
        expect(row!.emp).toBe(true);
      });
    }

    for (const f of SENSITIVE_FORBIDDEN_FOR_ESS) {
      it(`HR Employee ESS: ${f.label} — emp_allowed = false`, () => {
        const row = findRow(f.module, f.action);
        expect(row).toBeDefined();
        expect(row!.emp).toBe(false);
      });
    }
  });

  describe("Lawyer / Clerk / Account Admin — default NOT in 0134 seed (ESS only from role fallback, no extra grant)", () => {
    it("migration 0134 seed explicitly INSERTs permissions only for 4 named roles: HR Manager, HR Admin, HR Employee, Partner", () => {
      expect(content).toMatch(/HR Manager/i);
      expect(content).toMatch(/HR Admin/i);
      expect(content).toMatch(/HR Employee/i);
      expect(content).toMatch(/Partner/i);
    });

    it("no Lawyer/Clerk/Account Admin permission row insertion in 0134 (they rely on HR Employee fallback OR explicit grant)", () => {
      const lawyerGrantMatch = content.match(/'Lawyer'[\s\S]{0,80}true/i);
      const clerkGrantMatch = content.match(/'Clerk'[\s\S]{0,80}true/i);
      const accAdminGrantMatch = content.match(/'Account Admin'[\s\S]{0,80}true/i);
      expect(lawyerGrantMatch).toBeNull();
      expect(clerkGrantMatch).toBeNull();
      expect(accAdminGrantMatch).toBeNull();
    });
  });

  describe("Firm-scoped enforcement + Cross-firm denied: seed scoping", () => {
    it("migration 0134 permissions INSERT all bound by outer firm loop: FOR v_firm IN firms LOOP", () => {
      expect(content).toMatch(/FOR\s+v_firm\s+IN[\s\S]*firms[\s\S]*LOOP/i);
    });

    it("role_id lookups include WHERE firm_id = v_firm.id for all 4 roles (firm scoped)", () => {
      expect(content).toMatch(/SELECT id INTO v_hr_manager_role_id\s+FROM roles\s+WHERE firm_id\s*=\s*v_firm\.id/i);
      expect(content).toMatch(/SELECT id INTO v_hr_admin_role_id\s+FROM roles\s+WHERE firm_id\s*=\s*v_firm\.id/i);
      expect(content).toMatch(/SELECT id INTO v_hr_employee_role_id\s+FROM roles\s+WHERE firm_id\s*=\s*v_firm\.id/i);
      expect(content).toMatch(/SELECT\s+id\s+INTO\s+v_partner_role_id\s+FROM\s+roles\s+WHERE\s+firm_id\s*=\s*v_firm\.id/i);
    });
  });

  describe("Ordinary employee: cannot access other employee salary/payroll/documents (scope boundary)", () => {
    it("emp_allowed = false on salary.view / salary.create / payroll.list / payroll.approve / documents.view_confidential", () => {
      const salaryView = findRow("hr_salary", "view");
      const salaryCreate = findRow("hr_salary", "create");
      const payrollList = findRow("hr_payroll", "list");
      const payrollApprove = findRow("hr_payroll", "approve");
      const docsConf = findRow("hr_documents", "view_confidential");
      expect(salaryView?.emp).toBe(false);
      expect(salaryCreate?.emp).toBe(false);
      expect(payrollList?.emp).toBe(false);
      expect(payrollApprove?.emp).toBe(false);
      expect(docsConf?.emp).toBe(false);
    });

    it("emp_allowed = false on all HR_FULL_ACCESS_PILLARS (no cross-grant)", () => {
      for (const p of HR_FULL_ACCESS_PILLARS) {
        const row = findRow(p.module, p.action);
        expect(row).toBeDefined();
        expect(row!.emp).toBe(false);
      }
    });
  });
});
