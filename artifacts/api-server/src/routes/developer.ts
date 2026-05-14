import express, { type Router as ExpressRouter } from "express";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import {
  caseKeyDatesTable,
  caseMessagesTable,
  casePurchasersTable,
  casesTable,
  clientsTable,
  developersTable,
  projectsTable,
  rolesTable,
  usersTable,
  type RlsDb,
  db,
} from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { loanStatusSql, spaStatusSql } from "../lib/caseListLogic.js";

type ReqLike = IncomingMessage & {
  body?: unknown;
  headers: IncomingHttpHeaders & Record<string, string | string[] | undefined>;
  ip?: string;
  originalUrl?: string;
  params?: Record<string, unknown>;
  path?: string;
  query?: Record<string, unknown>;
  firmId?: number | null;
  userId?: number | null;
  userType?: string | null;
  roleId?: number | null;
  developerId?: number | null;
  rlsDb?: unknown;
  [key: string]: unknown;
};

type RouteResLike = {
  status: (code: number) => RouteResLike;
  json: (body: unknown) => unknown;
  send: (body: unknown) => unknown;
  setHeader: (key: string, value: string) => unknown;
  [key: string]: unknown;
};

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const routerInternal = expressRouter as unknown as RouterInternalLike;

type AuthRequestLike = AuthRequest & ReqLike;
type DbConn = typeof db | RlsDb;
const rdb = (req: AuthRequestLike): DbConn => (req.rlsDb as DbConn | undefined) ?? db;

function safeFilenameAscii(filename: string): string {
  const base = filename.replace(/[\r\n"]/g, "").trim();
  if (!base) return "download";
  return base.replace(/[^\x20-\x7E]/g, "_");
}

async function requireDeveloperUser(req: AuthRequestLike, res: RouteResLike): Promise<{ firmId: number; developerId: number; userId: number } | null> {
  if (req.userType !== "firm_user" || !req.firmId || !req.userId || !req.roleId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  const r = rdb(req);
  const [role] = await r
    .select({ name: rolesTable.name })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, req.roleId), eq(rolesTable.firmId, req.firmId)))
    .limit(1);
  if (role?.name !== "Developer_User") {
    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType ?? "firm_user",
      action: "auth.forbidden.developer_portal_role_required",
      detail: `${req.method} ${req.path}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    }, { db: req.rlsDb as RlsDb | undefined });
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  const developerId = typeof req.developerId === "number" && Number.isFinite(req.developerId) ? req.developerId : null;
  if (!developerId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  const [dev] = await r
    .select({ id: developersTable.id })
    .from(developersTable)
    .where(and(eq(developersTable.id, developerId), eq(developersTable.firmId, req.firmId)))
    .limit(1);
  if (!dev) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { firmId: req.firmId, developerId, userId: req.userId };
}

function toIsoStringSafe(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return typeof v === "string" ? v : String(v);
  }
  return String(v ?? "");
}

const ListInventoryQuery = (q: unknown) => {
  const page = q && typeof q === "object" ? Number((q as any).page ?? 1) : 1;
  const limit = q && typeof q === "object" ? Number((q as any).limit ?? 50) : 50;
  const projectId = q && typeof q === "object" ? Number((q as any).projectId ?? NaN) : NaN;
  const search = q && typeof q === "object" ? String((q as any).search ?? "") : "";
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    limit: Number.isFinite(limit) && limit > 0 && limit <= 500 ? limit : 50,
    projectId: Number.isFinite(projectId) && projectId > 0 ? projectId : null,
    search: search.trim(),
  };
};

const purchaserNameSql = sql<string | null>`(
  SELECT ${clientsTable.name}
  FROM ${casePurchasersTable}
  INNER JOIN ${clientsTable} ON ${casePurchasersTable.clientId} = ${clientsTable.id}
  WHERE ${casePurchasersTable.caseId} = ${casesTable.id}
  ORDER BY ${casePurchasersTable.orderNo} ASC
  LIMIT 1
)`;

const purchaserNamesSql = sql<string | null>`(
  SELECT string_agg(${clientsTable.name}, ', ' ORDER BY ${casePurchasersTable.orderNo} ASC)
  FROM ${casePurchasersTable}
  INNER JOIN ${clientsTable} ON ${casePurchasersTable.clientId} = ${clientsTable.id}
  WHERE ${casePurchasersTable.caseId} = ${casesTable.id}
)`;

routerInternal.get("/developer/dashboard", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);

  const [agg] = await r
    .select({
      spaSigned: sql<number>`COUNT(*) FILTER (WHERE ${caseKeyDatesTable.spaSignedDate} IS NOT NULL)`,
      loanApproved: sql<number>`COUNT(*) FILTER (WHERE ${casesTable.purchaseMode} = 'loan' AND ${caseKeyDatesTable.bankLuReceivedDate} IS NOT NULL)`,
      handover: sql<number>`COUNT(*) FILTER (WHERE ${caseKeyDatesTable.completionDate} IS NOT NULL)`,
      stamping: sql<number>`COUNT(*) FILTER (WHERE ${caseKeyDatesTable.spaStampedDate} IS NOT NULL OR ${caseKeyDatesTable.letterOfOfferStampedDate} IS NOT NULL)`,
      advice: sql<number>`COUNT(*) FILTER (WHERE ${caseKeyDatesTable.adviceToBankDate} IS NOT NULL)`,
      mot: sql<number>`COUNT(*) FILTER (WHERE ${caseKeyDatesTable.motReceivedDate} IS NOT NULL OR ${caseKeyDatesTable.motSignedDate} IS NOT NULL OR ${caseKeyDatesTable.motStampedDate} IS NOT NULL OR ${caseKeyDatesTable.motRegisteredDate} IS NOT NULL)`,
    })
    .from(casesTable)
    .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
    .where(and(eq(casesTable.firmId, ctx.firmId), eq(casesTable.developerId, ctx.developerId)));

  const staleRows = await r
    .select({
      id: casesTable.id,
      referenceNo: casesTable.referenceNo,
      unitNo: casesTable.parcelNo,
      projectName: projectsTable.name,
      purchaserName: purchaserNameSql,
      purchaserNames: purchaserNamesSql,
      spaStatus: spaStatusSql(),
      loanStatus: loanStatusSql(),
      updatedAt: casesTable.updatedAt,
    })
    .from(casesTable)
    .innerJoin(projectsTable, eq(casesTable.projectId, projectsTable.id))
    .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
    .where(and(
      eq(casesTable.firmId, ctx.firmId),
      eq(casesTable.developerId, ctx.developerId),
      sql`${casesTable.updatedAt} < (NOW() - INTERVAL '21 days')`,
    ))
    .orderBy(asc(casesTable.updatedAt))
    .limit(50);

  res.json({
    kpis: {
      spaSigned: Number(agg?.spaSigned ?? 0),
      loanApproved: Number(agg?.loanApproved ?? 0),
      handover: Number(agg?.handover ?? 0),
    },
    stageDistribution: [
      { stage: "Stamping", count: Number(agg?.stamping ?? 0) },
      { stage: "Advice", count: Number(agg?.advice ?? 0) },
      { stage: "MOT", count: Number(agg?.mot ?? 0) },
    ],
    stagnantCases: staleRows.map((c) => ({
      id: c.id,
      referenceNo: c.referenceNo,
      unitNo: c.unitNo ?? null,
      projectName: c.projectName,
      purchaserName: (c as any).purchaserNames ?? c.purchaserName ?? null,
      spaStatus: String(c.spaStatus ?? "Pending"),
      loanStatus: c.loanStatus == null ? null : String(c.loanStatus),
      updatedAt: toIsoStringSafe(c.updatedAt),
    })),
  });
});

routerInternal.get("/developer/inventory", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const q = ListInventoryQuery(req.query);
  const offset = (q.page - 1) * q.limit;

  const conditions: any[] = [
    eq(casesTable.firmId, ctx.firmId),
    eq(casesTable.developerId, ctx.developerId),
  ];
  if (q.projectId) conditions.push(eq(casesTable.projectId, q.projectId));
  if (q.search) {
    const like = `%${q.search}%`;
    conditions.push(or(
      ilike(casesTable.referenceNo, like),
      ilike(casesTable.parcelNo, like),
      sql`EXISTS (
        SELECT 1
        FROM ${casePurchasersTable}
        INNER JOIN ${clientsTable} ON ${casePurchasersTable.clientId} = ${clientsTable.id}
        WHERE ${casePurchasersTable.caseId} = ${casesTable.id}
          AND ${clientsTable.name} ILIKE ${like}
      )`,
    ));
  }

  const [totalRes] = await r
    .select({ c: count() })
    .from(casesTable)
    .where(and(...conditions));

  const rows = await r
    .select({
      id: casesTable.id,
      referenceNo: casesTable.referenceNo,
      unitNo: casesTable.parcelNo,
      projectName: projectsTable.name,
      purchaserName: purchaserNameSql,
      purchaserNames: purchaserNamesSql,
      spaStatus: spaStatusSql(),
      loanStatus: loanStatusSql(),
      updatedAt: casesTable.updatedAt,
      lawyerStatus: casesTable.lawyerStatus,
      lawyerStatusUpdatedAt: casesTable.lawyerStatusUpdatedAt,
      developerStatus: casesTable.developerStatus,
      developerStatusUpdatedAt: casesTable.developerStatusUpdatedAt,
    })
    .from(casesTable)
    .innerJoin(projectsTable, eq(casesTable.projectId, projectsTable.id))
    .where(and(...conditions))
    .orderBy(desc(casesTable.updatedAt))
    .limit(q.limit)
    .offset(offset);

  res.json({
    data: rows.map((c) => ({
      id: c.id,
      referenceNo: c.referenceNo,
      unitNo: c.unitNo ?? null,
      projectName: c.projectName,
      purchaserNames: (c as any).purchaserNames ?? null,
      purchaserName: c.purchaserName ?? null,
      spaStatus: String(c.spaStatus ?? "Pending"),
      loanStatus: c.loanStatus == null ? null : String(c.loanStatus),
      updatedAt: toIsoStringSafe(c.updatedAt),
      lawyerStatus: c.lawyerStatus ?? null,
      lawyerStatusUpdatedAt: c.lawyerStatusUpdatedAt ? toIsoStringSafe(c.lawyerStatusUpdatedAt) : null,
      developerStatus: c.developerStatus ?? null,
      developerStatusUpdatedAt: c.developerStatusUpdatedAt ? toIsoStringSafe(c.developerStatusUpdatedAt) : null,
    })),
    total: Number(totalRes?.c ?? 0),
    page: q.page,
    limit: q.limit,
  });
});

routerInternal.patch("/developer/cases/:caseId/status", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const caseId = Number((req.params as any)?.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const body = req.body as any;
  const rawStatus = body?.developerStatus;
  const developerStatus =
    rawStatus === null
      ? null
      : typeof rawStatus === "string"
          ? (rawStatus.trim() ? rawStatus.trim() : null)
          : undefined;
  if (developerStatus === undefined || (typeof developerStatus === "string" && developerStatus.length > 2000)) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const now = new Date();
  const [updated] = await r
    .update(casesTable)
    .set({
      developerStatus,
      developerStatusUpdatedAt: now,
    })
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, ctx.firmId), eq(casesTable.developerId, ctx.developerId)))
    .returning({
      id: casesTable.id,
      developerStatus: casesTable.developerStatus,
      developerStatusUpdatedAt: casesTable.developerStatusUpdatedAt,
    });

  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  await writeAuditLog({
    firmId: ctx.firmId,
    actorId: ctx.userId,
    actorType: "developer_user",
    action: "developer_portal.case_status.update",
    entityType: "case",
    entityId: caseId,
    detail: JSON.stringify({ developerStatus }),
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb as RlsDb | undefined });

  res.json({
    developerStatus: updated.developerStatus ?? null,
    developerStatusUpdatedAt: updated.developerStatusUpdatedAt ? toIsoStringSafe(updated.developerStatusUpdatedAt) : null,
  });
});

routerInternal.get("/developer/inventory/export.xlsx", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const q = ListInventoryQuery(req.query);

  const conditions: any[] = [
    eq(casesTable.firmId, ctx.firmId),
    eq(casesTable.developerId, ctx.developerId),
  ];
  if (q.projectId) conditions.push(eq(casesTable.projectId, q.projectId));
  if (q.search) {
    const like = `%${q.search}%`;
    conditions.push(or(
      ilike(casesTable.referenceNo, like),
      ilike(casesTable.parcelNo, like),
      sql`EXISTS (
        SELECT 1
        FROM ${casePurchasersTable}
        INNER JOIN ${clientsTable} ON ${casePurchasersTable.clientId} = ${clientsTable.id}
        WHERE ${casePurchasersTable.caseId} = ${casesTable.id}
          AND ${clientsTable.name} ILIKE ${like}
      )`,
    ));
  }

  const rows = await r
    .select({
      referenceNo: casesTable.referenceNo,
      unitNo: casesTable.parcelNo,
      projectName: projectsTable.name,
      purchaserName: purchaserNameSql,
      purchaserNames: purchaserNamesSql,
      spaStatus: spaStatusSql(),
      loanStatus: loanStatusSql(),
      updatedAt: casesTable.updatedAt,
    })
    .from(casesTable)
    .innerJoin(projectsTable, eq(casesTable.projectId, projectsTable.id))
    .where(and(...conditions))
    .orderBy(desc(casesTable.updatedAt))
    .limit(5000);

  const exportRows = rows.map((r) => ({
    "Reference No": r.referenceNo,
    "Unit No": r.unitNo ?? "",
    "Purchaser": (r as any).purchaserNames ?? r.purchaserName ?? "",
    "Project": r.projectName,
    "SPA Status": String(r.spaStatus ?? "Pending"),
    "Loan Status": r.loanStatus == null ? "" : String(r.loanStatus),
    "Last Updated": toIsoStringSafe(r.updatedAt),
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportRows);
  XLSX.utils.book_append_sheet(wb, ws, "Inventory");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Buffer;

  const fileName = safeFilenameAscii(`developer_inventory_${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(buf);
});

routerInternal.get("/developer/cases/:caseId/messages", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const caseId = Number((req.params as any)?.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const [c] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, ctx.firmId), eq(casesTable.developerId, ctx.developerId)))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const channelRaw = (req as any)?.query?.channel;
  const channel = typeof channelRaw === "string" ? channelRaw : (Array.isArray(channelRaw) ? channelRaw[0] : undefined);
  if (channel && channel !== "developer") {
    res.status(400).json({ error: "Invalid channel" });
    return;
  }

  const rows = await r
    .select({
      id: caseMessagesTable.id,
      senderType: caseMessagesTable.senderType,
      senderId: caseMessagesTable.senderId,
      senderName: usersTable.name,
      messageText: caseMessagesTable.messageText,
      attachments: caseMessagesTable.attachments,
      createdAt: caseMessagesTable.createdAt,
    })
    .from(caseMessagesTable)
    .leftJoin(usersTable, eq(caseMessagesTable.senderId, usersTable.id))
    .where(and(
      eq(caseMessagesTable.firmId, ctx.firmId),
      eq(caseMessagesTable.caseId, caseId),
      eq(caseMessagesTable.channel, "developer"),
      inArray(caseMessagesTable.senderType, ["developer", "staff"]),
    ))
    .orderBy(asc(caseMessagesTable.createdAt))
    .limit(200);

  res.setHeader("Cache-Control", "no-store");
  res.json({
    data: rows.map((m) => ({
      id: String(m.id),
      senderType: String(m.senderType) === "staff" ? "staff" : "developer",
      senderName: String(m.senderType) === "staff"
        ? (m.senderName ? String(m.senderName) : "Staff")
        : "You",
      messageText: String(m.messageText ?? ""),
      attachments: m.attachments ?? [],
      createdAt: toIsoStringSafe(m.createdAt),
    })),
  });
});

routerInternal.post("/developer/cases/:caseId/messages", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const caseId = Number((req.params as any)?.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const body = req.body as any;
  const messageText = typeof body?.messageText === "string" ? body.messageText.trim() : "";
  if (!messageText || messageText.length > 2000) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  if (body?.channel && String(body.channel) !== "developer") {
    res.status(400).json({ error: "Invalid channel" });
    return;
  }

  const [c] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, ctx.firmId), eq(casesTable.developerId, ctx.developerId)))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [created] = await r
    .insert(caseMessagesTable)
    .values({
      firmId: ctx.firmId,
      caseId,
      channel: "developer",
      senderType: "developer",
      senderId: ctx.userId,
      messageText,
      attachments: [],
    })
    .returning({ id: caseMessagesTable.id, createdAt: caseMessagesTable.createdAt });

  await writeAuditLog({
    firmId: ctx.firmId,
    actorId: ctx.userId,
    actorType: "developer_user",
    action: "developer_portal.message.create",
    entityType: "case",
    entityId: caseId,
    detail: "developer_message",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb as RlsDb | undefined });

  res.status(201).json({ id: String(created?.id ?? ""), createdAt: toIsoStringSafe(created?.createdAt) });
});

routerInternal.get("/developer/cases/:caseId/progress", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const caseId = Number((req.params as any)?.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }
  const [c] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, ctx.firmId), eq(casesTable.developerId, ctx.developerId)))
    .limit(1);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [kd] = await r
    .select({
      spaSignedDate: caseKeyDatesTable.spaSignedDate,
      spaDate: caseKeyDatesTable.spaDate,
      spaStampedDate: caseKeyDatesTable.spaStampedDate,
      letterOfOfferDate: caseKeyDatesTable.letterOfOfferDate,
      letterOfOfferStampedDate: caseKeyDatesTable.letterOfOfferStampedDate,
      bankLuReceivedDate: caseKeyDatesTable.bankLuReceivedDate,
      motSignedDate: caseKeyDatesTable.motSignedDate,
      motStampedDate: caseKeyDatesTable.motStampedDate,
      motRegisteredDate: caseKeyDatesTable.motRegisteredDate,
      completionDate: caseKeyDatesTable.completionDate,
    })
    .from(caseKeyDatesTable)
    .where(and(eq(caseKeyDatesTable.firmId, ctx.firmId), eq(caseKeyDatesTable.caseId, caseId)))
    .limit(1);

  res.setHeader("Cache-Control", "no-store");
  res.json({
    keyDates: {
      spa_signed_date: kd?.spaSignedDate ? String(kd.spaSignedDate) : null,
      spa_date: kd?.spaDate ? String(kd.spaDate) : null,
      spa_stamped_date: kd?.spaStampedDate ? String(kd.spaStampedDate) : null,
      letter_of_offer_date: kd?.letterOfOfferDate ? String(kd.letterOfOfferDate) : null,
      letter_of_offer_stamped_date: kd?.letterOfOfferStampedDate ? String(kd.letterOfOfferStampedDate) : null,
      bank_lu_received_date: kd?.bankLuReceivedDate ? String(kd.bankLuReceivedDate) : null,
      mot_signed_date: kd?.motSignedDate ? String(kd.motSignedDate) : null,
      mot_stamped_date: kd?.motStampedDate ? String(kd.motStampedDate) : null,
      mot_registered_date: kd?.motRegisteredDate ? String(kd.motRegisteredDate) : null,
      completion_date: kd?.completionDate ? String(kd.completionDate) : null,
    },
  });
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
