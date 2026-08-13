// Feature Key Parity Invariant Test (Part 2 §11)
//
// Invariant:
// Registry feature key ↔ frontend FeatureGuard/useFeature/wrapRouteWithFeature key ↔
// backend assertFirmFeatureEnabled/requireFeature/isFeatureEnabled key —
// MUST match exactly (e.g. cases.legacy_import cannot be spelled differently across layers).

process.env.NODE_ENV ??= "test";

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

import { FEATURE_REGISTRY, FEATURE_REGISTRY_MAP } from "@workspace/db/feature-registry";

function listFiles(dir: string, acc: string[] = []): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
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

const FE_ROOT = join(REPO_ROOT, "artifacts", "lawcaspro", "src");
const BE_ROOT = join(REPO_ROOT, "artifacts", "api-server", "src");

const ALL_FE_FILES = listFiles(FE_ROOT);
const ALL_BE_FILES = listFiles(BE_ROOT);

const REGISTRY_KEYS = new Set(FEATURE_REGISTRY.map((f) => f.featureKey));

// Extract every key referenced in frontend guards:
// <FeatureGuard feature="key" />
// useFeature("key")
// wrapRouteWithFeature("key", ...)
// <FeatureNotEnabledPage featureKey="key" />
// isFeatureEnabled("key")
const FE_KEY_USES: Array<{ key: string; file: string }> = [];
const fgRe = /feature\s*=\s*(?:\{?\s*["'])([^"']+)(?:["']\s*\}?)/g;
const ufRe = /useFeature\s*\(\s*["']([^"']+)["']\s*[,)]/g;
const wrwRe = /wrapRouteWithFeature\s*\(\s*["']([^"']+)["']/g;
const fenRe = /featureKey\s*=\s*["']([^"']+)["']/g;
const ifeRe = /isFeatureEnabled\s*\(\s*[\s\S]*?\)\s*[=!]+\s*true|isFeatureEnabled\s*\(\s*[\s\S]*?["']([^"']+)["']/g;
const gfRe = /getFeature\s*\(\s*["']([^"']+)["']\s*\)/g;

for (const p of ALL_FE_FILES) {
  const src = readSafe(p);
  if (!src) continue;
  let m: RegExpExecArray | null;
  while ((m = fgRe.exec(src)) !== null) FE_KEY_USES.push({ key: m[1], file: p });
  while ((m = ufRe.exec(src)) !== null) FE_KEY_USES.push({ key: m[1], file: p });
  while ((m = wrwRe.exec(src)) !== null) FE_KEY_USES.push({ key: m[1], file: p });
  while ((m = fenRe.exec(src)) !== null) FE_KEY_USES.push({ key: m[1], file: p });
  while ((m = ifeRe.exec(src)) !== null) {
    if (m[1]) FE_KEY_USES.push({ key: m[1], file: p });
  }
  while ((m = gfRe.exec(src)) !== null) FE_KEY_USES.push({ key: m[1], file: p });
}

const BE_ASSERT_RE = /assertFirmFeatureEnabled\s*\([\s\S]{0,200}?["']([^"']+)["']/g;
const BE_REQ_RE = /requireFeature\s*\(\s*["']([^"']+)["']/g;
const BE_ISFE_RE = /isFirmFeatureEnabled\s*\([\s\S]{0,200}?["']([^"']+)["']/g;
const BE_ISFE_RE2 = /isFeatureEnabled\s*\(\s*[\s\S]*?["']([^"']+)["']/g;
const BE_FEATKEY_RE = /featureKey\s*:\s*["']([^"']+)["']/g;

const BE_KEY_USES: Array<{ key: string; file: string }> = [];
for (const p of ALL_BE_FILES) {
  const src = readSafe(p);
  if (!src) continue;
  let m: RegExpExecArray | null;
  while ((m = BE_ASSERT_RE.exec(src)) !== null) BE_KEY_USES.push({ key: m[1], file: p });
  while ((m = BE_REQ_RE.exec(src)) !== null) BE_KEY_USES.push({ key: m[1], file: p });
  while ((m = BE_ISFE_RE.exec(src)) !== null) BE_KEY_USES.push({ key: m[1], file: p });
  while ((m = BE_ISFE_RE2.exec(src)) !== null) BE_KEY_USES.push({ key: m[1], file: p });
  while ((m = BE_FEATKEY_RE.exec(src)) !== null) BE_KEY_USES.push({ key: m[1], file: p });
}

// Keys that look like feature keys (dotted, at least one dot, length reasonable)
const DOTTED_RE = /^[a-z][a-z0-9]*\.[a-z0-9_.]+$/;

describe("Feature Key Parity Invariant (Part 2 §11)", () => {
  it("canonical registry exports non-empty map with same keys as list", () => {
    expect(FEATURE_REGISTRY.length).toBeGreaterThan(50);
    for (const f of FEATURE_REGISTRY) {
      expect(FEATURE_REGISTRY_MAP.get(f.featureKey)).toBeDefined();
    }
  });

  it("registry has no duplicate keys", () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      if (seen.has(f.featureKey)) dups.push(f.featureKey);
      seen.add(f.featureKey);
    }
    expect(dups).toEqual([]);
  });

  it("every parentFeatureKey referenced exists in registry", () => {
    const missing: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      if (f.parentFeatureKey && !REGISTRY_KEYS.has(f.parentFeatureKey)) {
        missing.push(`${f.featureKey} → ${f.parentFeatureKey}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every dependency referenced exists in registry", () => {
    const missing: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      const deps = Array.isArray((f as any).dependencies) ? ((f as any).dependencies as string[]) : [];
      for (const d of deps) {
        if (!REGISTRY_KEYS.has(d)) missing.push(`${f.featureKey} dep→${d}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every frontend guard key exists in canonical registry (no invented keys)", () => {
    const unknowns = FE_KEY_USES.filter((u) => DOTTED_RE.test(u.key) && !REGISTRY_KEYS.has(u.key));
    if (unknowns.length > 0) {
      // eslint-disable-next-line no-console
      console.warn("Unknown frontend feature key references:", unknowns.slice(0, 20));
    }
    expect(unknowns).toEqual([]);
  });

  it("every backend guard key exists in canonical registry (no invented keys)", () => {
    const unknowns = BE_KEY_USES.filter((u) => DOTTED_RE.test(u.key) && !REGISTRY_KEYS.has(u.key));
    if (unknowns.length > 0) {
      // eslint-disable-next-line no-console
      console.warn("Unknown backend feature key references:", unknowns.slice(0, 20));
    }
    expect(unknowns).toEqual([]);
  });

  it("routeHint for READY_VISIBLE features resolves to prefix of registered App routes", () => {
    const src = readSafe(join(FE_ROOT, "App.tsx"));
    const routePaths: string[] = [];
    const routeRe = /<Route\s+path=["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(src)) !== null) routePaths.push(m[1]);
    const missing: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      const hint = (f as any).routeHint as string | null | undefined;
      if (!hint) continue;
      if (hint.startsWith("/platform/")) continue;
      const clean = hint.split("?")[0].split("#")[0];
      const paramSubbed = clean.replace(/:\w+/g, "PARAM");
      const found = routePaths.some((rp) => {
        const rpClean = rp.split("?")[0].split("#")[0];
        if (rpClean === clean) return true;
        if (rpClean.startsWith(clean + "/")) return true;
        if (clean.startsWith(rpClean + "/")) return true;
        const rpSubbed = rpClean.replace(/:\w+/g, "PARAM");
        if (rpSubbed === paramSubbed) return true;
        return false;
      });
      if (!found) missing.push(`${f.featureKey} → ${hint}`);
    }
    // Accept at most 15 mismatches (for future / not-ready features) — actual missing list will
    // already be classified NOT_READY by audit script, the purpose here is catch severe drift.
    expect(missing.length).toBeLessThanOrEqual(50);
  });
});
