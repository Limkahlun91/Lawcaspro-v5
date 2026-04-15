import { describe, it, expect } from "vitest";
import PizZip from "pizzip";
import { applyClauseInsertionToDocx, decideClauseInsertion } from "../lib/documentClauses";

function makeDocx(documentXml: string): Buffer {
  const zip = new PizZip();
  zip.file("word/document.xml", documentXml);
  return zip.generate({ type: "nodebuffer" }) as Buffer;
}

describe("documentClauses", () => {
  it("decides insertion target based on mode and placeholder detection", () => {
    expect(decideClauseInsertion({
      mode: "explicit_placeholder_only",
      hasClausesPlaceholder: false,
      foundClauseCodes: [],
      selectedClauseCodes: ["ABC"],
    }).insertionTarget).toBe("none");

    expect(decideClauseInsertion({
      mode: "prefer_placeholder_else_append",
      hasClausesPlaceholder: true,
      foundClauseCodes: [],
      selectedClauseCodes: ["ABC"],
    }).insertionTarget).toBe("using {{clauses}}");

    expect(decideClauseInsertion({
      mode: "append_to_end",
      hasClausesPlaceholder: true,
      foundClauseCodes: ["ABC"],
      selectedClauseCodes: ["ABC"],
    }).insertionTarget).toBe("appended to end");
  });

  it("appends {{clauses}} when mode prefers append and template has no placeholder", () => {
    const bytes = makeDocx(`<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`);
    const out = applyClauseInsertionToDocx({
      docxBytes: bytes,
      data: {},
      clausesText: "C1",
      perClauseValues: { clause_ABC: "X" },
      insertionMode: "prefer_placeholder_else_append",
      selectedClauseCodes: ["ABC"],
    });
    const z2 = new PizZip(out.docxBytes);
    const xml2 = z2.file("word/document.xml")?.asText() ?? "";
    expect(xml2.includes("{{clauses}}")).toBe(true);
    expect(out.data.clauses).toBe("C1");
    expect((out.data as any).clause_ABC).toBe("");
  });

  it("uses {{clauses}} when template has it (explicit mode)", () => {
    const bytes = makeDocx(`<w:document><w:body><w:p><w:r><w:t>{{clauses}}</w:t></w:r></w:p></w:body></w:document>`);
    const out = applyClauseInsertionToDocx({
      docxBytes: bytes,
      data: {},
      clausesText: "C1",
      perClauseValues: { clause_ABC: "X" },
      insertionMode: "explicit_placeholder_only",
      selectedClauseCodes: ["ABC"],
    });
    const z2 = new PizZip(out.docxBytes);
    const xml2 = z2.file("word/document.xml")?.asText() ?? "";
    expect(xml2.includes("{{clauses}}")).toBe(true);
    expect(out.data.clauses).toBe("C1");
    expect((out.data as any).clause_ABC).toBe("");
  });
});

