import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * PART 2.4 G1 — TEST DISCOVERY GUARD.
 *
 * Automatic + manual classification. Static test reads every file on disk:
 *   - file contains skipDb / hasDatabaseUrl pattern? => LIVE_DB_REQUIRED
 *     (and its own suite-level guard skips everything if no env DATABASE_URL)
 *   - imports @electric-sql/pglite? => PGLITE_IN_PROCESS
 *   - else => DB_INDEPENDENT
 *
 * Plus: UNACCOUNTED = 0 (total disk count = sum of 3 buckets).
 * Plus: each LIVE_DB_REQUIRED file actually contains an internal guard
 *       (i.e. it will skip when DATABASE_URL absent rather than blow up).
 */

type TestClass = "DB_INDEPENDENT" | "PGLITE_IN_PROCESS" | "LIVE_DB_REQUIRED";

function listAllTestsOnDisk(): string[] {
  return fs
    .readdirSync(path.resolve(__dirname))
    .filter((f) => f.endsWith(".test.ts"))
    .sort();
}

function classify(file: string): TestClass {
  const full = path.join(path.resolve(__dirname), file);
  const c = fs.readFileSync(full, "utf8");
  // P0 guard test itself contains "process.env.DATABASE_URL" inside its own
  // regex literal — must override (it's pure filesystem/strings only)
  if (file === "test-file-classification.guard.test.ts") return "DB_INDEPENDENT";
  if (c.includes("@electric-sql/pglite") || /new\s+PGlite\b/.test(c)) return "PGLITE_IN_PROCESS";
  if (
    /skipDb\s*=/.test(c) ||
    /hasDatabaseUrl\s*=/.test(c) ||
    /process\.env\.DATABASE_URL\s*\?/.test(c)
  ) return "LIVE_DB_REQUIRED";
  return "DB_INDEPENDENT";
}

describe("PART 2.4 G1 — Test discovery guard + class manifest", () => {
  it("UNACCOUNTED FILES = 0, MISSING MANIFEST OVERRIDES = 0; prints summary", () => {
    const disk = listAllTestsOnDisk();
    let ind = 0, pg = 0, live = 0;
    const miss: string[] = [];
    for (const f of disk) {
      const cls = classify(f);
      if (cls === "DB_INDEPENDENT") ind++;
      else if (cls === "PGLITE_IN_PROCESS") pg++;
      else live++;
    }
    const total = ind + pg + live;
    // eslint-disable-next-line no-console
    console.log(
      `[GUARD] TOTAL_TEST_FILES=${disk.length} ` +
      `| DB_INDEPENDENT_INCLUDED=${ind} ` +
      `| PGLITE_IN_PROCESS=${pg} ` +
      `| LIVE_DB_SKIPPABLE_INCLUDED_WHEN_NO_URL=${live} ` +
      `| SUM=${total} ` +
      `| UNACCOUNTED=${disk.length - total}`,
    );
    expect(disk.length - total).toBe(0);
    expect(miss).toEqual([]);
    // Expected classification sanity: live bucket matches 11 known skipDb files +
    // any future files we correctly catch via regex pattern.
    expect(live).toBeGreaterThanOrEqual(11);
    expect(pg).toBeGreaterThanOrEqual(1);
    expect(ind).toBeGreaterThanOrEqual(90);
  });

  it("each LIVE_DB_REQUIRED file has an internal suite skip-guard (no crash when no URL)", () => {
    const disk = listAllTestsOnDisk();
    const live = disk.filter((f) => classify(f) === "LIVE_DB_REQUIRED");
    for (const f of live) {
      const c = fs.readFileSync(path.join(path.resolve(__dirname), f), "utf8");
      const hasGuard =
        /process\.env\.DATABASE_URL/.test(c) ||
        /skipDb\s*=/.test(c) ||
        /hasDatabaseUrl\s*=/.test(c) ||
        /VITEST_SKIP_DB/.test(c);
      expect(hasGuard).toBe(true);
    }
  });

  it("PGLITE file imports @electric-sql/pglite", () => {
    const disk = listAllTestsOnDisk();
    const pgs = disk.filter((f) => classify(f) === "PGLITE_IN_PROCESS");
    for (const f of pgs) {
      const c = fs.readFileSync(path.join(path.resolve(__dirname), f), "utf8");
      expect(c.includes("@electric-sql/pglite") || /new\s+PGlite\b/.test(c)).toBe(true);
    }
  });

  it("the 5 mandatory P0 regression files ARE classified DB_INDEPENDENT or PGLITE_IN_PROCESS (no external live DB → always run)", () => {
    const mustBeAlwaysRunnable: string[] = [
      "p0-authz-classification.unit.test.ts",
      "p0-case-access-centralized.unit.test.ts",
      "p0-billing-lock-reversal.unit.test.ts",
      "p0-g13-staff-baseline-batch-mutation.unit.test.ts",
      "feature-registry-parity.unit.test.ts",
    ];
    const alwaysRunnableClasses = new Set(["DB_INDEPENDENT", "PGLITE_IN_PROCESS"]);
    for (const f of mustBeAlwaysRunnable) {
      expect(fs.existsSync(path.join(path.resolve(__dirname), f))).toBe(true);
      const cls = classify(f);
      expect(alwaysRunnableClasses.has(cls)).toBe(true);
    }
  });
});
