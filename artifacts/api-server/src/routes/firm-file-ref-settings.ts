import express, { type Response, type Router as ExpressRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, firmFileRefSettingsTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

function normalizeCaseType(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  const clean = s.replace(/[^a-z0-9_-]/g, "_").slice(0, 40);
  return clean || "default";
}

router.get("/firm-file-ref-settings", requireAuth, requireFirmUser, requirePermission("settings", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = rdb(req);
  const items = await r
    .select({
      id: firmFileRefSettingsTable.id,
      firmId: firmFileRefSettingsTable.firmId,
      caseType: firmFileRefSettingsTable.caseType,
      formatPattern: firmFileRefSettingsTable.formatPattern,
      currentSequence: firmFileRefSettingsTable.currentSequence,
      createdAt: firmFileRefSettingsTable.createdAt,
      updatedAt: firmFileRefSettingsTable.updatedAt,
    })
    .from(firmFileRefSettingsTable)
    .where(eq(firmFileRefSettingsTable.firmId, req.firmId!))
    .orderBy(firmFileRefSettingsTable.caseType);

  res.json({
    items: items.map((x) => ({
      id: Number(x.id),
      firmId: Number(x.firmId),
      caseType: String(x.caseType),
      formatPattern: String(x.formatPattern),
      currentSequence: Number(x.currentSequence ?? 0),
      createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : String(x.createdAt),
      updatedAt: x.updatedAt instanceof Date ? x.updatedAt.toISOString() : String(x.updatedAt),
    })),
  });
});

router.put("/firm-file-ref-settings", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = rdb(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const caseType = normalizeCaseType(body.caseType);
  const formatPattern = typeof body.formatPattern === "string" ? body.formatPattern.trim() : "";
  const currentSequenceRaw = body.currentSequence;
  const currentSequence = typeof currentSequenceRaw === "number"
    ? Math.trunc(currentSequenceRaw)
    : (typeof currentSequenceRaw === "string" ? Math.trunc(Number(currentSequenceRaw)) : NaN);

  if (!formatPattern) {
    res.status(422).json({ error: "formatPattern is required", code: "FORMAT_PATTERN_REQUIRED" });
    return;
  }
  if (formatPattern.length > 120) {
    res.status(422).json({ error: "formatPattern too long", code: "FORMAT_PATTERN_TOO_LONG", limit: 120 });
    return;
  }
  const nextSeq = Number.isFinite(currentSequence) && currentSequence >= 0 ? currentSequence : null;

  const [row] = await (r as any).transaction(async (tx: DbConn) => {
    await tx.execute(sql`
      INSERT INTO firm_file_ref_settings (firm_id, case_type, format_pattern, current_sequence)
      VALUES (${req.firmId!}, ${caseType}, ${formatPattern}, ${nextSeq ?? 0})
      ON CONFLICT (firm_id, case_type) DO UPDATE SET
        format_pattern = EXCLUDED.format_pattern,
        current_sequence = ${nextSeq !== null ? sql`EXCLUDED.current_sequence` : sql`firm_file_ref_settings.current_sequence`},
        updated_at = now()
      RETURNING id, firm_id, case_type, format_pattern, current_sequence, created_at, updated_at
    `);
    const result = await tx.execute(sql`
      SELECT id, firm_id, case_type, format_pattern, current_sequence, created_at, updated_at
      FROM firm_file_ref_settings
      WHERE firm_id = ${req.firmId!} AND case_type = ${caseType}
      LIMIT 1
    `);
    const rows = Array.isArray(result) ? result : ("rows" in (result as any) ? (result as any).rows : []);
    return (rows as any[]).map((r0) => ({
      id: Number(r0.id),
      firmId: Number(r0.firm_id),
      caseType: String(r0.case_type),
      formatPattern: String(r0.format_pattern),
      currentSequence: Number(r0.current_sequence ?? 0),
      createdAt: r0.created_at,
      updatedAt: r0.updated_at,
    }));
  });

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "settings.firm_file_ref_settings.upsert",
    entityType: "firm",
    entityId: req.firmId,
    detail: JSON.stringify({ caseType, formatPattern, ...(nextSeq !== null ? { currentSequence: nextSeq } : {}) }),
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({
    id: Number((row as any)?.id ?? 0),
    firmId: Number((row as any)?.firmId ?? req.firmId),
    caseType: String((row as any)?.caseType ?? caseType),
    formatPattern: String((row as any)?.formatPattern ?? formatPattern),
    currentSequence: Number((row as any)?.currentSequence ?? 0),
    createdAt: (row as any)?.createdAt instanceof Date ? (row as any).createdAt.toISOString() : String((row as any)?.createdAt ?? ""),
    updatedAt: (row as any)?.updatedAt instanceof Date ? (row as any).updatedAt.toISOString() : String((row as any)?.updatedAt ?? ""),
  });
});

router.delete("/firm-file-ref-settings/:caseType", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = rdb(req);
  const caseType = normalizeCaseType((req.params as any).caseType);
  await r.delete(firmFileRefSettingsTable).where(and(eq(firmFileRefSettingsTable.firmId, req.firmId!), eq(firmFileRefSettingsTable.caseType, caseType)));

  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "settings.firm_file_ref_settings.delete",
    entityType: "firm",
    entityId: req.firmId,
    detail: JSON.stringify({ caseType }),
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({ success: true });
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;

