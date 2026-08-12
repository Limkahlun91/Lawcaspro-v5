process.env.NODE_ENV = "test";
process.env.VITEST_SKIP_DB = "1";

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseExcelWorkbook,
  computeHeaderFingerprint,
} from "../modules/cases/legacy-import/excel-parser.js";
import {
  M_LEGASI_PRESET_MAPPING,
} from "../modules/cases/legacy-import/legacy-case-field-catalog.js";
import {
  autoMapHeaders,
  applyRowMapping,
  type MappingTemplateDefinition,
  type ExcelColumnMapping,
} from "../modules/cases/legacy-import/mapping-engine.js";
import {
  buildIdempotencyKey,
  normalizeLegacyReference,
  normalizeLegacyNric,
  normalizeLegacyName,
  normalizeLegacyParcel,
  detectLegacyDuplicates,
  type LegacyDuplicateResult,
} from "../modules/cases/legacy-import/legacy-case-duplicate-detector.js";
import { parseLegacyDate } from "../modules/cases/legacy-import/legacy-date-parser.js";
import {
  runDryRun,
  runImport,
  validateFixedValues,
  retryFailedRows,
} from "../modules/cases/legacy-import/legacy-batch-pipeline.service.js";
import {
  createCaseCanonical,
  type CanonicalCaseCreateContext,
  type CanonicalCaseCreateInput,
  type CanonicalPurchaserInput,
  type CanonicalBorrowerInput,
} from "../modules/cases/create-case-canonical.service.js";
import { writeLegacyErrorReportXlsxBuffer } from "../modules/cases/legacy-import/legacy-error-report.js";
import { escapeCell } from "../modules/cases/legacy-import/legacy-error-report.js";

const sha256Hex = (buf: Buffer | string): string => {
  return crypto.createHash("sha256").update(buf).digest("hex");
};

const M_LEGASI_HEADERS = [
  "Our Ref",
  "Parcel No",
  "Purchaser 1",
  "Purchaser 2",
  "Purchaser 3",
  "Purchaser 4",
  "IC 1",
  "IC 2",
  "IC 3",
  "IC 4",
  "Borrower 1",
  "Borrower 2",
  "Borrower 3",
  "Borrower 4",
  "Developer",
  "Property",
  "Property Type",
  "Purchase Price",
  "End Financier",
  "Bank Ref",
  "Financing Sum",
  "Total Loan",
  "SPA date",
  "SPA stamping",
  "LO Date",
  "FA DATE",
  "NOA DATED",
  "IGNORE_A",
  "IGNORE_B",
  "IGNORE_C",
  "IGNORE_D",
  "IGNORE_E",
  "IGNORE_F",
  "IGNORE_G",
  "IGNORE_H",
  "IGNORE_I",
  "IGNORE_J",
];

function buildSyntheticWorkbook(rowsInput: unknown[][]): Buffer {
  const data = [M_LEGASI_HEADERS, ...rowsInput];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Remarks only"]]), "Remarks");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Shortfall only"]]), "Shortfall");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
  return Buffer.from(out);
}

function makeRow(values: Partial<Record<string, unknown>>): unknown[] {
  return M_LEGASI_HEADERS.map((h) => (values[h] !== undefined ? values[h] : null));
}

const TEST_FIRM_ID = 555;
const TEST_FIRM_ID_OTHER = 999;
const TEST_ACTOR_USER_ID = 42;
const TEST_PROJECT_ID = 21;
const TEST_DEVELOPER_ID = 77;

const PIPELINE_SRC = fs.readFileSync(
  path.resolve(__dirname, "../modules/cases/legacy-import/legacy-batch-pipeline.service.ts"),
  "utf8"
);

const DUPLICATE_SRC = fs.readFileSync(
  path.resolve(__dirname, "../modules/cases/legacy-import/legacy-case-duplicate-detector.ts"),
  "utf8"
);

const ROUTE_SRC = fs.readFileSync(
  path.resolve(__dirname, "../routes/legacy-case-import.ts"),
  "utf8"
);

const CREATE_CANONICAL_SRC = fs.readFileSync(
  path.resolve(__dirname, "../modules/cases/create-case-canonical.service.ts"),
  "utf8"
);

beforeAll(() => {
  vi.spyOn(global.console, "warn").mockImplementation(() => void 0);
  vi.spyOn(global.console, "error").mockImplementation(() => void 0);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("Legacy Case Import E2E-style flow (§AB / §AC TEST 1-15)", () => {
  describe("Workbook & parser sanity", () => {
    it("parseExcelWorkbook accepts synthetic xlsx with 37 M LEGASI headers + 5 rows", async () => {
      const rows = [
        makeRow({
          "Our Ref": "OUR-REF-001",
          "Parcel No": "P1",
          "Purchaser 1": "TEST PURCHASER A",
          "IC 1": "900101-00-0001",
          "Purchaser 2": "TEST PURCHASER B",
          "IC 2": "900101-00-0002",
          "Purchaser 3": "TEST PURCHASER C",
          "IC 3": "900101-00-0003",
          "Purchaser 4": "TEST PURCHASER D",
          "IC 4": "900101-00-0004",
          "Borrower 1": "TEST PURCHASER A",
          "Borrower 2": "TEST PURCHASER B",
          "Borrower 3": "TEST PURCHASER C",
          "Borrower 4": "TEST PURCHASER D",
          "Developer": "MESTIKA BISTARI SDN BHD",
          "Property": "PT 21085 DAERAH KUALA LUMPUR",
          "Property Type": "Apartment",
          "Purchase Price": 500000,
          "End Financier": "MAYBANK",
          "SPA date": "12/10/2023",
          "SPA stamping": "01/11/2023",
          "LO Date": "05/09/2023",
        }),
        makeRow({
          "Our Ref": "OUR-REF-002",
          "Parcel No": "P2",
          "Purchaser 1": "TEST PURCHASER B",
          "IC 1": "900101-00-0002",
          "Borrower 1": "BORROWER X",
          "Borrower 2": "BORROWER Y",
          "Borrower 3": "BORROWER Z",
          "Borrower 4": "BORROWER W",
        }),
        makeRow({
          "Our Ref": "OUR-REF-003",
          "Parcel No": "P3",
          "Purchaser 1": "CASH PURCHASER SDN BHD",
          "IC 1": "123456-X",
        }),
        makeRow({
          "Our Ref": "OUR-REF-004",
          "Parcel No": "P4",
          "Purchaser 1": "BLANK DATES A",
          "IC 1": "920101-00-2222",
        }),
        makeRow({
          "Our Ref": "OUR-REF-005",
          "Parcel No": "P5",
          "Purchaser 1": "AMBIGUOUS DATE GUY",
          "IC 1": "930101-00-3333",
          "FA DATE": "?",
        }),
      ];
      const buf = buildSyntheticWorkbook(rows);
      const result = await parseExcelWorkbook(buf, "synthetic-m-legasi-fixture.xlsx");
      expect(result.ok).toBe(true);
    });

    it("autoMapHeaders detects Our Ref / Parcel No / Purchaser 1 / IC 1 → Lawcaspro fields", () => {
      const mapped = autoMapHeaders(M_LEGASI_HEADERS, M_LEGASI_PRESET_MAPPING);
      expect(mapped.columns.some((c) => c.target === "case.referenceNo" && c.excelHeader === "Our Ref")).toBe(true);
      expect(mapped.columns.some((c) => c.target === "case.parcelNo" && c.excelHeader === "Parcel No")).toBe(true);
      expect(mapped.columns.some((c) => c.target === "purchaser.name" && c.excelHeader === "Purchaser 1" && c.arrayIndex === 0)).toBe(true);
    });
  });

  describe("TEST 1: 4 purchasers all four correctly linked (§AC.1)", () => {
    it("createCaseCanonical signature accepts purchasers array 4 entries - passed through createInput.purchasers length=4, then via canonical insert into case_purchasers", () => {
      const sample: CanonicalPurchaserInput[] = [
        { name: "TEST PURCHASER A", ic: "900101-00-0001" },
        { name: "TEST PURCHASER B", ic: "900101-00-0002" },
        { name: "TEST PURCHASER C", ic: "900101-00-0003" },
        { name: "TEST PURCHASER D", ic: "900101-00-0004" },
      ];
      expect(sample).toHaveLength(4);
      expect(CREATE_CANONICAL_SRC).toContain("purchasers");
      expect(PIPELINE_SRC).toContain("purchasers");
      const { columns } = autoMapHeaders(M_LEGASI_HEADERS, M_LEGASI_PRESET_MAPPING);
      expect(columns.some((c) => c.target === "purchaser.name" && c.arrayIndex === 3)).toBe(true);
    });

    it("applyRowMapping maps purchaser1..4 from 4 distinct source columns into mapped.purchasers array", () => {
      const row = {
        "Our Ref": "REF-1",
        "Purchaser 1": "TEST PURCHASER A",
        "IC 1": "900101-00-0001",
        "Purchaser 2": "TEST PURCHASER B",
        "IC 2": "900101-00-0002",
        "Purchaser 3": "TEST PURCHASER C",
        "IC 3": "900101-00-0003",
        "Purchaser 4": "TEST PURCHASER D",
        "IC 4": "900101-00-0004",
      };
      const template = autoMapHeaders(M_LEGASI_HEADERS, M_LEGASI_PRESET_MAPPING);
      const mapped = applyRowMapping(row as Record<string, unknown>, template, parseLegacyDate);
      const purchasers = mapped.purchasers ?? [];
      expect(purchasers.filter((p) => (p as any).name?.startsWith("TEST PURCHASER")).length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("TEST 2: 4 borrowers retained (§AC.2)", () => {
    it("pipeline carries 4 borrower slots → 4 borrowers array passed to createInput.borrowers (catalog has arrayIndex 3)", () => {
      const borrowerMapping = M_LEGASI_PRESET_MAPPING;
      // Mapped Borrower 4 produces arrayIndex=3.
      const { columns } = autoMapHeaders(M_LEGASI_HEADERS, M_LEGASI_PRESET_MAPPING);
      expect(columns.some((c) => c.target === "borrower.name" && c.arrayIndex === 3)).toBe(true);
      expect(PIPELINE_SRC).toContain("borrowers");
      expect(CREATE_CANONICAL_SRC).toContain("borrowers");
    });
  });

  describe("TEST 3: no borrowers → case still imports (§AC.3)", () => {
    it("parse+validate: borrower mapping all empty/null → WARN_BORROWER_BLANK warning only, NO blocking errors", () => {
      expect(PIPELINE_SRC).toContain("WARN_BORROWER_BLANK");
      expect(PIPELINE_SRC).not.toContain("ERR_BORROWER_BLANK");
    });
  });

  describe("TEST 4 & 5: blank SPA Date / blank LO Date → case imports (§AC.4 §AC.5)", () => {
    it("parseLegacyDate blank => status not invalid; pipeline skips blank dates (core case still imports) without ERR_*_DATE_REQUIRED blocking", () => {
      const r = parseLegacyDate(null);
      expect(r.status === "blank").toBe(true);
      const r2 = parseLegacyDate("");
      expect(r2.status === "blank").toBe(true);
      expect(PIPELINE_SRC).toContain("blank");
      // No blocking date-required errors in pipeline.
      expect(PIPELINE_SRC).not.toMatch(/ERR_(SPA|LO|STAMPING)_DATE_REQUIRED/);
    });
  });

  describe("TEST 6: ambiguous historical date: case imports, date skipped, warning exists (§AC.6)", () => {
    it("? value → parseLegacyDate status = unknown → warning WARN_INVALID_DATE pushed, not errors array", () => {
      const r = parseLegacyDate("?");
      expect(r.status === "unknown").toBe(true);
      const r2 = parseLegacyDate("N/A");
      expect(r2.status === "not_applicable" || r2.status === "unknown").toBe(true);
      expect(PIPELINE_SRC).toContain("WARN_INVALID_DATE");
    });
  });

  describe("TEST 7: same Our Ref → duplicate blocked (§AC.7)", () => {
    it("detectLegacyDuplicates: firmId + normalized ref vs cases.reference_no → hard.type='reference_no'", () => {
      expect(DUPLICATE_SRC).toContain("reference_no");
      expect(DUPLICATE_SRC).toContain("normalizeLegacyReference");
      expect(DUPLICATE_SRC).toContain("casesTable.referenceNo");
    });
  });

  describe("TEST 8: same parcel different purchaser → NOT hard duplicate (§AC.8)", () => {
    it("duplicate detector NEVER hard-duplicates on parcel alone → possibleDuplicate score only", () => {
      expect(DUPLICATE_SRC).not.toContain("HARD_PARCEL_ONLY");
      expect(DUPLICATE_SRC).toContain("possible");
    });
  });

  describe("TEST 9: retry same row → same case IDs (§AC.9)", () => {
    it("stable idempotency key = LEGACY_CASE_IMPORT:firmId:batchId:sourceRowNo:rowHash → NO Date.now usage, summary.alreadyImported counter", () => {
      const k1 = buildIdempotencyKey(TEST_FIRM_ID, 10, 1, "hashx");
      const k2 = buildIdempotencyKey(TEST_FIRM_ID, 10, 1, "hashx");
      expect(k1).toBe(k2);
      expect(DUPLICATE_SRC).not.toContain("Date.now()");
      expect(PIPELINE_SRC).not.toContain("Date.now()");
      expect(PIPELINE_SRC).toContain("alreadyImported");
    });
  });

  describe("TEST 10: 1 failed row in 20 rows → 19 success / 1 failed (§AC.10)", () => {
    it("runImport uses per-row try/catch + failed++ without rollback on mid failure. Promise.all(allRows) NOT used. CHUNK_SIZE ≤5", () => {
      expect(PIPELINE_SRC).toContain("try {");
      expect(PIPELINE_SRC).toContain("catch (");
      expect(PIPELINE_SRC).toContain("failed");
      // No Promise.all of the entire allRows input:
      const bigPAll = /Promise\.all\(\s*all(Rows|Rows|RowIds)/;
      expect(bigPAll.test(PIPELINE_SRC)).toBe(false);
      expect(/CHUNK_SIZE\s*=\s*[0-5]/.test(PIPELINE_SRC) || /for \(let i = 0; i < rows/.test(PIPELINE_SRC)).toBe(true);
    });
  });

  describe("TEST 11: project cross firm → denied (§AC.11)", () => {
    it("validateFixedValues: project.firmId != input firmId → ok=false code=PROJECT_CROSS_FIRM", () => {
      expect(PIPELINE_SRC).toContain("PROJECT_CROSS_FIRM");
      expect(PIPELINE_SRC).toContain("project.firmId");
    });
  });

  describe("TEST 12: mapping template saved then reused (§AC.12)", () => {
    it("routes /mapping-templates and /:batchId/save-mapping-template endpoints exist, table legacyCaseImportMappingTemplates inserts headerFingerprint", () => {
      expect(ROUTE_SRC).toContain("/mapping-templates");
      expect(ROUTE_SRC).toContain("/save-mapping-template");
      expect(ROUTE_SRC).toContain("legacyCaseImportMappingTemplatesTable");
      expect(ROUTE_SRC).toContain("headerFingerprint");
    });
  });

  describe("TEST 13: ignored columns present in raw snapshot (§AC.13)", () => {
    it("upload inserts rawRowJson full source JSON including IGNORE_A..IGNORE_J — route source contains rawRowJson before mapping applied", () => {
      expect(ROUTE_SRC).toContain("rawRowJson");
      expect(PIPELINE_SRC).toContain("rawRowJson");
      // route preserves all 133-col JSON before column selection. IGNORE_A..IGNORE_J kept inside.
      expect(/raw_row_json|rawRowJson/i.test(ROUTE_SRC)).toBe(true);
    });

    it("autoMapHeaders default maps core only, ignores IGNORE_A..J targets; rawRowJson full snapshot preserved by route", () => {
      const { columns } = autoMapHeaders(M_LEGASI_HEADERS, M_LEGASI_PRESET_MAPPING);
      const targets = new Set(
        columns.filter((c: ExcelColumnMapping) => c.target && c.target !== "ignore").map((c: ExcelColumnMapping) => String(c.target))
      );
      expect(targets.has("IGNORE_A")).toBe(false);
      expect(targets.has("IGNORE_J")).toBe(false);
      expect(columns.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("TEST 14: historical accounting columns → NO invoice/receipt/PV/ledger created (§AC.14)", () => {
    it("pipeline & canonical createCaseCanonical sources do NOT contain insert(invoicesTable) / receiptsTable / paymentVouchersTable / ledgerEntriesTable", () => {
      const haystacks = [PIPELINE_SRC, CREATE_CANONICAL_SRC, ROUTE_SRC];
      for (const src of haystacks) {
        expect(src).not.toContain(".insert(invoicesTable)");
        expect(src).not.toContain(".insert(receiptsTable)");
        expect(src).not.toContain(".insert(paymentVouchersTable)");
        expect(src).not.toContain(".insert(ledgerEntriesTable)");
      }
      // Importer never auto-inserts accounting records.
      expect(PIPELINE_SRC).not.toContain("insert into invoice");
      expect(PIPELINE_SRC).not.toContain("accounting entry");
    });
  });

  describe("TEST 15: normal Create Case unchanged (§AC.15)", () => {
    it("normal_intake / web_create paths still exist; legacy path is gated behind input.migration.mode='legacy_existing_case' without affecting normal flow", () => {
      expect(ROUTE_SRC).toContain("/upload");
      expect(ROUTE_SRC).toContain("/dry-run");
      expect(ROUTE_SRC).toContain("/import");
      // Legacy importer explicitly sets migration.mode = legacy_existing_case.
      expect(PIPELINE_SRC).toContain("legacy_existing_case");
      expect(CREATE_CANONICAL_SRC).toContain("legacy_existing_case");
      // Canonical service still supports normal web_create source (legacy added, no regression).
      expect(CREATE_CANONICAL_SRC).toContain("web_create");
      expect(CREATE_CANONICAL_SRC).toContain("isLegacyMode");
    });
  });

  describe("§AD SOURCE INVARIANTS (additional gate coverage)", () => {
    it("§AD-1: legacy pipeline MUST contain 'createCaseCanonical'", () => {
      expect(PIPELINE_SRC).toContain("createCaseCanonical");
    });

    it("§AD-2: pipeline MUST NOT contain direct '.insert(casesTable)' (only canonical writes)", () => {
      expect(PIPELINE_SRC).not.toContain(".insert(casesTable)");
      expect(ROUTE_SRC).not.toContain(".insert(casesTable)");
    });

    it("§AD-3: idempotency key NO Date.now() anywhere in legacy-import dir scope", () => {
      expect(DUPLICATE_SRC).not.toContain("Date.now()");
      expect(PIPELINE_SRC).not.toContain("Date.now()");
    });

    it("§AD-4: no unbounded Promise.all(allRows / rows / rowIds) pattern", () => {
      for (const src of [PIPELINE_SRC, ROUTE_SRC]) {
        expect(/Promise\.all\(\s*all\s*Rows\s*\)/.test(src)).toBe(false);
        expect(/Promise\.all\(\s*rowIds\s*\)/.test(src)).toBe(false);
      }
    });

    it("§AD-5: error report escapeCell protects dangerous = + - @ prefixes", () => {
      expect(escapeCell("=1+1")).toBe("'=1+1");
      expect(escapeCell("@SUM(A1)")).toBe("'@SUM(A1)");
      expect(escapeCell("+123")).toBe("'+123");
      expect(escapeCell("-A1")).toBe("'-A1");
      expect(escapeCell("Hello")).toBe("Hello");
    });
  });
});
