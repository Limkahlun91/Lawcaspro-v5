// ============================================================================
// P0 Emergency Recovery — Frontend targeted regressions
// Covers:
//   ENT-1/ENT-2   useFirmEntitlements calls /users/_self/effective-features
//   ENT-3         sidebar/settings never call /entitlements/founder/* endpoint
//   ENT-PERF-1    ONE shared React Query cache key ["firm","user","effective-features"]
//                 with staleTime 60_000 + refetchOnWindowFocus = stale
// ============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE_ROOT = join(__dirname, "..");

beforeAll(() => { process.env.NODE_ENV ??= "test"; });

function listFiles(dir: string, acc: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        listFiles(p, acc);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) acc.push(p);
    }
  } catch {}
  return acc;
}
function readSafe(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

const FILES = listFiles(FE_ROOT);
const SRC_AGG = Object.fromEntries(FILES.map((p) => [relative(FE_ROOT, p), readSafe(p)]));

describe("ENT-PERF-1 — single shared query key with staleTime 60s", () => {
  function findFile(basenameEnd: string): { rel: string; src: string } | null {
    for (const [rel, src] of Object.entries(SRC_AGG)) {
      const normalized = rel.replace(/\\/g, "/");
      if (normalized.endsWith(basenameEnd)) return { rel, src };
    }
    return null;
  }
  it("feature-guards.tsx exports EFFECTIVE_FEATURES_QUERY_KEY exactly ['firm','user','effective-features']", () => {
    const hit = findFile("lib/feature-guards.tsx");
    expect(hit).not.toBeNull();
    const fg = hit!.src;
    expect(fg).toMatch(/const\s+EFFECTIVE_FEATURES_QUERY_KEY\s*=\s*\[\s*"firm"\s*,\s*"user"\s*,\s*"effective-features"\s*\]/);
    expect(fg).toMatch(/staleTime:\s*(?:60_000|60\s*\*\s*1000)/);
    expect(fg).toMatch(/refetchOnWindowFocus:\s*(?:true|"stale")/);
  });
  it("FirmSubscriptionFeaturesTab uses the same queryKey ['firm','user','effective-features']", () => {
    const hit = findFile("FirmSubscriptionFeaturesTab.tsx");
    expect(hit).not.toBeNull();
    const tab = hit!.src;
    expect(tab).toContain(`"firm", "user", "effective-features"`);
    expect(tab).toMatch(/staleTime:\s*(?:60\s*\*\s*1000|60_000)/);
  });
});

describe("ENT-3 — Firm runtime bootstrap NEVER calls /entitlements/founder/*", () => {
  it("no founder entitlement endpoint appears in non-platform, non-test runtime files", () => {
    const bad: string[] = [];
    for (const [rel, src] of Object.entries(SRC_AGG)) {
      if (/__tests__/.test(rel)) continue;
      if (/platform/i.test(rel)) continue; // platform admin pages allowed
      if (/entitlements\/founder\//.test(src)) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});

describe("ENT-1 / ENT-2 — canonical /users/_self/effective-features referenced in runtime UI", () => {
  it("at least two runtime files reference /users/_self/effective-features", () => {
    const refs: string[] = [];
    for (const [rel, src] of Object.entries(SRC_AGG)) {
      if (/__tests__/.test(rel)) continue;
      if (/\/users\/_self\/effective-features/.test(src)) refs.push(rel);
    }
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });
});
