function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function normalizeMissingRequiredVariables(payload: unknown): string[] {
  const p = asRecord(payload) ?? {};
  const raw = p.missingRequiredVariables;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === "string" ? x : null))
    .filter((x): x is string => Boolean(x))
    .map((x) => x.trim())
    .filter(Boolean);
}
