export type StorageUploadValidationResult =
  | { ok: true }
  | { ok: false; code: "UNSUPPORTED_MEDIA_TYPE"; message: string };

function fileExtensionFromName(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  if (i < 0) return "";
  return fileName
    .slice(i + 1)
    .trim()
    .toLowerCase();
}

function isTemplatesObjectPath(objectPath: unknown): boolean {
  return typeof objectPath === "string" && objectPath.startsWith("/objects/templates/");
}

export function validateStorageUploadFile(input: {
  objectPath?: unknown;
  originalName?: unknown;
  mimetype?: unknown;
}): StorageUploadValidationResult {
  const originalName = typeof input.originalName === "string" ? input.originalName : "";
  const mimetype = typeof input.mimetype === "string" ? input.mimetype : "";
  const ext = fileExtensionFromName(originalName);
  const allowTemplateTypes = isTemplatesObjectPath(input.objectPath);

  const defaultAllowedMime = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  const templateAllowedMime = new Set([
    ...defaultAllowedMime,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-word.document.macroEnabled.12",
  ]);

  if (!allowTemplateTypes) {
    const extOk =
      ext === "pdf" ||
      ext === "jpg" ||
      ext === "jpeg" ||
      ext === "png" ||
      ext === "webp";
    const mimeOk = defaultAllowedMime.has(mimetype);
    if (!mimeOk && !extOk) {
      return {
        ok: false,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Only PDF, JPG, PNG, or WebP files are allowed",
      };
    }
    return { ok: true };
  }

  if (ext === "doc" || mimetype === "application/msword") {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Only PDF and DOCX templates are supported.",
    };
  }

  const extOk =
    ext === "docx" ||
    ext === "docm" ||
    ext === "pdf" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "png" ||
    ext === "webp";

  if (ext === "docx") {
    if (mimetype !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      return {
        ok: false,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Only PDF, DOCX, JPG, PNG, or WebP files are allowed",
      };
    }
    return { ok: true };
  }

  if (ext === "docm") {
    if (mimetype !== "application/vnd.ms-word.document.macroEnabled.12") {
      return {
        ok: false,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Only PDF, DOCX, JPG, PNG, or WebP files are allowed",
      };
    }
    return { ok: true };
  }

  const mimeOk = templateAllowedMime.has(mimetype);
  if (!mimeOk && !extOk) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Only PDF, DOCX, JPG, PNG, or WebP files are allowed",
    };
  }

  return { ok: true };
}

