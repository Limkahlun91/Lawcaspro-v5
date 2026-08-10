import { describe, expect, it } from "vitest";
import { resolveFirmAccessScopeFromInputs, FirmAccessScope, isRoleGroupManagement } from "../lib/auth.js";

const DASHBOARD_READ = { module: "dashboard", action: "read" } as const;
const CASES_ASSIGN_ANY = { module: "cases", action: "assign_any" } as const;
const ACCOUNTING_READ = { module: "accounting", action: "read" } as const;
const ACCOUNTING_WRITE = { module: "accounting", action: "write" } as const;
const HR_MANAGE = { module: "hr", action: "manage" } as const;
const HR_READ = { module: "hr", action: "read" } as const;

type Perm = { readonly module: string; readonly action: string };
type CaseRow = readonly [
  label: string,
  roleName: string | undefined,
  permissions: ReadonlyArray<Perm>,
  expDashboard: boolean,
  expFirmwide: boolean,
  expAccounting: boolean,
  expHr: boolean,
];

const cases: ReadonlyArray<CaseRow> = [
  ["Partner", "Partner", [], true, true, false, false],
  ["Partner (lc", "partner", [], true, true, false, false],
  ["Firm Manager", "Firm Manager", [], true, true, false, false],
  ["Practice Manager", "Practice Manager", [], true, true, false, false],
  ["Managing Partner", "Managing Partner", [], true, true, false, false],
  ["Senior Partner", "Senior Partner", [], true, true, false, false],
  ["Director", "Director", [], true, true, false, false],
  ["Manager (canonical)", "Manager", [], true, true, false, false],
  ["Account Manager no perms", "Account Manager", [], false, false, false, false],
  ["Account Manager with accounting only", "Account Manager", [ACCOUNTING_READ, ACCOUNTING_WRITE], false, false, true, false],
  ["Account Manager + dashboard perm", "Account Manager", [ACCOUNTING_READ, DASHBOARD_READ], true, false, true, false],
  ["Account Manager + assign_any", "Account Manager", [ACCOUNTING_READ, CASES_ASSIGN_ANY], false, true, true, false],
  ["Account Admin", "Account Admin", [], false, false, false, false],
  ["Account Admin with accounting", "Account Admin", [ACCOUNTING_READ], false, false, true, false],
  ["HR Manager no perms", "HR Manager", [], false, false, false, true],
  ["HR Manager with hr only", "HR Manager", [HR_READ, HR_MANAGE], false, false, false, true],
  ["HR Manager + dashboard", "HR Manager", [HR_MANAGE, DASHBOARD_READ], true, false, false, true],
  ["HR Manager + assign_any", "HR Manager", [HR_MANAGE, CASES_ASSIGN_ANY], false, true, false, true],
  ["Payroll Manager", "Payroll Manager", [], false, false, false, false],
  ["Training Manager", "Training Manager", [], false, false, false, false],
  ["Lawyer", "Lawyer", [], false, false, false, false],
  ["Clerk", "Clerk", [], false, false, false, false],
  ["HR Executive", "HR Executive", [], false, false, false, true],
  ["HR Admin", "HR Admin", [], false, false, false, true],
  ["HR Assistant", "HR Assistant", [], false, false, false, true],
  ["HR Officer", "HR Officer", [], false, false, false, true],
  ["Founder userType", undefined, [], true, true, true, true],
  ["Developer userType", undefined, [], true, true, true, true],
  ["Staff with dashboard perm only", "Lawyer", [DASHBOARD_READ], true, false, false, false],
  ["Staff with assign_any only", "Lawyer", [CASES_ASSIGN_ANY], false, true, false, false],
];

describe("P0 — FirmAccessScope classification never elevates * Manager silos", () => {
  describe("resolveFirmAccessScopeFromInputs", () => {
    it.each(cases)(
      "%s → dashboard=%s firmwide=%s accounting=%s hr=%s",
      (_label, roleName, perms, expDashboard, expFirmwide, expAcc, expHr) => {
        const userType: string | undefined =
          _label.startsWith("Founder") ? "founder" : _label.startsWith("Developer") ? "developer_user" : undefined;
        const scope: FirmAccessScope = resolveFirmAccessScopeFromInputs({
          userType,
          roleName: typeof roleName === "string" ? roleName : null,
          permissions: perms as ReadonlyArray<{ module: string; action: string }>,
        });
        expect(scope.canAccessFirmDashboard).toBe(expDashboard);
        expect(scope.hasFirmwideCaseScope).toBe(expFirmwide);
        expect(scope.isAccountingPrivileged).toBe(expAcc);
        expect(scope.isHrPrivileged).toBe(expHr);
      },
    );

    it("Account Manager → fuzzy includes('manager') substring must NOT grant dashboard/case-firmwide", () => {
      const accMgrOnly = resolveFirmAccessScopeFromInputs({ roleName: "Account Manager", permissions: [] });
      expect(accMgrOnly.canAccessFirmDashboard).toBe(false);
      expect(accMgrOnly.hasFirmwideCaseScope).toBe(false);
    });

    it("HR Manager → fuzzy substring must NOT grant dashboard/case-firmwide (only hr privileged)", () => {
      const hrMgrOnly = resolveFirmAccessScopeFromInputs({ roleName: "HR Manager", permissions: [] });
      expect(hrMgrOnly.canAccessFirmDashboard).toBe(false);
      expect(hrMgrOnly.hasFirmwideCaseScope).toBe(false);
      expect(hrMgrOnly.isHrPrivileged).toBe(true);
    });

    it("Payroll Manager / Training Manager → NO auto-management elevation", () => {
      for (const n of ["Payroll Manager", "Training Manager"]) {
        const s = resolveFirmAccessScopeFromInputs({ roleName: n, permissions: [] });
        expect(s.canAccessFirmDashboard || s.hasFirmwideCaseScope).toBe(false);
      }
    });

    it("Explicit dashboard:read perm grants dashboard regardless of role name", () => {
      const withPerm = resolveFirmAccessScopeFromInputs({
        roleName: "Junior Clerk",
        permissions: [{ module: "dashboard", action: "read" }],
      });
      expect(withPerm.canAccessFirmDashboard).toBe(true);
      expect(withPerm.hasFirmwideCaseScope).toBe(false);
    });

    it("Explicit cases:assign_any grants firmwide case scope regardless of role", () => {
      const withPerm = resolveFirmAccessScopeFromInputs({
        roleName: "File Clerk",
        permissions: [{ module: "cases", action: "assign_any" }],
      });
      expect(withPerm.canAccessFirmDashboard).toBe(false);
      expect(withPerm.hasFirmwideCaseScope).toBe(true);
    });
  });

  describe("Legacy isRoleGroupManagement (deprecated wrapper) must also exclude siloed managers", () => {
    it("Partner → legacy wrapper returns true (union of dashboard or firmwide)", () => {
      expect(isRoleGroupManagement("Partner")).toBe(true);
      expect(isRoleGroupManagement("partner")).toBe(true);
      expect(isRoleGroupManagement("Firm Manager")).toBe(true);
    });
    it("Account Manager → legacy wrapper returns false (no substring fuzzy)", () => {
      expect(isRoleGroupManagement("Account Manager")).toBe(false);
      expect(isRoleGroupManagement("Account Manager")).toBe(false);
    });
    it("HR Manager → legacy wrapper returns false (no substring fuzzy)", () => {
      expect(isRoleGroupManagement("HR Manager")).toBe(false);
    });
    it("Payroll/Training Manager → legacy wrapper false", () => {
      expect(isRoleGroupManagement("Payroll Manager")).toBe(false);
      expect(isRoleGroupManagement("Training Manager")).toBe(false);
    });
    it("Lawyer / Clerk → legacy wrapper false", () => {
      expect(isRoleGroupManagement("Lawyer")).toBe(false);
      expect(isRoleGroupManagement("Clerk")).toBe(false);
    });
  });
});
