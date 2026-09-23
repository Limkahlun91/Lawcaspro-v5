import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

const CASE_MONITOR_SRC = path.resolve(
  __dirname,
  "..",
  "routes",
  "case-monitor.ts",
);
const FEATURE_REGISTRY_SRC = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "lib",
  "db",
  "src",
  "feature-registry.ts",
);

function readSrc(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function locateRouteWindow(
  src: string,
  pathFrag: string,
  method: "get" | "post" | "patch" | "put" | "delete" = "get",
): { start: number; end: number; mw: string } {
  const idx = src.indexOf(pathFrag);
  if (idx === -1) {
    return { start: -1, end: -1, mw: "" };
  }
  const routerCall = `${method}(`;
  let routerStart = src.lastIndexOf(`router.${routerCall}`, idx);
  if (routerStart === -1) {
    routerStart = src.lastIndexOf(`${method.toUpperCase()}${pathFrag[0]}`, idx) - 10;
  }
  const asyncIdx = src.indexOf("async (req", routerStart);
  if (asyncIdx === -1) {
    return { start: routerStart, end: routerStart, mw: "" };
  }
  return {
    start: routerStart,
    end: asyncIdx,
    mw: src.slice(routerStart, asyncIdx),
  };
}

describe("CM-A — feature registry contains cases.monitor (SQL/STRUCTURAL)", () => {
  const registry = readSrc(FEATURE_REGISTRY_SRC);

  it("CM-A-1: defines featureKey cases.monitor exactly", () => {
    expect(registry).toContain('featureKey: "cases.monitor"');
  });

  it("CM-A-2: parent is module.cases", () => {
    const block = registry.slice(
      registry.indexOf('featureKey: "cases.monitor"') - 40,
      registry.indexOf('featureKey: "cases.monitor"') + 160,
    );
    expect(block).toContain("parentFeatureKey: \"module.cases\"");
  });
});

describe("CM-B — summary route middleware order (SQL/STRUCTURAL)", () => {
  const src = readSrc(CASE_MONITOR_SRC);
  const win = locateRouteWindow(src, '"/case-monitor/summary"', "get");

  it("CM-B-1: summary route exists", () => {
    expect(win.start).toBeGreaterThan(-1);
  });

  it("CM-B-2: contains requireAuth", () => {
    expect(win.mw).toContain("requireAuth");
  });

  it("CM-B-3: contains requireFirmUser", () => {
    expect(win.mw).toContain("requireFirmUser");
  });

  it("CM-B-4: contains cases.monitor feature gate", () => {
    expect(win.mw).toContain('requireUserFeatureAccess("cases.monitor")');
  });

  it("CM-B-5: contains requirePermission case_monitor view", () => {
    expect(win.mw).toContain('requirePermission("case_monitor", "view")');
  });

  it("CM-B-6: contains requireManagementRoleForDashboard", () => {
    expect(win.mw).toContain("requireManagementRoleForDashboard");
  });

  it("CM-B-7: ordering Auth → FirmUser → Feature → Permission → ManagementRole", () => {
    const authIdx = win.mw.indexOf("requireAuth");
    const firmIdx = win.mw.indexOf("requireFirmUser");
    const featIdx = win.mw.indexOf('requireUserFeatureAccess("cases.monitor")');
    const permIdx = win.mw.indexOf('requirePermission("case_monitor", "view")');
    const mgmtIdx = win.mw.indexOf("requireManagementRoleForDashboard");
    expect(authIdx).toBeGreaterThan(-1);
    expect(firmIdx).toBeGreaterThan(authIdx);
    expect(featIdx).toBeGreaterThan(firmIdx);
    expect(permIdx).toBeGreaterThan(featIdx);
    expect(mgmtIdx).toBeGreaterThan(permIdx);
  });
});

describe("CM-C — bottlenecks route middleware order (SQL/STRUCTURAL)", () => {
  const src = readSrc(CASE_MONITOR_SRC);
  const win = locateRouteWindow(src, '"/case-monitor/bottlenecks",', "get");

  it("CM-C-1: bottlenecks route exists", () => {
    expect(win.start).toBeGreaterThan(-1);
  });

  it("CM-C-2: contains requireAuth", () => {
    expect(win.mw).toContain("requireAuth");
  });

  it("CM-C-3: contains requireFirmUser", () => {
    expect(win.mw).toContain("requireFirmUser");
  });

  it("CM-C-4: contains cases.monitor feature gate", () => {
    expect(win.mw).toContain('requireUserFeatureAccess("cases.monitor")');
  });

  it("CM-C-5: contains requirePermission case_monitor view", () => {
    expect(win.mw).toContain('requirePermission("case_monitor", "view")');
  });

  it("CM-C-6: contains requireManagementRoleForDashboard", () => {
    expect(win.mw).toContain("requireManagementRoleForDashboard");
  });

  it("CM-C-7: ordering Auth → FirmUser → Feature → Permission → ManagementRole", () => {
    const authIdx = win.mw.indexOf("requireAuth");
    const firmIdx = win.mw.indexOf("requireFirmUser");
    const featIdx = win.mw.indexOf('requireUserFeatureAccess("cases.monitor")');
    const permIdx = win.mw.indexOf('requirePermission("case_monitor", "view")');
    const mgmtIdx = win.mw.indexOf("requireManagementRoleForDashboard");
    expect(authIdx).toBeGreaterThan(-1);
    expect(firmIdx).toBeGreaterThan(authIdx);
    expect(featIdx).toBeGreaterThan(firmIdx);
    expect(permIdx).toBeGreaterThan(featIdx);
    expect(mgmtIdx).toBeGreaterThan(permIdx);
  });
});

describe("CM-D — no tenant DB fallback (SQL/STRUCTURAL)", () => {
  const src = readSrc(CASE_MONITOR_SRC);

  it("CM-D-1: no req.rlsDb ?? db absent", () => {
    expect(src).not.toContain("req.rlsDb ?? db");
  });

  it("CM-D-2: no rlsDb ?? db absent", () => {
    expect(src).not.toContain("rlsDb ?? db");
  });

  it("CM-D-3: no old const rdb arrow fallback helper", () => {
    expect(src).not.toMatch(/const\s+rdb\s*=\s*\(req[^)]*\)\s*=>\s*req\.rlsDb\s*\?\?\s*db/);
  });

  it("CM-D-4: defines getRlsDb(req,res)", () => {
    expect(src).toContain("const getRlsDb = (req: AuthRequest, res: Response)");
  });

  it("CM-D-5: getRlsDb contains 503 JSON return when null", () => {
    const fnStart = src.indexOf("const getRlsDb = (req");
    const fnBody = src.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain('status(503).json');
    expect(fnBody).toContain("Tenant DB context unavailable");
    expect(fnBody).toContain("return null");
  });
});

describe("CM-E — summary handler fail-closed (SQL/STRUCTURAL)", () => {
  const src = readSrc(CASE_MONITOR_SRC);
  const routeStart = src.indexOf('"/case-monitor/summary"');
  const handlerStart = src.indexOf("async (req", routeStart);
  const handlerEnd = src.indexOf(").catch", handlerStart) !== -1
    ? src.indexOf(").catch", handlerStart)
    : handlerStart + 2200;
  const block = src.slice(handlerStart, handlerEnd);

  it("CM-E-1: uses getRlsDb(req, res)", () => {
    expect(block).toContain("getRlsDb(req, res)");
  });

  it("CM-E-2: short-circuits with `if (!orm) return;", () => {
    // allow either `if (!orm) return` or `if (!<var>) return`
    expect(block).toMatch(/if\s*\(\s*!orm\s*\)\s*return/);
  });

  it("CM-E-3: no global db reference inside handler", () => {
    // The body should not reference bare `db.` anywhere inside handler (should go through orm)
    // But note we want to ensure not rely on any usage of `db` is only for types only.
    // Actually since handler must reference orm.* queries, not db.* queries
    const afterGuard = block.slice(block.indexOf("return;") + 1);
    expect(afterGuard).not.toMatch(/\bdb\.(select|update|insert|delete|execute)/);
  });
});

describe("CM-F — bottlenecks handler fail-closed (SQL/STRUCTURAL)", () => {
  const src = readSrc(CASE_MONITOR_SRC);
  const routeStart = src.indexOf('"/case-monitor/bottlenecks",');
  const handlerStart = src.indexOf("async (req", routeStart);
  const handlerEnd = handlerStart + 2500;
  const block = src.slice(handlerStart, handlerEnd);

  it("CM-F-1: uses getRlsDb(req, res)", () => {
    expect(block).toContain("getRlsDb(req, res)");
  });

  it("CM-F-2: short-circuits with `if (!orm) return;", () => {
    expect(block).toMatch(/if\s*\(\s*!orm\s*\)\s*return/);
  });
});

describe("CM-G — mutation routes also have cases.monitor + fail-closed (SQL/STRUCTURAL)", () => {
  const src = readSrc(CASE_MONITOR_SRC);

  it("CM-G-1: POST /resolve has cases.monitor feature + handler uses getRlsDb", () => {
    const w = locateRouteWindow(src, '"/case-monitor/bottlenecks/:id/resolve"', "post");
    expect(w.mw).toContain('requireUserFeatureAccess("cases.monitor")');
    const handlerSlice = src.slice(w.end, w.end + 1200);
    expect(handlerSlice).toContain("getRlsDb(req, res)");
    expect(handlerSlice).toMatch(/if\s*\(\s*!orm\s*\)\s*return/);
  });

  it("CM-G-2: POST /escalate has cases.monitor feature + handler uses getRlsDb", () => {
    const w = locateRouteWindow(src, '"/case-monitor/bottlenecks/:id/escalate"', "post");
    expect(w.mw).toContain('requireUserFeatureAccess("cases.monitor")');
    const handlerSlice = src.slice(w.end, w.end + 1200);
    expect(handlerSlice).toContain("getRlsDb(req, res)");
    expect(handlerSlice).toMatch(/if\s*\(\s*!orm\s*\)\s*return/);
  });
});
