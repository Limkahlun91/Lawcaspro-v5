// G0.2 Structural regression test:
// Job guard keys are opaque tokens passed EXCLUSIVELY through two canonical
// APIs: canFirmRunJobsFor(firmId, jobKey, conn) and filterFirmsForJob(jobKey, firms).
// They must NEVER be passed directly as feature keys to entitlement resolution.
//
// Failure here indicates: future developer accidentally used a job-guard string
// like 'payment_voucher_sla' as a feature key → entitlement engine lookup would
// fail "not found" (deny), but the semantic meaning is wrong and job guards
// would silently short-circuit.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const API_SERVER_ROOT = resolve(__dirname, "..", "..");

// All 9 known job guard keys registered in FEATURE_REGISTRY.jobGuards[] union.
// (Mirror of the runtime collectJobGuardToFeatureMap() domain; intentionally
// duplicated here as a lock list to force audits when new job guards added.)
const JOB_GUARD_KEYS: readonly string[] = [
  "payment_voucher_sla",
  "case_bottleneck",
  "completion_sla",
  "email_sla",
  "email_sync",
  "hr_claim_sla",
  "hr_leave_sla",
  "hr_onboarding",
  "hr_offboarding",
  "hr_event_delivery",
] as const;

// Forbidden functions: any direct lookup of feature entitlement by string key.
// If a job-guard string appears inside these call arguments, it's being used
// as a feature key — G0.2 violation.
const FORBIDDEN_CALL_PATTERNS: readonly RegExp[] = [
  // resolveEntitlement(sFirm, |bulk(
  /\bresolveEntitlement(?:sBulk)?\s*\(\s*[^)]*['"]([^'"]+)['"]/g,
  // requireUserFeatureAccess(
  /\brequireUserFeatureAccess\s*\(\s*['"]([^'"]+)['"]/g,
  // requireFirmFeature(
  /\brequireFirmFeature\s*\(\s*['"]([^'"]+)['"]/g,
  // canFirmRunFeature(  (if it existed, historical wrapper)
  /\bcanFirmRunFeature\s*\(\s*[^)]*['"]([^'"]+)['"]/g,
  // [featureKey]="xxx" inside role permission tables that are RBAC only? → exempted by file below
];

// Production files to scan: all .ts / .tsx excluding __tests__ and __fixtures__
// and node_modules and dist.  For G0.2 structural check, this is the
// enforceable contract surface (cron paths, job runners, services, routes, lib).
function walkProductionFiles(root: string, out: string[] = []): string[] {
  // Avoid deep node_modules walks.
  const skip = new Set(["node_modules", "dist", "build", ".turbo", ".next", "coverage", "__fixtures__", "__mocks__"]);
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const name = String(e.name);
    if (skip.has(name)) continue;
    const full = path.join(root, name);
    if (e.isDirectory()) walkProductionFiles(full, out);
    else if (e.isFile() && /\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

// Files EXEMPT from G0.2 structural check (job guard strings appear ONLY for
// their legitimate canonical use or in audit/RBAC contexts — never as feature
// key lookups):
//   - cron-jobs.ts: passes payment_voucher_sla to canFirmRunJobsFor ✓ (canonical)
//   - case-bottleneck-monitor.ts: passes case_bottleneck to filterFirmsForJob ✓ (canonical)
//   - hr-offboarding.ts + auth.ts + validators + settings/index + hr-phase1 + permission matrix tests:
//       use as requirePermission("hr_offboarding", …) which is RBAC module name — different namespace, NOT feature key entitlement call.
//       (These are string-matched in requirePermission, not entitlement resolver calls —
//        the FORBIDDEN_CALL_PATTERNS list above excludes requirePermission on purpose.)
//   - entitlement-resolver.ts: commented dead code only + jobGuardMap build from FEATURE_REGISTRY — not passed to resolver as key.
//   - case-monitor.ts: entityType:"case_bottleneck" audit only — NOT feature key.
//   - any __tests__ / .test.ts files: already excluded by walk (skip __tests__)
const EXEMPT_FILE_SUBSTRINGS: readonly string[] = [
  // Canonical legit use of job guard strings via blessed APIs (already confirmed in our prior grep)
  "cron-jobs.ts",
  "case-bottleneck-monitor.ts",
  // RBAC module-action namespace (requirePermission/permissionChecker), separate from feature key resolution
  "hr-offboarding.ts",
  "hr-role-permission-matrix.test.ts",
  "employee-status-transitions.ts",
  "case-monitor.ts",
  "auth.ts",
  "settings/index.tsx",
  "hr-phase1.unit.test.ts",
  // Feature registry itself defines jobGuards[] — strings live here only as metadata
  "feature-registry.ts",
  "feature-registry-parity.unit.test.ts",
  "platform-feature-control.integration.test.ts",
  // Tests we're writing now (avoid self-reference match)
  "g0-2-jobguard-decoupling.structural.test.ts",
];

describe("G0.2 Job Guard ↔ Feature Key Separation (structural contract)", () => {
  it("collectJobGuardToFeatureMap domain matches hardcoded JOB_GUARD_KEYS lock list", async () => {
    // Structural guard: if a new job-guard key is added to FEATURE_REGISTRY.jobGuards
    // without updating this locked test list → fail immediately (forces audit).
    const { collectJobGuardToFeatureMap } = await import("@workspace/db/feature-registry");
    const runtimeMap = collectJobGuardToFeatureMap();
    const runtimeKeys = Array.from(runtimeMap.keys()).sort();
    const lockedKeys = Array.from(new Set(JOB_GUARD_KEYS.slice())).sort();
    expect(runtimeKeys).toEqual(lockedKeys);
  });

  it("No job guard key is ever passed directly as feature-key argument to entitlement/feature-resolution calls across the production surface", () => {
    const files = walkProductionFiles(API_SERVER_ROOT);
    // Also scan lawcaspro artifact (frontend could accidentally misuse too):
    const LAW_ROOT = resolve(__dirname, "..", "..", "..", "lawcaspro", "src");
    if (existsSync(LAW_ROOT)) walkProductionFiles(LAW_ROOT, files);

    const violations: Array<{ file: string; jobKey: string; pattern: string; matchText: string }> = [];

    for (const f of files) {
      // Fast-path exemption
      if (EXEMPT_FILE_SUBSTRINGS.some((ex) => f.endsWith(ex) || f.includes(ex.replace(/\.tsx?$/, "")))) continue;
      let text: string;
      try { text = readFileSync(f, "utf8"); } catch { continue; }
      // Skip block comments (/* ... */) and line comments (// ...) approximately
      // to avoid false matches on documentation.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|\s)\/\/[^\n]*/g, " ");

      for (const pattern of FORBIDDEN_CALL_PATTERNS) {
        const regex = new RegExp(pattern.source, "g");
        let m: RegExpExecArray | null;
        while ((m = regex.exec(code)) !== null) {
          const captured = m[1];
          if (!captured) continue;
          if (JOB_GUARD_KEYS.includes(captured)) {
            violations.push({
              file: f,
              jobKey: captured,
              pattern: pattern.toString(),
              matchText: m[0].slice(0, 120),
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error("G0.2 VIOLATIONS", JSON.stringify(violations, null, 2));
    }
    expect(violations).toEqual([]);
  });
});
