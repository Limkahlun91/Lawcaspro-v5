import { describe, expect, it } from "vitest";
import { validateStorageUploadFile } from "../lib/storageUploadValidation";

describe("validateStorageUploadFile", () => {
  it("allows docx for templates objectPath when mime matches", () => {
    const r = validateStorageUploadFile({
      objectPath: "/objects/templates/firms/1/document-templates/x.docx",
      originalName: "x.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects legacy .doc for templates with clear message", () => {
    const r = validateStorageUploadFile({
      objectPath: "/objects/templates/firms/1/document-templates/x.doc",
      originalName: "x.doc",
      mimetype: "application/msword",
    });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.message).toBe("Only PDF and DOCX templates are supported.");
    }
  });

  it("rejects docx with invalid mime even if extension is .docx", () => {
    const r = validateStorageUploadFile({
      objectPath: "/objects/templates/firms/1/document-templates/x.docx",
      originalName: "x.docx",
      mimetype: "application/x-msdownload",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects exe always", () => {
    const r = validateStorageUploadFile({
      objectPath: "/objects/templates/firms/1/document-templates/x.exe",
      originalName: "x.exe",
      mimetype: "application/x-msdownload",
    });
    expect(r.ok).toBe(false);
  });

  it("allows pdf for non-template uploads", () => {
    const r = validateStorageUploadFile({
      objectPath: "/objects/cases/1/uploads/x.pdf",
      originalName: "x.pdf",
      mimetype: "application/pdf",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects docx for non-template uploads", () => {
    const r = validateStorageUploadFile({
      objectPath: "/objects/cases/1/uploads/x.docx",
      originalName: "x.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(r.ok).toBe(false);
  });
});
