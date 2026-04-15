import { describe, it, expect, vi } from "vitest";
import { ensureUniqueCaseDocumentFileName, resolveDocumentFileName } from "../lib/documentFileName";

describe("documentFileName", () => {
  it("resolves naming with {{}} syntax and warning for missing variables", () => {
    const out = resolveDocumentFileName({
      ctx: {
        caseId: 101,
        firmId: 1,
        caseReferenceNo: "LCP/2026/001",
        documentName: "SPA Letter",
      },
      rule: "{{our_ref}} - {{primary_client_name}} - {{document_title}}",
      fallbackExt: "docx",
      originalFileNameOrExt: "docx",
    });
    expect(out.fileName.endsWith(".docx")).toBe(true);
    expect(out.fileName.includes("LCP")).toBe(true);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.fallbackUsed).toBe(false);
  });

  it("falls back to safe default when rule renders empty", () => {
    const out = resolveDocumentFileName({
      ctx: { caseId: 1, firmId: 1, caseReferenceNo: "", documentName: "" },
      rule: "{{primary_client_name}}",
      fallbackExt: "pdf",
      originalFileNameOrExt: "pdf",
    });
    expect(out.fileName.endsWith(".pdf")).toBe(true);
    expect(out.fallbackUsed).toBe(true);
  });

  it("resolves collision with predictable suffix", async () => {
    const execute = vi
      .fn()
      // first exact desired exists
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      // (2) does not exist
      .mockResolvedValueOnce({ rows: [] });
    const out = await ensureUniqueCaseDocumentFileName({
      r: { execute } as any,
      firmId: 1,
      caseId: 2,
      desiredFileName: "LCP-001-SPA.docx",
    });
    expect(out.fileName).toBe("LCP-001-SPA (2).docx");
    expect(out.collisionResolved).toBe(true);
    expect(out.collisionSuffixApplied).toBe(2);
  });
});

