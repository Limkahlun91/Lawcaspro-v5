export const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export const queryOne = (query: unknown, key: string): string | undefined => {
  if (!query || typeof query !== "object") return undefined;
  const v = (query as Record<string, unknown>)[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
};

