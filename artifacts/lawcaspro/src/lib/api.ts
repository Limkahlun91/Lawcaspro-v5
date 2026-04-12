export function getApiBaseUrl(): string {
  return import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";
}
