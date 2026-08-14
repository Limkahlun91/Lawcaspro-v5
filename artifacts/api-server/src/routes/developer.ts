import express, { type Router as ExpressRouter } from "express";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import {
  caseAssignmentsTable,
  caseKeyDatesTable,
  caseMessagesTable,
  casePurchasersTable,
  casesTable,
  caseWorkflowStepsTable,
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
import {
  classifyCurrentStageLabel,
  classifySpaLoanStage,
  collectAttentionItems,
  deriveMotStatus,
  deriveNextAction,
  deriveSpaStatus,
  deriveLoanStatus,
  formatPurchasePrice,
  getDeveloperPortalUnitLabel,
  kdFromJoined,
  mapJoinedCaseToDetailDto,
  mapJoinedCaseToListDto,
  sanitizePurchasers,
  summarizeCards,
  summarizeProgress,
  toBankName,
  buildSpaLoanTimeline,
  buildMotTimeline,
  buildRecentActivity,
  extractLawyerClerk,
  portalSummaryAggregateSelect,
  portalProgressAggregateSelect,
  portalStagePredicateSql,
  type DevPortalStageFilter,
  type UnitListDto,
  type AttentionItem,
  type SummaryCards,
  type ProgressStrip,
  type UnitDetailDto,
} from "../lib/developer-portal.js";

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
  const stageRaw = q && typeof q === "object" ? String((q as any).stage ?? "all") : "all";
  const attentionRaw = q && typeof q === "object" ? String((q as any).attention ?? "") : "";
  const stage: DevPortalStageFilter =
    stageRaw === "spa" || stageRaw === "spa_stamped" || stageRaw === "loan" || stageRaw === "attention" || stageRaw === "completed"
      ? stageRaw
      : "all";
  const attentionOnly = attentionRaw === "1" || attentionRaw === "true" || stage === "attention";
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    limit: Number.isFinite(limit) && limit > 0 && limit <= 500 ? limit : 50,
    projectId: Number.isFinite(projectId) && projectId > 0 ? projectId : null,
    search: search.trim(),
    stage,
    attentionOnly,
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

routerInternal.patch("/developer/cases/:caseId/status", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  res.status(410).json({
    code: "DEVELOPER_STATUS_WRITE_RETIRED",
    message: "Case status is managed by the law firm workflow.",
  });
  return;
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

const developerPortalColumnsForList = {
  id: casesTable.id,
  referenceNo: casesTable.referenceNo,
  parcelNo: casesTable.parcelNo,
  purchaseMode: casesTable.purchaseMode,
  status: casesTable.status,
  updatedAt: casesTable.updatedAt,
  createdAt: casesTable.createdAt,
  propertyDetails: casesTable.propertyDetails,
  loanDetails: casesTable.loanDetails,
  titleType: casesTable.titleType,
  spaPrice: casesTable.spaPrice,
  projectName: projectsTable.name,
  phase: projectsTable.phase,
  purchaserNames: purchaserNamesSql,
  kd_spaStampedDate: caseKeyDatesTable.spaStampedDate,
  kd_spaSignedDate: caseKeyDatesTable.spaSignedDate,
  kd_spaDate: caseKeyDatesTable.spaDate,
  kd_spaForwardToDeveloperExecutionOn: caseKeyDatesTable.spaForwardToDeveloperExecutionOn,
  kd_spaReceivedDevReturnSpaOn: caseKeyDatesTable.spaReceivedDevReturnSpaOn,
  kd_letterOfOfferDate: caseKeyDatesTable.letterOfOfferDate,
  kd_letterOfOfferStampedDate: caseKeyDatesTable.letterOfOfferStampedDate,
  kd_actingLetterIssuedDate: caseKeyDatesTable.actingLetterIssuedDate,
  kd_bankLuReceivedDate: caseKeyDatesTable.bankLuReceivedDate,
  kd_adviceToBankDate: caseKeyDatesTable.adviceToBankDate,
  kd_motReceivedDate: caseKeyDatesTable.motReceivedDate,
  kd_motSignedDate: caseKeyDatesTable.motSignedDate,
  kd_motStampedDate: caseKeyDatesTable.motStampedDate,
  kd_motRegisteredDate: caseKeyDatesTable.motRegisteredDate,
  kd_completionDate: caseKeyDatesTable.completionDate,
  kd_loanDocsPendingDate: caseKeyDatesTable.loanDocsPendingDate,
  kd_loanDocsSignedDate: caseKeyDatesTable.loanDocsSignedDate,
  kd_loanAgreementStampedDate: caseKeyDatesTable.loanAgreementStampedDate,
  kd_dischargeTitleReceivedOn: caseKeyDatesTable.dischargeTitleReceivedOn,
  kd_consentToTransferDate: caseKeyDatesTable.consentToTransferDate,
};

type JoinedForPortal = Awaited<ReturnType<typeof loadJoinedDeveloperRows>>[number];

async function loadJoinedDeveloperRows(
  r: typeof db | RlsDb,
  conditions: any[],
  orderBy: any[],
  limit?: number,
  offset?: number,
) {
  let q: any = r
    .select(developerPortalColumnsForList)
    .from(casesTable)
    .innerJoin(projectsTable, eq(casesTable.projectId, projectsTable.id))
    .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
    .where(and(...conditions));
  if (Array.isArray(orderBy) && orderBy.length) q = q.orderBy(...(orderBy as any));
  if (typeof limit === "number") q = q.limit(limit);
  if (typeof offset === "number") q = q.offset(offset);
  return q as unknown as Promise<any[]>;
}

function enrichAssignments(
  rows: JoinedForPortal[],
  assignments: Record<number, { lawyer: string | null; clerk: string | null }>,
) {
  for (const row of rows as any[]) {
    const a = assignments[row.id] ?? { lawyer: null, clerk: null };
    row.lawyerName = a.lawyer;
    row.clerkName = a.clerk;
  }
}

function applyStageFilterPredicate(dto: UnitListDto, stage: DevPortalStageFilter): boolean {
  switch (stage) {
    case "spa":
      return dto.spa.status === "In Progress" || dto.spa.status === "Attention Required" || dto.currentStage === "SPA Signing";
    case "spa_stamped":
      return dto.spa.label === "SPA Stamped" && dto.spa.status === "Completed";
    case "loan":
      return dto.loan.status === "In Progress" || dto.loan.status === "Attention Required" || dto.loan.status === "Completed";
    case "attention":
      return !!dto.nextAction?.attentionRequired || dto.spa.status === "Attention Required" || dto.loan.status === "Attention Required";
    case "completed":
      return dto.currentStage === "Completed / Handover";
    case "all":
    default:
      return true;
  }
}

routerInternal.get("/developer/portal/projects", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const rows = await r
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      phase: projectsTable.phase,
      activeUnitCount: sql<number>`COUNT(${casesTable.id})::int`,
    })
    .from(projectsTable)
    .innerJoin(casesTable, and(
      eq(casesTable.projectId, projectsTable.id),
      eq(casesTable.firmId, projectsTable.firmId),
      eq(casesTable.developerId, ctx.developerId),
      sql`COALESCE(${casesTable.deletedAt}, 'infinity'::timestamptz) > now()`,
    ))
    .where(and(eq(projectsTable.firmId, ctx.firmId)))
    .groupBy(projectsTable.id, projectsTable.name, projectsTable.phase)
    .orderBy(asc(projectsTable.name), asc(projectsTable.phase));
  res.setHeader("Cache-Control", "no-store");
  res.json(rows.map((r) => ({ id: r.id, name: r.name, phase: r.phase ?? null, activeUnitCount: Number(r.activeUnitCount ?? 0) })));
});

routerInternal.get("/developer/portal/overview", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const projectIdRaw = typeof (req.query as any)?.projectId === "string" ? Number((req.query as any).projectId) : null;
  const projectId = Number.isFinite(projectIdRaw) && projectIdRaw !== null && (projectIdRaw as number) > 0 ? (projectIdRaw as number) : null;
  const baseConditions: any[] = [
    eq(casesTable.firmId, ctx.firmId),
    eq(casesTable.developerId, ctx.developerId),
  ];
  if (projectId) baseConditions.push(eq(casesTable.projectId, projectId));

  const [dev] = await r.select({ name: developersTable.name }).from(developersTable).where(and(eq(developersTable.id, ctx.developerId), eq(developersTable.firmId, ctx.firmId))).limit(1);
  let resolvedProjectName: string | null = null;
  let resolvedPhase: string | null = null;
  if (projectId) {
    const [p] = await r.select({ name: projectsTable.name, phase: projectsTable.phase }).from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.firmId, ctx.firmId), eq(projectsTable.developerId, ctx.developerId))).limit(1);
    resolvedProjectName = p?.name ?? null;
    resolvedPhase = p?.phase ?? null;
  }

  const [aggSummary] = await r
    .select(portalSummaryAggregateSelect())
    .from(casesTable)
    .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
    .where(and(...baseConditions)) as unknown as Array<{
      total_units: number;
      spa_in_progress: number;
      spa_stamped: number;
      loan_in_progress: number;
      needs_attention: number;
      completed_handover: number;
      last_updated_at: string | null;
    }>;
  const [aggProgress] = await r
    .select(portalProgressAggregateSelect())
    .from(casesTable)
    .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
    .where(and(...baseConditions)) as unknown as Array<{ spa_progressing: number; loan_progressing: number; mot_progressing: number; completed_progressing: number; total: number }>;

  const summary: SummaryCards = {
    totalUnits: Number(aggSummary?.total_units ?? 0),
    spaInProgress: Number(aggSummary?.spa_in_progress ?? 0),
    spaStamped: Number(aggSummary?.spa_stamped ?? 0),
    loanInProgress: Number(aggSummary?.loan_in_progress ?? 0),
    needsAttention: Number(aggSummary?.needs_attention ?? 0),
    completedHandover: Number(aggSummary?.completed_handover ?? 0),
  };
  const progress: ProgressStrip = {
    spa: { progressing: Number(aggProgress?.spa_progressing ?? 0) },
    loan: { progressing: Number(aggProgress?.loan_progressing ?? 0) },
    mot: { progressing: Number(aggProgress?.mot_progressing ?? 0) },
    completed: { progressing: Number(aggProgress?.completed_progressing ?? 0) },
    total: Number(aggProgress?.total ?? 0),
  };
  const lastUpdatedAt = aggSummary?.last_updated_at ?? null;

  const attentionConditions = [...baseConditions];
  const attentionPred = portalStagePredicateSql("attention");
  if (attentionPred) attentionConditions.push(attentionPred);
  const attentionRows = await loadJoinedDeveloperRows(r, attentionConditions, [desc(casesTable.updatedAt)], 8, 0);
  const attentionIds = attentionRows.map((x) => x.id);
  const attentionAssignments = attentionIds.length ? await loadCaseAssignments(r, ctx.firmId, attentionIds) : {};
  if (attentionIds.length) enrichAssignments(attentionRows as any, attentionAssignments);
  const attentionDtos: UnitListDto[] = attentionRows.map((row) => mapJoinedCaseToListDto(row as any));
  const attentionItems = collectAttentionItems(attentionDtos, 8);

  res.setHeader("Cache-Control", "no-store");
  res.json({
    project: {
      allProjects: !projectId,
      projectId: projectId ?? null,
      name: resolvedProjectName,
      phase: resolvedPhase,
      developerName: dev?.name ?? null,
      lastUpdatedAt,
    },
    summary,
    attentionSummary: {
      total: summary.needsAttention,
      items: attentionItems,
    },
    progress,
  });
});

routerInternal.get("/developer/portal/units", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
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
      sql`${casesTable.propertyDetails}::text ILIKE ${like}`,
    ));
  }

  const filteredConditions = [...conditions];
  if (q.stage !== "all") {
    const stagePred = portalStagePredicateSql(q.stage);
    if (stagePred) filteredConditions.push(stagePred);
  }
  if (q.attentionOnly) {
    const attnPred = portalStagePredicateSql("attention");
    if (attnPred) filteredConditions.push(attnPred);
  }

  const [totalRes] = await r.select({ c: count() }).from(casesTable).leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`).where(and(...filteredConditions));
  const [totalScopeRes] = await r.select({ c: count() }).from(casesTable).where(and(...conditions));

  const rows = await loadJoinedDeveloperRows(
    r,
    filteredConditions,
    [desc(casesTable.updatedAt)],
    q.limit,
    offset,
  );
  const ids = rows.map((x) => x.id);
  const assignments = ids.length ? await loadCaseAssignments(r, ctx.firmId, ids) : {};
  if (ids.length) enrichAssignments(rows as any, assignments);
  const mapped: UnitListDto[] = rows.map((r) => mapJoinedCaseToListDto(r as any));

  let filtered = mapped;
  if (q.stage !== "all") filtered = filtered.filter((d) => applyStageFilterPredicate(d, q.stage));
  if (q.attentionOnly) filtered = filtered.filter((d) => !!d.nextAction?.attentionRequired || d.spa.status === "Attention Required" || d.loan.status === "Attention Required");

  res.setHeader("Cache-Control", "no-store");
  res.json({
    data: filtered,
    total: Number(totalRes?.c ?? 0),
    totalMatchingScope: Number(totalScopeRes?.c ?? 0),
    page: q.page,
    limit: q.limit,
  });
});

routerInternal.get("/developer/portal/units/:caseId", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const caseId = Number((req.params as any)?.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }

  const rows = await loadJoinedDeveloperRows(
    r,
    [
      eq(casesTable.firmId, ctx.firmId),
      eq(casesTable.developerId, ctx.developerId),
      eq(casesTable.id, caseId),
    ],
    [],
    1,
    0,
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const firstRow = rows[0] as JoinedForPortal;
  const assignments = await loadCaseAssignments(r, ctx.firmId, [caseId]);
  enrichAssignments([firstRow] as any, assignments);

  const workflowSteps = await r
    .select({
      stepName: caseWorkflowStepsTable.stepName,
      status: caseWorkflowStepsTable.status,
      completedAt: caseWorkflowStepsTable.completedAt,
    })
    .from(caseWorkflowStepsTable)
    .where(eq(caseWorkflowStepsTable.caseId, caseId))
    .orderBy(caseWorkflowStepsTable.stepOrder, caseWorkflowStepsTable.id)
    .limit(200);

  const detail: UnitDetailDto = mapJoinedCaseToDetailDto(firstRow as any, workflowSteps as any[]);

  res.setHeader("Cache-Control", "no-store");
  res.json({ data: detail });
});

routerInternal.get("/developer/portal/export.xlsx", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike) => {
  const ctx = await requireDeveloperUser(req, res);
  if (!ctx) return;
  const r = rdb(req);
  const q = ListInventoryQuery(req.query);
  const EXPORT_SAFETY_CAP = 5000;

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
  const exportConditions = [...conditions];
  if (q.stage !== "all") {
    const stagePred = portalStagePredicateSql(q.stage);
    if (stagePred) exportConditions.push(stagePred);
  }
  if (q.attentionOnly) {
    const attnPred = portalStagePredicateSql("attention");
    if (attnPred) exportConditions.push(attnPred);
  }

  const [countRes] = await r
    .select({ c: count() })
    .from(casesTable)
    .leftJoin(caseKeyDatesTable, sql`${caseKeyDatesTable.caseId} = ${casesTable.id} AND ${caseKeyDatesTable.firmId} = ${casesTable.firmId}`)
    .where(and(...exportConditions));
  const matchingCount = Number(countRes?.c ?? 0);
  if (matchingCount > EXPORT_SAFETY_CAP) {
    res.status(413).json({
      code: "EXPORT_TOO_LARGE",
      message: `Export matches ${matchingCount} rows. Please filter by project or status first to keep export under ${EXPORT_SAFETY_CAP} rows.`,
      matchingRows: matchingCount,
      limit: EXPORT_SAFETY_CAP,
    });
    return;
  }

  const rows = await loadJoinedDeveloperRows(r, exportConditions, [desc(casesTable.updatedAt)], EXPORT_SAFETY_CAP, 0);
  const ids = rows.map((x) => x.id);
  const assignments = ids.length ? await loadCaseAssignments(r, ctx.firmId, ids) : {};
  if (ids.length) enrichAssignments(rows as any, assignments);
  let mapped: UnitListDto[] = rows.map((row) => mapJoinedCaseToListDto(row as any));
  if (q.stage !== "all") mapped = mapped.filter((d) => applyStageFilterPredicate(d, q.stage));
  if (q.attentionOnly) mapped = mapped.filter((d) => !!d.nextAction?.attentionRequired || d.spa.status === "Attention Required" || d.loan.status === "Attention Required");

  const exportRows = mapped.map((u) => ({
    "Unit / Parcel": u.unitLabel,
    "Purchaser": u.purchasers.map((p) => p.displayName).join(", "),
    "Case Reference": u.referenceNo ?? "",
    "SPA Status": u.spa.status,
    "SPA Date": u.spa.date ?? "",
    "Loan Status": u.loan.status,
    "Bank": u.loan.bankName ?? "",
    "MOT Status": u.mot.status,
    "Current Stage": u.currentStage,
    "Next Action": u.nextAction?.label ?? "",
    "Waiting For": u.nextAction?.waitingFor ?? "",
    "Last Updated": u.lastUpdatedAt ?? "",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportRows);
  XLSX.utils.book_append_sheet(wb, ws, "Units");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Buffer;

  const fileName = safeFilenameAscii(`developer_portal_units_${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(buf);
});

async function loadCaseAssignments(
  rlsDb: typeof db | RlsDb,
  firmId: number,
  caseIds: number[],
): Promise<Record<number, { lawyer: string | null; clerk: string | null }>> {
  if (caseIds.length === 0) return {};
  const rows = await (rlsDb as any)
    .select({
      caseId: caseAssignmentsTable.caseId,
      userId: caseAssignmentsTable.userId,
      name: usersTable.name,
      roleInCase: caseAssignmentsTable.roleInCase,
    })
    .from(caseAssignmentsTable)
    .innerJoin(usersTable, eq(usersTable.id, caseAssignmentsTable.userId))
    .where(and(inArray(caseAssignmentsTable.caseId, caseIds), eq(caseAssignmentsTable.unassignedAt, null as any)));
  const byCase: Record<number, Array<{ userId: number | null; name: string | null; roleInCase: string | null }>> = {};
  for (const r of rows) {
    if (!byCase[r.caseId]) byCase[r.caseId] = [];
    byCase[r.caseId].push({ userId: r.userId, name: r.name, roleInCase: r.roleInCase });
  }
  const out: Record<number, { lawyer: string | null; clerk: string | null }> = {};
  for (const caseId of Object.keys(byCase)) out[Number(caseId)] = extractLawyerClerk(byCase[Number(caseId)]);
  return out;
}

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
