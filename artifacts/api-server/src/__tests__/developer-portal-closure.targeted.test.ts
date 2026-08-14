import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  developerOnlyAllowlistMiddleware,
  isDeveloperAllowedPath,
  isDeveloperPortalUser,
} from "../lib/developer-allowlist.js";
import { collectAttentionItems, summarizeCards, type UnitListDto } from "../lib/developer-portal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

function read(p: string) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

const ROUTE_DEV_SRC = read(path.join(ROOT, "routes", "developer.ts"));
const DASHBOARD_SRC = read(path.join(REPO_ROOT, "artifacts", "lawcaspro", "src", "pages", "developer", "dashboard.tsx"));

function buildReq(partial: any = {}): any {
  return {
    method: "GET",
    headers: {},
    userType: partial.userType ?? "firm_user",
    roleName: partial.roleName ?? null,
    ...partial,
  };
}

function buildRes() {
  let statusCode: number | null = null;
  let body: any = null;
  const res: any = {
    status: (n: number) => {
      statusCode = n;
      return res;
    },
    json: (b: any) => {
      body = b;
      return res;
    },
  };
  res.getStatus = () => statusCode;
  res.getBody = () => body;
  return res as any;
}

describe("SEC-1/2/3 · Non-Developer internal users are NOT blocked by allowlist", () => {
  const paths = [
    { method: "GET", path: "/quotations", label: "SEC-1 quotations" },
    { method: "GET", path: "/invoices", label: "SEC-2 invoices" },
    { method: "GET", path: "/receipts", label: "SEC-3 receipts" },
    { method: "GET", path: "/payment-vouchers", label: "PV user" },
    { method: "GET", path: "/hr/employees", label: "HR" },
  ];
  for (const p of paths) {
    it(`${p.label} · Partner/firm_user passes allowlist silently`, () => {
      let nextInvoked: any = null;
      const req = buildReq({ method: p.method, originalUrl: p.path, roleName: "Partner" });
      developerOnlyAllowlistMiddleware(req, buildRes(), (err?: any) => {
        nextInvoked = err ?? "CALLED";
      });
      expect(nextInvoked).toBe("CALLED");
    });
  }
});

describe("SEC-4/5/6 · Developer_User gets 403 on internal routes", () => {
  const cases = [
    { path: "/quotations/99", label: "SEC-4 quotation" },
    { path: "/payment-vouchers/create", label: "SEC-5 PV" },
    { path: "/cases/42/ledger/trust", label: "SEC-6 case ledger" },
    { path: "/audit/csv", label: "audit log" },
    { path: "/firm-settings/billing", label: "firm settings" },
    { path: "/users", label: "users" },
    { path: "/roles/6/permissions", label: "roles" },
  ];
  for (const c of cases) {
    it(`${c.label} → 403 DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST`, () => {
      let nextInvoked: any = "NOT_CALLED";
      const res = buildRes();
      const req = buildReq({ method: "GET", originalUrl: c.path, roleName: "Developer_User", userType: "developer_user" });
      developerOnlyAllowlistMiddleware(req, res, (err?: any) => {
        nextInvoked = err ?? "CALLED";
      });
      expect(nextInvoked).toBe("NOT_CALLED");
      expect(res.getStatus()).toBe(403);
      expect(res.getBody()?.error?.code).toBe("DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST");
    });
  }
});

describe("Developer_User allowlist paths allowed (SEC sanity)", () => {
  const good = [
    { path: "/auth/me" },
    { path: "/auth/logout" },
    { path: "/auth/permissions" },
    { path: "/developer/portal/overview" },
    { path: "/developer/portal/units" },
    { path: "/developer/portal/projects" },
    { path: "/developer/portal/units/99" },
    { path: "/developer/cases/99/messages" },
    { path: "/developer/cases/99/progress" },
    { path: "/developer/dashboard" },
  ];
  for (const g of good) {
    it(`allows ${g.path} for Developer_User`, () => {
      let nextInvoked: any = "NOT_CALLED";
      const req = buildReq({ method: "GET", originalUrl: g.path, userType: "developer_user" });
      developerOnlyAllowlistMiddleware(req, buildRes(), (e?: any) => {
        nextInvoked = e ?? "CALLED";
      });
      expect(nextInvoked).toBe("CALLED");
    });
  }
});

describe("PROJECT-1 · All Projects = portfolio title (FE wired)", () => {
  it("Header renders Developer Portfolio · All Projects when allProjects=true", () => {
    expect(DASHBOARD_SRC).toMatch(/displayTitle = project\.allProjects \? "Developer Portfolio" : project\.name/);
    expect(DASHBOARD_SRC).toMatch(/displaySubtitle = project\.allProjects \? "All Projects" : project\.phase/);
  });
  it("Query keys include selectedProjectId for overview & units (PROJECT-2/3 isolation)", () => {
    expect(DASHBOARD_SRC).toContain('queryKey: ["developer-portal-overview", selectedProjectId]');
    expect(DASHBOARD_SRC).toContain('queryKey: ["developer-portal-units", selectedProjectId, qs]');
  });
});

describe("PROJECT-2/3 · Backend accepts projectId & filters overview/units", () => {
  it("overview endpoint accepts ?projectId= & units endpoint uses projectId from ListInventoryQuery", () => {
    expect(ROUTE_DEV_SRC).toMatch(/\/developer\/portal\/overview[\s\S]{0,500}projectIdRaw = typeof \(req\.query as any\)\?\.projectId === "string"/);
    expect(ROUTE_DEV_SRC).toMatch(/if \(q\.projectId\) conditions\.push\(eq\(casesTable\.projectId, q\.projectId\)\)/);
  });
  it("projectId filter on overview: when present, uses it; else allProjects=true & name=null", () => {
    expect(ROUTE_DEV_SRC).toContain('allProjects: resolvedAllProjectsFlag,');
    expect(ROUTE_DEV_SRC).toContain('resolvedProjectName = projectId ?');
  });
});

describe("ATTN-1 · attentionSummary.total == summary.needsAttention, items=min(8,N)", () => {
  it("27 attention → total=27, items=8", () => {
    const list: UnitListDto[] = [];
    for (let i = 0; i < 27; i++) {
      list.push({
        caseId: 1000 + i,
        referenceNo: "R-" + i,
        projectName: "LEGASI",
        phase: "Phase 1",
        unitLabel: `PT${1000 + i}`,
        propertySummary: null,
        purchasers: [{ displayName: "PU" + i }],
        spa: { status: "Attention Required", label: "SPA Signing", date: "2026-08-01" },
        loan: { status: "In Progress", label: "Loan Documentation", bankName: null, date: "2026-08-05" },
        mot: { status: "Not Yet Required", label: "MOT / Title", date: null },
        currentStage: "SPA Signing",
        nextAction: { label: "SPA Signing", waitingFor: "Purchaser", since: "2026-08-01", ageDays: 13 + i, attentionRequired: true },
        lastUpdatedAt: "2026-08-13T00:00:00Z",
      });
    }
    const summary = summarizeCards(list);
    const items = collectAttentionItems(list, 8);
    expect(summary.needsAttention).toBe(27);
    expect(items.length).toBe(8);
    const payloadTotal = summary.needsAttention;
    expect(payloadTotal).toBe(27);
    expect(ROUTE_DEV_SRC).toContain('total: summary.needsAttention,');
    expect(ROUTE_DEV_SRC).toContain('collectAttentionItems(dtos, 8)');
  });
});

describe("WORKFLOW-1 · workflow query no tautology (stepKey=stepKey) removed", () => {
  it("developer.ts detail endpoint uses caseId only and never references stepKey=stepKey", () => {
    expect(ROUTE_DEV_SRC).toMatch(/from\(caseWorkflowStepsTable\)[\s\S]{0,200}\.where\(eq\(caseWorkflowStepsTable\.caseId, caseId\)\)/);
    expect(ROUTE_DEV_SRC).not.toMatch(/eq\(\s*caseWorkflowStepsTable\.stepKey\s*,\s*caseWorkflowStepsTable\.stepKey\s*\)/);
  });
});

describe("STATUS-1 · legacy PATCH /developer/cases/:id/status → 410 Gone retired code", () => {
  it("route returns 410 + DEVELOPER_STATUS_WRITE_RETIRED", () => {
    expect(ROUTE_DEV_SRC).toMatch(/routerInternal\.patch\("\/developer\/cases\/:caseId\/status"[\s\S]{0,400}res\.status\(410\)\.json\(\{[\s\S]{0,100}DEVELOPER_STATUS_WRITE_RETIRED[\s\S]{0,100}Case status is managed by the law firm workflow\./);
  });
});

describe("ROLE-HELPER · isDeveloperPortalUser canonical", () => {
  it("matches userType developer_user", () => {
    expect(isDeveloperPortalUser({ userType: "developer_user" } as any)).toBe(true);
  });
  it("matches roleName Developer_User case-insensitive", () => {
    expect(isDeveloperPortalUser({ userType: "firm_user", roleName: "Developer_User" } as any)).toBe(true);
    expect(isDeveloperPortalUser({ userType: "firm_user", roleName: "developer_user" } as any)).toBe(true);
  });
  it("rejects Partner/Staff/Clerk/Founder", () => {
    expect(isDeveloperPortalUser({ userType: "firm_user", roleName: "Partner" } as any)).toBe(false);
    expect(isDeveloperPortalUser({ userType: "founder", roleName: null } as any)).toBe(false);
  });
});

describe("ALLOWLIST-PATH · /developer/cases/:id subpath denials are granular", () => {
  it("GET /developer/cases/5/messages allowed", () => {
    expect(isDeveloperAllowedPath("/developer/cases/5/messages", "GET", {} as any).allowed).toBe(true);
    expect(isDeveloperAllowedPath("/developer/cases/5/messages?channel=developer", "POST", {} as any).allowed).toBe(true);
  });
  it("GET /developer/cases/5/notes → not in allowlist → denied", () => {
    expect(isDeveloperAllowedPath("/developer/cases/5/notes", "GET", {} as any).allowed).toBe(false);
  });
  it("DELETE /developer/cases/5/messages → method denied", () => {
    expect(isDeveloperAllowedPath("/developer/cases/5/messages", "DELETE", {} as any).allowed).toBe(false);
  });
  it("PATCH /developer/cases/5/status → allowlist denies it (retired, route itself still 410 for safety)", () => {
    expect(isDeveloperAllowedPath("/developer/cases/5/status", "PATCH", {} as any).allowed).toBe(false);
  });
});
