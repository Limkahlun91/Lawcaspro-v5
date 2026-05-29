import { apiRequest } from "@/lib/api-client";

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function extensionFromContentType(contentType: string | null): string | null {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/pdf")) return "pdf";
  if (ct.includes("application/zip")) return "zip";
  return null;
}

function looksLikeErrorContentType(contentType: string | null): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return ct.includes("application/json") || ct.includes("application/problem+json") || ct.includes("text/plain") || ct.includes("text/html");
}

export function normalizeDownloadFilename(filename: string, contentType: string | null): string {
  const ext = extensionFromContentType(contentType);
  if (!ext) return filename;
  const hasExt = /\.[a-z0-9]{1,6}$/i.test(filename);
  if (!hasExt) return `${filename}.${ext}`;
  return filename.replace(/\.[a-z0-9]{1,6}$/i, `.${ext}`);
}

export async function downloadFromApi(path: string, filename: string) {
  try {
    const res = await apiRequest(path, { timeoutMs: 60_000, allowStatuses: [400, 401, 403, 404, 409, 422, 429, 500, 503] });
    const contentType = res.headers.get("Content-Type");
    if (!res.ok || looksLikeErrorContentType(contentType)) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    downloadBlob(blob, normalizeDownloadFilename(filename || "download", contentType));
  } catch (err) {
    console.error("DOWNLOAD ERR:", err);
    throw err;
  }
}
