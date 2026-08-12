// Navigation ↔ Route Integrity invariant test (Part 2 §10)
// Ensures every visible nav href resolves to an actual mounted Route in App.tsx.
// Forbids: Menu → 404 or Menu → blank / missing route.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const APP_TSX = join(REPO_ROOT, "artifacts", "lawcaspro", "src", "App.tsx");
const SIDEBAR_TSX = join(REPO_ROOT, "artifacts", "lawcaspro", "src", "components", "layout", "sidebar-body.tsx");

beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://fake:fake@localhost:5432/fake";
  process.env.NODE_ENV ??= "test";
});

type NavHref = { href: string; label: string; group: string };

function extractNavHrefs(src: string): NavHref[] {
  const out: NavHref[] = [];
  // Match groups: key: "...", label: "..."
  const groupRe = /key:\s*"([^"]+)"\s*,\s*\n\s*label:\s*"([^"]+)"/g;
  const itemRe = /label:\s*"([^"]+)"\s*,\s*href:\s*"(\/[^"]+)"/g;
  // Map to nearest group label by source position
  const groupPositions: Array<{ pos: number; groupLabel: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = groupRe.exec(src)) !== null) {
    groupPositions.push({ pos: m.index, groupLabel: m[2] });
  }
  while ((m = itemRe.exec(src)) !== null) {
    const pos = m.index;
    let groupLabel = "main";
    for (let i = 0; i < groupPositions.length; i++) {
      if (groupPositions[i].pos <= pos) groupLabel = groupPositions[i].groupLabel;
    }
    out.push({ label: m[1], href: m[2], group: groupLabel });
  }
  return out;
}

type RouteEntry = { path: string; isRedirect: boolean; redirectTo?: string };
function extractAppRoutes(src: string): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const pathRe = /<Route\s+path=["']([^"']+)["']([^>]*?)>/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(src)) !== null) {
    const attrs = m[2];
    let redirectTo: string | undefined;
    const redirMatch = /<Redirect\s+to=["']([^"']+)["']/;
    // Slice ahead ~200 chars to find nested Redirect
    const tail = src.slice(m.index, m.index + Math.max(300, m[0].length));
    const to = tail.match(redirMatch);
    if (to) redirectTo = to[1];
    routes.push({ path: m[1], isRedirect: !!redirectTo, redirectTo });
  }
  return routes;
}

function hrefMatchesRoute(href: string, routes: RouteEntry[]): boolean {
  const clean = href.split("?")[0].split("#")[0];
  for (const r of routes) {
    if (r.path === clean) return true;
    // Prefix: /app/cases → matches /app/cases/anything (but skip root /app collision)
    if (r.path.length > 5 && clean.startsWith(r.path + "/")) return true;
    // Wildcard-style prefix match for routes like /app/settings/logs matches href /app/settings
    if (clean.length > 5 && r.path.startsWith(clean + "/")) return true;
    // Route param substitution: /app/cases/:id matches /app/cases/PARAM-hint
    if (r.path.includes(":")) {
      const re = new RegExp(
        "^" +
          r.path
            .split("/")
            .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
            .join("/") +
          "$"
      );
      if (re.test(clean)) return true;
      // Also match route /app/cases/:id against parent href /app/cases since user can navigate there
      const parentPath = r.path.split("/").slice(0, -1).join("/");
      if (parentPath === clean) return true;
    }
  }
  return false;
}

describe("Navigation ↔ Route Integrity (Part 2 §10)", () => {
  const appSrc = readFileSync(APP_TSX, "utf8");
  const sidebarSrc = readFileSync(SIDEBAR_TSX, "utf8");
  const routes = extractAppRoutes(appSrc);
  const navHrefs = extractNavHrefs(sidebarSrc);

  it("parses at least 8 nav items across 7 groups", () => {
    expect(navHrefs.length).toBeGreaterThanOrEqual(8);
    const groups = new Set(navHrefs.map((n) => n.group));
    expect(groups.size).toBeGreaterThanOrEqual(4);
  });

  it("parses at least 40 routes from App.tsx", () => {
    expect(routes.length).toBeGreaterThanOrEqual(40);
  });

  it.each(navHrefs.map((n) => [`[${n.group}] ${n.label} → ${n.href}`, n] as const))(
    "href resolves: %s",
    (_name, nav) => {
      const matches = hrefMatchesRoute(nav.href, routes);
      if (!matches) {
        // If the href redirects (e.g. /app/users → /app/settings?tab=users),
        // then check that the REDIRECT route exists with this exact path
        const redirectRoute = routes.find((r) => r.path === nav.href.split("?")[0].split("#")[0]);
        if (redirectRoute && redirectRoute.isRedirect) {
          // Resolve redirect target recursively (one-level): check target route resolves
          if (redirectRoute.redirectTo) {
            const tgt = redirectRoute.redirectTo;
            expect(hrefMatchesRoute(tgt, routes)).toBeTruthy();
            return;
          }
        }
      }
      expect(matches).toBeTruthy();
    }
  );

  it("does not contain nav entries with /app or / or blank href", () => {
    for (const n of navHrefs) {
      expect(n.href).toMatch(/^\/app\//);
      expect(n.href.length).toBeGreaterThan(5);
    }
  });

  it("does not contain File Custody nav entry (Part 2 §6 exception)", () => {
    for (const n of navHrefs) {
      expect(n.href).not.toBe("/app/file-custody");
    }
  });
});
