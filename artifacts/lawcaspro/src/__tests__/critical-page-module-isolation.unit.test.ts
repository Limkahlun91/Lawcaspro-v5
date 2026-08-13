// Critical Page Module Isolation Test (Part 2 §8)
//
// Invariants:
// 1. Login page (unauthenticated landing) is imported STATICALLY and
//    therefore does NOT transitively depend on any lazy()'d optional
//    module (Legacy Import, HR, Accounting, Documents, Communications,
//    Reports, File Custody, Bank Adapters, Case Monitor, Platform
//    Operations heavy pages, Founder Billing, etc).
// 2. Therefore even if any optional lazy module throws at top-level
//    module-evaluation time, the static dependency graph of main.tsx
//    → App.tsx → Login.tsx must not throw. Login can still render.
// 3. The App.tsx source itself MUST NOT contain a static import of any
//    optional lazy page (i.e. every page listed in §10 as lazy must be
//    lazy-imported in the source — not accidentally re-imported via a
//    side static import).

process.env.DATABASE_URL ??= "postgresql://fake:fake@localhost:5432/fake";
process.env.NODE_ENV ??= "test";

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const APP_TSX = join(REPO_ROOT, "artifacts", "lawcaspro", "src", "App.tsx");
const LOGIN_TSX = join(REPO_ROOT, "artifacts", "lawcaspro", "src", "pages", "auth", "login.tsx");
const MAIN_TSX = join(REPO_ROOT, "artifacts", "lawcaspro", "src", "main.tsx");

function readSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

const STATIC_REQUIRED_APP_PAGES = new Set([
  "@/pages/auth/login",
  "@/pages/not-found",
  "@/pages/public/track/[token]",
  "@/pages/platform/dashboard",
  "@/pages/platform/firms",
  "@/pages/platform/firms/new",
  "@/pages/platform/firms/detail",
  "@/pages/platform/firms/history-detail",
  "@/pages/app/dashboard",
  "@/pages/app/cases",
  "@/pages/app/cases/new",
  "@/pages/app/cases/detail",
  "@/pages/app/workbench",
  "@/pages/app/cases/intake",
  "@/pages/app/users/new",
  "@/pages/app/developers",
  "@/pages/app/developers/new",
  "@/pages/app/developers/detail",
  "@/pages/app/projects",
  "@/pages/app/projects/new",
  "@/pages/app/projects/edit",
  "@/pages/app/projects/detail",
  "@/pages/app/clients",
  "@/pages/app/clients/new",
  "@/pages/app/clients/detail",
  "@/pages/app/audit-logs",
  "@/pages/app/settings/logs",
  "@/pages/app/settings/templates",
  "@/pages/app/settings/clauses",
  "@/pages/app/settings",
  "@/pages/app/quotations",
  "@/pages/app/quotations/new",
  "@/pages/app/quotations/detail",
  "@/pages/app/my/dashboard",
  "@/pages/app/my/leave",
  "@/pages/app/my/claims",
  "@/pages/app/my/payslips",
  "@/pages/app/my/profile",
  "@/pages/app/my/attendance",
  "@/pages/app/my/documents",
  "@/pages/app/my/requests",
  "@/pages/developer/dashboard",
]);

const LAZY_MANDATORY_PAGES = new Set([
  "@/pages/platform/operations",
  "@/pages/platform/operations/logs",
  "@/pages/platform/operations/incidents",
  "@/pages/platform/operations/incident-detail",
  "@/pages/platform/operations/recommendations",
  "@/pages/platform/operations/readiness",
  "@/pages/platform/operations/pending",
  "@/pages/platform/operations/templates",
  "@/pages/platform/monitoring",
  "@/pages/platform/audit-logs",
  "@/pages/platform/documents",
  "@/pages/platform/messages",
  "@/pages/founder/billing",
  "@/pages/platform/subscription-plans",
  "@/pages/platform/variables",
  "@/pages/platform/custom-variables",
  "@/pages/app/cases/legacy-import",
  "@/pages/app/settings/accounting",
  "@/pages/app/settings/email",
  "@/pages/app/documents",
  "@/pages/app/documents/automation",
  "@/pages/app/documents/generation-logs",
  "@/pages/app/documents/variables",
  "@/pages/app/documents/custom-variables",
  "@/pages/app/accounting",
  "@/pages/app/accounting/file-listing",
  "@/pages/app/accounting/bank-reconciliation",
  "@/pages/app/accounting/invoices/detail",
  "@/pages/app/accounting/receipts/detail",
  "@/pages/app/file-custody",
  "@/pages/app/reports",
  "@/pages/app/reports/bills-delivered-book",
  "@/pages/app/reports/matter-aging",
  "@/pages/app/reports/trust-account-statement",
  "@/pages/app/reports/project-status",
  "@/pages/app/hub",
  "@/pages/app/communications",
  "@/pages/app/communications/thread-detail",
  "@/pages/app/communication/email",
  "@/pages/app/communication/whatsapp",
  "@/pages/app/case-monitor",
  "@/pages/app/bank-adapters",
  "@/pages/app/hr/dashboard",
  "@/pages/app/hr/employees",
  "@/pages/app/hr/attendance",
  "@/pages/app/hr/leave",
  "@/pages/app/hr/claims",
  "@/pages/app/hr/payroll",
  "@/pages/app/hr/recruitment",
  "@/pages/app/hr/performance",
  "@/pages/app/hr/training",
  "@/pages/app/hr/assets",
  "@/pages/app/hr/documents",
  "@/pages/app/hr/onboarding",
  "@/pages/app/hr/offboarding",
  "@/pages/app/hr/departments",
  "@/pages/app/hr/positions",
  "@/pages/app/hr/reports",
  "@/pages/app/hr/settings",
]);

function extractStaticAppImports(src: string): string[] {
  const re = /^\s*import\s+(?!type\s)(?:[^;]*?\s+from\s+)?["']([^"']+)["']\s*;?\s*$/gm;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1].startsWith("@/pages/")) out.push(m[1]);
  }
  return out;
}

function extractLazyAppImports(src: string): string[] {
  const re = /lazy\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*["']([^"']+)["']\s*\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("Critical Page Module Isolation (Login survives optional page explosions)", () => {
  let appSrc: string;
  let loginSrc: string;
  let mainSrc: string;

  beforeAll(() => {
    appSrc = readSafe(APP_TSX);
    loginSrc = readSafe(LOGIN_TSX);
    mainSrc = readSafe(MAIN_TSX);
  });

  it("P0: main.tsx does NOT statically import App.tsx (must dynamic import only)", () => {
    expect(mainSrc.length).toBeGreaterThan(0);
    expect(loginSrc.length).toBeGreaterThan(0);
    expect(appSrc.length).toBeGreaterThan(0);

    const staticAppImports = mainSrc
      .split("\n")
      .filter((l) => /^\s*import\s+(?!type\s)/.test(l))
      .filter((l) => /App/.test(l));
    expect(staticAppImports).toEqual([]);

    expect(mainSrc).toContain('import("./App")');
  });

  it("P0: Login page import in App.tsx is STATIC (not lazy) so /auth/login cannot be blocked by any lazy() failure", () => {
    const staticPageImports = extractStaticAppImports(appSrc);
    expect(staticPageImports).toContain("@/pages/auth/login");
  });

  it("P0: Every lazy-mandatory page in App.tsx is ACTUALLY lazy()'d, not statically imported", () => {
    const staticPageImports = new Set(extractStaticAppImports(appSrc));
    const lazyPageImports = new Set(extractLazyAppImports(appSrc));

    for (const page of LAZY_MANDATORY_PAGES) {
      expect(staticPageImports.has(page)).toBe(false);
      expect(lazyPageImports.has(page)).toBe(true);
    }
  });

  it("P0: No lazy-mandatory page is accidentally referenced in STATIC App imports (isolation check)", () => {
    const staticPageImports = new Set(extractStaticAppImports(appSrc));
    const leaks: string[] = [];
    for (const page of LAZY_MANDATORY_PAGES) {
      if (staticPageImports.has(page)) leaks.push(page);
    }
    expect(leaks).toEqual([]);
  });

  it("P0: Login page module source does NOT reference @workspace/db root or server-only pg/drizzle imports", () => {
    const leakLines: { line: number; match: string }[] = [];
    const lines = loginSrc.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/from\s*["']@workspace\/db["']/.test(line) && !/from\s*["']@workspace\/db\//.test(line)) {
        leakLines.push({ line: i + 1, match: line.trim() });
      }
      if (/from\s*["'](pg|drizzle-orm\/node-postgres|drizzle-orm\/pg-core)["']/.test(line)) {
        leakLines.push({ line: i + 1, match: line.trim() });
      }
    }
    expect(leakLines).toEqual([]);
  });

  it("P0: Legacy case import contract subpath import in App dependency graph is browser-safe (no pg transitive)", () => {
    const legacyImportSrc = readSafe(
      join(REPO_ROOT, "artifacts", "lawcaspro", "src", "pages", "app", "cases", "legacy-import", "index.tsx")
    );
    expect(legacyImportSrc.length).toBeGreaterThan(0);
    const rootDbLines: string[] = [];
    for (const line of legacyImportSrc.split("\n")) {
      if (/from\s*["']@workspace\/db["']/.test(line)) rootDbLines.push(line.trim());
    }
    expect(rootDbLines).toEqual([]);
  });
});
