process.env.NODE_ENV = "test";
process.env.VITEST_SKIP_DB = "1";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PIPELINE_FILE = path.resolve(
  __dirname,
  "..",
  "modules",
  "cases",
  "legacy-import",
  "legacy-batch-pipeline.service.ts"
);
const PIPELINE_SRC = fs.existsSync(PIPELINE_FILE) ? fs.readFileSync(PIPELINE_FILE, "utf8") : "";

beforeAll(() => {
  process.env.VITEST_SKIP_DB = "1";
  process.env.NODE_ENV = "test";

  vi.mock("@workspace/db", async () => {
    const actual = (await vi.importActual("@workspace/db")) as any;
    const makeDb = () => {
      const db: any = {
        execute: async () => [],
        select: () => ({ from: () => makeFluent(() => []) }),
        insert: () => ({
          values: () => {
            const p = Promise.resolve([{ id: 123 }]) as any;
            p.returning = async () => [{ id: 123 }];
            return p;
          },
        }),
        update: () => ({ set: () => makeFluent(() => [{ id: 1 }]) }),
        delete: () => ({ where: () => makeFluent(() => []) }),
        transaction: async (fn: (tx: any) => Promise<any>) => await fn(makeDb()),
        $count: () => 0,
      };
      return db;
    };
    const makeFluent = (rowsFactory: () => unknown[] = () => []) => {
      const self: any = {};
      const makePromise = (v: unknown[]) => {
        const p = Promise.resolve(v) as any;
        Object.assign(p, self);
        return p;
      };
      self.where = () => makePromise(rowsFactory());
      self.innerJoin = () => makePromise(rowsFactory());
      self.leftJoin = () => makePromise(rowsFactory());
      self.limit = () => makePromise(rowsFactory());
      self.orderBy = () => makePromise(rowsFactory());
      self.offset = () => makePromise(rowsFactory());
      self.groupBy = () => makePromise(rowsFactory());
      self.returning = () => makePromise([{ id: 1 }]);
      return self;
    };
    return {
      ...actual,
      db: makeDb(),
    };
  });

  vi.mock("drizzle-orm", async () => {
    const actual = (await vi.importActual("drizzle-orm")) as any;
    return {
      ...actual,
      isNotNull: () => ({}),
      or: () => ({}),
      and: () => ({}),
    };
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("Legacy Import Pipeline Correctness (L1-L4: purchaseMode + loanPartyType)", () => {
  describe("L1-L4 deriveLegacyPurchaseMode helper", () => {
    it("L4: no bank/no loan/borrower → purchaseMode cash", async () => {
      const { deriveLegacyPurchaseMode } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const mode = deriveLegacyPurchaseMode([], {});
      expect(mode).toBe("cash");
    });

    it("L1: borrower same purchaser exists → loan", async () => {
      const { deriveLegacyPurchaseMode } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const mode = deriveLegacyPurchaseMode([{ ic: "123456", name: "Ahmad" }], {});
      expect(mode).toBe("loan");
    });

    it("L2: borrower different purchaser → loan", async () => {
      const { deriveLegacyPurchaseMode } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const mode = deriveLegacyPurchaseMode(
        [{ ic: "999", name: "Guarantor Co" }],
        {}
      );
      expect(mode).toBe("loan");
    });

    it("L3: bank financing exists, borrower blank → loan (via endFinancierBank)", async () => {
      const { deriveLegacyPurchaseMode } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const mode = deriveLegacyPurchaseMode([], { endFinancierBank: "MAYBANK" });
      expect(mode).toBe("loan");
    });

    it("L3: propertyFinancingSum > 0, borrower blank → loan", async () => {
      const { deriveLegacyPurchaseMode } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const mode = deriveLegacyPurchaseMode([], { propertyFinancingSum: 500000 });
      expect(mode).toBe("loan");
    });

    it("L3: loanAmount > 0, borrower blank → loan", async () => {
      const { deriveLegacyPurchaseMode } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const mode = deriveLegacyPurchaseMode([], { loanAmount: 400000 });
      expect(mode).toBe("loan");
    });

    it("L3: bankRef nonblank, borrower blank → loan", async () => {
      const { deriveLegacyPurchaseMode } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const mode = deriveLegacyPurchaseMode([], { bankRef: "HL-A1B2" });
      expect(mode).toBe("loan");
    });
  });

  describe("Loan party type deriveLegacyLoanPartyType (1st_party vs 3rd_party)", () => {
    it("P10: same borrower identity (IC match) → 1st_party + same_as_purchaser", async () => {
      const { deriveLegacyLoanPartyType } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const purchasers = [{ ic: "800101-01-1234", name: "Ali", tin: null }] as any;
      const borrowers = [{ ic: "800101-01-1234", name: "Ali", tin: null }] as any;
      const r = deriveLegacyLoanPartyType(purchasers, borrowers);
      expect(r.loanPartyType).toBe("1st_party");
      expect(r.borrowerMode).toBe("same_as_purchaser");
    });

    it("P11: different borrower identity → 3rd_party + separate", async () => {
      const { deriveLegacyLoanPartyType } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const purchasers = [{ ic: "111", name: "Ali", tin: null }] as any;
      const borrowers = [{ ic: "999", name: "Father", tin: null }] as any;
      const r = deriveLegacyLoanPartyType(purchasers, borrowers);
      expect(r.loanPartyType).toBe("3rd_party");
      expect(r.borrowerMode).toBe("separate");
    });

    it("P: no borrower + loan → borrowerMode none", async () => {
      const { deriveLegacyLoanPartyType } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const purchasers = [{ ic: "111", name: "Ali", tin: null }] as any;
      const borrowers = [] as any;
      const r = deriveLegacyLoanPartyType(purchasers, borrowers);
      expect(r.loanPartyType).toBe("1st_party");
      expect(r.borrowerMode).toBe("none");
    });
  });

  describe("P structural: import source construction (fixedValue survival / developer_sales constant)", () => {
    it("P1: mappedPayloadStorable persists fixedValues projectId/developerId/caseType/preserveRef", () => {
      expect(PIPELINE_SRC).toContain("fixedValues:");
      expect(PIPELINE_SRC).toContain("selectedFixedValues.projectId");
      expect(PIPELINE_SRC).toContain("selectedFixedValues.developerId");
      expect(PIPELINE_SRC).toContain("LEGACY_IMPORT_V1_CASE_TYPE");
      expect(PIPELINE_SRC).toContain("selectedFixedValues.preserveRef");
    });

    it("P source: import reads effective = row ?? fixed, not only caseData", () => {
      expect(PIPELINE_SRC).toContain("rowMappedProjectId");
      expect(PIPELINE_SRC).toContain("rowMappedDeveloperId");
      expect(PIPELINE_SRC).toContain("fixedProjectId");
      expect(PIPELINE_SRC).toContain("fixedDeveloperId");
      expect(PIPELINE_SRC).toContain("effectiveProjectId = rowMappedProjectId ?? fixedProjectId");
      expect(PIPELINE_SRC).toContain("effectiveDeveloperId = rowMappedDeveloperId ?? fixedDeveloperId");
    });

    it("P: purchaseMode not hardcoded 'cash' in createInput construction in legacy runImport", () => {
      const runImportStart = PIPELINE_SRC.indexOf("export async function runImport");
      const retryStart = PIPELINE_SRC.indexOf("export async function retryFailedRows");
      const slice = PIPELINE_SRC.slice(runImportStart, retryStart > runImportStart ? retryStart : PIPELINE_SRC.length);
      expect(slice).toContain("deriveLegacyPurchaseMode");
      expect(slice).toContain("purchaseMode,");
      expect(slice).not.toMatch(/purchaseMode:\s*["']cash["']/);
    });

    it("P: caseType = LEGACY_IMPORT_V1_CASE_TYPE constant in runImport", () => {
      const runImportStart = PIPELINE_SRC.indexOf("export async function runImport");
      const retryStart = PIPELINE_SRC.indexOf("export async function retryFailedRows");
      const slice = PIPELINE_SRC.slice(runImportStart, retryStart > runImportStart ? retryStart : PIPELINE_SRC.length);
      expect(slice).toContain("caseType: LEGACY_IMPORT_V1_CASE_TYPE");
    });

    it("P: loanPartyInfo used in createInput (not hardcoded 1st_party/separate)", () => {
      const runImportStart = PIPELINE_SRC.indexOf("export async function runImport");
      const retryStart = PIPELINE_SRC.indexOf("export async function retryFailedRows");
      const slice = PIPELINE_SRC.slice(runImportStart, retryStart > runImportStart ? retryStart : PIPELINE_SRC.length);
      expect(slice).toContain("borrowerMode: loanPartyInfo.borrowerMode");
      expect(slice).toContain("loanPartyType: loanPartyInfo.loanPartyType");
    });

    it("P: runImport uses createCaseCanonicalInTx (no nested tx)", () => {
      const runImportStart = PIPELINE_SRC.indexOf("export async function runImport");
      const retryStart = PIPELINE_SRC.indexOf("export async function retryFailedRows");
      const slice = PIPELINE_SRC.slice(runImportStart, retryStart > runImportStart ? retryStart : PIPELINE_SRC.length);
      expect(slice).toContain("createCaseCanonicalInTx");
      expect(slice).not.toMatch(/await\s+createCaseCanonical\(/);
    });

    it("P7: No blank date warnings exist in pipeline (no WARN_SPA/STAMPED/LO DATE_BLANK)", () => {
      expect(PIPELINE_SRC).not.toContain("WARN_SPA_DATE_BLANK");
      expect(PIPELINE_SRC).not.toContain("WARN_LO_DATE_BLANK");
      expect(PIPELINE_SRC).not.toContain("WARN_STAMPED_DATE_BLANK");
    });
  });
});

describe("Legacy >50 rows + import-plan structural checks in routes", () => {
  const ROUTE_FILE = path.resolve(__dirname, "..", "routes", "legacy-case-import.ts");
  const ROUTE_SRC = fs.existsSync(ROUTE_FILE) ? fs.readFileSync(ROUTE_FILE, "utf8") : "";

  it("P2/P3: /import-plan endpoint exists returns importableRowIds + counts", () => {
    expect(ROUTE_SRC).toContain("/:batchId/import-plan");
    expect(ROUTE_SRC).toContain("importableRowIds");
    expect(ROUTE_SRC).toContain("reviewRowIds");
    expect(ROUTE_SRC).toContain('case "READY":');
    expect(ROUTE_SRC).toContain('case "WARNING":');
  });

  it("P: GET rows supports status filter param", () => {
    expect(ROUTE_SRC).toContain("statusFilter");
    expect(ROUTE_SRC).toContain("eq(legacyCaseImportRowsTable.rowStatus, statusFilter)");
  });

  it("P9: sourceHeaders returned in mapping response", () => {
    expect(ROUTE_SRC).toContain("sourceHeaders");
    expect(ROUTE_SRC).toContain("Object.keys(firstRow.rawRowJson");
  });

  it("P4/P5: import-plan not capped 50 → selects ALL rows not limit 50", () => {
    const planRouteIdx = ROUTE_SRC.indexOf("/:batchId/import-plan");
    expect(planRouteIdx).toBeGreaterThan(-1);
    const slice = ROUTE_SRC.slice(planRouteIdx, planRouteIdx + 1500);
    expect(slice).not.toContain(".limit(");
    expect(slice).not.toContain(".offset(");
  });
});
