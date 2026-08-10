import { Request, Response, NextFunction } from "express";
import { clearTenantContext, db, makeRlsDb, permissionsTable, pool, RlsDb, rolesTable, sessionsTable, setTenantContext, setTenantContextSession, sql, usersTable, auditLogsTable, platformFounderRolePermissionsTable, platformFounderRolesTable, platformFounderUserRolesTable, caseAssignmentsTable, casesTable, type PoolClient } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "./logger";
import { isAuthAdminDbConfigured, withAuthAdminDb } from "./auth-admin-db";
import { isTransientDbConnectionError, withAuthSafeDb } from "./auth-safe-db";

export interface AuthRequest extends Request {
  userId?: number;
  email?: string;
  userType?: string;
  firmId?: number | null;
  roleId?: number | null;
  developerId?: number | null;
  supportSessionId?: number | null;
  founderPermissions?: string[];
  founderRoleLevel?: string | null;
  timing?: { startAt: number; sections: Record<string, number> };
  /**
   * Per-request RLS-enforced Drizzle instance.
   * Set by requireFirmUser. Runs inside a transaction as app_user with
   * app.current_firm_id set to req.firmId. All firm-scoped queries in
   * Phase 2+ route handlers must use this instead of the global db.
   */
  rlsDb?: RlsDb;
  /**
   * The underlying PoolClient that rlsDb is bound to.
   * Set alongside rlsDb by requireFirmUser so that route handlers can
   * apply `SET LOCAL statement_timeout` (transaction-scoped) without
   * opening a separate transaction.
   */
  rlsClient?: PoolClient;
}

const getReqId = (req: unknown): string | undefined => {
  const id = (req as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
};

const getJobId = (req: unknown): string | undefined => {
  const params = (req as { params?: Record<string, unknown> } | null)?.params;
  const v = params?.jobId;
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
};

const FOUNDER_EMAIL = "lun.6923@hotmail.com";
const FOUNDER_EMAILS = Array.from(
  new Set(
    `${process.env.FOUNDER_EMAILS ?? ""},${FOUNDER_EMAIL}`
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
);

const DEFAULT_FOUNDER_PERMISSION_CODES = [
  "founder.dashboard.read",
  "platform.read",
  "platform.manage",
  "system.documents.read",
  "system.documents.manage",
  "founder.ops.read",
  "founder.ops.manage",
  "founder.firms.read",
  "founder.firms.manage",
  "founder.documents.read",
  "founder.documents.manage",
  "founder.audit.read",
  "founder.messages.read",
  "founder.messages.manage",
  "founder.monitoring.read",
  "founder.support.read",
  "founder.support.manage",
  "founder.maintenance.reset.firm",
  "founder.maintenance.restore.snapshot",
  "founder.maintenance.rollback.snapshot",
];

export function isFounderAllowlistedEmail(email: string | null | undefined): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  return !!e && FOUNDER_EMAILS.includes(e);
}

export function getFounderFallbackPermissions(email: string | null | undefined): { permissions: string[]; highestLevel: string | null } | null {
  if (!isFounderAllowlistedEmail(email)) return null;
  return { permissions: [...DEFAULT_FOUNDER_PERMISSION_CODES], highestLevel: "super_admin" };
}

export async function writeAuditLog(params: {
  firmId?: number | null;
  actorId?: number | null;
  actorType?: string;
  action: string;
  entityType?: string;
  entityId?: number;
  detail?: string;
  ipAddress?: string;
  userAgent?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  requestId?: string | null;
  actingForUserId?: number | string | null;
}, options?: { db?: RlsDb; strict?: boolean }) {
  const targetDb = options?.db;
  const strict = options?.strict ?? false;
  try {
    const firmId = params.firmId ?? null;
    const actorId = params.actorId ?? null;
    const isSystemActor = (params.actorType ?? "firm_user") === "system";
    if (firmId === null || (actorId === null && !isSystemActor)) {
      logger.warn(
        {
          action: params.action,
          firmId,
          actorId,
          actorType: params.actorType ?? null,
          entityType: params.entityType ?? null,
          entityId: params.entityId ?? null,
        },
        "audit.skipped_missing_context",
      );
      return;
    }
    let storedDetail: string | null = params.detail ?? null;
    const hasStructured =
      params.before !== undefined ||
      params.after !== undefined ||
      params.reason !== undefined ||
      params.requestId !== undefined ||
      params.actingForUserId !== undefined;
    if (hasStructured) {
      const structured: Record<string, unknown> = {};
      if (params.detail !== undefined && params.detail !== null) structured.message = params.detail;
      if (params.reason !== undefined) structured.reason = params.reason;
      if (params.requestId !== undefined) structured.requestId = params.requestId;
      if (params.actingForUserId !== undefined) structured.actingForUserId = params.actingForUserId;
      if (params.before !== undefined) structured.before = params.before;
      if (params.after !== undefined) structured.after = params.after;
      storedDetail = JSON.stringify(structured);
    }
    const shared = {
      firmId,
      actorId,
      actorType: params.actorType ?? "firm_user",
      action: params.action,
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      detail: storedDetail,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    };
    if (targetDb) {
      await targetDb.insert(auditLogsTable).values(shared);
    } else {
      await db.insert(auditLogsTable).values(shared);
    }
  } catch (err) {
    logger.error(
      {
        err,
        action: params.action,
        firmId: params.firmId ?? null,
        actorId: params.actorId ?? null,
        actorType: params.actorType ?? null,
        entityType: params.entityType ?? null,
        entityId: params.entityId ?? null,
      },
      "audit.write_failed",
    );
    if (strict) throw err;
  }
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const cookieToken = req.cookies?.["auth_token"] as string | undefined;
  const authHeader = req.headers["authorization"];
  const headerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;
  const candidates = Array.from(new Set([cookieToken, headerToken].filter(Boolean))) as string[];
  if (candidates.length === 0) {
    await writeAuditLog({ action: "auth.missing_token", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(401).json({ error: "Not authenticated", code: "AUTH_MISSING_TOKEN" });
    return;
  }

  let session: typeof sessionsTable.$inferSelect | undefined;
  let user:
    | {
        id: number;
        email: string;
        userType: string;
        firmId: number | null;
        roleId: number | null;
        status: string;
      }
    | undefined;
  let lookupTiming: SessionUserLookupTiming | undefined;
  try {
    const reqId = getReqId(req);
    const lookupStartedAt = Date.now();
    for (const token of candidates) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const result = await lookupSessionAndUserByTokenHash(tokenHash);
      if (result?.session) {
        session = result.session;
        user = result.user;
        lookupTiming = result.timing;
        break;
      }
      lookupTiming = result?.timing;
    }
    const ms = Date.now() - lookupStartedAt;
    if (req.timing) req.timing.sections.authSessionMs = ms;
    if (ms > 1000) {
      logger.warn(
        {
          route: req.path,
          reqId,
          ms,
          attempts: lookupTiming?.attempts ?? null,
          inflightShared: lookupTiming?.inflightShared ?? null,
          primaryLookupMs: lookupTiming?.primaryLookupMs ?? null,
          fallbackLookupMs: lookupTiming?.fallbackLookupMs ?? null,
          poolTotal: typeof (pool as any)?.totalCount === "number" ? (pool as any).totalCount : null,
          poolIdle: typeof (pool as any)?.idleCount === "number" ? (pool as any).idleCount : null,
          poolWaiting: typeof (pool as any)?.waitingCount === "number" ? (pool as any).waitingCount : null,
        },
        "auth.require_auth.slow",
      );
    }
  } catch (err) {
    logger.error({ err }, "auth.require_auth.db_error");
    res.status(503).json({ error: "Auth temporarily unavailable", code: "AUTH_TEMPORARILY_UNAVAILABLE" });
    return;
  }

  if (!session) {
    await writeAuditLog({ action: "auth.session_not_found", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(401).json({ error: "Session not found", code: "AUTH_SESSION_NOT_FOUND" });
    return;
  }

  if (session.expiresAt < new Date()) {
    await writeAuditLog({ action: "auth.session_expired", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(401).json({ error: "Session expired", code: "AUTH_SESSION_EXPIRED" });
    return;
  }

  if (!user) {
    await writeAuditLog({
      action: "auth.user_not_found",
      detail: `userId=${session.userId} route=${req.method} ${req.path}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(401).json({ error: "User not found", code: "AUTH_USER_NOT_FOUND" });
    return;
  }

  if (user.status !== "active") {
    await writeAuditLog({
      firmId: user?.firmId ?? null,
      actorId: user?.id ?? null,
      actorType: user?.userType ?? "unknown",
      action: "auth.user_inactive",
      detail: `userId=${session.userId} route=${req.method} ${req.path}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(401).json({ error: "User inactive", code: "AUTH_USER_INACTIVE" });
    return;
  }

  req.userId = user.id;
  req.email = user.email;
  req.userType = user.userType;
  req.firmId = user.firmId;
  req.roleId = user.roleId;
  req.developerId = (user as any).developerId ?? null;

  next();
}

type SessionUserLookupTiming = {
  attempts: number;
  inflightShared: boolean;
  primaryLookupMs: number;
  fallbackLookupMs: number;
  identityDbSource: "DATABASE_URL" | "AUTH_DATABASE_URL" | "ADMIN_DATABASE_URL" | "UNKNOWN";
  cacheHit?: boolean;
  cacheAgeMs?: number | null;
};

type SessionUserLookupResult =
  | {
      session: typeof sessionsTable.$inferSelect;
      user:
        | {
            id: number;
            email: string;
            name: string;
            userType: string;
            firmId: number | null;
            roleId: number | null;
            developerId: number | null;
            status: string;
          }
        | undefined;
      timing?: SessionUserLookupTiming;
    }
  | null;

const inflightSessionLookups = new Map<string, Promise<SessionUserLookupResult>>();
const VERIFIED_SESSION_CACHE_TTL_MS = 30_000;
const VERIFIED_SESSION_CACHE_MAX_ENTRIES = 300;
const verifiedSessionCache = new Map<string, { cachedAtMs: number; value: NonNullable<SessionUserLookupResult> }>();

export function invalidateVerifiedSessionCacheByTokenHash(tokenHash: string): void {
  if (!tokenHash) return;
  verifiedSessionCache.delete(tokenHash);
}

export function invalidateVerifiedSessionCacheByUserId(userId: number): void {
  if (!Number.isFinite(userId) || userId <= 0) return;
  for (const [k, v] of verifiedSessionCache.entries()) {
    const uid = Number((v.value as any)?.user?.id ?? (v.value as any)?.session?.userId ?? 0);
    if (uid === userId) verifiedSessionCache.delete(k);
  }
}

export function __clearAuthCachesForTests(): void {
  verifiedSessionCache.clear();
  inflightSessionLookups.clear();
}

function getVerifiedSessionFromCache(tokenHash: string): SessionUserLookupResult {
  const hit = verifiedSessionCache.get(tokenHash);
  if (!hit) return null;
  const now = Date.now();
  const ageMs = now - hit.cachedAtMs;
  if (ageMs < 0 || ageMs > VERIFIED_SESSION_CACHE_TTL_MS) {
    verifiedSessionCache.delete(tokenHash);
    return null;
  }
  const session = (hit.value as any)?.session as typeof sessionsTable.$inferSelect | undefined;
  const user = (hit.value as any)?.user as { status?: unknown } | undefined;
  if (!session) {
    verifiedSessionCache.delete(tokenHash);
    return null;
  }
  const expiresAtMs = session.expiresAt instanceof Date ? session.expiresAt.getTime() : new Date(session.expiresAt as any).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    verifiedSessionCache.delete(tokenHash);
    return null;
  }
  if (user && String((user as any).status ?? "") !== "active") {
    verifiedSessionCache.delete(tokenHash);
    return null;
  }
  return {
    ...(hit.value as any),
    timing: {
      attempts: 0,
      inflightShared: false,
      primaryLookupMs: 0,
      fallbackLookupMs: 0,
      identityDbSource: hit.value.timing?.identityDbSource ?? "UNKNOWN",
      cacheHit: true,
      cacheAgeMs: ageMs,
    },
  };
}

function setVerifiedSessionCache(tokenHash: string, value: SessionUserLookupResult): void {
  if (!value?.session) return;
  const session = value.session;
  const now = Date.now();
  const expiresAtMs = session.expiresAt instanceof Date ? session.expiresAt.getTime() : new Date(session.expiresAt as any).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return;
  const status = String((value as any)?.user?.status ?? "active");
  if (status !== "active") return;
  while (verifiedSessionCache.size >= VERIFIED_SESSION_CACHE_MAX_ENTRIES) {
    const first = verifiedSessionCache.keys().next();
    if (first.done) break;
    verifiedSessionCache.delete(first.value);
  }
  verifiedSessionCache.set(tokenHash, { cachedAtMs: now, value: value as NonNullable<SessionUserLookupResult> });
}

export async function lookupSessionAndUserByTokenHash(
  tokenHash: string,
): Promise<SessionUserLookupResult> {
  const cached = getVerifiedSessionFromCache(tokenHash);
  if (cached) return cached;

  const shared = inflightSessionLookups.get(tokenHash);
  if (shared) {
    const r = await shared;
    if (!r) return null;
    return {
      ...r,
      timing: {
        attempts: r.timing?.attempts ?? 1,
        inflightShared: true,
        primaryLookupMs: r.timing?.primaryLookupMs ?? 0,
        fallbackLookupMs: r.timing?.fallbackLookupMs ?? 0,
        identityDbSource: r.timing?.identityDbSource ?? "UNKNOWN",
      },
    };
  }

  const p = (async (): Promise<SessionUserLookupResult> => {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const authAdminSource = (() => {
    const rawAuth = typeof process.env.AUTH_DATABASE_URL === "string" ? process.env.AUTH_DATABASE_URL.trim() : "";
    if (rawAuth) return "AUTH_DATABASE_URL";
    const rawAdmin = typeof process.env.ADMIN_DATABASE_URL === "string" ? process.env.ADMIN_DATABASE_URL.trim() : "";
    if (rawAdmin) return "ADMIN_DATABASE_URL";
    return "UNKNOWN";
  })();

  const lookupViaDb = async (): Promise<SessionUserLookupResult> => {
    if (process.env.NODE_ENV === "test") {
      const [s] = await db.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
      if (!s) return null;
      const [u] = await db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          name: usersTable.name,
          userType: usersTable.userType,
          firmId: usersTable.firmId,
          roleId: usersTable.roleId,
          developerId: usersTable.developerId,
          status: usersTable.status,
        })
        .from(usersTable)
        .where(eq(usersTable.id, s.userId))
        .catch(async (err) => {
          const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
          if (code !== "42703") throw err;
          const [u2] = await db
            .select({
              id: usersTable.id,
              email: usersTable.email,
              name: usersTable.name,
              userType: usersTable.userType,
              firmId: usersTable.firmId,
              roleId: usersTable.roleId,
              status: usersTable.status,
            })
            .from(usersTable)
            .where(eq(usersTable.id, s.userId));
          return [u2 ? ({ ...u2, developerId: null }) : undefined] as any;
        });
      return { session: s, user: u as any };
    }

    try {
      const [row] = await db
        .select({
          session: {
            id: sessionsTable.id,
            userId: sessionsTable.userId,
            tokenHash: sessionsTable.tokenHash,
            expiresAt: sessionsTable.expiresAt,
            createdAt: sessionsTable.createdAt,
            userAgent: sessionsTable.userAgent,
            ipAddress: sessionsTable.ipAddress,
          },
          user: {
            id: usersTable.id,
            email: usersTable.email,
            name: usersTable.name,
            userType: usersTable.userType,
            firmId: usersTable.firmId,
            roleId: usersTable.roleId,
            developerId: usersTable.developerId,
            status: usersTable.status,
          },
        })
        .from(sessionsTable)
        .innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
        .where(eq(sessionsTable.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      return { session: row.session as any, user: row.user as any };
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code !== "42703") throw err;
      const [row2] = await db
        .select({
          session: {
            id: sessionsTable.id,
            userId: sessionsTable.userId,
            tokenHash: sessionsTable.tokenHash,
            expiresAt: sessionsTable.expiresAt,
            createdAt: sessionsTable.createdAt,
            userAgent: sessionsTable.userAgent,
            ipAddress: sessionsTable.ipAddress,
          },
          user: {
            id: usersTable.id,
            email: usersTable.email,
            name: usersTable.name,
            userType: usersTable.userType,
            firmId: usersTable.firmId,
            roleId: usersTable.roleId,
            status: usersTable.status,
          },
        })
        .from(sessionsTable)
        .innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
        .where(eq(sessionsTable.tokenHash, tokenHash))
        .limit(1);
      if (!row2) return null;
      return { session: row2.session as any, user: ({ ...(row2.user as any), developerId: null } as any) };
    }
  };

  const lookupViaAuthAdminDb = async (): Promise<
    | {
        session: typeof sessionsTable.$inferSelect;
        user:
          | {
              id: number;
              email: string;
              name: string;
              userType: string;
              firmId: number | null;
              roleId: number | null;
              developerId: number | null;
              status: string;
            }
          | undefined;
      }
    | null
  > => {
    if (!isAuthAdminDbConfigured()) return null;
    return await withAuthAdminDb(async (authDb) => {
      const [s] = await authDb.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
      if (!s) return null;
      const [u] = await authDb
        .select({
          id: usersTable.id,
          email: usersTable.email,
          name: usersTable.name,
          userType: usersTable.userType,
          firmId: usersTable.firmId,
          roleId: usersTable.roleId,
          developerId: usersTable.developerId,
          status: usersTable.status,
        })
        .from(usersTable)
        .where(eq(usersTable.id, s.userId))
        .catch(async (err) => {
          const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
          if (code !== "42703") throw err;
          const [u2] = await authDb
            .select({
              id: usersTable.id,
              email: usersTable.email,
              name: usersTable.name,
              userType: usersTable.userType,
              firmId: usersTable.firmId,
              roleId: usersTable.roleId,
              status: usersTable.status,
            })
            .from(usersTable)
            .where(eq(usersTable.id, s.userId));
          return [u2 ? ({ ...u2, developerId: null }) : undefined] as any;
        });
      return { session: s, user: u as any };
    });
  };

  const lookupViaAuthSafeDb = async (): Promise<
    | {
        session: typeof sessionsTable.$inferSelect;
        user:
          | {
              id: number;
              email: string;
              name: string;
              userType: string;
              firmId: number | null;
              roleId: number | null;
              developerId: number | null;
              status: string;
            }
          | undefined;
      }
    | null
  > => {
    return await withAuthSafeDb(
      async (authDb) => {
        const [s] = await authDb
          .select()
          .from(sessionsTable)
          .where(eq(sessionsTable.tokenHash, tokenHash))
          ;
        if (!s) return null;
        const [u] = await authDb
          .select({
            id: usersTable.id,
            email: usersTable.email,
            name: usersTable.name,
            userType: usersTable.userType,
            firmId: usersTable.firmId,
            roleId: usersTable.roleId,
            developerId: usersTable.developerId,
            status: usersTable.status,
          })
          .from(usersTable)
          .where(eq(usersTable.id, s.userId))
          .catch(async (err) => {
            const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
            if (code !== "42703") throw err;
            const [u2] = await authDb
              .select({
                id: usersTable.id,
                email: usersTable.email,
                name: usersTable.name,
                userType: usersTable.userType,
                firmId: usersTable.firmId,
                roleId: usersTable.roleId,
                status: usersTable.status,
              })
              .from(usersTable)
              .where(eq(usersTable.id, s.userId))
              ;
            return [u2 ? ({ ...u2, developerId: null }) : undefined] as any;
          });
        return { session: s, user: u as any };
      },
      { retry: true, maxRetries: 1, ctx: { stage: "lookup_session_user" }, allowUnsafe: true },
    );
  };

  const timing: SessionUserLookupTiming = { attempts: 0, inflightShared: false, primaryLookupMs: 0, fallbackLookupMs: 0, identityDbSource: "UNKNOWN" };

  for (let attempt = 1; attempt <= 3; attempt++) {
    timing.attempts = attempt;
    try {
      if (isAuthAdminDbConfigured()) {
        const adminStart = Date.now();
        const admin = await lookupViaAuthAdminDb();
        timing.primaryLookupMs += Date.now() - adminStart;
        if (admin?.session) {
          timing.identityDbSource = authAdminSource;
          return admin?.user ? { ...(admin as any), timing } : { session: admin.session as any, user: undefined as any, timing };
        }
        if (attempt < 2) {
          await sleep(30 * attempt);
          continue;
        }
        return null;
      }

      const primaryStart = Date.now();
      const primary = await lookupViaDb();
      timing.primaryLookupMs += Date.now() - primaryStart;
      if (!primary?.session) {
        if (attempt < 2) {
          await sleep(30 * attempt);
          continue;
        }
        return null;
      }
      timing.identityDbSource = "DATABASE_URL";
      if (primary.user) return { ...primary, timing };

      try {
        const fallbackStart = Date.now();
        const fallback = await lookupViaAuthSafeDb();
        timing.fallbackLookupMs += Date.now() - fallbackStart;
        if (fallback?.session) timing.identityDbSource = "DATABASE_URL";
        return fallback?.session ? { ...(fallback as any), timing } : { ...primary, timing };
      } catch (err) {
        const shouldRetry = isTransientDbConnectionError(err);
        if (shouldRetry && attempt < 3) {
          await sleep(50 * attempt);
          continue;
        }
        return { ...primary, timing };
      }
    } catch (err) {
      const shouldRetry = isTransientDbConnectionError(err);
      if (shouldRetry && attempt < 3) {
        await sleep(50 * attempt);
        continue;
      }
      throw err;
    }
  }

  return null;
  })().finally(() => {
    inflightSessionLookups.delete(tokenHash);
  });

  inflightSessionLookups.set(tokenHash, p);
  const result = await p;
  if (result?.session) setVerifiedSessionCache(tokenHash, result);
  return result;
}

export async function requireFounder(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.userType !== "founder") {
    await writeAuditLog({ actorId: req.userId, actorType: req.userType ?? "unknown", action: "auth.forbidden.founder_required", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(403).json({ error: "Founder access required" });
    return;
  }
  const email = String(req.email ?? "").trim().toLowerCase();
  if (!FOUNDER_EMAILS.includes(email)) {
    await writeAuditLog({ actorId: req.userId, actorType: req.userType ?? "unknown", action: "auth.forbidden.founder_email_mismatch", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(403).json({ error: "Founder access required" });
    return;
  }
  next();
}

const founderLevelRank = (level: string | null | undefined): number => {
  if (!level) return 0;
  if (level === "viewer") return 1;
  if (level === "operator") return 2;
  if (level === "admin") return 3;
  if (level === "super_admin") return 4;
  return 0;
};

export async function loadFounderPermissions(req: AuthRequest): Promise<{ permissions: string[]; highestLevel: string | null }> {
  if (!req.userId || req.userType !== "founder") return { permissions: [], highestLevel: null };
  let rows: Array<{ perm: string; level: string | null }> = [];
  try {
    rows = await db
      .select({
        perm: platformFounderRolePermissionsTable.permissionCode,
        level: platformFounderRolesTable.level,
      })
      .from(platformFounderUserRolesTable)
      .innerJoin(platformFounderRolesTable, eq(platformFounderUserRolesTable.roleId, platformFounderRolesTable.id))
      .innerJoin(platformFounderRolePermissionsTable, eq(platformFounderRolesTable.id, platformFounderRolePermissionsTable.roleId))
      .where(eq(platformFounderUserRolesTable.userId, req.userId));
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
    logger.error({ err, userId: req.userId ?? null, code: typeof code === "string" ? code : null }, "auth.founder_permissions.degraded");
    const fallback = getFounderFallbackPermissions(req.email);
    if (fallback) return fallback;
    return { permissions: [], highestLevel: null };
  }

  const perms = Array.from(new Set(rows.map((r) => r.perm).filter((p): p is string => typeof p === "string" && p.length > 0)));
  const highest = rows.reduce<string | null>((acc, r) => {
    const lvl = typeof r.level === "string" ? r.level : null;
    if (!acc) return lvl;
    return founderLevelRank(lvl) > founderLevelRank(acc) ? lvl : acc;
  }, null);

  const merged = Array.from(new Set([...DEFAULT_FOUNDER_PERMISSION_CODES, ...perms]));
  const highestLevel = highest ?? (isFounderAllowlistedEmail(req.email) ? "super_admin" : null);
  return { permissions: merged, highestLevel };
}

export function requireFounderPermission(permissionCode: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (req.userType !== "founder") {
      res.status(403).json({ error: "Founder access required" });
      return;
    }
    try {
      const loaded = req.founderPermissions
        ? { permissions: req.founderPermissions, highestLevel: req.founderRoleLevel ?? null }
        : await loadFounderPermissions(req);
      req.founderPermissions = loaded.permissions;
      req.founderRoleLevel = loaded.highestLevel;

      if (!loaded.permissions.includes(permissionCode)) {
        await writeAuditLog({
          actorId: req.userId,
          actorType: "founder",
          action: "founder.permission.denied",
          detail: `permission=${permissionCode} route=${req.method} ${req.path}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
        res.status(403).json({ error: "Permission denied" });
        return;
      }
      next();
    } catch (err) {
      logger.error({ err, userId: req.userId, route: req.path }, "founder.permission.load_failed");
      res.status(503).json({ error: "Auth temporarily unavailable" });
    }
  };
}

/**
 * requireFirmUser — verifies the caller is an active firm user, then opens a
 * per-request Postgres transaction as app_user with app.current_firm_id set.
 *
 * This is what actually enforces DB-level RLS:
 *   1. A PoolClient is checked out from the pool.
 *   2. BEGIN is issued.
 *   3. SET LOCAL ROLE app_user — switches away from postgres (BYPASSRLS).
 *   4. SET LOCAL app.current_firm_id = req.firmId — drives tenant_isolation policies.
 *   5. req.rlsDb is set to a Drizzle instance bound to this client.
 *   6. On res.finish (or close), the transaction is COMMITTED (or ROLLBACKed).
 *
 * Phase 2+ route handlers MUST use req.rlsDb (not global db) for any query
 * that should be tenant-isolated at the DB layer.
 */
export async function requireFirmUser(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.userType !== "firm_user" || !req.firmId) {
    writeAuditLog({ actorId: req.userId, firmId: req.firmId, actorType: req.userType ?? "unknown", action: "auth.forbidden.firm_user_required", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(403).json({ error: "Firm user access required" });
    return;
  }

  let released = false;
  let client: PoolClient | null = null;
  const dbConnectStartedAt = Date.now();
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const connStart = Date.now();
        client = await pool.connect();
        const connMs = Date.now() - connStart;
        if (req.timing?.sections) {
          req.timing.sections["db_pool_connect"] = connMs;
          if (typeof (pool as any)?.totalCount !== undefined) {
            req.timing.sections["pool.totalCount"] = (pool as any).totalCount;
            req.timing.sections["pool.idleCount"] = (pool as any).idleCount;
            req.timing.sections["pool.waitingCount"] = (pool as any).waitingCount;
          }
        }
        break;
      } catch (err) {
        const transient = isTransientDbConnectionError(err);
        if (!transient || attempt >= 2) throw err;
        await new Promise<void>((r) => setTimeout(r, 50 * attempt));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sqlState = (() => {
      if (!err || typeof err !== "object") return undefined;
      const c = (err as { code?: unknown }).code;
      return typeof c === "string" ? c : undefined;
    })();
    logger.error({ err, message, sqlState: sqlState ?? null, userId: req.userId ?? null, firmId: req.firmId ?? null }, "auth.firm_user.connect_failed");
    res.status(503).json({
      error: "Tenant context temporarily unavailable",
      code: "DB_CONNECT",
      meta: {
        request_id: getReqId(req) ?? null,
        route: req.path,
        method: req.method,
        phase: "db_connect",
        jobId: getJobId(req) ?? null,
        firmUserLookupStatus: req.userType === "firm_user" ? "ok" : "not_firm_user",
        userId: req.userId ?? null,
        firmId: req.firmId ?? null,
        authTokenPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        authHeaderPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        cookiePresent: typeof req.headers.cookie === "string" && req.headers.cookie.length > 0,
      },
    });
    return;
  }
  if (req.timing) req.timing.sections.tenantContextDbConnectMs = Date.now() - dbConnectStartedAt;
  const dbConnectMs = Date.now() - dbConnectStartedAt;
  if (dbConnectMs > 250) {
    logger.warn(
      {
        route: req.path,
        requestId: getReqId(req) ?? null,
        method: req.method ?? null,
        firmId: req.firmId ?? null,
        userId: req.userId ?? null,
        dbConnectMs,
        poolTotal: typeof (pool as any)?.totalCount === "number" ? (pool as any).totalCount : null,
        poolIdle: typeof (pool as any)?.idleCount === "number" ? (pool as any).idleCount : null,
        poolWaiting: typeof (pool as any)?.waitingCount === "number" ? (pool as any).waitingCount : null,
      },
      "db.pool_connect_slow",
    );
  }
  if (!client) {
    res.status(503).json({
      error: "Tenant context temporarily unavailable",
      code: "DB_CONNECT",
      meta: {
        request_id: getReqId(req) ?? null,
        route: req.path,
        method: req.method,
        phase: "db_connect",
        jobId: getJobId(req) ?? null,
        firmUserLookupStatus: req.userType === "firm_user" ? "ok" : "not_firm_user",
        userId: req.userId ?? null,
        firmId: req.firmId ?? null,
        authTokenPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        authHeaderPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        cookiePresent: typeof req.headers.cookie === "string" && req.headers.cookie.length > 0,
      },
    });
    return;
  }

  const releaseClient = async (ok: boolean) => {
    if (released) return;
    released = true;
    try {
      if (ok) {
        await client.query("COMMIT");
      } else {
        await client.query("ROLLBACK");
      }
    } catch {
    }
    try {
      await clearTenantContext(client);
    } catch {
    } finally {
      client.release(!ok);
    }
  };

  try {
    const tenantContextStartedAt = Date.now();
    const originalQuery = client.query.bind(client);
    let chain = Promise.resolve();
    (client as any).query = (...args: unknown[]) => {
      const run = () => (originalQuery as any)(...args);
      const p = chain.then(run, run);
      chain = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    };
    await client.query("BEGIN");
    await setTenantContext(client, req.firmId, req.userId ?? undefined);
    req.rlsDb = makeRlsDb(client);
    req.rlsClient = client;
    if (req.timing) req.timing.sections.tenantContextMs = Date.now() - tenantContextStartedAt;
  } catch (err) {
    try {
      await releaseClient(false);
    } catch {
    }
    const message = err instanceof Error ? err.message : String(err);
    const sqlState = (() => {
      if (!err || typeof err !== "object") return undefined;
      const c = (err as { code?: unknown }).code;
      return typeof c === "string" ? c : undefined;
    })();
    logger.error({ err, message, userId: req.userId, firmId: req.firmId }, "auth.firm_context_error");
    const code =
      message.includes("must be member of role") || message.includes("permission denied")
        ? "RLS_ROLE"
        : message.includes("SET ROLE") || message.includes("RESET ROLE") || message.includes("Cannot enforce RLS safely")
          ? "RLS_CONTEXT"
          : "DB";
    logger.error(
      {
        route: req.path,
        requestId: getReqId(req) ?? null,
        code,
        errorCode: code,
        sqlState: sqlState ?? null,
        userId: req.userId ?? null,
        firmId: req.firmId ?? null,
        err,
      },
      "auth.firm_context_failed",
    );
    res.status(503).json({
      error: "Tenant context temporarily unavailable",
      code,
      meta: {
        request_id: getReqId(req) ?? null,
        route: req.path,
        method: req.method,
        phase: "set_tenant_context",
        jobId: getJobId(req) ?? null,
        firmUserLookupStatus: req.userType === "firm_user" ? "ok" : "not_firm_user",
        userId: req.userId ?? null,
        firmId: req.firmId ?? null,
        authTokenPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        authHeaderPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        cookiePresent: typeof req.headers.cookie === "string" && req.headers.cookie.length > 0,
      },
    });
    return;
  }

  res.on("finish", () => { releaseClient(true); });
  res.on("close", () => { releaseClient(false); });

  next();
}

export async function requireFirmUserSession(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.userType !== "firm_user" || !req.firmId) {
    writeAuditLog({ actorId: req.userId, firmId: req.firmId, actorType: req.userType ?? "unknown", action: "auth.forbidden.firm_user_required", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(403).json({ error: "Firm user access required" });
    return;
  }

  let released = false;
  let client: PoolClient | null = null;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const connStart = Date.now();
        client = await pool.connect();
        const connMs = Date.now() - connStart;
        if (req.timing?.sections) {
          req.timing.sections["db_pool_connect"] = connMs;
          if (typeof (pool as any)?.totalCount !== undefined) {
            req.timing.sections["pool.totalCount"] = (pool as any).totalCount;
            req.timing.sections["pool.idleCount"] = (pool as any).idleCount;
            req.timing.sections["pool.waitingCount"] = (pool as any).waitingCount;
          }
        }
        break;
      } catch (err) {
        const transient = isTransientDbConnectionError(err);
        if (!transient || attempt >= 2) throw err;
        await new Promise<void>((r) => setTimeout(r, 50 * attempt));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message, userId: req.userId ?? null, firmId: req.firmId ?? null }, "auth.firm_user.connect_failed");
    res.status(503).json({
      error: "Tenant context temporarily unavailable",
      code: "DB_CONNECT",
      meta: {
        request_id: getReqId(req) ?? null,
        route: req.path,
        method: req.method,
        phase: "db_connect",
        jobId: getJobId(req) ?? null,
        firmUserLookupStatus: req.userType === "firm_user" ? "ok" : "not_firm_user",
        userId: req.userId ?? null,
        firmId: req.firmId ?? null,
        authTokenPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        authHeaderPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        cookiePresent: typeof req.headers.cookie === "string" && req.headers.cookie.length > 0,
      },
    });
    return;
  }
  if (!client) {
    res.status(503).json({
      error: "Tenant context temporarily unavailable",
      code: "DB_CONNECT",
      meta: {
        request_id: getReqId(req) ?? null,
        route: req.path,
        method: req.method,
        phase: "db_connect",
        jobId: getJobId(req) ?? null,
        firmUserLookupStatus: req.userType === "firm_user" ? "ok" : "not_firm_user",
        userId: req.userId ?? null,
        firmId: req.firmId ?? null,
        authTokenPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        authHeaderPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        cookiePresent: typeof req.headers.cookie === "string" && req.headers.cookie.length > 0,
      },
    });
    return;
  }

  const releaseClient = async (ok: boolean) => {
    if (released) return;
    released = true;
    try {
      await clearTenantContext(client);
    } catch {
    } finally {
      client.release(!ok);
    }
  };

  try {
    const originalQuery = client.query.bind(client);
    let chain = Promise.resolve();
    (client as any).query = (...args: unknown[]) => {
      const run = () => (originalQuery as any)(...args);
      const p = chain.then(run, run);
      chain = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    };
    await setTenantContextSession(client, req.firmId, req.userId ?? undefined);
    req.rlsDb = makeRlsDb(client);
  } catch (err) {
    try {
      await releaseClient(false);
    } catch {
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message, userId: req.userId, firmId: req.firmId }, "auth.firm_context_error");
    res.status(503).json({
      error: "Tenant context temporarily unavailable",
      code: "RLS_CONTEXT",
      meta: {
        request_id: getReqId(req) ?? null,
        route: req.path,
        method: req.method,
        phase: "set_tenant_context",
        jobId: getJobId(req) ?? null,
        firmUserLookupStatus: req.userType === "firm_user" ? "ok" : "not_firm_user",
        userId: req.userId ?? null,
        firmId: req.firmId ?? null,
        authTokenPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        authHeaderPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
        cookiePresent: typeof req.headers.cookie === "string" && req.headers.cookie.length > 0,
      },
    });
    return;
  }

  res.on("finish", () => { releaseClient(true); });
  res.on("close", () => { releaseClient(false); });
  next();
}

export function requirePermission(moduleName: string, action: string) {
  return async function permissionMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const safeAudit = async (detail: string) => {
        if (!req.rlsDb) return;
        await writeAuditLog(
          {
            actorId: req.userId,
            firmId: req.firmId,
            actorType: req.userType ?? "unknown",
            action: "auth.forbidden.permission",
            detail,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
          },
          { db: req.rlsDb },
        );
      };

      if (req.userType !== "firm_user" || !req.firmId || !req.roleId) {
        await safeAudit(`${moduleName}:${action} ${req.method} ${req.path}`);
        res.status(403).json({ error: "Permission denied" });
        return;
      }

      const rlsDb = req.rlsDb ?? db;

      const cached = (req as any)._roleCache as { firmId: number; roleId: number; name: string } | undefined;
      let roleName = cached && cached.firmId === req.firmId && cached.roleId === req.roleId ? cached.name : null;
      if (!roleName) {
        const [role] = await rlsDb
          .select({ name: rolesTable.name })
          .from(rolesTable)
          .where(and(eq(rolesTable.id, req.roleId), eq(rolesTable.firmId, req.firmId)))
          .limit(1);
        roleName = role?.name ?? null;
        if (roleName) {
          (req as any)._roleCache = { firmId: req.firmId, roleId: req.roleId, name: roleName };
        }
      }

      if (!roleName) {
        try {
          const diag = await rlsDb.execute(sql`
            SELECT
              current_user AS current_user,
              current_setting('app.current_firm_id', true) AS current_firm_id,
              current_setting('app.is_founder', true) AS is_founder
          `);
          const rows = Array.isArray(diag) ? (diag as any[]) : ((diag as any)?.rows ?? []);
          const first = rows?.[0] ?? null;
          logger.error(
            {
              route: req.path,
              requestId: getReqId(req) ?? null,
              userId: req.userId ?? null,
              firmId: req.firmId ?? null,
              roleId: req.roleId ?? null,
              moduleName,
              action,
              hasRlsDb: Boolean(req.rlsDb),
              currentUser: first?.current_user ?? null,
              currentFirmId: first?.current_firm_id ?? null,
              isFounder: first?.is_founder ?? null,
            },
            "auth.permission.role_not_found",
          );
        } catch {
        }
        await safeAudit(`${moduleName}:${action} ${req.method} ${req.path} reason=role_not_found`);
        res.status(403).json({ error: "Permission denied" });
        return;
      }

      const permCache = ((req as any)._permissionCache as Map<string, boolean> | undefined) ?? new Map<string, boolean>();
      (req as any)._permissionCache = permCache;
      const permKey = `${moduleName}:${action}`;
      const cachedAllowed = permCache.has(permKey) ? permCache.get(permKey) : undefined;
      if (cachedAllowed === false) {
        await safeAudit(`${moduleName}:${action} ${req.method} ${req.path}`);
        res.status(403).json({ error: "Permission denied", code: "PERMISSION_DENIED" });
        return;
      }
      if (cachedAllowed === true) {
        next();
        return;
      }

      let [perm] = await rlsDb
        .select()
        .from(permissionsTable)
        .where(and(
          eq(permissionsTable.roleId, req.roleId),
          eq(permissionsTable.module, moduleName),
          eq(permissionsTable.action, action),
        ));

      if (!perm) {
        const ensured = ((req as any)._baselineEnsuredRoleIds as Set<number> | undefined) ?? new Set<number>();
        (req as any)._baselineEnsuredRoleIds = ensured;
        try {
          if (!ensured.has(req.roleId) && req.firmId) {
            await ensureRolePermissionsInitialized(rlsDb as any, req.firmId, req.roleId);
            ensured.add(req.roleId);
          }
        } catch (err) {
          const sqlState = (() => {
            if (!err || typeof err !== "object") return undefined;
            const c = (err as { code?: unknown }).code;
            return typeof c === "string" ? c : undefined;
          })();
          logger.error(
            {
              route: req.path,
              requestId: getReqId(req) ?? null,
              userId: req.userId ?? null,
              firmId: req.firmId ?? null,
              roleId: req.roleId ?? null,
              moduleName,
              action,
              sqlState: sqlState ?? null,
              errorCode: sqlState ?? null,
              err,
            },
            "auth.permission_seed_failed",
          );
        }
        [perm] = await rlsDb
          .select()
          .from(permissionsTable)
          .where(and(
            eq(permissionsTable.roleId, req.roleId),
            eq(permissionsTable.module, moduleName),
            eq(permissionsTable.action, action),
          ));
      }

      if (!perm || !perm.allowed) {
        permCache.set(permKey, false);
        await safeAudit(`${moduleName}:${action} ${req.method} ${req.path}`);
        res.status(403).json({ error: "Permission denied", code: "PERMISSION_DENIED" });
        return;
      }

      permCache.set(permKey, true);
      next();
    } catch (err) {
      const sqlState = (() => {
        if (!err || typeof err !== "object") return undefined;
        const c = (err as { code?: unknown }).code;
        return typeof c === "string" ? c : undefined;
      })();
      logger.error(
        {
          route: req.path,
          requestId: getReqId(req) ?? null,
          userId: req.userId ?? null,
          firmId: req.firmId ?? null,
          roleId: req.roleId ?? null,
          moduleName,
          action,
          sqlState: sqlState ?? null,
          errorCode: sqlState ?? null,
          err,
        },
        "auth.permission_failed",
      );
      res.status(503).json({ error: "Auth temporarily unavailable" });
      return;
    } finally {
      if (req.timing?.sections) {
        req.timing.sections.permissionMs = (req.timing.sections.permissionMs ?? 0) + Math.max(0, Date.now() - startedAt);
      }
    }
  };
}

async function ensureBaselinePermissions(
  rlsDb: RlsDb | typeof db,
  roleId: number,
  baseline: "Partner" | "Staff" | "Developer_User",
): Promise<void> {
  if (baseline === "Partner") {
    await rlsDb.execute(sql`
      INSERT INTO permissions (role_id, module, action, allowed)
      SELECT ${roleId}, v.module, v.action, TRUE
      FROM (
        VALUES
          ('dashboard','read'),
          ('case_monitor','view'),
          ('file_custody','view'),
          ('file_custody','release'),
          ('file_custody','receive'),
          ('file_custody','return'),
          ('file_custody','manage'),
          ('cases','read'),('cases','create'),('cases','update'),('cases','delete'),
          ('cases','assign_any'),
          ('case_reference','view'),('case_reference','change'),
          ('projects','read'),('projects','create'),('projects','update'),('projects','delete'),
          ('developers','read'),('developers','create'),('developers','update'),('developers','delete'),
          ('documents','read'),('documents','create'),('documents','update'),('documents','delete'),('documents','generate'),('documents','export'),
          ('communications','read'),('communications','create'),('communications','update'),('communications','delete'),
          ('accounting','read'),('accounting','write'),('accounting','create'),('accounting','edit'),
          ('accounting','review'),('accounting','approve'),('accounting','mark_received'),('accounting','mark_paid'),
          ('accounting','cancel'),('accounting','reopen'),('accounting','export'),('accounting','view_audit'),
          ('accounting','manage_settings'),('accounting','override_sla'),
          ('reports','read'),('reports','export'),
          ('audit','read'),
          ('settings','read'),('settings','update'),
          ('users','read'),('users','create'),('users','update'),('users','delete'),
          ('roles','read'),('roles','create'),('roles','update'),('roles','delete')
      ) AS v(module, action)
      WHERE NOT EXISTS (
        SELECT 1 FROM permissions p
        WHERE p.role_id = ${roleId} AND p.module = v.module AND p.action = v.action
      )
    `);
    return;
  }

  if (baseline === "Developer_User") {
    await rlsDb.execute(sql`
      INSERT INTO permissions (role_id, module, action, allowed)
      SELECT ${roleId}, v.module, v.action, TRUE
      FROM (
        VALUES
          ('dashboard','read'),
          ('cases','read'),
          ('developer_portal','read'),
          ('developer_portal','export'),
          ('developer_portal','message')
      ) AS v(module, action)
      WHERE NOT EXISTS (
        SELECT 1 FROM permissions p
        WHERE p.role_id = ${roleId} AND p.module = v.module AND p.action = v.action
      )
    `);
    return;
  }

  await rlsDb.execute(sql`
    INSERT INTO permissions (role_id, module, action, allowed)
    SELECT ${roleId}, v.module, v.action, TRUE
    FROM (
      VALUES
        ('dashboard','read'),
        ('cases','read'),('cases','create'),('cases','update'),
        ('case_reference','view'),
        ('projects','read'),('projects','create'),('projects','update'),
        ('developers','read'),('developers','create'),('developers','update'),
        ('documents','read'),('documents','export'),
        ('communications','read'),('communications','create'),
        ('reports','read'),
        ('settings','read'),
        ('users','read')
    ) AS v(module, action)
    WHERE NOT EXISTS (
      SELECT 1 FROM permissions p
      WHERE p.role_id = ${roleId} AND p.module = v.module AND p.action = v.action
    )
  `);
}

export async function ensureRolePermissionsInitialized(
  rlsDb: RlsDb | typeof db,
  firmId: number,
  roleId: number,
): Promise<{ ensured: boolean; insertedBaseline: boolean; permissionsCount: number }> {
  const [role] = await rlsDb
    .select()
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)));
  if (!role) return { ensured: false, insertedBaseline: false, permissionsCount: 0 };

  const roleName = String((role as any).name ?? "");
  const roleLower = roleName.toLowerCase();
  const countRows = await rlsDb.execute(sql`SELECT COUNT(*)::int AS c FROM permissions WHERE role_id = ${roleId} AND allowed = true`);
  const rows = Array.isArray(countRows) ? (countRows as any[]) : ((countRows as any)?.rows ?? []);
  const beforeCount = typeof rows?.[0]?.c === "number" ? rows[0].c : Number(rows?.[0]?.c ?? 0);

  const isAutoBaselineStandardName = (() => {
    const n = roleName.trim().toLowerCase();
    return (
      n === "partner"
      || n === "lawyer"
      || n === "senior lawyer"
      || n === "clerk"
      || n === "senior clerk"
      || n === "staff"
      || n === "admin"
      || n === "manager"
      || n === "viewer"
      || n === "account admin"
      || n === "account manager"
      || n === "developer_user"
    );
  })();
  const eligibleForAutoBaseline = Boolean((role as any).isSystemRole) || isAutoBaselineStandardName;
  if (!eligibleForAutoBaseline) {
    return { ensured: true, insertedBaseline: false, permissionsCount: beforeCount };
  }

  let insertedBaseline = false;
  const baseline: "Partner" | "Staff" | "Developer_User" = (() => {
    if (roleLower.includes("partner")) return "Partner";
    if (roleName === "Developer_User" || roleLower.includes("developer")) return "Developer_User";
    return "Staff";
  })();
  await ensureBaselinePermissions(rlsDb, roleId, baseline);

  const countRows2 = await rlsDb.execute(sql`SELECT COUNT(*)::int AS c FROM permissions WHERE role_id = ${roleId} AND allowed = true`);
  const rows2 = Array.isArray(countRows2) ? (countRows2 as any[]) : ((countRows2 as any)?.rows ?? []);
  const c2 = typeof rows2?.[0]?.c === "number" ? rows2[0].c : Number(rows2?.[0]?.c ?? 0);
  insertedBaseline = c2 > beforeCount;
  return { ensured: true, insertedBaseline, permissionsCount: c2 };
}

/**
 * Restricts access to users with the Partner role (role_id = 1).
 * Must be used after requireAuth + requireFirmUser.
 */
export async function requirePartner(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  return requirePermission("roles", "manage")(req, res, next);
}

const normalizeRoleNameForGuard = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

export function isRoleGroupManagement(roleName: unknown): boolean {
  const n = typeof roleName === "string" ? roleName.trim().toLowerCase() : "";
  return n.includes("partner") || n.includes("manager");
}

async function hasExplicitPermission(req: AuthRequest, moduleName: string, action: string): Promise<boolean> {
  if (!req.roleId || !req.firmId) return false;
  const r = req.rlsDb ?? db;
  let [perm] = await r
    .select()
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, req.roleId),
      eq(permissionsTable.module, moduleName),
      eq(permissionsTable.action, action),
      eq(permissionsTable.allowed, true),
    ));

  if (perm) return true;

  try {
    await ensureRolePermissionsInitialized(r as any, req.firmId, req.roleId);
  } catch (err) {
    logger.error({ err, firmId: req.firmId, roleId: req.roleId, moduleName, action }, "auth.explicit_permission_seed_failed");
  }

  [perm] = await r
    .select()
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, req.roleId),
      eq(permissionsTable.module, moduleName),
      eq(permissionsTable.action, action),
      eq(permissionsTable.allowed, true),
    ));
  return Boolean(perm);
}

export async function requirePartnerOrAccountForInvoices(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.firmId || !req.roleId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const allowed = await hasExplicitPermission(req, "accounting", "write")
    || await hasExplicitPermission(req, "accounting", "create")
    || await hasExplicitPermission(req, "accounting", "edit");
  if (!allowed) {
    await writeAuditLog({
      actorId: req.userId,
      firmId: req.firmId,
      actorType: req.userType ?? "firm_user",
      action: "auth.forbidden.invoice_create",
      detail: `roleId=${req.roleId}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(403).json({ error: "Explicit accounting permission required" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Short-lived in-memory re-auth token store
// ---------------------------------------------------------------------------

interface ReauthEntry {
  userId: number;
  expiresAt: Date;
  used: boolean;
}

const _reauthStore = new Map<string, ReauthEntry>();

setInterval(() => {
  const now = new Date();
  for (const [k, v] of _reauthStore) {
    if (v.expiresAt < now) _reauthStore.delete(k);
  }
}, 5 * 60 * 1000).unref();

export function issueReauthToken(userId: number): string {
  const plain = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(plain).digest("hex");
  _reauthStore.set(hash, {
    userId,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    used: false,
  });
  return plain;
}

export async function requireReAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const reAuthToken = req.headers["x-reauth-token"] as string | undefined;
  if (!reAuthToken) {
    res.status(403).json({ error: "Re-authentication required for this action", code: "REAUTH_REQUIRED" });
    return;
  }

  const hash = crypto.createHash("sha256").update(reAuthToken).digest("hex");
  const entry = _reauthStore.get(hash);

  if (!entry || entry.used || entry.expiresAt < new Date() || entry.userId !== req.userId) {
    await writeAuditLog({
      actorId: req.userId, firmId: req.firmId, actorType: req.userType ?? "firm_user",
      action: "auth.reauth_failed", detail: `${req.method} ${req.path}`,
      ipAddress: req.ip, userAgent: req.headers["user-agent"],
    });
    res.status(403).json({ error: "Re-authentication token invalid or expired", code: "REAUTH_FAILED" });
    return;
  }

  entry.used = true;
  next();
}

async function hasRolePermissionFromDb(
  r: { select: any },
  firmId: number,
  roleId: number | undefined,
  module: string,
  action: string,
): Promise<boolean> {
  if (!roleId) return false;
  const [role] = await r
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, firmId)));
  if (!role) return false;
  const [perm] = await r
    .select({ allowed: permissionsTable.allowed })
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, roleId),
      eq(permissionsTable.module, module),
      eq(permissionsTable.action, action),
    ));
  return Boolean(perm?.allowed);
}

export async function hasCasesFirmwideScope(
  r: { select: any },
  firmId: number | undefined,
  roleId: number | undefined,
  roleName: string | null | undefined,
): Promise<boolean> {
  if (!firmId || !roleId) return isRoleGroupManagement(roleName);
  const perm = await hasRolePermissionFromDb(r as any, firmId, roleId, "cases", "assign_any");
  if (perm) return true;
  return isRoleGroupManagement(roleName);
}

export type CaseScopeSqlOpts = {
  casesTableAlias?: string;
  assignmentsAlias?: string;
};

export function getAccessibleCasesSqlScope(
  opts: {
    hasFirmwideScope: boolean;
    firmId: number;
    userId: number;
    caseIdColumnRef?: any;
    rawCaseAssignments?: any;
  },
): any {
  if (opts.hasFirmwideScope) return sql`TRUE`;
  const caseRef = opts.caseIdColumnRef ?? casesTable.id;
  const assignmentsTable = opts.rawCaseAssignments ?? caseAssignmentsTable;
  return sql`EXISTS (
    SELECT 1 FROM ${assignmentsTable} a
    WHERE a.case_id = ${caseRef}
      AND a.user_id = ${opts.userId}
      AND a.unassigned_at IS NULL
  )`;
}

export async function requireManagementRoleForDashboard(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const permOk = await new Promise<boolean>((resolve) => {
    const mw = requirePermission("dashboard", "read") as any;
    mw(req, res, () => resolve(true));
  });
  if (!permOk) return;

  const rlsDb = req.rlsDb ?? db;
  let roleName: string | null = null;
  const cached = (req as any)._roleCache as { firmId: number; roleId: number; name: string } | undefined;
  if (cached && cached.firmId === req.firmId && cached.roleId === req.roleId) {
    roleName = cached.name;
  } else if (req.firmId && req.roleId) {
    const [role] = await rlsDb
      .select({ name: rolesTable.name })
      .from(rolesTable)
      .where(and(eq(rolesTable.id, req.roleId), eq(rolesTable.firmId, req.firmId)))
      .limit(1);
    roleName = role?.name ?? null;
    if (roleName) {
      (req as any)._roleCache = { firmId: req.firmId, roleId: req.roleId, name: roleName };
    }
  }

  if (!isRoleGroupManagement(roleName)) {
    await writeAuditLog({
      actorId: req.userId,
      firmId: req.firmId,
      actorType: req.userType ?? "unknown",
      action: "auth.forbidden.dashboard_access_denied_staff",
      detail: `${req.method} ${req.path}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    }, { db: req.rlsDb });
    res.status(403).json({ error: "DashboardAccessRestricted", code: "DASHBOARD_ACCESS_RESTRICTED" });
    return;
  }

  next();
}

export async function enforceCaseAccessGeneric(
  r: { select: any; insert: any },
  req: AuthRequest,
  res: Response,
  caseId: number,
): Promise<boolean> {
  const firmId = req.firmId;
  if (!firmId || !req.userId) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, firmId)))
    .limit(1);
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return false;
  }

  const rlsDb = req.rlsDb ?? db;
  let roleName: string | null = null;
  const cached = (req as any)._roleCache as { firmId: number; roleId: number; name: string } | undefined;
  if (cached && cached.firmId === req.firmId && cached.roleId === req.roleId) {
    roleName = cached.name;
  } else if (req.firmId && req.roleId) {
    const [role] = await rlsDb
      .select({ name: rolesTable.name })
      .from(rolesTable)
      .where(and(eq(rolesTable.id, req.roleId), eq(rolesTable.firmId, req.firmId)))
      .limit(1);
    roleName = role?.name ?? null;
    if (roleName) {
      (req as any)._roleCache = { firmId: req.firmId, roleId: req.roleId, name: roleName };
    }
  }

  const elevated = await hasCasesFirmwideScope(r as any, firmId, req.roleId ?? undefined, roleName);
  if (elevated) return true;

  const [assigned] = await r
    .select({ id: caseAssignmentsTable.id })
    .from(caseAssignmentsTable)
    .where(and(
      eq(caseAssignmentsTable.caseId, caseId),
      eq(caseAssignmentsTable.userId, req.userId),
      inArray(caseAssignmentsTable.roleInCase, ["lawyer", "clerk"]),
      sql`${caseAssignmentsTable.unassignedAt} IS NULL`,
    ))
    .limit(1);
  if (assigned) return true;

  await writeAuditLog({
    firmId,
    actorId: req.userId,
    actorType: req.userType ?? "firm_user",
    action: "auth.forbidden.case_access_denied",
    entityType: "case",
    entityId: caseId,
    detail: "not_assigned",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });

  res.status(403).json({ error: "Forbidden" });
  return false;
}
