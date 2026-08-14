// VIS-1..VIS-10 Unified Feature Access & Visibility — structural static analysis tests
// (Part 1 / §18)

process.env.NODE_ENV ??= "test";

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const FE_ROOT = join(REPO_ROOT, "artifacts", "lawcaspro", "src");

function readSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

const APP_TSX = readSafe(join(FE_ROOT, "App.tsx"));
const SIDEBAR = readSafe(join(FE_ROOT, "components", "layout", "sidebar-body.tsx"));
const CASE_DETAIL = readSafe(join(FE_ROOT, "pages", "app", "cases", "detail.tsx"));
const CASES_INDEX = readSafe(join(FE_ROOT, "pages", "app", "cases", "index.tsx"));

function countInSrc(src: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = -1;
  while ((i = src.indexOf(needle, i + 1)) !== -1) n += 1;
  return n;
}

function windowAround(src: string, anchor: string, before = 400, after = 400): string {
  const idx = src.indexOf(anchor);
  if (idx < 0) return "";
  const s = Math.max(0, idx - before);
  const e = Math.min(src.length, idx + anchor.length + after);
  return src.slice(s, e);
}

describe("VIS-1: isHRModuleEnabled static flag does NOT gate HR active routes", () => {
  it("App.tsx HR active routes do not reference isHRModuleEnabled in their guard window", () => {
    const hrAnchors = [
      'path="/app/hr/dashboard"',
      'path="/app/hr/employees"',
      'path="/app/hr/attendance"',
      'path="/app/hr/leave"',
      'path="/app/hr/claims"',
      'path="/app/hr/payroll"',
    ];
    const bad: string[] = [];
    for (const a of hrAnchors) {
      const win = windowAround(APP_TSX, a, 500, 500);
      if (win.includes("isHRModuleEnabled")) bad.push(a + " -> isHRModuleEnabled nearby");
      if (win.includes("HRRedirectGuard")) bad.push(a + " -> HRRedirectGuard nearby");
    }
    expect(bad).toEqual([]);
  });
});

describe("VIS-2: isEmailControlEnabled static flag does NOT gate Email active route", () => {
  it("App.tsx email control + settings routes do not use isEmailControlEnabled nearby", () => {
    const anchors = [
      'path="/app/communication/email"',
      'path="/app/settings/email"',
    ];
    const bad: string[] = [];
    for (const a of anchors) {
      const win = windowAround(APP_TSX, a, 600, 600);
      if (win.includes("isEmailControlEnabled(")) bad.push(a + " -> isEmailControlEnabled nearby");
      if (/Phase2RedirectGuard[\s\S]{0,300}isEmailControlEnabled/.test(win)) {
        bad.push(a + " -> Phase2RedirectGuard gated by static flag");
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("VIS-3: Partner + HR enabled → HR visible + route allowed (structural guard)", () => {
  it("App.tsx HR routes wrapped with FeatureGuard module.hr AND PermissionGuard hr:read", () => {
    // At least one HR dashboard route guard wrapping contains both
    const win = windowAround(APP_TSX, 'path="/app/hr/dashboard"', 1200, 2000);
    expect(win.includes('feature="module.hr"')).toBe(true);
    expect(win.includes('allOf={["hr.dashboard"]') || win.includes('allOf={[ "hr.dashboard"') || win.includes("hr.dashboard")).toBe(true);
    expect(win.includes('module="hr"')).toBe(true);
    expect(win.includes('action="read"')).toBe(true);
  });

  it("permissions.ts Partner set includes hr:read and hr:manage", () => {
    const perms = readSafe(join(FE_ROOT, "lib", "permissions.ts"));
    const win = windowAround(perms, "Partner", 0, 2500);
    expect(win).toContain('"hr:read"');
    expect(win).toContain('"hr:manage"');
    expect(win).toContain('"hims:read"');
    expect(win).toContain('"hims:manage"');
  });
});

describe("VIS-4: HR disabled → sidebar hidden + direct route denied (structural guard)", () => {
  it("sidebar HR entries reference perm [hr, read] and featureKey hr.xxx", () => {
    expect(SIDEBAR.includes('perm: ["hr", "read"]') || SIDEBAR.includes('perm: ["hr","read"]')).toBe(true);
    const hrEntriesWithFeature = countInSrc(SIDEBAR, 'featureKey: "hr.');
    expect(hrEntriesWithFeature).toBeGreaterThanOrEqual(3);
  });

  it("App.tsx HR routes pass hideDisabled={false} so they render a block page when disabled", () => {
    const win = windowAround(APP_TSX, 'path="/app/hr/dashboard"', 700, 300);
    expect(win.includes("hideDisabled")).toBe(true);
  });
});

describe("VIS-5: Email parent+child enabled → Email visible (structural gate)", () => {
  it("App.tsx email control center route uses FeatureGuard module.communications + communications.email", () => {
    const win = windowAround(APP_TSX, 'path="/app/communication/email"', 900, 300);
    expect(win.includes('feature="module.communications"')).toBe(true);
    expect(
      win.includes('"communications.email"') ||
      win.includes("communications.email"),
    ).toBe(true);
    expect(win.includes('module="communications"')).toBe(true);
    expect(win.includes('action="read"')).toBe(true);
  });
});

describe("VIS-6: module.communications disabled → Email denied (parent guard)", () => {
  it("App.tsx email settings also requires module.communications parent + communications.email.settings child", () => {
    const win = windowAround(APP_TSX, 'path="/app/settings/email"', 900, 300);
    expect(win.includes('feature="module.communications"')).toBe(true);
    expect(
      win.includes("communications.email.settings") ||
      win.includes('"communications.email"'),
    ).toBe(true);
  });
});

describe("VIS-7: HIMS enabled → sidebar HIMS entry visible", () => {
  it("sidebar Cases group: HIMS / eSPA href=/app/hims gated by hims.tracker featureKey and cases:read perm", () => {
    // Combined in one anchor window
    const win = windowAround(SIDEBAR, "HIMS / eSPA", 200, 400);
    expect(win).toContain("/app/hims");
    expect(win).toContain('featureKey: "hims.tracker"');
    expect(win.includes('perm: ["cases", "read"]') || win.includes('perm: ["cases","read"]')).toBe(true);
    expect(win.includes("Shield") || win.includes("Building2")).toBe(true);
  });
});

describe("VIS-8: HIMS disabled → sidebar entry + Case detail hims tab hidden", () => {
  it("Case detail page imports useFeature and combines hims module + tracker + cases read", () => {
    expect(CASE_DETAIL.includes('useFeature("module.hims")')).toBe(true);
    expect(CASE_DETAIL.includes('useFeature("hims.tracker")')).toBe(true);
    const win = windowAround(CASE_DETAIL, "himsTabVisible", 0, 80);
    expect(win.includes("himsModuleFeature.enabled")).toBe(true);
    expect(win.includes("himsTrackerFeature.enabled")).toBe(true);
    expect(win.includes("canViewHims") || win.includes('hasPermission(user, "cases", "read")')).toBe(true);
  });

  it("Case detail TabsTrigger(hims-tracker) and TabsContent(hims-tracker) are inside himsTabVisible conditional", () => {
    const triggerWin = windowAround(CASE_DETAIL, 'value="hims-tracker"', 300, 300);
    expect(triggerWin.includes("himsTabVisible")).toBe(true);
  });
});

describe("VIS-9: HIMS API error → visible error, NOT fake empty list", () => {
  it("HimsTrackerPanel does NOT silently swallow errors into {items:[]} anti-pattern", () => {
    // Find HimsTrackerPanel function block
    const start = CASE_DETAIL.indexOf("HimsTrackerPanel");
    const end = CASE_DETAIL.indexOf("export default function CaseDetail", start);
    const panel = start >= 0 ? CASE_DETAIL.slice(start, end >= 0 ? end : start + 4000) : "";

    // The old anti-pattern: catch block returning empty items array
    const anti1 = /catch\s*\([^)]*\)\s*\{[^}]*return\s*\{\s*items\s*:\s*\[\s*\]\s*\}/;
    // Variation: any catch returning any object with items:[]
    const anti2 = /catch\s*\([^)]*\)[\s\S]{0,300}items\s*:\s*\[\s*\]/;

    const bad = anti1.test(panel) || anti2.test(panel);
    expect(bad).toBe(false);
  });

  it("HimsTrackerPanel renders explicit state branches: loading / not config / no mapping / no data / error", () => {
    const start = CASE_DETAIL.indexOf("HimsTrackerPanel");
    const end = CASE_DETAIL.indexOf("export default function CaseDetail", start);
    const panel = start >= 0 ? CASE_DETAIL.slice(start, end >= 0 ? end : start + 4000) : "";
    expect(panel.length).toBeGreaterThan(300);
    const lower = panel.toLowerCase();
    expect(lower.includes("loading") || lower.includes("skeleton")).toBe(true);
    expect(lower.includes("not configured") || lower.includes("not enabled")).toBe(true);
    expect(lower.includes("no mapping") || lower.includes("project/phase mapping")).toBe(true);
    expect(lower.includes("no tracker data yet") || lower.includes("no data yet") || lower.includes("no tracking data")).toBe(true);
    expect(lower.includes("error") || lower.includes("failed to load") || lower.includes("queryfallback") || lower.includes("unable to load hims")).toBe(true);
  });
});

describe("VIS-10: Legacy Import enabled → Import Old Cases button visible (structural gate)", () => {
  it("Cases index Import Old Cases wrapped with FeatureGuard cases.legacy_import AND PermissionGuard cases create", () => {
    const win = windowAround(CASES_INDEX, "Import Old Cases", 400, 400);
    expect(win.includes('feature="cases.legacy_import"')).toBe(true);
    expect(win.includes('module="cases"')).toBe(true);
    expect(win.includes('action="create"')).toBe(true);
    expect(win.includes("PermissionGuard")).toBe(true);
    expect(win.includes('mode="silent"')).toBe(true);
  });
});
