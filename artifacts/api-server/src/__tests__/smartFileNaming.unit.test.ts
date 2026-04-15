import { describe, it, expect } from "vitest";
import { resolveSmartFilename, sanitizeFileStem, truncateFileNamePreserveExt, extractExtension } from "../lib/smartFileNaming";

describe("smartFileNaming", () => {
  it("resolves tokens with fallback behavior", () => {
    const r = resolveSmartFilename({
      ctx: {
        caseId: 123,
        firmId: 1,
        caseReferenceNo: "LCP-0001",
        documentName: "SPA",
        sequence: 2,
        now: new Date("2026-04-15T00:00:00Z"),
      },
      rule: "{case_reference}_{document_name}_{date_ymd}_{sequence}_{missing}",
      originalFileNameOrExt: "file.DOCX",
      fallbackExt: "docx",
    });
    expect(r.fileName).toMatch(/^LCP-0001_SPA_20260415_002\.docx$/);
    expect(r.resolvedTokens).toContain("case_reference");
    expect(r.fallbackTokens).toContain("template_name");
  });

  it("sanitizes illegal characters and collapses whitespace", () => {
    expect(sanitizeFileStem(' A  B  <C>: "D" / E \\ F | G ? * ')).toBe("A_B_C_D_E_F_G");
  });

  it("preserves extension and truncates safely", () => {
    const out = truncateFileNamePreserveExt("a".repeat(300) + ".pdf", 120);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out.length).toBe(120);
  });

  it("extracts extension from filename or ext string", () => {
    expect(extractExtension("test.DOCX", "pdf")).toBe("docx");
    expect(extractExtension(".PDF", "docx")).toBe("pdf");
    expect(extractExtension("noext", "docx")).toBe("docx");
  });
});

