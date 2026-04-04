function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export function getApiOrigin(): string | null {
  const raw = import.meta.env.VITE_API_BASE_URL;
  if (typeof raw !== "string") return null;
  const trimmed = normalizeOrigin(raw.trim());
  return trimmed === "" ? null : trimmed;
}

export function apiUrl(path: string): string {
  const origin = getApiOrigin();
  if (!origin) return path;
  if (!path.startsWith("/")) return `${origin}/${path}`;
  return `${origin}${path}`;
}

