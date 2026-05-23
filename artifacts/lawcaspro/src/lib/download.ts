import { API_BASE } from "@/lib/api-base";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

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

export async function downloadFromApi(path: string, filename: string) {
  try {
    const res = await fetchWithTimeout(`${API_BASE}${path}`, { credentials: "include", timeoutMs: 60_000 });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    downloadBlob(blob, filename);
  } catch (err) {
    console.error("DOWNLOAD ERR:", err);
    throw err;
  }
}
