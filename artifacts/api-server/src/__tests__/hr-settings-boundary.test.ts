import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, ".."),
    path.resolve(cwd, "..", ".."),
    path.resolve(cwd, "artifacts", "api-server"),
  ];
  for (const cand of candidates) {
    const hasModulesHr = fs.existsSync(path.resolve(cand, "src", "modules", "hr"));
    const hasLibDbMigrations = fs.existsSync(path.resolve(cand, "..", "..", "lib", "db", "migrations"));
    if (hasModulesHr && hasLibDbMigrations) return cand;
  }
  for (const cand of candidates) {
    if (fs.existsSync(path.resolve(cand, "src", "modules", "hr"))) return cand;
  }
  for (const cand of candidates) {
    if (fs.existsSync(path.resolve(cand, "package.json"))) return cand;
  }
  return cwd;
}

const API_SERVER_ROOT = (() => {
  const cwd = process.cwd();
  const markers = ["src/modules/hr", "src/__tests__", "package.json"];
  const candidates = [
    cwd,
    path.resolve(cwd, "artifacts", "api-server"),
    path.resolve(cwd, "..", "artifacts", "api-server"),
  ];
  for (const cand of candidates) {
    const all = markers.every((m) => fs.existsSync(path.resolve(cand, ...m.split("/"))));
    if (all) return cand;
  }
  for (const cand of candidates) {
    if (fs.existsSync(path.resolve(cand, "package.json"))) return cand;
  }
  return cwd;
})();

const MONOREPO_ROOT = (() => {
  const cand = path.resolve(API_SERVER_ROOT, "..", "..");
  if (fs.existsSync(path.resolve(cand, "lib", "db", "migrations"))) return cand;
  const cand2 = path.resolve(API_SERVER_ROOT, "..");
  if (fs.existsSync(path.resolve(cand2, "lib", "db", "migrations"))) return cand2;
  return path.resolve(API_SERVER_ROOT);
})();

const HR_MODULE_GLOB = path.resolve(API_SERVER_ROOT, "src", "modules", "hr");
const HR_ROUTES_GLOB = path.resolve(API_SERVER_ROOT, "src", "routes");

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(t|j)sx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("B0128-01 + B0135-02: HR settings boundary — ZERO imports / calls to accounting_settings / getAccountingSettings", () => {
  const hrModuleFiles = walk(HR_MODULE_GLOB);
  const hrRouteFiles = walk(HR_ROUTES_GLOB).filter((f) => {
    const base = path.basename(f).toLowerCase();
    return base.startsWith("hr-") || /hr.*\.ts$/.test(base);
  });
  const allFiles = [...hrModuleFiles, ...hrRouteFiles];

  it(`Scanning ${allFiles.length} HR files (modules/hr/** + routes/hr-*.ts)`, () => {
    expect(allFiles.length).toBeGreaterThan(0);
  });

  it("B0128-01 / B0135-02: literal accounting_settings import path occurrence = ZERO", () => {
    const matches: Array<{ file: string; line: string; lineNo: number }> = [];
    const importLine = /^\s*(import|export)\s+.*from\s+["'][^"']*accounting_settings[^"']*["']|^\s*require\s*\(\s*["'][^"']*accounting_settings[^"']*["']|^import\s*\(["'][^"']*accounting_settings[^"']*["']/;
    for (const f of allFiles) {
      const content = fs.readFileSync(f, "utf8");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (importLine.test(line)) {
          matches.push({ file: f, line, lineNo: i + 1 });
        }
      }
    }
    expect(matches, `Unexpected accounting_settings import paths found:\n${matches.map((m) => `${m.file}:${m.lineNo}  ${m.line}`).join("\n")}`).toEqual([]);
  });

  it("B0128-01 / B0135-02: function call occurrence getAccountingSettings() / *AccountingSettings* = ZERO", () => {
    const calls: Array<{ file: string; line: string; lineNo: number }> = [];
    for (const f of allFiles) {
      const content = fs.readFileSync(f, "utf8");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/getAccountingSettings\s*\(/.test(line) || /AccountingSettings[A-Za-z0-9_]*\s*\(/.test(line)) {
          calls.push({ file: f, line, lineNo: i + 1 });
        }
      }
    }
    expect(calls, `Unexpected *AccountingSettings* function calls found:\n${calls.map((m) => `${m.file}:${m.lineNo}  ${m.line}`).join("\n")}`).toEqual([]);
  });

  it("B0128-01: modules/hr/** must import firmOperatingSettings service (file existence check)", () => {
    const serviceFile = path.resolve(HR_MODULE_GLOB, "settings", "firm-operating-settings-service.ts");
    expect(fs.existsSync(serviceFile)).toBe(true);
    const content = fs.readFileSync(serviceFile, "utf8");
    expect(content).toContain("firmOperatingSettingsTable");
    expect(content).toContain("doubleWriteSharedOperatingSettings");
  });

  it("B0135-01: double-write service contains update to BOTH firm_operating_settings AND accounting_settings legacy columns", () => {
    const svcFile = path.resolve(HR_MODULE_GLOB, "settings", "firm-operating-settings-service.ts");
    const content = fs.readFileSync(svcFile, "utf8");
    expect(content).toContain("firmOperatingSettingsTable");
    expect(content).toContain("accountingSettingsTable");
    expect(content).toContain("working_hours_start");
    expect(content).toContain("working_hours_end");
    expect(content).toContain("exclude_saturday");
    expect(content).toContain("exclude_sunday");
    expect(content).toContain("firm_holidays");
    expect(content).toContain("timezone");
  });
});

describe("CORRECTIVE GATE 11 REVISION — Migration 0134: Partner = HR FULL ACCESS; HR Admin + HR Manager = HR FULL ACCESS; Lawyer/Clerk/Account Admin = ESS only", () => {
  const migrationFile = path.resolve(
    MONOREPO_ROOT,
    "lib",
    "db",
    "migrations",
    "0134_hrms_rbac_roles_permissions.sql",
  );
  it("migration 0134 file exists and is readable", () => {
    expect(fs.existsSync(migrationFile)).toBe(true);
  });

  it("migration explicitly SELECTs Partner role id and writes Partner permissions (v_partner_role_id present)", () => {
    const content = fs.readFileSync(migrationFile, "utf8");
    expect(content).toMatch(/v_partner_role_id\s+integer/i);
    expect(content).toMatch(/SELECT\s+id\s+INTO\s+v_partner_role_id\s+FROM\s+roles\s+WHERE\s+firm_id\s*=\s*v_firm\.id\s+AND\s+name\s*=\s*'Partner'/i);
    expect(content).toMatch(/AS p\(module,\s*action,\s*manager_allowed,\s*admin_allowed,\s*emp_allowed,\s*partner_allowed\)/i);
    expect(content).toMatch(/v_perm\.partner_allowed/i);
    expect(content).toMatch(/INSERT INTO permissions \(role_id, module, action, allowed\)[\s\S]*v_partner_role_id/i);
  });

  it("CORRECTIVE 11-A: Partner row explicitly includes all HR FULL ACCESS pillars (salary/bank/payroll/termination/settings)", () => {
    const content = fs.readFileSync(migrationFile, "utf8");
    const pillars = [
      { pillar: "salary view", re: /\('hr_salary',\s*'view',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "salary create", re: /\('hr_salary',\s*'create',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "salary adjustment approve", re: /\('hr_salary',\s*'adjustment_approve',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "bank details view", re: /\('hr_bank_details',\s*'view',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "bank details edit", re: /\('hr_bank_details',\s*'edit',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "payroll list", re: /\('hr_payroll',\s*'list',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "payroll calculate", re: /\('hr_payroll',\s*'calculate',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "payroll lock", re: /\('hr_payroll',\s*'lock',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "payroll reverse", re: /\('hr_payroll',\s*'reverse',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "employee terminate", re: /\('hr_employee',\s*'terminate',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "settings manage_organisation", re: /\('hr_settings',\s*'manage_organisation',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
      { pillar: "settings manage_feature_flags", re: /\('hr_settings',\s*'manage_feature_flags',\s*true,\s*true,\s*(?:false|true),\s*true\)/i },
    ];
    for (const p of pillars) {
      expect(content).toMatch(p.re);
    }
  });

  it("CORRECTIVE 11-B: HR Admin column (admin_allowed) = FULL ACCESS, not partial (salary.create/payroll.lock/terminate/settings manage all true)", () => {
    const content = fs.readFileSync(migrationFile, "utf8");
    const adminPillars = [
      { pillar: "salary view", re: /\('hr_salary',\s*'view',\s*true,\s*true,/i },
      { pillar: "salary create", re: /\('hr_salary',\s*'create',\s*true,\s*true,/i },
      { pillar: "payroll lock", re: /\('hr_payroll',\s*'lock',\s*true,\s*true,/i },
      { pillar: "payroll reverse", re: /\('hr_payroll',\s*'reverse',\s*true,\s*true,/i },
      { pillar: "terminate", re: /\('hr_employee',\s*'terminate',\s*true,\s*true,/i },
      { pillar: "settings manage", re: /\('hr_settings',\s*'manage_organisation',\s*true,\s*true,/i },
    ];
    for (const p of adminPillars) expect(content).toMatch(p.re);
  });

  it("CORRECTIVE 11-C: HR Employee role (emp_allowed) = ESS ONLY — NEVER salary.view/bank.view/payroll.list/terminate", () => {
    const content = fs.readFileSync(migrationFile, "utf8");
    const forbiddenForEmployee = [
      { name: "hr_salary.view", re: /\('hr_salary',\s*'view',\s*true,\s*true,\s*true,/i },
      { name: "hr_bank_details.view", re: /\('hr_bank_details',\s*'view',\s*true,\s*true,\s*true,/i },
      { name: "hr_payroll.list", re: /\('hr_payroll',\s*'list',\s*true,\s*true,\s*true,/i },
      { name: "hr_employee.terminate", re: /\('hr_employee',\s*'terminate',\s*true,\s*true,\s*true,/i },
      { name: "hr_settings.manage_organisation", re: /\('hr_settings',\s*'manage_organisation',\s*true,\s*true,\s*true,/i },
    ];
    for (const f of forbiddenForEmployee) expect(content).not.toMatch(f.re);
  });
});
