/**
 * PART 2 K - Routes index invariant: all PART 2 router names mounted + HR routes not empty routers.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "routes");
const INDEX_PATH = path.join(ROOT, "index.ts");

const REQUIRED_ROUTE_NAMES = [
  "document-intelligence",
  "template-migrations",
  "bank-adapters",
  "hims",
];

const HR_ROUTERS_MUST_NOT_BE_EMPTY = [
  "hr-leave.ts",
  "hr-claims.ts",
  "hr-payroll.ts",
  "hr-attendance.ts",
  "hr-self-service.ts",
  "hr-recruitment.ts",
  "hr-offboarding.ts",
];

describe("PART 2K - Routes Index mount invariants", () => {
  const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");

  it(`routes/index.ts exports mount point contains all PART 2 router names`, () => {
    for (const name of REQUIRED_ROUTE_NAMES) {
      expect(indexSrc).toContain(name);
    }
  });

  it(`routes/index.ts explicitly imports and uses the 4 new routers`, () => {
    expect(indexSrc).toContain('documentIntelligenceRouter from "./document-intelligence.js"');
    expect(indexSrc).toContain('templateMigrationsRouter from "./template-migrations.js"');
    expect(indexSrc).toContain('bankAdaptersRouter from "./bank-adapters.js"');
    expect(indexSrc).toContain('himsRouter from "./hims.js"');
    expect(indexSrc).toContain("routerInternal.use(documentIntelligenceRouter)");
    expect(indexSrc).toContain("routerInternal.use(templateMigrationsRouter)");
    expect(indexSrc).toContain("routerInternal.use(bankAdaptersRouter)");
    expect(indexSrc).toContain("routerInternal.use(himsRouter)");
  });

  it.each(HR_ROUTERS_MUST_NOT_BE_EMPTY)(
    "%s must contain real handlers (not just empty Router() default export", (fileName) => {
      const full = path.join(ROOT, fileName);
      expect(fs.existsSync(full)).toBe(true);
      const src = fs.readFileSync(full, "utf8");
      expect(src).toContain("express.Router()");
      expect(src).not.toMatch(/^\s*export\s+default\s+router;\s*$/);
      expect(src.length).toBeGreaterThan(200);
      expect(src).toContain("requireAuth");
      expect(src).toContain("requireFirmUser");
    },
  );
});
