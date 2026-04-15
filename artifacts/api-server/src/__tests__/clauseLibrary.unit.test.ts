import { describe, it, expect } from "vitest";
import PizZip from "pizzip";
import { normalizeClauseCode, scanPlaceholdersInText, renderClauseBodyWithResolvedVariables } from "../lib/clauseLibrary";
import { ensureDocxHasPlaceholderAtEnd } from "../lib/docxPlaceholder";

describe("clauseLibrary", () => {
  it("normalizes clause code", () => {
    expect(normalizeClauseCode("spa special-condition 01")).toBe("SPA_SPECIAL_CONDITION_01");
  });

  it("scans docx-style placeholders", () => {
    expect(scanPlaceholdersInText("Hello {{ purchaser_name }} and {{project_name}}")).toEqual(["purchaser_name", "project_name"]);
  });

  it("renders clause body with resolved variables and tracks missing", () => {
    const out = renderClauseBodyWithResolvedVariables({
      body: "A={{a}} B={{b}}",
      resolvedVariables: { a: "1" },
    });
    expect(out.rendered).toBe("A=1 B=");
    expect(out.used).toEqual(["a", "b"]);
    expect(out.missing).toEqual(["b"]);
  });

  it("injects {{clauses}} placeholder into docx when missing", () => {
    const zip = new PizZip();
    zip.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`);
    const bytes = zip.generate({ type: "nodebuffer" }) as Buffer;
    const next = ensureDocxHasPlaceholderAtEnd(bytes, "clauses");
    const z2 = new PizZip(next);
    const xml2 = z2.file("word/document.xml")?.asText() ?? "";
    expect(xml2.includes("{{clauses}}")).toBe(true);
  });
});

