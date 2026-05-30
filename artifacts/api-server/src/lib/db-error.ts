export type DbErrorInfo = {
  sqlstate: string | null;
  table: string | null;
  column: string | null;
  constraint: string | null;
  detail: string | null;
  hint: string | null;
  message: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function getString(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v ? v : null;
}

function parseMessageForRelation(msg: string): { table: string | null; column: string | null } {
  const rel = /relation\s+"([^"]+)"\s+does\s+not\s+exist/i.exec(msg);
  if (rel?.[1]) return { table: rel[1], column: null };
  const perm = /permission\s+denied\s+for\s+relation\s+"?([^"\s]+)"?/i.exec(msg);
  if (perm?.[1]) return { table: perm[1], column: null };
  const colOfRel = /column\s+"([^"]+)"\s+of\s+relation\s+"([^"]+)"\s+does\s+not\s+exist/i.exec(msg);
  if (colOfRel?.[1] && colOfRel?.[2]) return { column: colOfRel[1], table: colOfRel[2] };
  const col = /column\s+"([^"]+)"\s+does\s+not\s+exist/i.exec(msg);
  if (col?.[1]) return { column: col[1], table: null };
  return { table: null, column: null };
}

function getFirstDbLikeRecord(err: unknown): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    const rec = asRecord(cur);
    if (!rec) continue;
    if (typeof rec.code === "string") return rec;
    for (const k of ["cause", "original", "parent", "error", "err"]) {
      const next = rec[k];
      if (next && typeof next === "object") queue.push(next);
    }
  }
  return null;
}

export function extractDbErrorInfo(err: unknown): DbErrorInfo {
  const rec = getFirstDbLikeRecord(err);
  const message = err instanceof Error ? err.message : rec && typeof rec.message === "string" ? String(rec.message) : null;
  const sqlstate = getString(rec, "code");
  const table = getString(rec, "table");
  const column = getString(rec, "column");
  const constraint = getString(rec, "constraint");
  const detail = getString(rec, "detail");
  const hint = getString(rec, "hint");
  const parsed = message ? parseMessageForRelation(message) : { table: null, column: null };
  return {
    sqlstate,
    table: table ?? parsed.table,
    column: column ?? parsed.column,
    constraint,
    detail,
    hint,
    message: message ? String(message) : null,
  };
}

