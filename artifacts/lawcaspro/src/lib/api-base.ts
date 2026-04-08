function basePathWithoutLawcaspro(): string {
  return import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "");
}

export const API_BASE = `${basePathWithoutLawcaspro()}/api`;

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${basePathWithoutLawcaspro()}${p}`;
}

export function getApiOrigin(): string | null {
  if (typeof window === "undefined") return null;
  return `${window.location.origin}${basePathWithoutLawcaspro()}`;
}
