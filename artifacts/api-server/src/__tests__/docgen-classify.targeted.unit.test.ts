import { describe, expect, it } from "vitest";
import {
  classifyDocGenError,
  DOC_GEN_HUMAN_MESSAGE,
} from "../routes/documents";

describe("Document Automation §10: classifyDocGenError targeted tests", () => {
  it("Test A1: classifies TEMPLATE_FILE_MISSING from direct rawCode", () => {
    expect(classifyDocGenError("TEMPLATE_FILE_MISSING", "templateLoad", "")).toBe("TEMPLATE_FILE_MISSING");
    expect(classifyDocGenError("TEMPLATE_NOT_FOUND", "x", "")).toBe("TEMPLATE_FILE_MISSING");
  });

  it("Test A2: classifies VARIABLE_RESOLUTION_FAILED from variable/tag keyword", () => {
    expect(classifyDocGenError("ERR_VAR", "x", "variable resolution failed")).toBe("VARIABLE_RESOLUTION_FAILED");
    expect(classifyDocGenError("", "variableStage", "tag syntax error")).toBe("VARIABLE_RESOLUTION_FAILED");
  });

  it("Test A3: classifies PDF_GENERATION_FAILED from phase/message", () => {
    expect(classifyDocGenError("PDF_GENERATION_FAILED", "render", "")).toBe("PDF_GENERATION_FAILED");
    expect(classifyDocGenError("", "", "chrome pdf failed")).toBe("PDF_GENERATION_FAILED");
  });

  it("Test A4: classifies DOCX_GENERATION_FAILED via phase docx", () => {
    expect(classifyDocGenError("", "docxRender", "")).toBe("DOCX_GENERATION_FAILED");
    expect(classifyDocGenError("DOCX_GENERATION_FAILED", "", "")).toBe("DOCX_GENERATION_FAILED");
  });

  it("Test A5: classifies OUTPUT_MISSING via code and object message", () => {
    expect(classifyDocGenError("OUTPUT_MISSING", "", "")).toBe("OUTPUT_MISSING");
    expect(classifyDocGenError("", "", "no output generated object")).toBe("OUTPUT_MISSING");
  });

  it("Test A6: classifies STORAGE_WRITE_FAILED s3 upload bucket", () => {
    expect(classifyDocGenError("", "upload", "s3 put failed bucket missing")).toBe("STORAGE_WRITE_FAILED");
  });

  it("Test A7: classifies ZIP_BUILD_FAILED via code and zip phase", () => {
    expect(classifyDocGenError("", "zipArchive", "")).toBe("ZIP_BUILD_FAILED");
    expect(classifyDocGenError("ZIP_BUILD_FAILED", "", "")).toBe("ZIP_BUILD_FAILED");
  });

  it("Test A8: classifies TIMEOUT via 504 timed out", () => {
    expect(classifyDocGenError("", "", "ETIMEDOUT 504")).toBe("TIMEOUT");
  });

  it("Test A9: UNKNOWN default (no stack trace ever exposed)", () => {
    expect(classifyDocGenError("SOMETHING_ELSE", "unknownPhase", "cryptic error")).toBe("UNKNOWN");
  });

  it("Test A10: DOC_GEN_HUMAN_MESSAGE covers all 9 codes + no stack/newline/at-space", () => {
    const allCodes = [
      "TEMPLATE_FILE_MISSING",
      "VARIABLE_RESOLUTION_FAILED",
      "PDF_GENERATION_FAILED",
      "DOCX_GENERATION_FAILED",
      "OUTPUT_MISSING",
      "STORAGE_WRITE_FAILED",
      "ZIP_BUILD_FAILED",
      "TIMEOUT",
      "UNKNOWN",
    ] as const;
    for (const c of allCodes) {
      const msg = DOC_GEN_HUMAN_MESSAGE[c];
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
      expect(msg.toLowerCase().includes("trace")).toBe(false);
      expect(msg.includes("\n")).toBe(false);
      expect(msg.includes(" at ")).toBe(false);
    }
  });

  it("Test A11: UNKNOWN user message — human friendly, no stack/at-space", () => {
    expect(DOC_GEN_HUMAN_MESSAGE.UNKNOWN).not.toContain(" at ");
    expect(DOC_GEN_HUMAN_MESSAGE.UNKNOWN).not.toContain("Error:");
    expect(DOC_GEN_HUMAN_MESSAGE.UNKNOWN).toMatch(/failed/i);
  });
});
