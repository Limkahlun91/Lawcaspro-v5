export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const DEFAULT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const DOCX_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroEnabled.12",
] as const;

export function validateUploadFile(
  file: File,
  opts?: { maxBytes?: number; allowedMimeTypes?: readonly string[] },
): { ok: true } | { ok: false; message: string } {
  const maxBytes = opts?.maxBytes ?? MAX_UPLOAD_BYTES;
  const allowed = opts?.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES;
  if (!file) return { ok: false, message: "No file selected" };
  if (typeof file.size === "number" && file.size > maxBytes) {
    return { ok: false, message: "File size must be under 10MB" };
  }
  const mime = typeof file.type === "string" ? file.type : "";
  const allowSet = new Set(allowed);
  const fileNameLower = typeof file.name === "string" ? file.name.toLowerCase() : "";
  const allowedByExt = (() => {
    const extAllowed: string[] = [];
    if (allowSet.has("application/vnd.openxmlformats-officedocument.wordprocessingml.document")) extAllowed.push(".docx");
    if (allowSet.has("application/vnd.ms-word.document.macroEnabled.12")) extAllowed.push(".docm");
    if (allowSet.has("application/pdf")) extAllowed.push(".pdf");
    if (allowSet.has("image/jpeg")) extAllowed.push(".jpg", ".jpeg");
    if (allowSet.has("image/png")) extAllowed.push(".png");
    if (allowSet.has("image/webp")) extAllowed.push(".webp");
    if (extAllowed.length === 0) return false;
    return extAllowed.some((ext) => fileNameLower.endsWith(ext));
  })();

  if ((!mime || !allowSet.has(mime)) && !allowedByExt) {
    if (
      allowSet.size === DEFAULT_ALLOWED_MIME_TYPES.length &&
      DEFAULT_ALLOWED_MIME_TYPES.every((t) => allowSet.has(t))
    ) {
      return { ok: false, message: "Only PDF, JPG, PNG, or WebP files are allowed" };
    }
    if (
      allowSet.has("application/vnd.openxmlformats-officedocument.wordprocessingml.document") &&
      allowSet.has("application/pdf") &&
      allowSet.has("image/jpeg") &&
      allowSet.has("image/png") &&
      allowSet.has("image/webp")
    ) {
      return { ok: false, message: "Only PDF, DOCX, JPG, PNG, or WebP files are allowed" };
    }
    if (allowSet.size === 1 && allowSet.has(DOCX_MIME_TYPES[0])) {
      return { ok: false, message: "Only DOCX files are allowed" };
    }
    return { ok: false, message: "Unsupported file type" };
  }
  return { ok: true };
}
