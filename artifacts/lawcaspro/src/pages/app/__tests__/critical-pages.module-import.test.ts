import { describe, expect, it, beforeAll } from "vitest";

beforeAll(() => {
  if (typeof process !== "undefined" && process.env) {
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/fake";
    }
    if (!process.env.TEST) process.env.TEST = "1";
  }
});

const CRITICAL_PAGES = [
  "../dashboard",
  "../cases",
  "../cases/detail",
  "../cases/legacy-import",
  "../workbench",
  "../accounting",
  "../accounting/bank-reconciliation",
  "../accounting/file-listing",
  "../accounting/bank-accounts",
  "../hr/dashboard",
  "../hr/employees",
  "../hr/attendance",
  "../hr/leave",
  "../hr/claims",
  "../hr/payroll",
  "../hr/offboarding",
  "../hr/onboarding",
  "../communication/email",
  "../communication/whatsapp",
  "../file-custody",
  "../documents",
  "../documents/automation",
  "../documents/variables",
  "../documents/custom-variables",
  "../communications",
  "../reports",
  "../settings",
  "../quotations",
  "../quotations/new",
  "../clients",
  "../projects",
  "../developers",
  "../audit-logs",
  "../../platform/dashboard",
  "../../platform/firms",
  "../../platform/operations",
  "../../platform/audit-logs",
  "../../platform/documents",
  "../../platform/monitoring",
  "../../platform/variables",
  "../../platform/custom-variables",
  "../../auth/login",
  "../../not-found",
] as const;

describe("Critical Pages Module Import Smoke", () => {
  for (const rel of CRITICAL_PAGES) {
    it(`resolves module import for ${rel}`, { timeout: 30_000 }, async () => {
      try {
        const mod = await import(/* @vite-ignore */ rel);
        expect(mod).toBeTruthy();
      } catch (err: any) {
        const msg = err && err.message ? String(err.message) : String(err);
        throw new Error(`Failed to import page module: ${rel}. Error: ${msg}`);
      }
    });
  }
});
