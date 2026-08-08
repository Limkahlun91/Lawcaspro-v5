import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db, casesTable, fileCustodyItemsTable, fileCustodyMovementsTable, permissionsTable, rolesTable, userNotificationsTable, usersTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const rdb = (req: AuthRequest) => req.rlsDb ?? db;

const one = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (typeof v === "string") return v || undefined;
  if (Array.isArray(v)) {
    const first = (v as unknown[])[0];
    return typeof first === "string" ? first || undefined : undefined;
  }
  if (typeof v === "number") return String(v);
  return undefined;
};
const asInt = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
};
const asBoolean = (v: string | undefined): boolean | undefined => {
  if (v == null) return undefined;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
};

const ACTIVE_OUT = ["out_on_loan", "out_with_counsel", "out_with_client", "out_external"] as const;
const ITEM_STATUSES = ["in_office","out_on_loan","out_with_counsel","out_with_client","out_external","return_pending","returned","archived","lost"] as const;
const CATEGORIES = ["court_document","spa","loan_agreement","land_title","caveat","identity_document","invoice","payment_voucher","quotation","firm_letter","correspondence","bundle","file_will","other"] as const;

const MovementReturnRequestSchema = z.object({
  custodyItemId: z.coerce.number().int().positive(),
  note: z.string().trim().max(4000).optional(),
  requestedReturnByUserId: z.coerce.number().int().positive().optional(),
  requestedReturnAt: z.string().datetime({ offset: true }).optional(),
});
const MovementReceiveReturnSchema = z.object({
  movementId: z.coerce.number().int().positive(),
  returnedNote: z.string().trim().max(4000).optional(),
  returnedCondition: z.enum(["good","damaged","partial","missing_pages"]).default("good"),
});

const CreateItemSchema = z.object({
  caseId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  matterLabel: z.string().trim().min(1).max(120).default("General"),
  fileReferenceNo: z.string().trim().min(2).max(120),
  fileTitle: z.string().trim().min(2).max(250),
  fileDescription: z.string().trim().max(5000).optional(),
  physicalOrDigital: z.enum(["physical","digital","hybrid"]).default("digital"),
  category: z.enum(CATEGORIES).default("court_document"),
  storageLocation: z.string().trim().max(250).optional(),
  tags: z.string().trim().max(1000).optional(),
  expectedReturnAt: z.string().datetime({ offset: true }).optional(),
  acknowledgeDueAt: z.string().datetime({ offset: true }).optional(),
  currentHolderUserId: z.coerce.number().int().positive().optional(),
  currentHolderName: z.string().trim().max(200).optional(),
  currentHolderContact: z.string().trim().max(200).optional(),
  currentHolderFirmExternal: z.string().trim().max(250).optional(),
  meta: z.record(z.string().min(1), z.any()).optional(),
});

const PatchItemSchema = z.object({
  matterLabel: z.string().trim().min(1).max(120).optional(),
  fileTitle: z.string().trim().min(2).max(250).optional(),
  fileDescription: z.string().trim().max(5000).optional(),
  physicalOrDigital: z.enum(["physical","digital","hybrid"]).optional(),
  category: z.enum(CATEGORIES).optional(),
  storageLocation: z.string().trim().max(250).optional(),
  tags: z.string().trim().max(1000).optional(),
  lifecycleStatus: z.enum(ITEM_STATUSES).optional(),
  isArchived: z.boolean().optional(),
  archivedByUserId: z.coerce.number().int().positive().optional(),
  meta: z.record(z.string().min(1), z.any()).optional(),
});

const MovementReleaseSchema = z.object({
  custodyItemId: z.coerce.number().int().positive(),
  toHolderUserId: z.coerce.number().int().positive().optional(),
  toHolderName: z.string().trim().min(1).max(200).optional(),
  toHolderContact: z.string().trim().max(200).optional(),
  toHolderFirmExternal: z.string().trim().max(250).optional(),
  expectedReturnAt: z.string().datetime({ offset: true }).optional(),
  acknowledgeDueAt: z.string().datetime({ offset: true }).optional(),
  severity: z.enum(["info","normal","high","urgent","critical"]).default("normal"),
  movementNote: z.string().trim().max(4000).optional(),
});

const MovementAckSchema = z.object({
  movementId: z.coerce.number().int().positive(),
  acknowledgedNote: z.string().trim().max(2000).optional(),
  condition: z.enum(["good","damaged","partial","missing_pages"]).default("good"),
});

const MovementReturnSchema = z.object({
  movementId: z.coerce.number().int().positive(),
  returnedNote: z.string().trim().max(4000).optional(),
  returnedCondition: z.enum(["good","damaged","partial","missing_pages"]).default("good"),
});

const EscalateSchema = z.object({
  targetPartnerUserId: z.string().optional(),
  note: z.string().trim().max(1000).optional(),
});

const PERM_CACHE_KEY = Symbol.for("file_custody_perm_cache");
type PermRow = { module: string; action: string; allowed: boolean };
async function getRoleName(req: AuthRequest): Promise<string> {
  return String((req as { roleName?: unknown }).roleName ?? "").trim();
}
async function getOrLoadPerms(req: AuthRequest): Promise<PermRow[]> {
  const anyReq = req as unknown as { [PERM_CACHE_KEY]?: Promise<PermRow[]> | PermRow[] };
  if (anyReq[PERM_CACHE_KEY]) {
    return (await anyReq[PERM_CACHE_KEY]) ?? [];
  }
  const prom = (async (): Promise<PermRow[]> => {
    if (!req.firmId || !req.roleId) return [];
    try {
      return await rdb(req)
        .select({ module: permissionsTable.module, action: permissionsTable.action, allowed: permissionsTable.allowed })
        .from(permissionsTable)
        .where(and(eq(permissionsTable.roleId, req.roleId), eq(permissionsTable.allowed, true)));
    } catch {
      return [];
    }
  })();
  anyReq[PERM_CACHE_KEY] = prom;
  return await prom;
}

async function hasPermissionOverride(req: AuthRequest): Promise<boolean> {
  const roleName = await getRoleName(req);
  if (roleName === "Partner" || roleName === "Founder") return true;
  const perms = await getOrLoadPerms(req);
  return perms.some((p) => p.module === "file_custody" && p.action === "manage" && p.allowed);
}

async function requireAny(req: AuthRequest, checks: Array<{ module: string; action: string }>): Promise<boolean> {
  const roleName = await getRoleName(req);
  if (roleName === "Partner" || roleName === "Founder") return true;
  const perms = await getOrLoadPerms(req);
  return checks.some((c) => perms.some((p) => p.module === c.module && p.action === c.action && p.allowed));
}

async function pushCustodyNotification(args: {
  firmId: number; userId: number; custodyItemId: number; movementId?: number; caseId?: number | null;
  kind: "release" | "ack_due" | "return_overdue" | "returned";
  title: string; message: string; severity: "normal" | "high" | "urgent" | "critical";
  acknowledgementDueAt?: Date | null; resolutionSlaDueAt?: Date | null;
  targetScope?: "user" | "lawyer" | "manager" | "all_partners" | "selected_partner";
  targetRoleId?: number | null; dismissible?: boolean; ip?: string; ua?: string;
}) {
  const now = new Date();
  try {
    await db.insert(userNotificationsTable).values({
      firmId: args.firmId,
      userId: args.userId,
      sourceType: "file_custody",
      sourceId: args.movementId ?? args.custodyItemId,
      caseId: args.caseId ?? null,
      notificationType: `custody_${args.kind}`,
      title: args.title,
      message: args.message,
      meta: { custodyItemId: args.custodyItemId, movementId: args.movementId ?? null, caseId: args.caseId ?? null },
      status: "unread",
      severity: args.severity,
      targetScope: args.targetScope ?? "user",
      targetRoleId: args.targetRoleId ?? null,
      dismissible: args.dismissible ?? false,
      acknowledgementDueAt: args.acknowledgementDueAt ?? null,
      resolutionSlaDueAt: args.resolutionSlaDueAt ?? null,
      createdAt: now,
      readAt: null, acknowledgedAt: null, escalatedAt: null, resolvedAt: null, autoResolvedAt: null,
      statusSetAt: now, escalatedReason: null, resolvedReason: null, ipAddress: args.ip ?? null, userAgent: args.ua ?? null,
    });
  } catch {
    // ignore: never let notifications break custody flow
  }
}

router.get("/file-custody/items", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "view" }, { module: "case_monitor", action: "view" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_view", message: "file_custody:view or case_monitor:view required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const status = one(req.query.lifecycle_status);
    const onlyOut = asBoolean(one(req.query.only_out));
    const onlyOverdue = asBoolean(one(req.query.only_overdue));
    const onlyUnacknowledged = asBoolean(one(req.query.only_unacknowledged));
    const category = one(req.query.category);
    const holder = asInt(one(req.query.current_holder_user_id));
    const caseId = asInt(one(req.query.case_id));
    const q = one(req.query.q);
    const offset = Math.max(0, asInt(one(req.query.offset)) ?? 0);
    const limitRaw = asInt(one(req.query.limit)) ?? 30;
    const limit = Math.min(200, Math.max(1, limitRaw));
    const now = new Date();
    const where = [eq(fileCustodyItemsTable.firmId, firmId)];
    if (status) where.push(eq(fileCustodyItemsTable.lifecycleStatus, status));
    else if (onlyOut) where.push(inArray(fileCustodyItemsTable.lifecycleStatus, ACTIVE_OUT as unknown as string[]));
    if (category) where.push(eq(fileCustodyItemsTable.category, category));
    if (holder) where.push(eq(fileCustodyItemsTable.currentHolderUserId, holder));
    if (caseId) where.push(eq(fileCustodyItemsTable.caseId, caseId));
    if (onlyOverdue) where.push(and(sql`${fileCustodyItemsTable.expectedReturnAt} IS NOT NULL`, sql`${fileCustodyItemsTable.expectedReturnAt} < ${now}`));
    if (onlyUnacknowledged) where.push(and(isNull(fileCustodyItemsTable.acknowledgedAt), sql`${fileCustodyItemsTable.acknowledgeDueAt} IS NOT NULL`));
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      where.push(sql`(${fileCustodyItemsTable.fileTitle} ILIKE ${like} OR ${fileCustodyItemsTable.fileReferenceNo} ILIKE ${like} OR COALESCE(${fileCustodyItemsTable.matterLabel},'') ILIKE ${like})`);
    }
    const [countRow] = await rdb(req).select({ count: count() }).from(fileCustodyItemsTable).where(and(...where));
    const items = await rdb(req)
      .select({
        id: fileCustodyItemsTable.id,
        fileReferenceNo: fileCustodyItemsTable.fileReferenceNo,
        fileTitle: fileCustodyItemsTable.fileTitle,
        fileDescription: fileCustodyItemsTable.fileDescription,
        physicalOrDigital: fileCustodyItemsTable.physicalOrDigital,
        category: fileCustodyItemsTable.category,
        storageLocation: fileCustodyItemsTable.storageLocation,
        tags: fileCustodyItemsTable.tags,
        lifecycleStatus: fileCustodyItemsTable.lifecycleStatus,
        isArchived: fileCustodyItemsTable.isArchived,
        caseId: fileCustodyItemsTable.caseId,
        projectId: fileCustodyItemsTable.projectId,
        matterLabel: fileCustodyItemsTable.matterLabel,
        currentHolderUserId: fileCustodyItemsTable.currentHolderUserId,
        currentHolderName: fileCustodyItemsTable.currentHolderName,
        currentHolderContact: fileCustodyItemsTable.currentHolderContact,
        currentHolderFirmExternal: fileCustodyItemsTable.currentHolderFirmExternal,
        acknowledgedAt: fileCustodyItemsTable.acknowledgedAt,
        acknowledgeDueAt: fileCustodyItemsTable.acknowledgeDueAt,
        expectedReturnAt: fileCustodyItemsTable.expectedReturnAt,
        lastMovementId: fileCustodyItemsTable.lastMovementId,
        createdAt: fileCustodyItemsTable.createdAt,
        updatedAt: fileCustodyItemsTable.updatedAt,
        holderName: usersTable.name,
      })
      .from(fileCustodyItemsTable)
      .leftJoin(usersTable, eq(usersTable.id, fileCustodyItemsTable.currentHolderUserId))
      .where(and(...where))
      .orderBy(sql`CASE WHEN ${fileCustodyItemsTable.expectedReturnAt} IS NULL THEN 1 ELSE 0 END`, sql`${fileCustodyItemsTable.expectedReturnAt} IS NOT NULL AND ${fileCustodyItemsTable.expectedReturnAt} < ${now} DESC`, desc(fileCustodyItemsTable.updatedAt), desc(fileCustodyItemsTable.createdAt))
      .limit(limit).offset(offset);
    const enriched = items.map(i => {
      const overdue = !!i.expectedReturnAt && i.expectedReturnAt < now;
      const ackOverdue = !!i.acknowledgeDueAt && !i.acknowledgedAt && i.acknowledgeDueAt < now;
      const hrsLeftReturn = i.expectedReturnAt ? (i.expectedReturnAt.getTime() - now.getTime()) / 3600000 : null;
      return { ...i, isReturnOverdue: overdue, isAcknowledgementOverdue: ackOverdue, returnHoursLeft: hrsLeftReturn, overdueSeverity: overdue ? (hrsLeftReturn !== null && hrsLeftReturn < -168 ? "critical" : hrsLeftReturn !== null && hrsLeftReturn < -72 ? "urgent" : "high") : "normal" };
    });
    res.json({ total: Number(countRow?.count ?? 0), offset, limit, items: enriched });
  } catch (e) {
    res.status(500).json({ error: "list_unavailable", detail: (e as Error).message });
  }
});

router.get("/file-custody/items/summary", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "view" }, { module: "case_monitor", action: "view" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_view", message: "file_custody:view or case_monitor:view required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const now = new Date();
    const baseWhere = eq(fileCustodyItemsTable.firmId, firmId);
    const [totalRow] = await rdb(req).select({ count: count() }).from(fileCustodyItemsTable).where(baseWhere);
    const [outRow] = await rdb(req).select({ count: count() }).from(fileCustodyItemsTable).where(and(baseWhere, inArray(fileCustodyItemsTable.lifecycleStatus, ACTIVE_OUT as unknown as string[])));
    const [overdueReturnRow] = await rdb(req).select({ count: count() }).from(fileCustodyItemsTable).where(and(baseWhere, sql`${fileCustodyItemsTable.expectedReturnAt} IS NOT NULL`, sql`${fileCustodyItemsTable.expectedReturnAt} < ${now}`));
    const [unAckRow] = await rdb(req).select({ count: count() }).from(fileCustodyItemsTable).where(and(baseWhere, isNull(fileCustodyItemsTable.acknowledgedAt), sql`${fileCustodyItemsTable.acknowledgeDueAt} IS NOT NULL`, sql`${fileCustodyItemsTable.acknowledgeDueAt} < ${now}`));
    const byStatus = await rdb(req).select({ status: fileCustodyItemsTable.lifecycleStatus, count: count() }).from(fileCustodyItemsTable).where(baseWhere).groupBy(fileCustodyItemsTable.lifecycleStatus);
    const byCategory = await rdb(req).select({ category: fileCustodyItemsTable.category, count: count() }).from(fileCustodyItemsTable).where(baseWhere).groupBy(fileCustodyItemsTable.category);
    res.json({
      total: Number(totalRow?.count ?? 0),
      out: Number(outRow?.count ?? 0),
      overdueReturn: Number(overdueReturnRow?.count ?? 0),
      unacknowledgedOverdue: Number(unAckRow?.count ?? 0),
      byStatus: Object.fromEntries(byStatus.map(r => [r.status, Number(r.count)])),
      byCategory: Object.fromEntries(byCategory.map(r => [r.category ?? "other", Number(r.count)])),
    });
  } catch (e) {
    res.status(500).json({ error: "summary_unavailable", detail: (e as Error).message });
  }
});

router.get("/file-custody/items/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "view" }, { module: "case_monitor", action: "view" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_view", message: "file_custody:view or case_monitor:view required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const id = asInt(req.params.id);
    if (!Number.isFinite(id!)) { res.status(400).json({ error: "invalid_id" }); return; }
    const [row] = await rdb(req)
      .select({
        id: fileCustodyItemsTable.id,
        firmId: fileCustodyItemsTable.firmId,
        caseId: fileCustodyItemsTable.caseId,
        projectId: fileCustodyItemsTable.projectId,
        matterLabel: fileCustodyItemsTable.matterLabel,
        fileReferenceNo: fileCustodyItemsTable.fileReferenceNo,
        fileTitle: fileCustodyItemsTable.fileTitle,
        fileDescription: fileCustodyItemsTable.fileDescription,
        physicalOrDigital: fileCustodyItemsTable.physicalOrDigital,
        category: fileCustodyItemsTable.category,
        storageLocation: fileCustodyItemsTable.storageLocation,
        tags: fileCustodyItemsTable.tags,
        currentHolderUserId: fileCustodyItemsTable.currentHolderUserId,
        currentHolderName: fileCustodyItemsTable.currentHolderName,
        currentHolderContact: fileCustodyItemsTable.currentHolderContact,
        currentHolderFirmExternal: fileCustodyItemsTable.currentHolderFirmExternal,
        acknowledgedAt: fileCustodyItemsTable.acknowledgedAt,
        acknowledgeDueAt: fileCustodyItemsTable.acknowledgeDueAt,
        expectedReturnAt: fileCustodyItemsTable.expectedReturnAt,
        lastMovementId: fileCustodyItemsTable.lastMovementId,
        lifecycleStatus: fileCustodyItemsTable.lifecycleStatus,
        isArchived: fileCustodyItemsTable.isArchived,
        archivedAt: fileCustodyItemsTable.archivedAt,
        archivedByUserId: fileCustodyItemsTable.archivedByUserId,
        meta: fileCustodyItemsTable.meta,
        createdByUserId: fileCustodyItemsTable.createdByUserId,
        createdAt: fileCustodyItemsTable.createdAt,
        updatedAt: fileCustodyItemsTable.updatedAt,
        holderName: usersTable.name,
      })
      .from(fileCustodyItemsTable)
      .leftJoin(usersTable, eq(usersTable.id, fileCustodyItemsTable.currentHolderUserId))
      .where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, id!)));
    if (!row) { res.status(404).json({ error: "not_found" }); return; }
    const movements = await rdb(req)
      .select({
        id: fileCustodyMovementsTable.id,
        movementKind: fileCustodyMovementsTable.movementKind,
        fromHolderUserId: fileCustodyMovementsTable.fromHolderUserId,
        fromHolderName: fileCustodyMovementsTable.fromHolderName,
        fromHolderContact: fileCustodyMovementsTable.fromHolderContact,
        fromHolderFirmExternal: fileCustodyMovementsTable.fromHolderFirmExternal,
        toHolderUserId: fileCustodyMovementsTable.toHolderUserId,
        toHolderName: fileCustodyMovementsTable.toHolderName,
        toHolderContact: fileCustodyMovementsTable.toHolderContact,
        toHolderFirmExternal: fileCustodyMovementsTable.toHolderFirmExternal,
        expectedReturnAt: fileCustodyMovementsTable.expectedReturnAt,
        acknowledgeDueAt: fileCustodyMovementsTable.acknowledgeDueAt,
        acknowledgedAt: fileCustodyMovementsTable.acknowledgedAt,
        acknowledgedByUserId: fileCustodyMovementsTable.acknowledgedByUserId,
        acknowledgedNote: fileCustodyMovementsTable.acknowledgedNote,
        returnedAt: fileCustodyMovementsTable.returnedAt,
        returnedByUserId: fileCustodyMovementsTable.returnedByUserId,
        returnedCondition: fileCustodyMovementsTable.returnedCondition,
        returnedNote: fileCustodyMovementsTable.returnedNote,
        severity: fileCustodyMovementsTable.severity,
        movementNote: fileCustodyMovementsTable.movementNote,
        escalatedAt: fileCustodyMovementsTable.escalatedAt,
        escalatedToPartner: fileCustodyMovementsTable.escalatedToPartner,
        createdByUserId: fileCustodyMovementsTable.createdByUserId,
        createdAt: fileCustodyMovementsTable.createdAt,
      })
      .from(fileCustodyMovementsTable)
      .where(and(eq(fileCustodyMovementsTable.firmId, firmId), eq(fileCustodyMovementsTable.custodyItemId, id!)))
      .orderBy(desc(fileCustodyMovementsTable.createdAt), desc(fileCustodyMovementsTable.id))
      .limit(100);
    res.json({ item: row, movements });
  } catch (e) {
    res.status(500).json({ error: "fetch_failed", detail: (e as Error).message });
  }
});

router.post("/file-custody/items", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "manage" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_manage", message: "file_custody:manage required to register items" }); return;
  }
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const parsed = CreateItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const data = parsed.data;
    if (data.currentHolderUserId && !(data.currentHolderName && data.currentHolderContact)) {
      const [u] = await rdb(req).select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(and(eq(usersTable.firmId, firmId), eq(usersTable.id, data.currentHolderUserId), eq(usersTable.status, "active")));
      if (!u) { res.status(400).json({ error: "invalid_current_holder_user_id" }); return; }
      data.currentHolderName = data.currentHolderName ?? u.name;
      data.currentHolderContact = data.currentHolderContact ?? u.email;
    }
    if (data.caseId) {
      const [cv] = await rdb(req).select({ id: casesTable.id }).from(casesTable).where(and(eq(casesTable.id, data.caseId), eq(casesTable.firmId, firmId)));
      if (!cv) { res.status(400).json({ error: "invalid_case_id" }); return; }
    }
    const ackDue = data.acknowledgeDueAt ? new Date(data.acknowledgeDueAt) : data.currentHolderUserId || data.currentHolderName ? new Date(Date.now() + 24 * 3600 * 1000) : null;
    const retDue = data.expectedReturnAt ? new Date(data.expectedReturnAt) : null;
    const [created] = await rdb(req).insert(fileCustodyItemsTable).values({
      firmId, caseId: data.caseId ?? null, projectId: data.projectId ?? null,
      matterLabel: data.matterLabel, fileReferenceNo: data.fileReferenceNo, fileTitle: data.fileTitle,
      fileDescription: data.fileDescription ?? null, physicalOrDigital: data.physicalOrDigital, category: data.category,
      storageLocation: data.storageLocation ?? null, tags: data.tags ?? null,
      currentHolderUserId: data.currentHolderUserId ?? null,
      currentHolderName: data.currentHolderName ?? null,
      currentHolderContact: data.currentHolderContact ?? null,
      currentHolderFirmExternal: data.currentHolderFirmExternal ?? null,
      acknowledgeDueAt: ackDue, expectedReturnAt: retDue,
      lifecycleStatus: (data.currentHolderUserId || data.currentHolderName) ? "out_on_loan" : "in_office",
      meta: data.meta ?? null, createdByUserId: userId,
    }).returning({ id: fileCustodyItemsTable.id, lifecycleStatus: fileCustodyItemsTable.lifecycleStatus });
    void writeAuditLog({ entityId: Number(created.id), action: "create", entityType: "file_custody_item", firmId, actorId: userId, detail: `created ref=${parsed.data.fileReferenceNo}`, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.status(201).json({ ok: true, id: Number(created.id), lifecycleStatus: created.lifecycleStatus });
  } catch (e: any) {
    if (String(e?.code) === "23505") { res.status(409).json({ error: "reference_already_exists", detail: (e as Error).message }); return; }
    res.status(500).json({ error: "create_failed", detail: (e as Error).message });
  }
});

router.patch("/file-custody/items/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "manage" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_manage", message: "file_custody:manage required for item meta edits" }); return;
  }
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const id = asInt(req.params.id);
    if (!Number.isFinite(id!)) { res.status(400).json({ error: "invalid_id" }); return; }
    const parsed = PatchItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [existingRaw] = await rdb(req).select().from(fileCustodyItemsTable).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, id!)));
    if (!existingRaw) { res.status(404).json({ error: "not_found" }); return; }
    if (parsed.data.archivedByUserId && parsed.data.archivedByUserId !== userId) {
      const [av] = await rdb(req).select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, parsed.data.archivedByUserId), eq(usersTable.firmId, firmId), eq(usersTable.status, "active")));
      if (!av) { res.status(400).json({ error: "invalid_archived_by_user_id" }); return; }
    }
    const existing = existingRaw as unknown as { version?: number };
    const expectedVersion = (Number(existing.version) || 0);
    const patch: Partial<typeof fileCustodyItemsTable.$inferInsert> & { version?: number } = {};
    if (parsed.data.matterLabel !== undefined) patch.matterLabel = parsed.data.matterLabel;
    if (parsed.data.fileTitle !== undefined) patch.fileTitle = parsed.data.fileTitle;
    if (parsed.data.fileDescription !== undefined) patch.fileDescription = parsed.data.fileDescription;
    if (parsed.data.physicalOrDigital !== undefined) patch.physicalOrDigital = parsed.data.physicalOrDigital;
    if (parsed.data.category !== undefined) patch.category = parsed.data.category;
    if (parsed.data.storageLocation !== undefined) patch.storageLocation = parsed.data.storageLocation;
    if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;
    if (parsed.data.lifecycleStatus !== undefined) patch.lifecycleStatus = parsed.data.lifecycleStatus;
    if (parsed.data.isArchived !== undefined) {
      patch.isArchived = parsed.data.isArchived;
      if (parsed.data.isArchived && !(existingRaw as any).archivedAt) { (patch as any).archivedAt = new Date(); (patch as any).archivedByUserId = parsed.data.archivedByUserId ?? userId; }
      if (!parsed.data.isArchived && (existingRaw as any).archivedAt) { (patch as any).archivedAt = null; (patch as any).archivedByUserId = null; }
    }
    if (parsed.data.meta !== undefined) patch.meta = { ...((existingRaw as any).meta ?? {}), ...parsed.data.meta } as any;
    if (Object.keys(patch).length === 0) { res.json({ ok: true, id }); return; }
    patch.version = expectedVersion + 1;
    const [updated] = await rdb(req)
      .update(fileCustodyItemsTable)
      .set(patch as any)
      .where(and(eq(fileCustodyItemsTable.id, id!), eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.version, expectedVersion)))
      .returning({ id: fileCustodyItemsTable.id });
    if (!updated) { res.status(409).json({ error: "version_conflict", message: "File custody item was modified concurrently. Re-read and retry." }); return; }
    void writeAuditLog({ entityId: id!, action: "patch", entityType: "file_custody_item", firmId, actorId: userId, detail: `updated fields: ${Object.keys(patch).join(",")} version=${expectedVersion}->${patch.version}`, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, id, version: patch.version });
  } catch (e) {
    res.status(500).json({ error: "patch_failed", detail: (e as Error).message });
  }
});

router.post("/file-custody/movements/release", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "release" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_release", message: "file_custody:release required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const parsed = MovementReleaseSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const data = parsed.data;
    const [itemRaw] = await rdb(req).select().from(fileCustodyItemsTable).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, data.custodyItemId)));
    if (!itemRaw) { res.status(404).json({ error: "item_not_found" }); return; }
    const item = itemRaw as any;
    if (item.isArchived) { res.status(409).json({ error: "archived_cannot_release" }); return; }
    if (data.toHolderUserId) {
      const [u] = await rdb(req).select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, roleId: usersTable.roleId }).from(usersTable).where(and(eq(usersTable.firmId, firmId), eq(usersTable.id, data.toHolderUserId), eq(usersTable.status, "active")));
      if (!u) { res.status(400).json({ error: "invalid_target_user" }); return; }
      data.toHolderName = data.toHolderName ?? u.name;
      data.toHolderContact = data.toHolderContact ?? u.email;
    } else if (!data.toHolderName) {
      res.status(400).json({ error: "need_to_holder_user_or_name" }); return;
    }
    const ackDueAt = data.acknowledgeDueAt ? new Date(data.acknowledgeDueAt) : new Date(Date.now() + 24 * 3600 * 1000);
    const returnAt = data.expectedReturnAt ? new Date(data.expectedReturnAt) : new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const severity = parsed.data.severity;
    const expectedVersion = Number(item.version) || 0;

    const tx = await (rdb(req).transaction as any) ? null : null;
    let mvId: number | undefined;
    try {
      const [mv] = await rdb(req).insert(fileCustodyMovementsTable).values({
        firmId, custodyItemId: data.custodyItemId, movementKind: "release",
        fromHolderUserId: item.currentHolderUserId ?? userId,
        fromHolderName: item.currentHolderName ?? null,
        fromHolderContact: item.currentHolderContact ?? null,
        fromHolderFirmExternal: item.currentHolderFirmExternal ?? null,
        toHolderUserId: data.toHolderUserId ?? null,
        toHolderName: data.toHolderName ?? null,
        toHolderContact: data.toHolderContact ?? null,
        toHolderFirmExternal: data.toHolderFirmExternal ?? null,
        expectedReturnAt: returnAt,
        acknowledgeDueAt: ackDueAt,
        severity, movementNote: data.movementNote ?? null,
        ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), createdByUserId: userId,
      }).returning({ id: fileCustodyMovementsTable.id });
      mvId = Number(mv.id);
      const nextVersion = expectedVersion + 1;
      const [itemUpdated] = await rdb(req).update(fileCustodyItemsTable).set({
        currentHolderUserId: data.toHolderUserId ?? null,
        currentHolderName: data.toHolderName ?? null,
        currentHolderContact: data.toHolderContact ?? null,
        currentHolderFirmExternal: data.toHolderFirmExternal ?? null,
        lifecycleStatus: data.toHolderFirmExternal ? "out_external" : (item.category === "firm_letter" || item.category === "court_document") ? "out_with_counsel" : "out_on_loan",
        acknowledgedAt: null,
        acknowledgeDueAt: ackDueAt,
        expectedReturnAt: returnAt,
        lastMovementId: mvId,
        version: nextVersion,
      } as any).where(and(eq(fileCustodyItemsTable.id, data.custodyItemId), eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.version, expectedVersion))).returning({ id: fileCustodyItemsTable.id });
      if (!itemUpdated) {
        throw Object.assign(new Error("version_conflict_release"), { code: "VERSION_CONFLICT" });
      }
    } catch (err: any) {
      if (err?.code === "VERSION_CONFLICT") {
        res.status(409).json({ error: "version_conflict", message: "Release race condition. Re-read item and retry." }); return;
      }
      throw err;
    }
    if (data.toHolderUserId) {
      void pushCustodyNotification({
        firmId, userId: data.toHolderUserId, custodyItemId: data.custodyItemId, movementId: mvId, caseId: item.caseId,
        kind: "release",
        title: `File released to you: ${item.fileReferenceNo}`,
        message: `\"${item.fileTitle}\" has been released. Please acknowledge receipt within 24h.`,
        severity: severity === "info" ? "normal" : severity === "normal" ? "normal" : severity === "high" ? "high" : (severity as "urgent" | "critical"),
        acknowledgementDueAt: ackDueAt, resolutionSlaDueAt: returnAt,
        targetScope: "user", dismissible: false, ip: req.ip, ua: String(req.headers["user-agent"] ?? ""),
      });
    }
    void writeAuditLog({ entityId: mvId!, action: "release", entityType: "file_custody_movement", firmId, actorId: userId, detail: data.movementNote ?? `itemId=${data.custodyItemId} version=${expectedVersion}`, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.status(201).json({ ok: true, movementId: mvId, custodyItemId: data.custodyItemId });
  } catch (e) {
    res.status(500).json({ error: "release_failed", detail: (e as Error).message });
  }
});

router.post("/file-custody/movements/acknowledge", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "receive" }, { module: "file_custody", action: "manage" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_receive", message: "file_custody:receive or manage required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const parsed = MovementAckSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [mv] = await rdb(req).select().from(fileCustodyMovementsTable).where(and(eq(fileCustodyMovementsTable.firmId, firmId), eq(fileCustodyMovementsTable.id, parsed.data.movementId)));
    if (!mv) { res.status(404).json({ error: "movement_not_found" }); return; }
    if (mv.movementKind !== "release") { res.status(409).json({ error: "only_release_acknowledgeable" }); return; }
    const [existingAck] = await rdb(req)
      .select({ id: fileCustodyMovementsTable.id })
      .from(fileCustodyMovementsTable)
      .where(and(
        eq(fileCustodyMovementsTable.firmId, firmId),
        eq(fileCustodyMovementsTable.custodyItemId, mv.custodyItemId),
        eq(fileCustodyMovementsTable.movementKind, "acknowledge"),
        sql`(${fileCustodyMovementsTable.meta}->>'relatedReleaseMovementId')::int = ${Number(mv.id)}`,
      ));
    if (existingAck) { res.status(409).json({ error: "already_acknowledged" }); return; }
    if (mv.toHolderUserId && mv.toHolderUserId !== userId) {
      if (!(await hasPermissionOverride(req))) { res.status(403).json({ error: "not_your_acknowledgement" }); return; }
    }
    const [itemRaw] = await rdb(req).select().from(fileCustodyItemsTable).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, mv.custodyItemId)));
    if (!itemRaw) { res.status(404).json({ error: "item_not_found" }); return; }
    const item = itemRaw as any;
    const expectedVersion = Number(item.version) || 0;
    const expectedStatuses: Set<string> = new Set([...(ACTIVE_OUT as readonly string[]), "return_pending"]);
    if (!expectedStatuses.has(String(item.lifecycleStatus))) { res.status(409).json({ error: "invalid_status_for_acknowledge", message: `Cannot acknowledge while status=${String(item.lifecycleStatus)}` }); return; }
    const now = new Date();
    const [ackMv] = await rdb(req).insert(fileCustodyMovementsTable).values({
      firmId,
      custodyItemId: mv.custodyItemId,
      movementKind: "acknowledge",
      fromHolderUserId: mv.fromHolderUserId,
      fromHolderName: mv.fromHolderName,
      fromHolderContact: mv.fromHolderContact,
      fromHolderFirmExternal: mv.fromHolderFirmExternal,
      toHolderUserId: mv.toHolderUserId,
      toHolderName: mv.toHolderName,
      toHolderContact: mv.toHolderContact,
      toHolderFirmExternal: mv.toHolderFirmExternal,
      expectedReturnAt: mv.expectedReturnAt,
      acknowledgeDueAt: mv.acknowledgeDueAt,
      acknowledgedAt: now,
      acknowledgedByUserId: userId,
      acknowledgedNote: parsed.data.acknowledgedNote ?? null,
      movementNote: parsed.data.acknowledgedNote ?? null,
      severity: mv.severity ?? "normal",
      ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), createdByUserId: userId,
      meta: { relatedReleaseMovementId: Number(mv.id), receivedCondition: parsed.data.condition } as any,
    } as any).returning({ id: fileCustodyMovementsTable.id });
    const nextVersion = expectedVersion + 1;
    const [itemUpdated] = await rdb(req).update(fileCustodyItemsTable).set({
      acknowledgedAt: now,
      lastMovementId: Number(ackMv.id),
      updatedAt: now,
      version: nextVersion,
    } as any).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, mv.custodyItemId), eq(fileCustodyItemsTable.version, expectedVersion))).returning({ id: fileCustodyItemsTable.id });
    if (!itemUpdated) { res.status(409).json({ error: "version_conflict", message: "Concurrent modification on acknowledge. Re-read and retry." }); return; }
    void writeAuditLog({ entityId: parsed.data.movementId, action: "acknowledge", entityType: "file_custody_movement", firmId, actorId: userId, detail: parsed.data.acknowledgedNote ?? `condition=${parsed.data.condition} newMovementId=${ackMv.id} version=${expectedVersion}->${nextVersion}`, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, movementId: parsed.data.movementId, acknowledgeMovementId: Number(ackMv.id), acknowledgedAt: now.toISOString(), version: nextVersion });
  } catch (e) {
    res.status(500).json({ error: "ack_failed", detail: (e as Error).message });
  }
});

router.post("/file-custody/movements/return_request", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "return" }, { module: "file_custody", action: "manage" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_return", message: "file_custody:return or manage required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const parsed = MovementReturnRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [itemRaw] = await rdb(req).select().from(fileCustodyItemsTable).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, parsed.data.custodyItemId)));
    if (!itemRaw) { res.status(404).json({ error: "item_not_found" }); return; }
    const item = itemRaw as any;
    if (item.isArchived) { res.status(409).json({ error: "archived_cannot_return_request" }); return; }
    if (!(ACTIVE_OUT as readonly string[]).includes(String(item.lifecycleStatus))) { res.status(409).json({ error: "item_not_out_cannot_request_return" }); return; }
    if (parsed.data.requestedReturnByUserId && parsed.data.requestedReturnByUserId !== userId) {
      const [rv] = await rdb(req).select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.id, parsed.data.requestedReturnByUserId), eq(usersTable.firmId, firmId), eq(usersTable.status, "active")));
      if (!rv) { res.status(400).json({ error: "invalid_requested_return_by_user_id" }); return; }
    }
    const expectedVersion = Number(item.version) || 0;
    const now = new Date();
    const returnBy = parsed.data.requestedReturnAt ? new Date(parsed.data.requestedReturnAt) : new Date(now.getTime() + 72 * 3600 * 1000);
    const [mv] = await rdb(req).insert(fileCustodyMovementsTable).values({
      firmId,
      custodyItemId: parsed.data.custodyItemId,
      movementKind: "return_request",
      fromHolderUserId: item.currentHolderUserId ?? null,
      fromHolderName: item.currentHolderName ?? null,
      fromHolderContact: item.currentHolderContact ?? null,
      fromHolderFirmExternal: item.currentHolderFirmExternal ?? null,
      expectedReturnAt: returnBy,
      severity: "high",
      movementNote: parsed.data.note ?? null,
      ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), createdByUserId: parsed.data.requestedReturnByUserId ?? userId,
      meta: { requestedReturnByUserId: parsed.data.requestedReturnByUserId ?? userId } as any,
    } as any).returning({ id: fileCustodyMovementsTable.id });
    const nextVersion = expectedVersion + 1;
    const [itemUpdated] = await rdb(req).update(fileCustodyItemsTable).set({
      lifecycleStatus: "return_pending",
      expectedReturnAt: returnBy,
      lastMovementId: Number(mv.id),
      version: nextVersion,
    } as any).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, parsed.data.custodyItemId), eq(fileCustodyItemsTable.version, expectedVersion))).returning({ id: fileCustodyItemsTable.id });
    if (!itemUpdated) { res.status(409).json({ error: "version_conflict", message: "Concurrent state change on return_request. Re-read and retry." }); return; }
    if (item.currentHolderUserId) {
      void pushCustodyNotification({
        firmId, userId: Number(item.currentHolderUserId), custodyItemId: parsed.data.custodyItemId, movementId: Number(mv.id), caseId: item.caseId,
        kind: "return_overdue",
        title: `Return requested: ${String(item.fileReferenceNo ?? "")}`,
        message: parsed.data.note ?? `Please return this file by ${returnBy.toLocaleString("en-MY")}.`,
        severity: "high",
        acknowledgementDueAt: now, resolutionSlaDueAt: returnBy,
        targetScope: "user", dismissible: false,
        ip: req.ip, ua: String(req.headers["user-agent"] ?? ""),
      });
    }
    void writeAuditLog({ entityId: parsed.data.custodyItemId, action: "return_request", entityType: "file_custody_item", firmId, actorId: userId, detail: parsed.data.note ?? `requestedReturnAt=${returnBy.toISOString()} version=${expectedVersion}->${nextVersion}`, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.status(201).json({ ok: true, returnRequestMovementId: Number(mv.id), custodyItemId: parsed.data.custodyItemId, returnBy: returnBy.toISOString(), version: nextVersion });
  } catch (e) {
    res.status(500).json({ error: "return_request_failed", detail: (e as Error).message });
  }
});

router.post("/file-custody/movements/receive_return", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "receive" }, { module: "file_custody", action: "manage" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_receive", message: "file_custody:receive or manage required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const parsed = MovementReceiveReturnSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [mv] = await rdb(req).select().from(fileCustodyMovementsTable).where(and(eq(fileCustodyMovementsTable.firmId, firmId), eq(fileCustodyMovementsTable.id, parsed.data.movementId)));
    if (!mv) { res.status(404).json({ error: "movement_not_found" }); return; }
    if (!(mv.movementKind === "return_request" || mv.movementKind === "release")) { res.status(409).json({ error: "only_return_request_or_release_receivable" }); return; }
    const [existingReceive] = await rdb(req)
      .select({ id: fileCustodyMovementsTable.id })
      .from(fileCustodyMovementsTable)
      .where(and(
        eq(fileCustodyMovementsTable.firmId, firmId),
        eq(fileCustodyMovementsTable.custodyItemId, mv.custodyItemId),
        eq(fileCustodyMovementsTable.movementKind, "receive_return"),
        sql`(${fileCustodyMovementsTable.meta}->>'relatedMovementId')::int = ${Number(mv.id)}`,
      ));
    if (existingReceive) { res.status(409).json({ error: "already_received_return" }); return; }
    const [itemRaw] = await rdb(req).select().from(fileCustodyItemsTable).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, mv.custodyItemId)));
    if (!itemRaw) { res.status(404).json({ error: "item_not_found" }); return; }
    const item = itemRaw as any;
    const expectedVersion = Number(item.version) || 0;
    const now = new Date();
    const [receiveMv] = await rdb(req).insert(fileCustodyMovementsTable).values({
      firmId, custodyItemId: mv.custodyItemId, movementKind: "receive_return",
      fromHolderUserId: mv.toHolderUserId ?? item.currentHolderUserId ?? null,
      fromHolderName: mv.toHolderName ?? item.currentHolderName ?? null,
      fromHolderContact: mv.toHolderContact ?? item.currentHolderContact ?? null,
      fromHolderFirmExternal: mv.toHolderFirmExternal ?? item.currentHolderFirmExternal ?? null,
      toHolderUserId: userId,
      toHolderName: (req as any).userName ?? null,
      expectedReturnAt: null, acknowledgeDueAt: null,
      acknowledgedAt: now, acknowledgedByUserId: userId,
      acknowledgedNote: parsed.data.returnedNote ?? null,
      returnedAt: now, returnedByUserId: userId,
      returnedCondition: parsed.data.returnedCondition, returnedNote: parsed.data.returnedNote ?? null,
      severity: "info", movementNote: parsed.data.returnedNote ?? null,
      ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), createdByUserId: userId,
      meta: { relatedMovementId: Number(mv.id) } as any,
    } as any).returning({ id: fileCustodyMovementsTable.id });
    const nextVersion = expectedVersion + 1;
    const [itemUpdated] = await rdb(req).update(fileCustodyItemsTable).set({
      lifecycleStatus: "returned",
      currentHolderUserId: null, currentHolderName: null, currentHolderContact: null, currentHolderFirmExternal: null,
      expectedReturnAt: null, acknowledgeDueAt: null, acknowledgedAt: now,
      lastMovementId: Number(receiveMv.id),
      version: nextVersion,
    } as any).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, mv.custodyItemId), eq(fileCustodyItemsTable.version, expectedVersion))).returning({ id: fileCustodyItemsTable.id });
    if (!itemUpdated) { res.status(409).json({ error: "version_conflict", message: "Concurrent state transition detected. Re-read and retry." }); return; }
    void writeAuditLog({ entityId: parsed.data.movementId, action: "receive_return", entityType: "file_custody_movement", firmId, actorId: userId, detail: `condition=${parsed.data.returnedCondition} receiveMovementId=${receiveMv.id}`, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, movementId: parsed.data.movementId, receiveReturnMovementId: Number(receiveMv.id), custodyItemId: mv.custodyItemId, returnedAt: now.toISOString() });
  } catch (e) {
    res.status(500).json({ error: "receive_return_failed", detail: (e as Error).message });
  }
});

router.post("/file-custody/movements/return", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "receive" }, { module: "file_custody", action: "manage" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_receive", message: "file_custody:receive or manage required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const parsed = MovementReturnSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [mv] = await rdb(req).select().from(fileCustodyMovementsTable).where(and(eq(fileCustodyMovementsTable.firmId, firmId), eq(fileCustodyMovementsTable.id, parsed.data.movementId)));
    if (!mv) { res.status(404).json({ error: "movement_not_found" }); return; }
    if (mv.movementKind !== "release") { res.status(409).json({ error: "only_release_returnable" }); return; }
    const [existingReturn] = await rdb(req)
      .select({ id: fileCustodyMovementsTable.id })
      .from(fileCustodyMovementsTable)
      .where(and(
        eq(fileCustodyMovementsTable.firmId, firmId),
        eq(fileCustodyMovementsTable.custodyItemId, mv.custodyItemId),
        eq(fileCustodyMovementsTable.movementKind, "return"),
        sql`(${fileCustodyMovementsTable.meta}->>'relatedReleaseMovementId')::int = ${Number(mv.id)}`,
      ));
    if (existingReturn) { res.status(409).json({ error: "already_returned" }); return; }
    const [itemRaw] = await rdb(req).select().from(fileCustodyItemsTable).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, mv.custodyItemId)));
    if (!itemRaw) { res.status(404).json({ error: "item_not_found" }); return; }
    const expectedVersion = Number((itemRaw as any).version) || 0;
    const now = new Date();
    const [retMv] = await rdb(req).insert(fileCustodyMovementsTable).values({
      firmId, custodyItemId: mv.custodyItemId, movementKind: "return",
      fromHolderUserId: mv.toHolderUserId, fromHolderName: mv.toHolderName, fromHolderContact: mv.toHolderContact, fromHolderFirmExternal: mv.toHolderFirmExternal,
      toHolderUserId: userId, toHolderName: (req as any).userName ?? null,
      expectedReturnAt: null, acknowledgeDueAt: null,
      acknowledgedAt: now, acknowledgedByUserId: userId, acknowledgedNote: "auto-ack on return",
      returnedAt: now, returnedByUserId: userId, returnedCondition: parsed.data.returnedCondition, returnedNote: parsed.data.returnedNote ?? null,
      severity: "info", movementNote: parsed.data.returnedNote ?? null,
      ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), createdByUserId: userId,
      meta: { relatedReleaseMovementId: Number(mv.id) } as any,
    } as any).returning({ id: fileCustodyMovementsTable.id });
    const nextVersion = expectedVersion + 1;
    const [itemUpdated] = await rdb(req).update(fileCustodyItemsTable).set({
      lifecycleStatus: "returned", currentHolderUserId: null, currentHolderName: null, currentHolderContact: null, currentHolderFirmExternal: null,
      expectedReturnAt: null, acknowledgeDueAt: null, acknowledgedAt: now,
      lastMovementId: Number(retMv.id), version: nextVersion,
    } as any).where(and(eq(fileCustodyItemsTable.firmId, firmId), eq(fileCustodyItemsTable.id, mv.custodyItemId), eq(fileCustodyItemsTable.version, expectedVersion))).returning({ id: fileCustodyItemsTable.id });
    if (!itemUpdated) { res.status(409).json({ error: "version_conflict", message: "Concurrent transition on return. Re-read and retry." }); return; }
    void writeAuditLog({ entityId: parsed.data.movementId, action: "return", entityType: "file_custody_movement", firmId, actorId: userId, detail: parsed.data.returnedNote ?? `condition=${parsed.data.returnedCondition} retMv=${retMv.id}`, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, movementId: parsed.data.movementId, custodyItemId: mv.custodyItemId, returnMovementId: Number(retMv.id), returnedAt: now.toISOString() });
  } catch (e) {
    res.status(500).json({ error: "return_failed", detail: (e as Error).message });
  }
});

router.post("/file-custody/movements/:id/escalate", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "manage" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_manage", message: "file_custody:manage required for escalation" }); return;
  }
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
    const id = asInt(req.params.id);
    if (!Number.isFinite(id!)) { res.status(400).json({ error: "invalid_id" }); return; }
    const parsed = EscalateSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: "invalid_body", issues: parsed.error.issues }); return; }
    const [mv] = await rdb(req).select().from(fileCustodyMovementsTable).where(and(eq(fileCustodyMovementsTable.firmId, firmId), eq(fileCustodyMovementsTable.id, id!)));
    if (!mv) { res.status(404).json({ error: "not_found" }); return; }
    let targetPartnerUserId: number | null = null;
    let allPartners = false;
    if (parsed.data.targetPartnerUserId) {
      const maybe = Number(parsed.data.targetPartnerUserId);
      if (!Number.isFinite(maybe)) { res.status(400).json({ error: "invalid_target_partner" }); return; }
      const [verify] = await rdb(req).select({ id: usersTable.id }).from(usersTable).innerJoin(rolesTable, eq(usersTable.roleId, rolesTable.id)).where(and(eq(usersTable.firmId, firmId), eq(usersTable.id, maybe), eq(usersTable.status, "active"), sql`lower(${rolesTable.name}) = 'partner'`));
      if (!verify) { res.status(400).json({ error: "target_not_active_partner" }); return; }
      targetPartnerUserId = maybe;
    } else allPartners = true;
    const now = new Date();
    const [escMv] = await rdb(req).insert(fileCustodyMovementsTable).values({
      firmId, custodyItemId: mv.custodyItemId, movementKind: "overdue_auto_flag",
      fromHolderUserId: mv.toHolderUserId, toHolderUserId: targetPartnerUserId ?? null,
      toHolderName: allPartners ? "ALL PARTNERS" : null,
      escalatedAt: now, escalatedToPartner: true,
      severity: "urgent", movementNote: parsed.data.note ?? null,
      ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? ""), createdByUserId: userId,
      meta: { relatedMovementId: id! } as any,
    } as any).returning({ id: fileCustodyMovementsTable.id });
    const partners = allPartners
      ? await rdb(req).select({ id: usersTable.id }).from(usersTable).innerJoin(rolesTable, eq(usersTable.roleId, rolesTable.id)).where(and(eq(usersTable.firmId, firmId), eq(usersTable.status, "active"), sql`lower(${rolesTable.name}) = 'partner'`))
      : [{ id: targetPartnerUserId! }];
    for (const p of partners) {
      void pushCustodyNotification({
        firmId, userId: p.id, custodyItemId: mv.custodyItemId, movementId: id!,
        kind: "return_overdue",
        title: `Custody escalated — itemId ${mv.custodyItemId}`,
        message: parsed.data.note ?? `Movement ${id} requires partner attention.`,
        severity: "urgent", targetScope: allPartners ? "all_partners" : "selected_partner", dismissible: false,
        acknowledgementDueAt: now, resolutionSlaDueAt: new Date(Date.now() + 12 * 3600 * 1000),
        ip: req.ip, ua: String(req.headers["user-agent"] ?? ""),
      });
    }
    void writeAuditLog({ entityId: id!, action: "escalate", entityType: "file_custody_movement", firmId, actorId: userId, detail: parsed.data.note ?? (allPartners ? "all partners" : `partner ${targetPartnerUserId}`) + ` escalateMv=${escMv.id}`, ipAddress: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
    res.json({ ok: true, movementId: id!, escalateMovementId: Number(escMv.id), allPartners, targetPartnerUserId, escalatedAt: now.toISOString() });
  } catch (e) {
    res.status(500).json({ error: "escalate_failed", detail: (e as Error).message });
  }
});

router.get("/file-custody/partners", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await requireAny(req, [{ module: "file_custody", action: "view" }, { module: "case_monitor", action: "view" }]))) {
    res.status(403).json({ error: "forbidden_file_custody_view", message: "file_custody:view or case_monitor:view required" }); return;
  }
  try {
    const firmId = req.firmId!;
    const rows = await rdb(req).select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, roleName: rolesTable.name }).from(usersTable).innerJoin(rolesTable, eq(usersTable.roleId, rolesTable.id)).where(and(eq(usersTable.firmId, firmId), eq(usersTable.status, "active"), sql`lower(${rolesTable.name}) = 'partner'`)).orderBy(asc(usersTable.name));
    res.json({ partners: rows });
  } catch (e) {
    res.status(500).json({ error: "partners_unavailable", detail: (e as Error).message });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
