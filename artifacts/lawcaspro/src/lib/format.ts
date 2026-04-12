export function formatCurrencyMYR(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR" }).format(safe);
}

export function formatDateMY(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-MY");
}

