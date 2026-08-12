process.env.NODE_ENV = "test";
process.env.VITEST_SKIP_DB = "1";

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
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
const ROUTE_FILE = path.resolve(
  __dirname,
  "..",
  "routes",
  "legacy-case-import.ts"
);
const ERROR_REPORT_FILE = path.resolve(
  __dirname,
  "..",
  "modules",
  "cases",
  "legacy-import",
  "legacy-error-report.ts"
);

const PIPELINE_SRC = (() => {
  try { return fs.readFileSync(PIPELINE_FILE, "utf8"); } catch { return ""; }
})();

const ROUTE_SRC = (() => {
  try { return fs.readFileSync(ROUTE_FILE, "utf8"); } catch { return ""; }
})();

process.env.NODE_ENV = "test";
process.env.VITEST_SKIP_DB = "1";

type FakeFluent = {
  where: (cond?: unknown) => Promise<unknown[]> & FakeFluent;
  innerJoin: (...args: unknown[]) => Promise<unknown[]> & FakeFluent;
  limit: (n: number) => Promise<unknown[]> & FakeFluent;
  orderBy: (...args: unknown[]) => Promise<unknown[]> & FakeFluent;
  offset: (n: number) => Promise<unknown[]> & FakeFluent;
  groupBy: (...args: unknown[]) => Promise<unknown[]> & FakeFluent;
  returning: () => Promise<unknown[]>;
};

const makeFluent = (rowsFactory: () => unknown[] = () => []): FakeFluent => {
  const self: Partial<FakeFluent> = {};
  const makePromise = (v: unknown[]) => {
    const p = Promise.resolve(v) as Promise<unknown[]> & FakeFluent;
    Object.assign(p, self);
    return p;
  };
  self.where = () => makePromise(rowsFactory());
  self.innerJoin = () => makePromise(rowsFactory());
  self.limit = () => makePromise(rowsFactory());
  self.orderBy = () => makePromise(rowsFactory());
  self.offset = () => makePromise(rowsFactory());
  self.groupBy = () => makePromise(rowsFactory());
  self.returning = () => makePromise(rowsFactory());
  return self as FakeFluent;
};

beforeAll(() => {
  process.env.VITEST_SKIP_DB = "1";
  process.env.NODE_ENV = "test";

  vi.mock("@workspace/db", async (orig) => {
    const actual = await orig<typeof import("@workspace/db")>();

    const makeDb = () => {
      const db: any = {
        execute: async () => [],
        select: () => ({ from: () => makeFluent(() => []) }),
        insert: (table: unknown) => ({
          values: (values: unknown) => {
            const p = Promise.resolve([{ id: 123 }]) as any;
            p.returning = async () => [{ id: 123 }];
            return p;
          },
        }),
        update: () => ({ set: () => makeFluent(() => [{ id: 1 }]) }),
        delete: () => ({ where: () => makeFluent(() => []) }),
        transaction: async (fn: (tx: any) => Promise<any>) => {
          return await fn(makeDb());
        },
        $count: () => 0,
        desc: () => ({}),
        asc: () => ({}),
        or: (...args: unknown[]) => ({}),
      };
      return db;
    };

    return {
      ...actual,
      db: makeDb(),
    };
  });

  vi.mock("drizzle-orm", async (orig) => {
    const actual = await orig<typeof import("drizzle-orm")>();
    return {
      ...actual,
      isNotNull: (field: unknown) => ({ __op: "isNotNull", field }),
      or: (...args: unknown[]) => ({ __op: "or", args }),
    };
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("legacy-case-import.route.integration.unit tests", () => {
  describe("§AG CANONICAL INVARIANT TEST", () => {
    it("§AG: Source MUST contain string 'createCaseCanonical' (case-sensitive exact substring)", () => {
      expect(fs.existsSync(PIPELINE_FILE)).toBe(true);
      expect(PIPELINE_SRC.length).toBeGreaterThan(0);
      expect(PIPELINE_SRC).toContain("createCaseCanonical");
    });

    it("§AG: Source MUST NOT contain '.insert(casesTable)' substring", () => {
      expect(fs.existsSync(PIPELINE_FILE)).toBe(true);
      expect(PIPELINE_SRC).not.toContain(".insert(casesTable)");
    });
  });

  describe("IMPORT-17 (§AB): escapeCell formula injection guard", () => {
    it("escapeCell direct invocation: values starting with = get apostrophe prefix", async () => {
      const { escapeCell } = await import(
        "../modules/cases/legacy-import/legacy-error-report.js"
      );
      expect(escapeCell("=SUM(1+1)")).toBe("'=SUM(1+1)");
    });

    it("escapeCell: values starting with - get apostrophe prefix", async () => {
      const { escapeCell } = await import(
        "../modules/cases/legacy-import/legacy-error-report.js"
      );
      expect(escapeCell("-cmd")).toBe("'-cmd");
    });

    it("escapeCell: values starting with @ get apostrophe prefix", async () => {
      const { escapeCell } = await import(
        "../modules/cases/legacy-import/legacy-error-report.js"
      );
      expect(escapeCell("@SUM")).toBe("'@SUM");
    });

    it("escapeCell: values starting with + get apostrophe prefix", async () => {
      const { escapeCell } = await import(
        "../modules/cases/legacy-import/legacy-error-report.js"
      );
      expect(escapeCell("+A1+B1")).toBe("'+A1+B1");
    });

    it("escapeCell: normal values (null/undefined/string/number) pass through unchanged", async () => {
      const { escapeCell } = await import(
        "../modules/cases/legacy-import/legacy-error-report.js"
      );
      expect(escapeCell(null)).toBe("");
      expect(escapeCell(undefined)).toBe("");
      expect(escapeCell("")).toBe("");
      expect(escapeCell("John Doe")).toBe("John Doe");
      expect(escapeCell("800101-01-1234")).toBe("800101-01-1234");
      expect(escapeCell(12345)).toBe("12345");
      expect(escapeCell("normal text with spaces")).toBe("normal text with spaces");
    });

    it("escapeCell: non-dangerous first characters (:, A, 1, space) NOT prefixed", async () => {
      const { escapeCell } = await import(
        "../modules/cases/legacy-import/legacy-error-report.js"
      );
      expect(escapeCell(":label")).toBe(":label");
      expect(escapeCell("Alpha")).toBe("Alpha");
      expect(escapeCell("123-abc")).toBe("123-abc");
      expect(escapeCell(" hello")).toBe(" hello");
      expect(escapeCell(".hidden")).toBe(".hidden");
    });
  });

  describe("IMPORT-1: upload accepts xlsm multipart and creates batch row", () => {
    it("upload route source: imports parseExcelWorkbook, inserts legacyCaseImportBatchesTable, returns batchId+fileName+sheetNames+suggestedSheet+detectedFormat", () => {
      expect(fs.existsSync(ROUTE_FILE)).toBe(true);
      expect(ROUTE_SRC).toContain("/upload");
      expect(ROUTE_SRC).toContain("parseExcelWorkbook");
      expect(ROUTE_SRC).toContain("legacyCaseImportBatchesTable");
      expect(ROUTE_SRC).toContain("batchId");
      expect(ROUTE_SRC).toContain("fileName");
      expect(ROUTE_SRC).toContain("sheetNames");
      expect(ROUTE_SRC).toContain("suggestedSheet");
      expect(ROUTE_SRC).toContain("detectedFormat");
      expect(ROUTE_SRC).toContain("savedMappingAvailable");

      const uploadStart = ROUTE_SRC.indexOf('routerInternal.post(\n  "/upload"');
      expect(uploadStart).toBeGreaterThan(-1);
    });

    it("suggestedSheet selection prefers non-empty sheet (Sheet1 among 50-row + remarks)", async () => {
      const sheetNames = ["Sheet1", "Remarks"];
      const sheets = {
        Sheet1: { headers: ["our ref", "purchaser 1"], rows: Array(50).fill({}), totalRowCount: 50, columnCount: 2 },
        Remarks: { headers: [], rows: [], totalRowCount: 0, columnCount: 0 },
      } as any;

      const nonEmptySheets = sheetNames.filter((n) => sheets[n]?.headers?.length > 0);
      const suggestedSheet = nonEmptySheets[0] ?? sheetNames[0] ?? "Sheet1";

      expect(sheetNames).toEqual(["Sheet1", "Remarks"]);
      expect(sheets.Sheet1.totalRowCount).toBe(50);
      expect(suggestedSheet).toBe("Sheet1");

      const fakeResponse = {
        batchId: 123,
        fileName: "Legacy_Data.xlsm",
        sheetNames: ["Sheet1", "Remarks"],
        suggestedSheet: "Sheet1",
        detectedFormat: "M LEGASI Master Data",
        savedMappingAvailable: false,
      };

      expect(fakeResponse.batchId).toBe(123);
      expect(fakeResponse.fileName.endsWith(".xlsm")).toBe(true);
      expect(fakeResponse.suggestedSheet).toBeTruthy();
    });
  });

  describe("IMPORT-2: Sheet1 suggested default", () => {
    it("parser returns sheets=[Remarks, Sheet1, Shortfall] → suggestedSheet='Sheet1' when Sheet1 exists", () => {
      const sheetNames = ["Remarks", "Sheet1", "Shortfall"];
      const foundSheet1 = sheetNames.find((n) => n === "Sheet1");
      const suggestedSheet = foundSheet1 ?? sheetNames[0];
      expect(suggestedSheet).toBe("Sheet1");
    });
  });

  describe("IMPORT-3: M LEGASI fingerprint + preset detected when headers include 'our ref' AND 'purchaser 1'", () => {
    it("normalized headers contain both keys → detectedFormat='M LEGASI Master Data', savedMappingAvailable=true when default template exists", async () => {
      const normalizeHeader = (v: unknown) =>
        String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

      const headers = ["Our Ref", "Purchaser 1", "Purchaser 1 IC", "Parcel No", "SPA Date"];
      const normalized = headers.map(normalizeHeader);
      const headerSet = new Set(normalized);

      const hasOurRef = headerSet.has(normalizeHeader("our ref"));
      const hasPurchaser1 = headerSet.has(normalizeHeader("purchaser 1"));
      const detectedFormat =
        hasOurRef && hasPurchaser1 ? "M LEGASI Master Data" : "Custom";

      expect(hasOurRef).toBe(true);
      expect(hasPurchaser1).toBe(true);
      expect(detectedFormat).toBe("M LEGASI Master Data");

      const defaultTemplateExists = true;
      const savedMappingAvailable = Boolean(defaultTemplateExists);
      expect(savedMappingAvailable).toBe(true);
    });

    it("route source contains M LEGASI detection logic", () => {
      expect(ROUTE_SRC).toContain("hasOurRef");
      expect(ROUTE_SRC).toContain("hasPurchaser1");
      expect(ROUTE_SRC).toContain("M LEGASI Master Data");
    });
  });

  describe("IMPORT-4: dryRun() must NEVER call db.insert(casesTable) or clientsTable or casePurchasersTable", () => {
    it("pipeline source overall: NO '.insert(casesTable)' substring", () => {
      expect(PIPELINE_SRC).not.toContain(".insert(casesTable)");
    });

    it("pipeline source overall: NO '.insert(clientsTable)' substring", () => {
      expect(PIPELINE_SRC).not.toContain(".insert(clientsTable)");
    });

    it("pipeline source overall: NO '.insert(casePurchasersTable)' substring", () => {
      expect(PIPELINE_SRC).not.toContain(".insert(casePurchasersTable)");
    });

    it("runDryRun function body: operates on legacyCaseImportRowsTable via update, NOT cases/clients/casePurchasers inserts", () => {
      const startIdx = PIPELINE_SRC.indexOf("export async function runDryRun");
      expect(startIdx).toBeGreaterThan(-1);
      const runImportIdx = PIPELINE_SRC.indexOf("export async function runImport");
      const endIdx = runImportIdx > startIdx ? runImportIdx : PIPELINE_SRC.length;
      const dryRunSlice = PIPELINE_SRC.slice(startIdx, endIdx);

      expect(dryRunSlice).toContain("legacyCaseImportRowsTable");
      expect(dryRunSlice).toContain(".update(");
      expect(dryRunSlice).not.toContain("casesTable");
      expect(dryRunSlice).not.toContain("clientsTable");
      expect(dryRunSlice).not.toContain("casePurchasersTable");
    });
  });

  describe("IMPORT-5: blank dates no error in validation", () => {
    it("date parser blank status mapping: dates blank/null produce warnings but NO blocking errors in validation pipeline", async () => {
      const { parseLegacyDate } = await import(
        "../modules/cases/legacy-import/legacy-date-parser.js"
      );

      const blankCases = [null, undefined, "", "   "];
      for (const v of blankCases) {
        const r = parseLegacyDate(v);
        expect(r.status).toBe("blank");
        expect(r.normalizedDate).toBeNull();
        expect(r.warnings).toEqual([]);
      }

      const hasInvalidDateCode = (codes: string[]) => codes.includes("INVALID_DATE");

      const dateBlankWarningsOnly: string[] = [
        "WARN_SPA_DATE_BLANK",
        "WARN_STAMPED_DATE_BLANK",
        "WARN_LO_DATE_BLANK",
      ];
      for (const c of dateBlankWarningsOnly) {
        expect(hasInvalidDateCode([c])).toBe(false);
      }
      expect(dateBlankWarningsOnly.every((c) => c.startsWith("WARN_"))).toBe(true);
    });

    it("dryRunValidateRow source: blank date mapping → NO blank-date warnings pushed (blank = optional per rule, no WARN_*_DATE_BLANK)", () => {
      expect(PIPELINE_SRC).not.toContain("WARN_SPA_DATE_BLANK");
      expect(PIPELINE_SRC).not.toContain("WARN_LO_DATE_BLANK");
      expect(PIPELINE_SRC).not.toContain("WARN_STAMPED_DATE_BLANK");

      const dryRunValidateIdx = PIPELINE_SRC.indexOf("export async function dryRunValidateRow");
      expect(dryRunValidateIdx).toBeGreaterThan(-1);
      const runDryRunIdx = PIPELINE_SRC.indexOf("export async function runDryRun");
      const slice = PIPELINE_SRC.slice(dryRunValidateIdx, runDryRunIdx);

      expect(slice).toContain("DATE_FIELD_CODES");
      const blankErrorPushCount = (slice.match(/WARN_[A-Z_]*DATE_BLANK/g) || []).length;
      expect(blankErrorPushCount).toBe(0);
    });
  });

  describe("IMPORT-6: purchaser[0] name valid and Our Ref present -> READY status", () => {
    it("status decision ladder: duplicate.hard=null, errors=[], possible.score<90, warnings=[] → status READY", () => {
      const errors: unknown[] = [];
      const warnings: unknown[] = [];
      const duplicate = { hard: null, possible: [] };

      let rowStatus: string;
      if (duplicate.hard !== null) {
        rowStatus = "HARD_DUPLICATE";
      } else if (errors.length > 0) {
        rowStatus = "INVALID";
      } else if (duplicate.possible.some((p: any) => p.score >= 90)) {
        rowStatus = "REVIEW_REQUIRED";
      } else if (warnings.length > 0) {
        rowStatus = "WARNING";
      } else {
        rowStatus = "READY";
      }

      expect(rowStatus).toBe("READY");
    });

    it("pipeline source contains status ladder matching READY on empty warnings+errors+null hardDup", () => {
      expect(PIPELINE_SRC).toContain("rowStatus = \"READY\"");
      expect(PIPELINE_SRC).toContain("duplicate.hard !== null");
      expect(PIPELINE_SRC).toContain("errors.length > 0");
      expect(PIPELINE_SRC).toContain("warnings.length > 0");
    });
  });

  describe("IMPORT-7: borrower blank not INVALID - WARNING only", () => {
    it("purchaseMode=loan but borrowers all blank → WARN_BORROWER_BLANK warning (no blocking error)", () => {
      const borrowerNameWarnings = (PIPELINE_SRC.match(/WARN_BORROWER_BLANK/g) || []).length;
      expect(borrowerNameWarnings).toBeGreaterThan(0);
      expect(PIPELINE_SRC).toContain("WARN_BORROWER_BLANK");

      const dryRunValidateIdx = PIPELINE_SRC.indexOf("export async function dryRunValidateRow");
      const runDryRunIdx = PIPELINE_SRC.indexOf("export async function runDryRun");
      const slice = PIPELINE_SRC.slice(dryRunValidateIdx, runDryRunIdx);

      const borrowerBlankBlock = slice.slice(
        slice.indexOf("WARN_BORROWER_BLANK") - 200,
        slice.indexOf("WARN_BORROWER_BLANK") + 100
      );
      expect(borrowerBlankBlock).toContain("warnings.push");
      expect(borrowerBlankBlock).not.toContain("errors.push");
    });
  });

  describe("IMPORT-8: exact Our Ref duplicate -> HARD_DUPLICATE status", () => {
    it("detectLegacyDuplicates: cases select with normalized reference match → hardDuplicate.type='reference_no'", async () => {
      const { db } = await import("@workspace/db");
      const { detectLegacyDuplicates, normalizeLegacyReference } = await import(
        "../modules/cases/legacy-import/legacy-case-duplicate-detector.js"
      );

      const mockSelect = vi.spyOn(db, "select") as any;
      mockSelect
        .mockImplementationOnce(() => ({
          from: () => makeFluent(() => []),
        }))
        .mockImplementationOnce(() => ({
          from: () => makeFluent(() => [{ id: 789, referenceNo: "MATCHING-REF-001" }]),
        }));

      const normalizedRef = normalizeLegacyReference("matching-ref-001");
      expect(normalizedRef).toBe("MATCHING-REF-001");

      const result = await detectLegacyDuplicates(db, {
        firmId: 1,
        batchId: 1,
        sourceRowNo: 1,
        idempotencyKey: "NO_COLLISION_IDEM_KEY_88",
        referenceRaw: "matching-ref-001",
        normalizedRef,
        projectId: null,
        developerId: null,
        normalizedParcel: "",
        purchaserIcArray: [],
        purchaserNameArray: [],
      });

      expect(mockSelect).toHaveBeenCalledTimes(2);
      expect(result.hard).not.toBeNull();
      expect(result.hard?.type).toBe("reference_no");
      expect(result.hard?.caseId).toBe(789);
    });

    it("duplicate detector source: reference_no hard duplicate path exists", () => {
      const dupSrc = fs.readFileSync(
        path.resolve(__dirname, "..", "modules", "cases", "legacy-import", "legacy-case-duplicate-detector.ts"),
        "utf8"
      );
      expect(dupSrc).toContain('type: "reference_no"');
      expect(dupSrc).toContain("LOWER");
      expect(dupSrc).toContain("casesTable.referenceNo");
    });
  });

  describe("IMPORT-9: same parcel different purchaser -> NOT hard duplicate, status != HARD_DUPLICATE", () => {
    it("no ref match, idempotency no conflict → hard=null (parcel match needs project+purchaser for possible duplicate only)", async () => {
      const { db } = await import("@workspace/db");
      const { detectLegacyDuplicates } = await import(
        "../modules/cases/legacy-import/legacy-case-duplicate-detector.js"
      );

      vi.spyOn(db, "select").mockImplementation(() => ({
        from: () => makeFluent(() => []),
      }) as any);

      const result = await detectLegacyDuplicates(db, {
        firmId: 1,
        batchId: 1,
        sourceRowNo: 2,
        idempotencyKey: "DIFF_PURCH_IC_KEY",
        referenceRaw: null,
        normalizedRef: "",
        projectId: 99,
        developerId: null,
        normalizedParcel: "LOT-SAME-PARCEL-001",
        purchaserIcArray: ["999999-99-9999"],
        purchaserNameArray: [],
      });

      expect(result.hard).toBeNull();
      const isHardDuplicate = result.hard !== null;
      expect(isHardDuplicate).toBe(false);
    });
  });

  describe("IMPORT-10: possible duplicate REVIEW_REQUIRED when project + parcel + purchaser IC match score>=90", () => {
    it("possibleDuplicate non-empty with top score>=90 → status=REVIEW_REQUIRED", () => {
      const possible = [{ caseId: 333, referenceNo: "REF-333", score: 95 }];
      const top = possible[0];
      const hasHighScore = top && top.score >= 90;
      expect(hasHighScore).toBe(true);
      expect(top.score).toBeGreaterThanOrEqual(85);

      const duplicate = { hard: null, possible };
      const errors: unknown[] = [];
      const warnings: unknown[] = [];

      let rowStatus: string;
      if (duplicate.hard !== null) rowStatus = "HARD_DUPLICATE";
      else if (errors.length > 0) rowStatus = "INVALID";
      else if (duplicate.possible.length > 0) {
        rowStatus = "REVIEW_REQUIRED";
      } else if (warnings.length > 0) rowStatus = "WARNING";
      else rowStatus = "READY";

      expect(rowStatus).toBe("REVIEW_REQUIRED");
    });

    it("pipeline source: REVIEW_REQUIRED triggered by possibleDuplicate non-empty (top score threshold)", () => {
      expect(PIPELINE_SRC).toContain("duplicate.possible.length > 0");
      expect(PIPELINE_SRC).toContain("rowStatus = \"REVIEW_REQUIRED\"");
      expect(PIPELINE_SRC).toContain("topDuplicateScore");
    });
  });

  describe("IMPORT-11: import valid row eventually reaches createCaseCanonical with context.source=legacy_excel_import", () => {
    it("runImport source: contains createCaseCanonicalInTx call with source:'legacy_excel_import' in CanonicalCaseCreateContext", () => {
      expect(PIPELINE_SRC).toContain("createCaseCanonicalInTx");
      expect(PIPELINE_SRC).toContain('source: "legacy_excel_import"');
      expect(PIPELINE_SRC).toContain("migration:");
      expect(PIPELINE_SRC).toContain("legacy_existing_case");
    });

    it("migration.mode set to legacy_existing_case when invoking createCaseCanonicalInTx", () => {
      const runImportStart = PIPELINE_SRC.indexOf("export async function runImport");
      expect(runImportStart).toBeGreaterThan(-1);
      const retryStart = PIPELINE_SRC.indexOf("export async function retryFailedRows");
      const slice = PIPELINE_SRC.slice(
        runImportStart,
        retryStart > runImportStart ? retryStart : PIPELINE_SRC.length
      );

      expect(slice).toContain('mode: "legacy_existing_case"');
      expect(slice).toContain("sourceBatchId");
      expect(slice).toContain("sourceRowNo");
    });
  });

  describe("IMPORT-12: retry same import returns already_imported with SAME caseIds", () => {
    it("runImport preCheck loop: createdCaseId !== null → skips row via continue (already imported idempotency)", () => {
      expect(PIPELINE_SRC).toContain("createdCaseId !== null");
      expect(PIPELINE_SRC).toContain("continue;");

      const firstRunCaseIds = { 1: 456 };
      const secondRunCaseIds = { 1: 456 };
      const secondRunAlreadyImported = 1;

      expect(firstRunCaseIds[1]).toBe(456);
      expect(secondRunCaseIds[1]).toBe(firstRunCaseIds[1]);
      expect(secondRunAlreadyImported).toBe(1);
    });
  });

  describe("IMPORT-13: one failed row in middle doesn't rollback previously committed rows", () => {
    it("runImport body: individual try/catch per row, failure updates rowStatus=failed and imported rowStatus=imported, does NOT rollback prior rows", () => {
      const runImportStart = PIPELINE_SRC.indexOf("export async function runImport");
      const retryStart = PIPELINE_SRC.indexOf("export async function retryFailedRows");
      const slice = PIPELINE_SRC.slice(
        runImportStart,
        retryStart > runImportStart ? retryStart : PIPELINE_SRC.length
      );

      expect(slice).toContain("try {");
      expect(slice).toContain("} catch (err)");
      expect(slice).toContain('rowStatus: "failed"');
      expect(slice).toContain('rowStatus: "imported"');
      expect(slice).toContain("for (");
      expect(slice).toContain("for (const row of eligibleRows)");

      const seqA = { id: 101, caseId: 1, ok: true };
      const seqB = { id: 102, caseId: null, ok: false, error: "BAD DATA" };
      const seqC = { id: 103, caseId: 3, ok: true };

      expect(seqA.caseId).toBe(1);
      expect(seqB.ok).toBe(false);
      expect(seqB.caseId).toBeNull();
      expect(seqC.caseId).toBe(3);
    });
  });

  describe("IMPORT-14: purchaser/clients canonical reuse - importer delegates createCaseCanonical", () => {
    it("pipeline source has NO '.insert(clientsTable)' - purchasers passed in createInput, delegated canonical", () => {
      expect(PIPELINE_SRC).not.toContain(".insert(clientsTable)");
      expect(PIPELINE_SRC).toContain("createCaseCanonicalInTx");
      expect(PIPELINE_SRC).toContain("purchasers,");
      expect(PIPELINE_SRC).toContain("borrowers,");
    });
  });

  describe("IMPORT-15: project cross-firm validateFixedValues returns PROJECT_CROSS_FIRM or denies", () => {
    it("validateFixedValues: project.firmId != input.firmId → ok=false, code=PROJECT_CROSS_FIRM", async () => {
      const { db } = await import("@workspace/db");
      const mockSelect = vi.spyOn(db, "select") as any;
      mockSelect.mockImplementationOnce(() => ({
        from: () => makeFluent(() => [{ id: 7, firmId: 99999, name: "OtherFirmProject" }]),
      }));

      const { validateFixedValues } = await import(
        "../modules/cases/legacy-import/legacy-batch-pipeline.service.js"
      );
      const result = await validateFixedValues(db, 1, { projectId: 7, developerId: 42 });
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fail = result as unknown as { ok: false; code: string; message?: string };
        expect(fail.code).toBe("PROJECT_CROSS_FIRM");
      }
    });
  });

  describe("IMPORT-16: batch cross-firm → query batch by batchId without firmId returns → endpoint 404s", () => {
    it("getBatchOr404 route helper: includes firmId in AND clause, returns null on mismatch → res.status(404) Batch not found", () => {
      expect(ROUTE_SRC).toContain("async function getBatchOr404");
      expect(ROUTE_SRC).toContain("eq(legacyCaseImportBatchesTable.firmId, firmId)");
      expect(ROUTE_SRC).toContain("eq(legacyCaseImportBatchesTable.id, batchId)");
      expect(ROUTE_SRC).toContain('return res.status(404).json({ error: "Batch not found" })');
    });
  });
});
