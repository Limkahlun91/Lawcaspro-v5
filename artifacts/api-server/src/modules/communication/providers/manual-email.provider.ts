export function normalizeEmailAddressList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    out.push(s);
  }
  return Array.from(new Set(out)).slice(0, 50);
}

