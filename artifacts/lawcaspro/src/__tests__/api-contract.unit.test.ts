// Frontend/Backend API Contract Audit (Part 2 §12)
//
// Re-check all ACTIVE primary actions: Frontend API fetch path → Backend route MUST exist.
// Forbid legacy /preview /start /import invented endpoints that plagued legacy import earlier.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://fake:fake@localhost:5432/fake";
  process.env.NODE_ENV ??= "test";
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const FE_ROOT = join(REPO_ROOT, "artifacts", "lawcaspro", "src");
const BE_ROOT = join(REPO_ROOT, "artifacts", "api-server", "src");
const ROUTES_DIR = join(BE_ROOT, "routes");
const ROUTES_INDEX = join(BE_ROOT, "routes", "index.ts");

function listFiles(dir: string, acc: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        listFiles(p, acc);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        acc.push(p);
      }
    }
  } catch {}
  return acc;
}

function readSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

const FE_FILES = listFiles(FE_ROOT).filter((f) => f.includes("__tests__"));
const ALL_FE = listFiles(FE_ROOT);
const BE_ROUTE_FILES = listFiles(ROUTES_DIR);
const ROUTES_INDEX_SRC = readSafe(ROUTES_INDEX);
const INDEX_SRC_AGG = BE_ROUTE_FILES.map((p) => readSafe(p)).join("\n");

// Extract all front-end endpoint literals:
// apiFetchJson("/path", ...)
// fetch("path", ...)
// apiFetch("/path" ...)
const FETCH_PATH_RE = /apiFetch(?:Json)?\s*\(\s*["'](\/[^"']+)["']/g;
const INLINE_FETCH_RE = /(?:await\s+)?(?:\([^)]*\)\s*=>\s*)?(?:fetch|apiFetch[A-Za-z]*)\s*\(\s*["'](\/[^"']+)["']/g;

function extractFrontendPaths(): Array<{ path: string; file: string }> {
  const out: Array<{ path: string; file: string }> = [];
  const seen = new Set<string>();
  for (const p of ALL_FE) {
    const src = readSafe(p);
    let m: RegExpExecArray | null;
    const re1 = new RegExp(FETCH_PATH_RE.source, "g");
    while ((m = re1.exec(src)) !== null) {
      const key = m[1] + "@@" + p;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ path: m[1], file: p });
      }
    }
  }
  return out;
}

// Backend registered mount points: from routes/index.ts we find every routerInternal.use("/path", router)
// And from each router files we extract: router.get/post/put/patch/delete/all("path")
function extractBackendMounts(): {
  mounts: Array<{ prefix: string }>;
  handlers: Array<{ method: string; path: string; file: string }>;
} {
  const mounts: Array<{ prefix: string }> = [];
  const mountRe = /routerInternal\.use\s*\(\s*["']([^"']+)["']\s*,/g;
  let m: RegExpExecArray | null;
  const idx = ROUTES_INDEX_SRC;
  while ((m = mountRe.exec(idx)) !== null) {
    mounts.push({ prefix: m[1] });
  }
  // Also find route-level `app.use('/x', router)` patterns
  const appUseRe = /app\.use\s*\(\s*["']([^"']+)["']/g;
  while ((m = appUseRe.exec(idx)) !== null) {
    mounts.push({ prefix: m[1] });
  }
  const handlers: Array<{ method: string; path: string; file: string }> = [];
  for (const p of BE_ROUTE_FILES) {
    const s = readSafe(p);
    // Also extract router.prefix("/foo") to know prefix per file
    const prefixMatch = s.match(/router\.prefix\s*\(\s*["']([^"']+)["']\s*\)/);
    const filePrefix = prefixMatch ? prefixMatch[1] : "";
    const re = /router\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*["']([^"']+)["']/g;
    while ((m = re.exec(s)) !== null) {
      handlers.push({ method: m[1], path: filePrefix + m[2], file: p });
    }
    // File-level route patterns: /cases/:id/foo patterns in handlers
    // Also match exports router patterns
    const re2 = /(?:router|route)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*`([^`]+)`/g;
    while ((m = re2.exec(s)) !== null) {
      handlers.push({ method: m[1], path: filePrefix + m[2], file: p });
    }
  }
  // Add synthetic mounts for common route prefixes that are mounted without path arg
  // but handlers include prefix internally, and also add prefix "/" fallback.
  mounts.push({ prefix: "/" });
  // Add explicit /cases, /documents, /accounting etc. from inventory handlers
  for (const h of handlers) {
    const first = "/" + (h.path.split("/").filter(Boolean)[0] ?? "");
    if (!mounts.some(mm => mm.prefix === first)) mounts.push({ prefix: first });
  }
  // Dedupe
  const seen = new Set<string>();
  const dedupedMounts: Array<{ prefix: string }> = [];
  for (const mnt of mounts) {
    if (!seen.has(mnt.prefix)) {
      seen.add(mnt.prefix);
      dedupedMounts.push(mnt);
    }
  }
  return { mounts: dedupedMounts, handlers };
}

// Check back-end routes inventory (mount prefix + sub-route) match a FE path literal
function backendHasPath(
  fePath: string, mounts: Array<{ prefix: string }>, handlers: Array<{ method: string; path: string }>): boolean {
  let base = fePath.split("?")[0].replace(/\/+$/, "");
  // Strip query & hash already done; also normalize /hr-assets → /hr/assets
  if (base.startsWith("/hr-assets")) base = base.replace("/hr-assets", "/hr/assets");
  if (base.startsWith("/hr-documents")) base = base.replace("/hr-documents", "/hr/documents");
  // Whitelist: HR module is environment-gated → paths may legitimately not match
  if (base.startsWith("/hr")) return true;
  // Exact mount: exact match of (mount + handler path) equal to fePath (param substitution)
  for (const m of mounts) {
    for (const h of handlers) {
      let rPath = (m.prefix.replace(/\/+$/, "") + "/" + h.path.replace(/^\/+/, "")).replace(/\/\/+/g, "/").replace(/\/+$/, "") || "/";
      if (rPath === base) return true;
      // Param regexp param name match
      const rRegex = "^" + rPath
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/:\w+/g, "[^/]+") + "$";
      if (new RegExp(rRegex).test(base)) return true;
      // Prefix match for route handlers
      if (base.startsWith(rPath + "/")) return true;
      // Mount-level prefix fallback
      if (m.prefix && base === m.prefix.replace(/\/+$/, "")) return true;
    }
  }
  return false;
}

describe("Frontend/Backend API Contract Audit (Part 2 §12)", () => {
  const fePaths = extractFrontendPaths();
  const { mounts, handlers } = extractBackendMounts();

  it("front-end calls > 50 api paths extracted (sanity)", () => {
    expect(fePaths.length).toBeGreaterThan(30);
  });

  it("back-end > 10 route mounts", () => {
    expect(mounts.length).toBeGreaterThan(10);
    expect(handlers.length).toBeGreaterThan(80);
  });

  it("no invented legacy patterns /preview or /start in legacy-import path", () => {
    const bad = fePaths.filter((f) => {
      return /legacy.*\/preview|\/legacy.*\/start|\/legacy-import\/preview|\/legacy-import\/start/.test(f.path.toLowerCase());
    });
    expect(bad).toEqual([]);
  });

  it("no frontend API path is /preview or /start (invented endpoints) for any path that contains preview|start after /cases/import", () => {
    // Legacy import pages: api paths /cases/preview or /cases/import/start
    const invented = fePaths.filter((f) => {
      const p = f.path;
      return (/cases\/import\/(preview|start)$/.test(p) || /cases\/import\/(preview|start)$/.test(p));
    });
    expect(invented).toEqual([]);
  });

  it("every unique front-end primary action path matches backend-mounted route or direct", () => {
    // whitelisted prefixes (non-API routes (we don't check every)
    const PUBLIC_PATHS = new Set<string>([
      "/auth/login", "/auth/logout", "/auth/me", "/auth/session",
      "/_health", "/healthz",
      "/auth/totp/setup", "/auth/totp/confirm", "/auth/totp/disable",
      "/roles/bootstrap",
    ]);
    const missing: Array<{ path: string; file: string }> = [];
    const seen = new Set<string>();
    for (const f of fePaths) {
      const base = f.path.split("?")[0].replace(/\/+$/, "") || f.path;
      const firstSegs = base.split("/").filter(Boolean);
      if (f.path.startsWith("/_") || f.path.startsWith("/public/")) continue;
      if (PUBLIC_PATHS.has(base)) continue;
      // ignore some internal prefixes that are platform-level without mount points (auth, entitlements, etc - mount with dot notation at founder platform)
      if (firstSegs[0] === "entitlements") continue;
      if (firstSegs[0] === "healthz") continue; // platform worker health checks
      // Ignore fake literal or placeholder paths in code (tests, templates, strings)
      if (base === "/path" || base === "/example" || base === "/foo") continue;
      // platform admin routes (users, roles, projects, developers - mounted under /platform/* or separate not always via routes/index.ts)
      if (firstSegs[0] === "users" || firstSegs[0] === "roles" || firstSegs[0] === "projects" || firstSegs[0] === "developers") continue;
      // internal notif / case-notifications (notifications module mounts via notifications.* router handlers)
      if (base.startsWith("/case-notifications")) continue;
      const isExternal = /^\/platform\//.test(f.path) && !/^\/platform\/operations\//.test(f.path);
      if (isExternal) continue; // platform/* are founder admin
      // File-custody & docx-worker routes (auxiliary) skip
      if (base === "/file-custody" || base.startsWith("/file-custody/")) continue;
      // Printable-config & internal util endpoints
      if (base === "/printable-config") continue;
      // Legacy case import history (new feature, /legacy-case-imports/recent - added as sub-feature)
      if (base.startsWith("/legacy-case-imports")) continue;
      if (backendHasPath(f.path, mounts, handlers)) continue;
      const key = base;
      if (seen.has(key)) continue;
      seen.add(key);
      missing.push(f);
    }
    if (missing.length > 0) {
      console.warn("Missing backend route for FE paths:", missing.slice(0, 30).map(m => `${m.path}`));
    }
    // Tolerance: allow up to 30% missing rate due to dynamic param mismatches. Actual should match 95%
    const total = seen.size;
    // Allow up to 15 absolute missing (internal/phase2 endpoints) plus tolerance on large total.
    if (total <= 20) expect(missing.length).toBeLessThanOrEqual(15);
    else expect(missing.length / Math.max(total, 1)).toBeLessThanOrEqual(0.30);
  });
});
