import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_MIME_TYPES, DOCX_MIME_TYPES, validateUploadFile } from "@/lib/upload-validation";

describe("validateUploadFile", () => {
  it("default allowed types returns correct message", () => {
    const file = new File(["x"], "x.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const r = validateUploadFile(file, { allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe("Only PDF, JPG, PNG, or WebP files are allowed");
    }
  });

  it("combined PDF+DOCX allowed types returns correct message", () => {
    const file = new File(["x"], "x.exe", { type: "application/x-msdownload" });
    const r = validateUploadFile(file, { allowedMimeTypes: [...DEFAULT_ALLOWED_MIME_TYPES, ...DOCX_MIME_TYPES] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe("Only PDF, DOCX, JPG, PNG, or WebP files are allowed");
    }
  });
});

