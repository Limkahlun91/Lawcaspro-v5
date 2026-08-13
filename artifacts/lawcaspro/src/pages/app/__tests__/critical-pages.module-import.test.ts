import { describe, expect, it, beforeAll } from "vitest";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.TEST) process.env.TEST = "1";
  }
});

const CRITICAL_PAGES = [
  { name: "dashboard", load: () => import("../dashboard") },
  { name: "cases", load: () => import("../cases/index") },
  { name: "case detail", load: () => import("../cases/detail") },
  { name: "legacy import", load: () => import("../cases/legacy-import/index") },
  { name: "my work", load: () => import("../workbench") },
  { name: "accounting", load: () => import("../accounting/index") },
  { name: "accounting bank reconciliation", load: () => import("../accounting/bank-reconciliation") },
  { name: "accounting file listing", load: () => import("../accounting/file-listing") },
  { name: "accounting bank accounts", load: () => import("../accounting/bank-accounts") },
  { name: "hr dashboard", load: () => import("../hr/dashboard/index") },
  { name: "hr employees", load: () => import("../hr/employees/index") },
  { name: "hr attendance", load: () => import("../hr/attendance/index") },
  { name: "hr leave", load: () => import("../hr/leave/index") },
  { name: "hr claims", load: () => import("../hr/claims/index") },
  { name: "hr payroll", load: () => import("../hr/payroll/index") },
  { name: "hr offboarding", load: () => import("../hr/offboarding/index") },
  { name: "hr onboarding", load: () => import("../hr/onboarding/index") },
  { name: "communication email", load: () => import("../communication/email") },
  { name: "communication whatsapp", load: () => import("../communication/whatsapp") },
  { name: "documents", load: () => import("../documents/index") },
  { name: "documents automation", load: () => import("../documents/automation") },
  { name: "documents variables", load: () => import("../documents/variables") },
  { name: "documents custom variables", load: () => import("../documents/custom-variables") },
  { name: "communications hub", load: () => import("../communications/index") },
  { name: "reports", load: () => import("../reports/index") },
  { name: "settings", load: () => import("../settings/index") },
  { name: "quotations", load: () => import("../quotations/index") },
  { name: "new quotation", load: () => import("../quotations/new") },
  { name: "clients", load: () => import("../clients/index") },
  { name: "projects", load: () => import("../projects/index") },
  { name: "developers", load: () => import("../developers/index") },
  { name: "audit logs", load: () => import("../audit-logs/index") },
  { name: "platform dashboard", load: () => import("../../platform/dashboard") },
  { name: "platform firms", load: () => import("../../platform/firms") },
  { name: "platform operations", load: () => import("../../platform/operations") },
  { name: "platform audit logs", load: () => import("../../platform/audit-logs") },
  { name: "platform documents", load: () => import("../../platform/documents") },
  { name: "platform monitoring", load: () => import("../../platform/monitoring") },
  { name: "platform variables", load: () => import("../../platform/variables") },
  { name: "platform custom variables", load: () => import("../../platform/custom-variables") },
  { name: "auth login", load: () => import("../../auth/login") },
  { name: "not found", load: () => import("../../not-found") },
] as const;

const HIDDEN_COMPILE_CHECK = [
  { name: "file custody (hidden module can still compile/import)", load: () => import("../file-custody/index") },
] as const;

describe("Critical Pages Module Import Smoke", () => {
  for (const page of CRITICAL_PAGES) {
    it(`resolves ${page.name}`, { timeout: 30_000 }, async () => {
      const mod = await page.load();
      expect(mod).toBeTruthy();
    });
  }
});

describe("Hidden module can still compile/import", () => {
  for (const page of HIDDEN_COMPILE_CHECK) {
    it(page.name, { timeout: 30_000 }, async () => {
      const mod = await page.load();
      expect(mod).toBeTruthy();
    });
  }
});
