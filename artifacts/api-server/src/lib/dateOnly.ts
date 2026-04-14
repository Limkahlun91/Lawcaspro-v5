function isValidYmd(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return false;
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  return dt.getUTCFullYear() === yyyy && dt.getUTCMonth() + 1 === mm && dt.getUTCDate() === dd;
}

export function parseDateOnlyInput(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isValidYmd(s) ? s : undefined;
    if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      const ymd = s.slice(0, 10);
      return isValidYmd(ymd) ? ymd : undefined;
    }
    return undefined;
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return undefined;
    return v.toISOString().slice(0, 10);
  }
  return undefined;
}

