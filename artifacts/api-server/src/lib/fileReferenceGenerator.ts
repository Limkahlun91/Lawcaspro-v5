import { sql } from "@workspace/db";

type DbConn = {
  execute: (q: unknown) => Promise<unknown>;
};

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as any).rows;
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }
  return [];
}

function normalizeCaseType(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  const clean = s.replace(/[^a-z0-9_-]/g, "_").slice(0, 40);
  return clean || "default";
}

function normalizeInitials(v: unknown): string {
  const raw = typeof v === "string" ? v.trim().toUpperCase() : "";
  const clean = raw.replace(/[^A-Z0-9]/g, "").slice(0, 5);
  return clean || "NA";
}

function padSeq(seq: number, width: number): string {
  const w = Number.isFinite(width) && width > 0 && width <= 12 ? Math.trunc(width) : 4;
  const s = String(Math.max(0, Math.trunc(seq)));
  return s.padStart(w, "0");
}

function renderPattern(patternRaw: string, args: { now: Date; seq: number; initials: string }): string {
  const now = args.now;
  const yyyy = String(now.getFullYear()).padStart(4, "0");
  const yy = yyyy.slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const initials = normalizeInitials(args.initials);
  const base0 = String(patternRaw || "").trim() || "{YY}/{SEQ:4}";
  const base = /\{SEQ:\d+\}/i.test(base0) ? base0 : `${base0}/{SEQ:4}`;

  const withDate = base
    .replaceAll("{YYYY}", yyyy)
    .replaceAll("{YY}", yy)
    .replaceAll("{MM}", mm)
    .replaceAll("{INITIALS}", initials);

  return withDate
    .replace(/\{SEQ:(\d+)\}/g, (_m, w: string) => padSeq(args.seq, Number(w)))
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, 80);
}

export async function allocateCaseReferenceNo(tx: DbConn, args: {
  firmId: number;
  caseType: unknown;
  initials: unknown;
  defaultPattern?: string;
  now?: Date;
}): Promise<string> {
  const firmId = args.firmId;
  const caseType = normalizeCaseType(args.caseType);
  const now = args.now ?? new Date();
  const defaultPattern = (args.defaultPattern || "{YY}/{SEQ:4}").trim() || "{YY}/{SEQ:4}";

  await tx.execute(sql`
    INSERT INTO firm_file_ref_settings (firm_id, case_type, format_pattern, current_sequence)
    VALUES (${firmId}, ${caseType}, ${defaultPattern}, 0)
    ON CONFLICT (firm_id, case_type) DO NOTHING
  `);

  const updated = rowsOf(await tx.execute(sql`
    UPDATE firm_file_ref_settings
    SET current_sequence = current_sequence + 1,
        updated_at = now()
    WHERE firm_id = ${firmId}
      AND case_type = ${caseType}
    RETURNING format_pattern, current_sequence
  `))[0];

  const pattern = typeof updated?.format_pattern === "string" ? String(updated.format_pattern) : defaultPattern;
  const seqRaw = updated?.current_sequence;
  const seq = typeof seqRaw === "number" ? seqRaw : (typeof seqRaw === "string" ? Number(seqRaw) : 1);
  const seqSafe = Number.isFinite(seq) && seq > 0 ? Math.trunc(seq) : 1;

  return renderPattern(pattern, { now, seq: seqSafe, initials: normalizeInitials(args.initials) });
}
