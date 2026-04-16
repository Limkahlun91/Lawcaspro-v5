import { describe, it, expect } from "vitest";
import { guessDocumentTypeFromText, mapExtractedTextToSuggestions } from "../lib/documentExtraction";

describe("documentExtraction", () => {
  it("guesses IC/NRIC document type", () => {
    expect(guessDocumentTypeFromText("No. K/P 900101-14-5678")).toBe("ic_nric");
  });

  it("extracts NRIC + name suggestions", () => {
    const raw = {
      extractedRawText: "Nama: JOHN DOE\nNo. K/P: 900101-14-5678\nAlamat:\n1 JALAN QA\nKUALA LUMPUR",
      extractionMethod: "text" as const,
      pageCount: 1,
      warnings: [],
      perPageText: ["Nama: JOHN DOE\nNo. K/P: 900101-14-5678\nAlamat:\n1 JALAN QA\nKUALA LUMPUR"],
    };
    const s = mapExtractedTextToSuggestions({ raw, documentTypeGuess: "unknown" });
    expect(s.some((x) => x.fieldKey === "ic_passport_no")).toBe(true);
    expect(s.some((x) => x.fieldKey === "full_name")).toBe(true);
  });

  it("extracts loan offer amount + bank", () => {
    const raw = {
      extractedRawText: "LETTER OF OFFER\nMAYBANK\nFinancing Sum: RM 300,000.00\nRef: ABC/123",
      extractionMethod: "text" as const,
      pageCount: 1,
      warnings: [],
      perPageText: ["LETTER OF OFFER\nMAYBANK\nFinancing Sum: RM 300,000.00\nRef: ABC/123"],
    };
    const s = mapExtractedTextToSuggestions({ raw, documentTypeGuess: "unknown" });
    expect(s.some((x) => x.fieldKey === "bank_name")).toBe(true);
    expect(s.some((x) => x.fieldKey === "financing_amount")).toBe(true);
  });
});

