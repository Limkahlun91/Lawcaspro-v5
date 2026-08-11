import { defineConfig } from "vitest/config";

/**
 * PART 2.4 G1 — FIX TEST DISCOVERY.
 *
 * PREVIOUS (broken):
 *   No DATABASE_URL set? → restrictive hardcoded whitelist of ~50 files, which
 *   silently dropped 70+ tests including every new P0 regression test (authz,
 *   case-access centralized, billing locks, G13 baseline matrix,
 *   feature-registry parity).
 *
 * NOW (correct):
 *   include ALL src/__tests__/** / *.test.ts files regardless of DATABASE_URL.
 *   Tests that genuinely require a live external Postgres (LIVE_DB_REQUIRED)
 *   already contain internal `skipDb = !process.env.DATABASE_URL` guards and
 *   will simply skip their suites — they are still "accounted for" in the
 *   vitest test-file report (not silently dropped from discovery).
 *
 * See classification test: src/__tests__/test-file-classification.guard.test.ts
 * for the explicit per-file manifest with classes:
 *   DB_INDEPENDENT | PGLITE_IN_PROCESS | LIVE_DB_REQUIRED
 * and the guard UNACCOUNTED = 0 assertion.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 15000,
    hookTimeout: 60000,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    pool: "forks",
    forks: {
      singleFork: true,
    },
  },
});
