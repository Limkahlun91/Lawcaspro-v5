import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { count, desc, eq, and, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  casesTable,
  casePurchasersTable,
  clientsTable,
  projectsTable,
  rolesTable,
  himsStatusChecksTable,
  himsConnectionsTable,
  himsDataComparisonsTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { one, queryOne } from "../lib/http.js";
import { assertFirmFeatureEnabled } from "../modules/platform/firm-feature-service.js";
import { publicCredentialStatus, encryptSecret, decryptSecret, isSecretEncryptionConfigured } from "../lib/security/secret-crypto.js";
import { ApiError } from "../lib/api-response.js";
import {
  getHimsConnections,
  createHimsConnection,
  patchHimsConnection,
  getHimsCaseStatus,
  checkHimsCase,
  getHimsCaseComparisons,
  compareHimsCase,
} from "../modules/hims/hims-tracker.service.js";
import { requireUserFeatureAccess, isPartnerRoleName } from "../services/user-feature-access.js";
import { canUserAccessCase, listAccessibleCaseIds } from "../services/case-access.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const FEATURE_KEY = "module.hims";
const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const parseIntParam = (raw: unknown, field: string): number => {
  const v = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(v) || v <= 0) {
    throw new ApiError({ status: 400, code: `BAD_PARAM_${field.toUpperCase()}`, message: `Valid numeric ${field} required`, retryable: false });
  }
  return v;
};

const HimsCreateConnectionSchema = z.object({
  providerCode: z.enum(["HIMS_PORTAL", "HIMS_SANDBOX", "CUSTOM_OAUTH"]),
  displayName: z.string().trim().min(1).max(200),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().trim().min(1).max(5000).optional(),
  accessToken: z.string().trim().min(1).max(5000).optional(),
  refreshToken: z.string().trim().min(1).max(5000).optional(),
  endpointBaseUrl: z.string().trim().url(),
  mode: z.enum(["tracker_only", "full_write"]).default("tracker_only"),
});

router.get("/hims/cases", requireAuth, requireFirmUser, requireUserFeatureAccess("hims.tracker"), requirePermission("cases", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const firmId = req.firmId!;
    const userId = req.userId!;
    const r = req.rlsDb ?? db;
    const roleId = typeof req.roleId === "number" && req.roleId > 0 ? req.roleId : null;

    let roleName: string | null = null;
    const roleCache = (req as any)._roleCache as { firmId: number; roleId: number; name: string; permissions?: ReadonlyArray<{ module: string; action: string }> } | undefined;
    if (roleCache && roleCache.firmId === firmId && Number(roleCache.roleId) === Number(roleId)) {
      roleName = roleCache.name;
    }
    if (!roleName && roleId) {
      const [rn] = await r
        .select({ name: rolesTable.name })
        .from(rolesTable)
        .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)))
        .limit(1);
      if (rn?.name) roleName = String(rn.name);
    }

    const connections = await r
      .select({ count: count() })
      .from(himsConnectionsTable)
      .where(and(eq(himsConnectionsTable.firmId, firmId), eq(himsConnectionsTable.status, "active")));
    const activeConnections = Number(connections?.[0]?.count ?? 0);

    // §3: mapping = active connections with project_id set (canonical via hims_connections.projectId, NOT parallel system)
    let mappedProjects = 0;
    if (activeConnections > 0) {
      const [row] = await r
        .select({ n: count() })
        .from(himsConnectionsTable)
        .where(and(
          eq(himsConnectionsTable.firmId, firmId),
          eq(himsConnectionsTable.status, "active"),
          sql`${himsConnectionsTable.projectId} is not null`,
        ));
      mappedProjects = Number(row?.n ?? 0);
    }

    const qRaw = queryOne(req.query, "q")?.trim();
    const q = qRaw && qRaw.length >= 2 ? `%${qRaw.replace(/[%_]/g, (ch) => `\\${ch}`)}%` : null;

    const baseCaseWhere: any[] = [eq(casesTable.firmId, firmId)];
    if (q) {
      baseCaseWhere.push(
        sql`(${casesTable.referenceNo} ilike ${q} or ${casesTable.parcelNo} ilike ${q} or exists (
          select 1 from ${casePurchasersTable} cp
          inner join ${clientsTable} cl on cl.id = cp.client_id
          where cp.case_id = ${casesTable.id} and cl.name ilike ${q}
        ))`,
      );
    }

    const baseCaseQb = r
      .select({
        caseId: casesTable.id,
        caseReference: casesTable.referenceNo,
        project: projectsTable.name,
        phase: projectsTable.phase,
        parcelNo: casesTable.parcelNo,
        lotNo: sql<string>`${casesTable.propertyDetails}->>'lotNo'`,
        titleNo: sql<string>`${casesTable.propertyDetails}->>'hakmilikNo'`,
      })
      .from(casesTable)
      .leftJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
      .where(and(...baseCaseWhere));

    const caseList: any[] = await baseCaseQb.orderBy(desc(casesTable.updatedAt)).limit(500);

    const caseIdsHint: number[] = [];
    for (const c of caseList) {
      if (typeof c.caseId === "number" && c.caseId > 0) caseIdsHint.push(c.caseId);
    }

    // Part 2 §12-14: canonical access computation, matches /cases list exactly.
    const accessRes = await listAccessibleCaseIds({
      r: r as any,
      firmId,
      userId,
      roleId,
      roleName,
      caseIdsHint,
      limit: 5000,
    });
    const accessibleCaseIds: number[] = [];
    if (accessRes.mode === "all_firm") {
      for (const cid of caseIdsHint) accessibleCaseIds.push(cid);
    } else {
      for (const cid of caseIdsHint) {
        if (accessRes.caseIds.has(cid)) accessibleCaseIds.push(cid);
      }
    }

    const latestChecks = new Map<number, any>();
    if (accessibleCaseIds.length > 0) {
      const checks = await r
        .select({
          caseId: himsStatusChecksTable.caseId,
          lastCheckedAt: himsStatusChecksTable.lastCheckedAt,
          himsStatus: himsStatusChecksTable.lastStatus,
          himsStatusCode: himsStatusChecksTable.lastStatusCode,
          sourceSnapshotJson: himsStatusChecksTable.sourceSnapshotJson,
        })
        .from(himsStatusChecksTable)
        .innerJoin(
          sql`(
            select firm_id, case_id, max(last_checked_at) as mx
            from hims_status_checks
            where firm_id = ${firmId} and case_id is not null
            group by firm_id, case_id
          ) latest`,
          sql`latest.firm_id = ${himsStatusChecksTable.firmId} and latest.case_id = ${himsStatusChecksTable.caseId} and latest.mx = ${himsStatusChecksTable.lastCheckedAt}`,
        )
        .where(and(
          eq(himsStatusChecksTable.firmId, firmId),
          inArray(himsStatusChecksTable.caseId, accessibleCaseIds),
        ));
      for (const chk of checks) {
        if (typeof chk.caseId === "number") latestChecks.set(chk.caseId, chk);
      }
    }

    const matchSummary = new Map<number, { matched: number; total: number }>();
    if (accessibleCaseIds.length > 0) {
      const comps = await r
        .select({
          caseId: himsDataComparisonsTable.caseId,
          status: himsDataComparisonsTable.status,
          cnt: count(),
        })
        .from(himsDataComparisonsTable)
        .where(and(
          eq(himsDataComparisonsTable.firmId, firmId),
          inArray(himsDataComparisonsTable.caseId, accessibleCaseIds),
        ))
        .groupBy(himsDataComparisonsTable.caseId, himsDataComparisonsTable.status);
      for (const row of comps) {
        if (typeof row.caseId !== "number") continue;
        const cur = matchSummary.get(row.caseId) ?? { matched: 0, total: 0 };
        const c = Number(row.cnt ?? 0);
        cur.total += c;
        if (String(row.status) === "match") cur.matched += c;
        matchSummary.set(row.caseId, cur);
      }
    }

    const purchasers = new Map<number, string>();
    if (accessibleCaseIds.length > 0) {
      const pRows = await r
        .select({
          caseId: casePurchasersTable.caseId,
          name: clientsTable.name,
          orderNo: casePurchasersTable.orderNo,
        })
        .from(casePurchasersTable)
        .innerJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
        .where(and(
          eq(clientsTable.firmId, firmId),
          inArray(casePurchasersTable.caseId, accessibleCaseIds),
        ))
        .orderBy(casePurchasersTable.caseId, casePurchasersTable.orderNo);
      for (const pr of pRows as any[]) {
        if (typeof pr.caseId !== "number" || purchasers.has(pr.caseId)) continue;
        if (typeof pr.name === "string" && pr.name.trim().length > 0) purchasers.set(pr.caseId, pr.name);
      }
    }

    const items: any[] = [];
    for (const c of caseList) {
      const caseId = Number(c.caseId ?? 0);
      if (!accessibleCaseIds.includes(caseId)) continue;
      const chk = latestChecks.get(caseId);
      const snap = chk?.sourceSnapshotJson ?? null;
      const espaStatus = (snap && typeof snap === "object" && "espaStatus" in snap ? String((snap as any).espaStatus ?? "") :
        (snap && typeof snap === "object" && "spaStatus" in snap ? String((snap as any).spaStatus ?? "") : null));
      const summary = matchSummary.get(caseId);
      let dataMatch: boolean | string | null = null;
      if (summary && summary.total > 0) {
        dataMatch = summary.matched === summary.total;
      }
      const unitLotTitleRaw = [c.parcelNo, c.lotNo, c.titleNo].filter((v) => typeof v === "string" && v.trim().length > 0).join(" / ");
      items.push({
        caseId,
        caseReference: c.caseReference ?? null,
        purchaser: purchasers.get(caseId) ?? null,
        project: c.project ?? null,
        phase: typeof c.phase === "string" && c.phase.trim().length > 0 ? c.phase : null,
        unitLotTitle: unitLotTitleRaw.length > 0 ? unitLotTitleRaw : null,
        himsStatus: typeof chk?.himsStatus === "string" ? chk.himsStatus : (typeof chk?.himsStatusCode === "string" ? chk.himsStatusCode : null),
        espaStatus: espaStatus ?? null,
        dataMatch,
        lastChecked: chk?.lastCheckedAt ? (chk.lastCheckedAt instanceof Date ? chk.lastCheckedAt.toISOString() : String(chk.lastCheckedAt)) : null,
      });
    }

    const filteredByQuery = q !== null;
    const hasChecks = latestChecks.size > 0;
    // §3 EXACT rule: Search filtering must NOT change configurationStatus.
    // no_connections → no_mappings → no_data → configured
    let configurationStatus: "configured" | "no_connections" | "no_mappings" | "no_data" = "configured";
    if (activeConnections === 0) {
      configurationStatus = "no_connections";
    } else if (mappedProjects === 0) {
      configurationStatus = "no_mappings";
    } else if (latestChecks.size === 0) {
      configurationStatus = "no_data";
    }

    // §4 Summary: firm-scoped dataset (NOT current filtered page)
    // trackedCases = total checks unique caseId; needsAttention = mismatch OR status includes error/fail; matchedCases = 100% match; lastCheckedAt = latest lastCheckedAt timestamp
    let trackedCases = 0;
    let needsAttention = 0;
    let matchedCases = 0;
    let lastCheckedAt: string | null = null;
    if (accessibleCaseIds.length > 0) {
      const checks = await r
        .select({
          caseId: himsStatusChecksTable.caseId,
          lastCheckedAt: himsStatusChecksTable.lastCheckedAt,
          himsStatus: himsStatusChecksTable.lastStatus,
          himsStatusCode: himsStatusChecksTable.lastStatusCode,
          lastErrorCode: himsStatusChecksTable.lastErrorCode,
        })
        .from(himsStatusChecksTable)
        .innerJoin(
          sql`(
            select firm_id, case_id, max(last_checked_at) as mx
            from hims_status_checks
            where firm_id = ${firmId} and case_id is not null
            group by firm_id, case_id
          ) latest`,
          sql`latest.firm_id = ${himsStatusChecksTable.firmId} and latest.case_id = ${himsStatusChecksTable.caseId} and latest.mx = ${himsStatusChecksTable.lastCheckedAt}`,
        )
        .where(and(
          eq(himsStatusChecksTable.firmId, firmId),
          inArray(himsStatusChecksTable.caseId, accessibleCaseIds),
        ));
      trackedCases = checks.length;
      let latest: number = 0;
      for (const row of checks as any[]) {
        const lc = row.lastCheckedAt ? new Date(row.lastCheckedAt).getTime() : 0;
        if (lc > latest) { latest = lc; }
        const stat = String(row.himsStatus ?? row.himsStatusCode ?? "").toLowerCase();
        const errc = String(row.lastErrorCode ?? "").toLowerCase();
        const hasError =
          stat.includes("error") || stat.includes("fail") || stat.includes("invalid") ||
          errc.includes("error") || errc.includes("fail") || stat.includes("timeout") ||
          stat.includes("attention") || stat.includes("discrepancy");
        const comp = matchSummary.get(Number(row.caseId));
        const mismatch = comp && comp.total > 0 && comp.matched < comp.total;
        if (hasError || mismatch) needsAttention++;
        if (comp && comp.total > 0 && comp.matched === comp.total) matchedCases++;
      }
      if (latest > 0) lastCheckedAt = new Date(latest).toISOString();
    }

    res.json({
      items,
      total: items.length,
      configurationStatus,
      summary: {
        trackedCases,
        needsAttention,
        matchedCases,
        lastCheckedAt,
      },
    });
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    const status4xx = err?.status && err.status >= 400 && err.status < 500;
    if (status4xx) {
      res.status(err.status).json({ code: err.code ?? "HIMS_4XX", error: err.message ?? "Denied" });
      return;
    }
    // §14 safe wrap: server-log PG code/table/col/constraint/stage; frontend only code/message/requestId.
    req.log?.error?.({
      err,
      route: req.originalUrl,
      firmId: req.firmId,
      userId: req.userId,
      stage: "hims.list_cases_failed",
      pgCode: err?.code || err?.pgCode || (err && typeof err.code === "string" ? err.code : null),
      table: err?.table ?? null,
      column: err?.column ?? null,
      constraint: err?.constraint ?? null,
    }, "hims.list_cases_failed");
    res.status(err?.status ?? 500).json({
      ok: false,
      error: {
        code: err?.code ?? "HIMS_CASES_LIST_FAILED",
        message: "Unable to load HIMS tracker. Please try again shortly.",
        retryable: true,
      },
      requestId: (req as any).id ?? `hims-${Number(process.hrtime.bigint() & 0xffffffffn).toString(16)}`,
    });
  }
});

// §5 §6: HIMS credentials require hims.credentials feature + Partner/Admin role.
// Clerk granted hims.tracker must NOT gain credential management.
function requireHimsCredentialsRoleGate(req: AuthRequest, res: Response, next: any): void {
  const roleCache = (req as any)._roleCache as { name?: string } | undefined;
  const rname = roleCache?.name ?? (typeof (req as any).roleName === "string" ? (req as any).roleName : "");
  const ok = isPartnerRoleName(rname)
    || String(rname).toLowerCase().includes("manager")
    || String(rname).toLowerCase().includes("admin")
    || String(rname).toLowerCase() === "founder";
  if (!ok) {
    res.status(403).json({
      ok: false,
      error: {
        code: "HIMS_CREDENTIAL_ROLE_REQUIRED",
        message: "HIMS connection credentials may only be managed by a Partner or firm-level Admin.",
        retryable: false,
      },
      requestId: (req as any).id ?? `hims-${Number(process.hrtime.bigint() & 0xffffffffn).toString(16)}`,
    });
    return;
  }
  next();
}

router.get("/hims/connections", requireAuth, requireFirmUser, requireUserFeatureAccess("hims.credentials"), requireHimsCredentialsRoleGate, requirePermission("module.hims", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const wrapped = await getHimsConnections({ firmId: req.firmId! }, { tx: req.rlsDb });
    const rows = Array.isArray(wrapped) ? wrapped : (wrapped && typeof wrapped === "object" && "connections" in wrapped ? (wrapped.connections ?? []) : []);
    const sanitized = (rows as unknown[]).map((c: any) => ({
      id: c.connectionId ?? c.id,
      displayName: c.connectionName ?? c.displayName,
      providerCode: c.providerCode ?? (c.config as any)?.providerCode ?? null,
      mode: c.mode ?? "tracker_only",
      endpointBaseUrl: typeof c.endpointBaseUrl === "string" ? c.endpointBaseUrl : (c.config as any)?.apiEndpoint ?? null,
      status: c.status ?? "unknown",
      lastSyncAt: typeof c.lastSyncAt !== "undefined" ? c.lastSyncAt ?? null : c.lastHealthCheckAt ?? null,
      credential: publicCredentialStatus((c.secretEnvelope ?? c.encryptedAccessToken ?? (c.config as any)?.secretEnvelope ?? null) as any),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
    res.json({ connections: sanitized });
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.get_connections_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CONNECTION_LIST_FAILED", error: err?.message ?? "Failed" });
  }
});

router.post("/hims/connections", requireAuth, requireFirmUser, requireUserFeatureAccess("hims.credentials"), requireHimsCredentialsRoleGate, requirePermission("module.hims", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    if (!isSecretEncryptionConfigured()) {
      throw new ApiError({
        status: 503,
        code: "SECRET_ENCRYPTION_NOT_CONFIGURED",
        message: "Cannot store HIMS credentials because server SECRET_ENCRYPTION_KEY is not configured",
        retryable: false,
      });
    }
    const parsed = HimsCreateConnectionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ code: "HIMS_CONNECTION_VALIDATION_FAILED", error: "Validation failed", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    if (body.mode === "full_write") {
      throw new ApiError({
        status: 403,
        code: "HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY",
        message: "PART 2 expansion routes are intentionally tracker/compare/notification-only. HIMS write modes (CREATE eSPA / SUBMIT eSPA / EDIT CASE) are not exposed on this router.",
        retryable: false,
      });
    }
    const secretPayload: Record<string, string> = {};
    if (body.clientSecret) secretPayload.clientSecret = body.clientSecret;
    if (body.accessToken) secretPayload.accessToken = body.accessToken;
    if (body.refreshToken) secretPayload.refreshToken = body.refreshToken;
    const envelope = Object.keys(secretPayload).length > 0 ? await encryptSecret(JSON.stringify(secretPayload), { associate: `${req.firmId!}:hims:conn` }) : null;

    const created = await createHimsConnection(
      {
        firmId: req.firmId!,
        actorUserId: req.userId!,
        connectionName: body.displayName,
        config: {
          apiEndpoint: body.endpointBaseUrl,
          authMode: body.providerCode,
          clientKeyRef: body.clientId ?? null,
          secretEnvelope: envelope as any,
        } as any,
      },
      { tx: req.rlsDb },
    );
    res.status(201).json({
      id: (created as any).id ?? created,
      mode: "tracker_only",
      credential: publicCredentialStatus(envelope as any),
    });
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED" || err?.code === "HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY" || err?.code === "SECRET_ENCRYPTION_NOT_CONFIGURED") {
      res.status(err.status ?? 403).json({ code: err.code, error: err.message ?? "Denied", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.create_connection_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CONNECTION_CREATE_FAILED", error: err?.message ?? "Failed" });
  }
});

router.patch("/hims/connections/:id", requireAuth, requireFirmUser, requireUserFeatureAccess("hims.credentials"), requireHimsCredentialsRoleGate, requirePermission("module.hims", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const id = parseIntParam(one(req.params?.id), "connectionId");
    const body = req.body as { displayName?: unknown; endpointBaseUrl?: unknown; status?: unknown; secretRotation?: unknown } ?? {};
    let updatedSecrets = false;
    let updatedConfig: Record<string, unknown> | undefined = undefined;
    if (body.secretRotation && typeof body.secretRotation === "object") {
      if (!isSecretEncryptionConfigured()) {
        throw new ApiError({ status: 503, code: "SECRET_ENCRYPTION_NOT_CONFIGURED", message: "Cannot rotate secrets without configured SECRET_ENCRYPTION_KEY", retryable: false });
      }
      const rotation = body.secretRotation as Record<string, string>;
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(rotation)) {
        if (typeof v === "string" && ["clientSecret", "accessToken", "refreshToken"].includes(k) && v.trim().length > 0) {
          sanitized[k] = v;
        }
      }
      if (Object.keys(sanitized).length > 0) {
        updatedConfig = { secretEnvelope: await encryptSecret(JSON.stringify(sanitized), { associate: `${req.firmId!}:hims:conn:${id}` }) };
        updatedSecrets = true;
      }
    }
    const patchInput: any = {
      firmId: req.firmId!,
      actorUserId: req.userId!,
      connectionId: id,
    };
    if (typeof body.displayName === "string") patchInput.connectionName = body.displayName.trim();
    if (typeof body.status === "string") patchInput.status = body.status as any;
    if (typeof body.endpointBaseUrl === "string") {
      patchInput.config = { ...(updatedConfig ?? {}), apiEndpoint: body.endpointBaseUrl.trim() };
    } else if (updatedConfig) {
      patchInput.config = updatedConfig;
    }
    const result = await patchHimsConnection(patchInput, { tx: req.rlsDb });
    res.json({ result, credentialRotated: updatedSecrets, credential: { hasCredential: true } });
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED" || err?.code === "SECRET_ENCRYPTION_NOT_CONFIGURED") {
      res.status(err.status ?? 403).json({ code: err.code, error: err.message ?? "Denied", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.patch_connection_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CONNECTION_PATCH_FAILED", error: err?.message ?? "Failed" });
  }
});

router.get("/hims/cases/:caseId/status", requireAuth, requireFirmUser, requireUserFeatureAccess("hims.tracker"), requirePermission("module.hims", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const firmId = req.firmId!;
    const caseId = parseIntParam(one(req.params?.caseId), "caseId");
    const r = req.rlsDb ?? db;
    const roleId = typeof req.roleId === "number" && req.roleId > 0 ? req.roleId : null;
    let roleName: string | null = null;
    const roleCache = (req as any)._roleCache as { firmId: number; roleId: number; name: string } | undefined;
    if (roleCache && roleCache.firmId === firmId && Number(roleCache.roleId) === Number(roleId)) roleName = roleCache.name;
    if (!roleName && roleId) {
      const [rn] = await r.select({ name: rolesTable.name }).from(rolesTable).where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId))).limit(1);
      if (rn?.name) roleName = String(rn.name);
    }
    const access = await canUserAccessCase({ r: r as any, firmId, userId: req.userId!, caseId, roleId, roleName });
    if (!access.ok) {
      res.status(403).json({ code: "CASE_ACCESS_DENIED", error: access.code ?? "You do not have access to this case." });
      return;
    }
    const status = await getHimsCaseStatus({ firmId, caseId }, { tx: req.rlsDb });
    res.json(status);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.get_case_status_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CASE_STATUS_FAILED", error: err?.message ?? "Failed" });
  }
});

router.post("/hims/cases/:caseId/check", requireAuth, requireFirmUser, requireUserFeatureAccess("hims.status_check"), requirePermission("module.hims", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const firmId = req.firmId!;
    const caseId = parseIntParam(one(req.params?.caseId), "caseId");
    const r = req.rlsDb ?? db;
    const roleId = typeof req.roleId === "number" && req.roleId > 0 ? req.roleId : null;
    let roleName: string | null = null;
    const roleCache = (req as any)._roleCache as { firmId: number; roleId: number; name: string } | undefined;
    if (roleCache && roleCache.firmId === firmId && Number(roleCache.roleId) === Number(roleId)) roleName = roleCache.name;
    if (!roleName && roleId) {
      const [rn] = await r.select({ name: rolesTable.name }).from(rolesTable).where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId))).limit(1);
      if (rn?.name) roleName = String(rn.name);
    }
    const access = await canUserAccessCase({ r: r as any, firmId, userId: req.userId!, caseId, roleId, roleName });
    if (!access.ok) {
      res.status(403).json({ code: "CASE_ACCESS_DENIED", error: access.code ?? "You do not have access to this case." });
      return;
    }
    const body = req.body as { connectionId?: unknown } ?? {};
    const connectionId = typeof body.connectionId === "number" || typeof body.connectionId === "string" ? parseInt(String(body.connectionId), 10) : null;
    const result = await checkHimsCase(
      {
        firmId,
        actorUserId: req.userId!,
        caseId,
        connectionId: Number.isFinite(connectionId) ? connectionId : null,
      },
      { tx: req.rlsDb },
    );
    res.status(202).json(result);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.check_case_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CASE_CHECK_FAILED", error: err?.message ?? "Failed" });
  }
});

router.get("/hims/cases/:caseId/comparisons", requireAuth, requireFirmUser, requireUserFeatureAccess("hims.compare_lawcaspro_hims"), requirePermission("module.hims", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const firmId = req.firmId!;
    const caseId = parseIntParam(one(req.params?.caseId), "caseId");
    const r = req.rlsDb ?? db;
    const roleId = typeof req.roleId === "number" && req.roleId > 0 ? req.roleId : null;
    let roleName: string | null = null;
    const roleCache = (req as any)._roleCache as { firmId: number; roleId: number; name: string } | undefined;
    if (roleCache && roleCache.firmId === firmId && Number(roleCache.roleId) === Number(roleId)) roleName = roleCache.name;
    if (!roleName && roleId) {
      const [rn] = await r.select({ name: rolesTable.name }).from(rolesTable).where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId))).limit(1);
      if (rn?.name) roleName = String(rn.name);
    }
    const access = await canUserAccessCase({ r: r as any, firmId, userId: req.userId!, caseId, roleId, roleName });
    if (!access.ok) {
      res.status(403).json({ code: "CASE_ACCESS_DENIED", error: access.code ?? "You do not have access to this case." });
      return;
    }
    const comparisons = await getHimsCaseComparisons({ firmId, caseId }, { tx: req.rlsDb });
    res.json(comparisons);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.get_case_comparisons_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CASE_COMPARISONS_FAILED", error: err?.message ?? "Failed" });
  }
});

router.post("/hims/cases/:caseId/compare", requireAuth, requireFirmUser, requireUserFeatureAccess("hims.compare_lawcaspro_hims"), requirePermission("module.hims", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const firmId = req.firmId!;
    const caseId = parseIntParam(one(req.params?.caseId), "caseId");
    const r = req.rlsDb ?? db;
    const roleId = typeof req.roleId === "number" && req.roleId > 0 ? req.roleId : null;
    let roleName: string | null = null;
    const roleCache = (req as any)._roleCache as { firmId: number; roleId: number; name: string } | undefined;
    if (roleCache && roleCache.firmId === firmId && Number(roleCache.roleId) === Number(roleId)) roleName = roleCache.name;
    if (!roleName && roleId) {
      const [rn] = await r.select({ name: rolesTable.name }).from(rolesTable).where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId))).limit(1);
      if (rn?.name) roleName = String(rn.name);
    }
    const access = await canUserAccessCase({ r: r as any, firmId, userId: req.userId!, caseId, roleId, roleName });
    if (!access.ok) {
      res.status(403).json({ code: "CASE_ACCESS_DENIED", error: access.code ?? "You do not have access to this case." });
      return;
    }
    const body = req.body as { connectionId?: unknown; fields?: unknown; options?: unknown } ?? {};
    const connectionId = typeof body.connectionId === "number" || typeof body.connectionId === "string" ? parseInt(String(body.connectionId), 10) : null;
    const fields = Array.isArray(body.fields) ? (body.fields as string[]) : null;
    const options = body.options && typeof body.options === "object" ? (body.options as Record<string, unknown>) : {};
    const result = await compareHimsCase(
      {
        firmId,
        actorUserId: req.userId!,
        caseId,
        connectionId: Number.isFinite(connectionId) ? connectionId : null,
        himsRecordOverride: fields ? { fields, ...options } : options,
      },
      { tx: req.rlsDb },
    );
    res.status(202).json(result);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.compare_case_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CASE_COMPARE_FAILED", error: err?.message ?? "Failed" });
  }
});

export default expressRouter;
