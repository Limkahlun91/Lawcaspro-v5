import { describe, it, expect } from "vitest";
import {
  normalizeHeader,
  computeHeaderFingerprint,
  detectExcelFormat,
  parseExcelWorkbook,
  LEGACY_IMPORT_LIMITS,
  type LegacyExcelSecurityError,
} from "../modules/cases/legacy-import/excel-parser.js";
import { parseLegacyDate } from "../modules/cases/legacy-import/legacy-date-parser.js";

describe("legacy excel parser unit tests", () => {
  describe("normalizeHeader", () => {
    it("normalizeHeader trims and lowercases", () => {
      expect(normalizeHeader({})).toBe("");
      expect(normalizeHeader("  Hello   World  ")).toBe("hello world");
      expect(normalizeHeader(null)).toBe("");
    });
  });

  describe("computeHeaderFingerprint", () => {
    it("computeHeaderFingerprint is deterministic SHA-256", () => {
      const headersA = ["Purchaser 1", "Purchaser 1 IC", "SPA Date"];
      const headersB = ["Purchaser 1", "Purchaser 1 IC", "SPA Date"];
      const headersC = ["Purchaser 1", "Borrower 1", "SPA Date"];

      const fpA = computeHeaderFingerprint(headersA);
      const fpB = computeHeaderFingerprint(headersB);
      const fpC = computeHeaderFingerprint(headersC);

      expect(typeof fpA).toBe("string");
      expect(fpA).toHaveLength(64);
      expect(fpA).toBe(fpB);
      expect(fpA).not.toBe(fpC);
    });
  });

  describe("detectExcelFormat", () => {
    it("detectExcelFormat supports xlsx, xlsm, xls, csv", () => {
      expect(detectExcelFormat("file.XLSX")).toBe("xlsx");
      expect(detectExcelFormat("file.xlsx")).toBe("xlsx");
      expect(detectExcelFormat("file.XlSm")).toBe("xlsm");
      expect(detectExcelFormat("file.xlsm")).toBe("xlsm");
      expect(detectExcelFormat("FILE.XLS")).toBe("xls");
      expect(detectExcelFormat("file.xls")).toBe("xls");
      expect(detectExcelFormat("data.CSV")).toBe("csv");
      expect(detectExcelFormat("data.csv")).toBe("csv");
      expect(detectExcelFormat("file.pdf")).toBeNull();
      expect(detectExcelFormat("noextension")).toBeNull();
    });
  });

  describe("parseExcelWorkbook", () => {
    it("parseExcelWorkbook rejects oversized buffer (>25MB)", async () => {
      const bigBuffer = Buffer.alloc(26 * 1024 * 1024);
      const result = await parseExcelWorkbook(bigBuffer, "test.xlsx");
      expect(result.ok).toBe(false);
      const err = result as unknown as { ok: false; error: { code: "LEGACY_IMPORT_FILE_TOO_LARGE"; detail: { maxBytes: number; actualBytes: number } } };
      expect(err.error.code).toBe("LEGACY_IMPORT_FILE_TOO_LARGE");
      expect(err.error.detail.maxBytes).toBe(LEGACY_IMPORT_LIMITS.MAX_FILE_BYTES);
      expect(err.error.detail.actualBytes).toBe(26 * 1024 * 1024);
    });
  });

  describe("parseLegacyDate", () => {
    it("date parser: blank/undefined/null returns blank status with null date", () => {
      const r1 = parseLegacyDate(undefined);
      expect(r1.status).toBe("blank");
      expect(r1.normalizedDate).toBeNull();
      expect(r1.warnings).toEqual([]);

      const r2 = parseLegacyDate(null);
      expect(r2.status).toBe("blank");
      expect(r2.normalizedDate).toBeNull();
      expect(r2.warnings).toEqual([]);

      const r3 = parseLegacyDate("");
      expect(r3.status).toBe("blank");
      expect(r3.normalizedDate).toBeNull();
      expect(r3.warnings).toEqual([]);

      const r4 = parseLegacyDate("   ");
      expect(r4.status).toBe("blank");
      expect(r4.normalizedDate).toBeNull();
      expect(r4.warnings).toEqual([]);
    });

    it("date parser: N/A, NA, -, n/a returns not_applicable", () => {
      for (const v of ["N/A", "NA", "-", "n/a", "N/a", "na"]) {
        const r = parseLegacyDate(v);
        expect(r.status).toBe("not_applicable");
        expect(r.normalizedDate).toBeNull();
        expect(r.warnings).toEqual([]);
      }
    });

    it("date parser: ? returns unknown status", () => {
      const r = parseLegacyDate("?");
      expect(r.status).toBe("unknown");
      expect(r.normalizedDate).toBeNull();
      expect(r.warnings).toEqual([]);
    });

    it("date parser: valid DD.MM.YYYY returns valid YYYY-MM-DD", () => {
      const r = parseLegacyDate("01.07.2025");
      expect(r.status).toBe("valid");
      expect(r.normalizedDate).toBe("2025-07-01");
      expect(r.warnings).toEqual([]);
    });

    it("date parser: valid DD/MM/YYYY returns valid YYYY-MM-DD", () => {
      const r = parseLegacyDate("01/07/2025");
      expect(r.status).toBe("valid");
      expect(r.normalizedDate).toBe("2025-07-01");
      expect(r.warnings).toEqual([]);
    });

    it("date parser: valid YYYY-MM-DD passes through", () => {
      const r = parseLegacyDate("2025-07-01");
      expect(r.status).toBe("valid");
      expect(r.normalizedDate).toBe("2025-07-01");
      expect(r.warnings).toEqual([]);
    });

    it("date parser: ambiguous string with 2 dates MULTIPLE_DATES_DETECTED warning", () => {
      const r = parseLegacyDate("01.07.2025 / 18.07.2025");
      expect(r.status).toBe("ambiguous");
      expect(r.normalizedDate).toBeNull();
      expect(r.warnings).toContain("MULTIPLE_DATES_DETECTED");
    });

    it("date parser: embedded date Signed - 18.07.2025 ambiguous detection", () => {
      const r = parseLegacyDate("Signed - 18.07.2025");
      expect(r.status).toBe("ambiguous");
      expect(r.normalizedDate).toBeNull();
      expect(r.warnings).toContain("MULTIPLE_DATES_DETECTED");
    });

    it("date parser: Excel serial number", () => {
      const serial = 45864;
      const r = parseLegacyDate(serial);
      expect(r.status).toBe("valid");
      expect(r.normalizedDate).toBe("2025-07-25");
      expect(r.warnings).toEqual([]);
    });

    it("date parser: unparseable garbage returns invalid + INVALID_DATE_FORMAT warning", () => {
      const r = parseLegacyDate("abcdefg-not-a-date");
      expect(r.status).toBe("invalid");
      expect(r.normalizedDate).toBeNull();
      expect(r.warnings).toContain("INVALID_DATE_FORMAT");
    });
  });
});
