import express, { type Router as ExpressRouter } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { auditLogsTable, clearTenantContext, db, firmsTable, makeRlsDb, permissionsTable, pool, rolesTable, sessionsTable, setTenantContextSession, sql, usersTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { ensureRolePermissionsInitialized, loadFounderPermissions, lookupSessionAndUserByTokenHash, requireAuth, requireReAuth, issueReauthToken, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { ApiError, sendError, sendOk } from "../lib/api-response.js";
import { authRateLimiter, sensitiveRateLimiter } from "../lib/rate-limit.js";
import { logger } from "../lib/logger.js";
import { isTransientDbConnectionError, withAuthSafeDb } from "../lib/auth-safe-db.js";
import { isAuthAdminDbConfigured, withAuthAdminDb } from "../lib/auth-admin-db.js";
import { extractDbErrorInfo } from "../lib/db-error.js";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

type ReqLike = {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  headers: Record<string, unknown>;
  cookies?: Record<string, string>;
  method?: unknown;
  url?: unknown;
  originalUrl?: unknown;
  path?: unknown;
  ip?: unknown;
  user?: unknown;
  firmId?: unknown;
  requestId?: unknown;
  [key: string]: unknown;
};

type RouteResLike = import("node:http").ServerResponse & {
  locals: Record<string, unknown>;
  status: (code: number) => RouteResLike;
  json: (body: unknown) => RouteResLike;
  cookie: (...args: unknown[]) => RouteResLike;
  clearCookie: (...args: unknown[]) => RouteResLike;
  setHeader?: (name: string, value: string | number | readonly string[]) => void;
  [key: string]: unknown;
};

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
  use: (...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const routerInternal = expressRouter as unknown as RouterInternalLike;

const FOUNDER_EMAIL = "lun.6923@hotmail.com";

type AuthRequestLike = AuthRequest & ReqLike;

const asOptionalString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

const getParam = (req: AuthRequestLike, key: string): string | undefined => {
  return asOptionalString(req.params?.[key]);
};

const getHeader = (req: AuthRequestLike, key: string): string | undefined => {
  const lower = key.toLowerCase();
  const value = req.headers?.[lower] ?? req.headers?.[key];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return asOptionalString(value);
};

const getRoute = (req: unknown): string => {
  const r = req as { path?: unknown; originalUrl?: unknown; url?: unknown } | null;
  if (typeof r?.path === "string" && r.path.length > 0) return r.path;
  if (typeof r?.originalUrl === "string" && r.originalUrl.length > 0) return r.originalUrl;
  if (typeof r?.url === "string" && r.url.length > 0) return r.url;
  return "unknown";
};

const asRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

const asNullableString = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
};

const optionalString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const optionalNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const getReqId = (req: unknown): string | undefined => {
  const r = req as { id?: unknown; requestId?: unknown; headers?: Record<string, unknown> } | null;
  const id = r?.id;
  if (typeof id === "string" && id.length > 0) return id;
  const requestId = r?.requestId;
  if (typeof requestId === "string" && requestId.length > 0) return requestId;
  const header = r?.headers?.["x-request-id"];
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && typeof header[0] === "string" && header[0].length > 0) return header[0];
  return undefined;
};

const getCookieToken = (req: unknown): string | undefined => {
  const cookies = (req as { cookies?: Record<string, unknown> } | null)?.cookies;
  const token = cookies?.["auth_token"];
  return typeof token === "string" ? token : undefined;
};

const isUndefinedColumnError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "42703") return true;
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown }).message === "string"
        ? ((err as { message: string }).message as string)
        : String(err);
  const lowered = message.toLowerCase();
  return lowered.includes("column") && lowered.includes("does not exist");
};

const getSqlState = (err: unknown): string | undefined => {
  const info = extractDbErrorInfo(err);
  const sqlstate = info.sqlstate ?? info.sqlState;
  return typeof sqlstate === "string" && sqlstate ? sqlstate : undefined;
};

async function withTransientDbRetry<T>(
  fn: () => Promise<T>,
  ctx: { route?: string; reqId?: unknown; stage?: string; firmId?: number | null; userId?: number | null; emailHash?: string },
  maxRetries: number,
): Promise<T> {
  let lastErr: unknown;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const shouldRetry = isTransientDbConnectionError(err) && attempt <= maxRetries;
      if (!shouldRetry) throw err;
      logger.warn(
        {
          ...ctx,
          attempt,
          retryCount: attempt,
          durationMs: Date.now() - startedAt,
          sqlState: getSqlState(err) ?? null,
          errorCode: getSqlState(err) ?? null,
          err,
        },
        "auth.db_transient_retry",
      );
    }
  }
  throw lastErr;
}

async function insertAuthAuditLog(
  row: typeof auditLogsTable.$inferInsert,
  ctx: { route?: string; reqId?: unknown; stage?: string; firmId?: number | null; userId?: number | null; emailHash?: string },
): Promise<void> {
  if (!isAuthAdminDbConfigured()) return;
  try {
    await withAuthAdminDb(async (adminDb) => {
      await adminDb.insert(auditLogsTable).values(row);
    }, { stage: ctx.stage, route: ctx.route, reqId: typeof ctx.reqId === "string" ? ctx.reqId : null });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in (err as any) && typeof (err as any).code === "string"
        ? String((err as any).code)
        : null;
    if (code === "AUTH_ADMIN_DB_NOT_CONFIGURED") return;
    const sqlState = getSqlState(err);
    if (sqlState === "42P01") return;
    if (sqlState === "28P01") return;
    logger.error({ ...ctx, sqlState: sqlState ?? null, err }, "auth.audit_insert_failed");
  }
}

routerInternal.post("/auth/login", authRateLimiter, async (req: ReqLike, res: RouteResLike): Promise<void> => {
  const debugHeader = (req.headers?.["x-lawcaspro-debug"] ??
    req.headers?.["x-debug-bridge"] ??
    req.headers?.["x-debug"]) as unknown;
  const shouldDebug =
    process.env.DEBUG_VERCEL_BRIDGE === "1" ||
    debugHeader === "1" ||
    (Array.isArray(debugHeader) && debugHeader[0] === "1") ||
    /[?&]__debug=1(?:&|$)/.test(typeof req.originalUrl === "string" ? req.originalUrl : "");

  if (shouldDebug) {
    logger.info(
      {
        method: typeof req.method === "string" ? req.method : undefined,
        url: typeof req.originalUrl === "string" ? req.originalUrl : typeof req.url === "string" ? req.url : undefined,
      },
      "AUTH LOGIN HIT",
    );
  }
  const startedAt = Date.now();
  let stage: string = "parse";
  let emailHash: string | undefined;
  let userId: number | undefined;
  const timing: Record<string, number> = {};
  try {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    const { email, password } = parsed.data;
    const emailNormalized = email.toLowerCase();
    emailHash = crypto
      .createHash("sha256")
      .update(emailNormalized)
      .digest("hex")
      .slice(0, 12);
    const ip = (req as { ip?: unknown } | null)?.ip;
    const ua = req.headers?.["user-agent"];
    const reqId = getReqId(req);

    const ctx = {
      route: getRoute(req),
      stage,
      reqId,
      emailHash,
      firmId: undefined as number | undefined,
      userId: undefined as number | undefined,
    };
    let useAdminDb = isAuthAdminDbConfigured();
    let useSafeDbFallback = false;

    type LoginDbLike = Pick<typeof db, "select" | "insert" | "update">;

    const safeDbFallbackCtx = (fallbackStage: string) => ({
      route: ctx.route,
      reqId: ctx.reqId,
      firmId: optionalNumber(ctx.firmId) ?? null,
      userId: optionalNumber(ctx.userId) ?? null,
      emailHash: ctx.emailHash,
      stage: fallbackStage,
    });

    const withLoginDb = async <T>(fn: (dbLike: LoginDbLike) => Promise<T>, opStage: string): Promise<T> => {
      if (useAdminDb) {
        try {
          return await withAuthAdminDb(async (dbLike) => await fn(dbLike as unknown as LoginDbLike), { stage: opStage, route: ctx.route, reqId: typeof ctx.reqId === "string" ? ctx.reqId : null });
        } catch (err) {
          const sqlState = getSqlState(err);
          if (sqlState === "28P01") {
            useAdminDb = false;
            useSafeDbFallback = true;
            logger.error(
              { ...ctx, stage: opStage, adminDbDisabled: true, safeCategory: "INVALID_DB_CREDENTIALS" },
              "auth.login.admin_db_disabled",
            );
          } else {
            throw err;
          }
        }
      }

      if (useSafeDbFallback) {
        return await withAuthSafeDb(async (dbLike) => await fn(dbLike as unknown as LoginDbLike), {
          retry: true,
          maxRetries: 2,
          allowUnsafe: true,
          ctx: safeDbFallbackCtx(opStage),
        });
      }
      return await fn(db);
    };

    stage = "login_start";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");

    stage = "user_lookup";
    ctx.stage = stage;
    const userLookupStartedAt = Date.now();
    logger.info({ ...ctx }, "auth.login.stage");
    type LoginUser = {
      id: number;
      firmId: number | null;
      email: string;
      name: string;
      passwordHash: string;
      userType: string;
      roleId: number | null;
      status: string;
      totpSecret: string | null;
      totpEnabled: boolean;
    };

    const user: LoginUser | null = await (async () => {
      try {
        const rows = await withTransientDbRetry(async () => {
          return await withLoginDb(async (dbLike) => {
            return await dbLike
              .select({
                id: usersTable.id,
                firmId: usersTable.firmId,
                email: usersTable.email,
                name: usersTable.name,
                passwordHash: usersTable.passwordHash,
                userType: usersTable.userType,
                roleId: usersTable.roleId,
                status: usersTable.status,
                totpSecret: usersTable.totpSecret,
                totpEnabled: usersTable.totpEnabled,
              })
              .from(usersTable)
              .where(eq(usersTable.email, emailNormalized));
          }, "auth_login_user_lookup");
        }, { ...ctx, stage: "user_lookup.query" }, 2);
        const u = rows[0] as LoginUser | undefined;
        return u ?? null;
      } catch (err) {
        if (!isUndefinedColumnError(err)) throw err;
        const errMessageShort =
          err instanceof Error ? err.message.slice(0, 180) : String(err ?? "").slice(0, 180);
        logger.warn({ ...ctx, stage: "user_lookup_fallback", errMessageShort, err }, "auth.login.degraded_schema");

        const rows = await withTransientDbRetry(async () => {
          return await withLoginDb(async (dbLike) => {
            return await dbLike
              .select({
                id: usersTable.id,
                firmId: usersTable.firmId,
                email: usersTable.email,
                name: usersTable.name,
                passwordHash: usersTable.passwordHash,
                userType: usersTable.userType,
                roleId: usersTable.roleId,
                status: usersTable.status,
              })
              .from(usersTable)
              .where(eq(usersTable.email, emailNormalized));
          }, "auth_login_user_lookup_fallback");
        }, { ...ctx, stage: "user_lookup_fallback.query" }, 2);
        const u = rows[0] as {
          id: number;
          firmId: number | null;
          email: string;
          name: string;
          passwordHash: string;
          userType: string;
          roleId: number | null;
          status: string;
        } | undefined;

        if (!u) return null;
        return {
          id: u.id,
          firmId: u.firmId,
          email: u.email,
          name: u.name,
          passwordHash: u.passwordHash,
          userType: u.userType,
          roleId: u.roleId,
          status: u.status,
          totpEnabled: false,
          totpSecret: null,
        } satisfies LoginUser;
      }
    })();

    if (!user) {
      logger.info({ emailHash, ms: Date.now() - startedAt }, "auth.user_not_found");
      await insertAuthAuditLog(
        {
          firmId: null,
          actorId: null,
          actorType: "firm_user",
          action: "auth.user_not_found",
          detail: `email=${emailNormalized} route=${req.method} ${getRoute(req)}`,
          ipAddress: asNullableString(ip),
          userAgent: asNullableString(ua),
        },
        { ...ctx, stage: "audit_user_not_found" },
      );
      res.status(401).json({ error: "Invalid email or password", code: "AUTH_INVALID_CREDENTIALS" });
      return;
    }

    userId = user.id;
    ctx.userId = user.id;
    ctx.firmId = optionalNumber(user.firmId) ?? undefined;
    const userLookupMs = Date.now() - userLookupStartedAt;
    timing.userLookupMs = userLookupMs;
    logger.info({ ...ctx, ms: userLookupMs }, "auth.login.stage.user_lookup_done");

    if (user.userType === "founder" && emailNormalized !== FOUNDER_EMAIL) {
      logger.warn({ emailHash, userId: user.id, ms: Date.now() - startedAt }, "auth.login.founder_email_mismatch");
      await insertAuthAuditLog(
        {
          firmId: null,
          actorId: user.id,
          actorType: "founder",
          action: "auth.login_failed",
          detail: "reason=founder_email_mismatch",
          ipAddress: asNullableString(ip),
          userAgent: asNullableString(ua),
        },
        { ...ctx, stage: "audit_founder_email_mismatch" },
      );
      res.status(403).json({ error: "Founder access required", code: "AUTH_FOUNDER_EMAIL_MISMATCH" });
      return;
    }

    stage = "password_verify";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");
    const passwordVerifyStartedAt = Date.now();
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    timing.passwordVerifyMs = Date.now() - passwordVerifyStartedAt;
    if (!passwordMatch) {
      logger.info({ emailHash, userId: user.id, userLookupMs, ms: Date.now() - startedAt }, "auth.invalid_password");
      await insertAuthAuditLog(
        {
          firmId: user.firmId,
          actorId: user.id,
          actorType: user.userType,
          action: "auth.invalid_password",
          detail: `route=${req.method} ${getRoute(req)}`,
          ipAddress: asNullableString(ip),
          userAgent: asNullableString(ua),
        },
        { ...ctx, stage: "audit_invalid_password" },
      );
      res.status(401).json({ error: "Invalid email or password", code: "AUTH_INVALID_CREDENTIALS" });
      return;
    }

    if (user.status !== "active") {
      logger.info({ emailHash, userId: user.id, ms: Date.now() - startedAt }, "auth.user_inactive");
      await insertAuthAuditLog(
        {
          firmId: user.firmId,
          actorId: user.id,
          actorType: user.userType,
          action: "auth.user_inactive",
          detail: `route=${req.method} ${getRoute(req)}`,
          ipAddress: asNullableString(ip),
          userAgent: asNullableString(ua),
        },
        { ...ctx, stage: "audit_user_inactive" },
      );
      res.status(401).json({ error: "Account is inactive", code: "AUTH_USER_INACTIVE" });
      return;
    }

    let didUseTotp = false;
    if (user.totpEnabled) {
      stage = "totp";
      ctx.stage = stage;
      logger.info({ ...ctx }, "auth.login.stage");
      const body = asRecord(req.body);
      const totpCode = optionalString(body.totpCode);
      if (!totpCode) {
        logger.info({ emailHash, userId: user.id, ms: Date.now() - startedAt }, "auth.login.totp_required");
        res.status(200).json({ needsTotp: true });
        return;
      }
      const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totpSecret!), digits: 6, period: 30 });
      const isValid = totp.validate({ token: totpCode, window: 1 }) !== null;
      if (!isValid) {
        logger.info({ emailHash, userId: user.id, ms: Date.now() - startedAt }, "auth.login.totp_invalid");
        await insertAuthAuditLog(
          {
            firmId: user.firmId,
            actorId: user.id,
            actorType: user.userType,
            action: "auth.totp_failed",
            detail: "reason=invalid_totp_code",
            ipAddress: asNullableString(ip),
            userAgent: asNullableString(ua),
          },
          { ...ctx, stage: "audit_totp_failed" },
        );
        res.status(401).json({ error: "Invalid authenticator code", code: "AUTH_TOTP_INVALID" });
        return;
      }
      didUseTotp = true;
    }

    stage = "session_create";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    stage = "session_persist";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");
    const sessionPersistStartedAt = Date.now();
    await withTransientDbRetry(
      async () => {
        type SessionInsert = typeof sessionsTable.$inferInsert;
        const row: SessionInsert = {
          userId: user.id,
          tokenHash,
          expiresAt,
          userAgent: asNullableString(ua),
          ipAddress: asNullableString(ip),
        };
        await withLoginDb(async (dbLike) => {
          await dbLike.insert(sessionsTable).values(row);
        }, "auth_login_session_persist");
      },
      { ...ctx, stage: "session_persist.query" },
      2,
    );
    timing.sessionPersistMs = Date.now() - sessionPersistStartedAt;

    stage = "side_effects";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");
    void (async () => {
      try {
        await withLoginDb(async (dbLike) => {
          const updateFields: Partial<typeof usersTable.$inferInsert> = { lastLoginAt: new Date() };
          if (didUseTotp) updateFields.totpLastUsedAt = new Date();
          await dbLike.update(usersTable).set(updateFields).where(eq(usersTable.id, user.id));
          await dbLike.insert(auditLogsTable).values({
            firmId: user.firmId,
            actorId: user.id,
            actorType: user.userType,
            action: "auth.login_success",
            detail: null,
            ipAddress: asNullableString(ip),
            userAgent: asNullableString(ua),
          });
        }, "auth_login_side_effects");
      } catch (err) {
        logger.error(
          {
            emailHash,
            userId: user.id,
            route: getRoute(req),
            reqId: getReqId(req) ?? null,
            firmId: user.firmId ?? null,
            stage: "side_effects",
            durationMs: Date.now() - startedAt,
            sqlState: getSqlState(err) ?? null,
            errorCode: getSqlState(err) ?? null,
            err,
          },
          "auth.login_side_effect_failed",
        );
      }
    })();

    const roleLookupStartedAt = Date.now();
    const roleLookupPromise = (async (): Promise<string | null> => {
      if (!user.roleId) return null;
      try {
        const rows = await withLoginDb(async (dbLike) => {
          return await dbLike.select().from(rolesTable).where(eq(rolesTable.id, user.roleId!));
        }, "auth_login_role_lookup");
        const roleRow = Array.isArray(rows) ? (rows[0] as unknown) : undefined;
        const role = (roleRow && typeof roleRow === "object" ? (roleRow as { name?: unknown }) : undefined) ?? undefined;
        return (role as { name?: unknown } | undefined)?.name as string | undefined ?? null;
      } catch (err) {
        logger.error({ ...ctx, stage: "role_lookup", err }, "auth.login.degraded");
        return null;
      }
    })();

    const firmLookupStartedAt = Date.now();
    const firmLookupPromise = (async (): Promise<string | null> => {
      if (!user.firmId) return null;
      try {
        const rows = await withLoginDb(async (dbLike) => {
          return await dbLike.select().from(firmsTable).where(eq(firmsTable.id, user.firmId!));
        }, "auth_login_firm_lookup");
        const firmRow = Array.isArray(rows) ? (rows[0] as unknown) : undefined;
        const firm = (firmRow && typeof firmRow === "object" ? (firmRow as { name?: unknown }) : undefined) ?? undefined;
        return (firm as { name?: unknown } | undefined)?.name as string | undefined ?? null;
      } catch (err) {
        logger.error({ ...ctx, stage: "firm_lookup", err }, "auth.login.degraded");
        return null;
      }
    })();

    const [roleName, firmName] = await Promise.all([roleLookupPromise, firmLookupPromise]);
    timing.roleLookupMs = Date.now() - roleLookupStartedAt;
    timing.firmLookupMs = Date.now() - firmLookupStartedAt;

    const payload = {
      token,
      id: user.id,
      email: user.email,
      name: user.name,
      userType: user.userType,
      firmId: user.firmId,
      firmName,
      roleId: user.roleId,
      roleName,
      status: user.status,
      totpEnabled: user.totpEnabled,
    };
    logger.info(
      {
        route: getRoute(req),
        reqId: getReqId(req) ?? null,
        stage: "response_shape",
        keys: Object.keys(payload).sort(),
        tokenReturned: true,
        setCookiePresent: true,
        cookie: { domain: null, path: "/", secure: process.env.NODE_ENV === "production", sameSite: "lax" },
      },
      "auth.login_response_shape",
    );

    const responseWriteStartedAt = Date.now();
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json(payload);
    timing.responseWriteMs = Date.now() - responseWriteStartedAt;

    stage = "response_sent";
    ctx.stage = stage;
    logger.info({ ...ctx, userLookupMs, ms: Date.now() - startedAt }, "auth.login.stage");
    logger.info({ emailHash, userId: user.id, userLookupMs, ms: Date.now() - startedAt }, "auth.login.success");
    logger.info(
      {
        route: getRoute(req),
        reqId: getReqId(req) ?? null,
        emailHash,
        userId: user.id,
        firmId: user.firmId ?? null,
        durationMs: Date.now() - startedAt,
        timing,
      },
      "auth.login_timing",
    );
  } catch (err) {
    const errMessageShort =
      err instanceof Error ? err.message.slice(0, 180) : String(err ?? "").slice(0, 180);
    const code =
      err && typeof err === "object" && "code" in (err as any) && typeof (err as any).code === "string"
        ? String((err as any).code)
        : null;
    const sqlState = getSqlState(err);
    logger.error(
      {
        emailHash,
        userId,
        route: getRoute(req),
        reqId: getReqId(req) ?? null,
        stage,
        durationMs: Date.now() - startedAt,
        code,
        sqlState: sqlState ?? null,
        errorCode: sqlState ?? null,
        errMessageShort,
        err,
      },
      "auth.login_failed",
    );
    if (code === "AUTH_ADMIN_DB_NOT_CONFIGURED") {
      logger.error({ emailHash, route: getRoute(req), stage, code }, "auth_admin_db_not_configured");
      res.status(503).json({ error: "Login temporarily unavailable", code: "AUTH_ADMIN_DB_NOT_CONFIGURED" });
      return;
    }
    if (sqlState === "42501") {
      logger.error({ emailHash, route: getRoute(req), stage, sqlState }, "auth.lookup_rls_blocked");
      res.status(503).json({ error: "Login temporarily unavailable", code: "AUTH_LOOKUP_RLS_BLOCKED" });
      return;
    }
    if (isTransientDbConnectionError(err)) {
      res.status(503).json({ error: "Login temporarily unavailable", code: "AUTH_TEMPORARILY_UNAVAILABLE" });
      return;
    }
    res.status(503).json({ error: "Login temporarily unavailable", code: "AUTH_TEMPORARILY_UNAVAILABLE" });
  }
});

routerInternal.post(
  "/auth/logout",
  requireAuth,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  let token = req.cookies?.["auth_token"] as string | undefined;
  if (!token) {
    const authHeader = req.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }
  if (token) {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
  }
  await writeAuditLog({
    firmId: typeof req.firmId === "number" ? req.firmId : req.firmId ?? null,
    actorId: typeof req.userId === "number" ? req.userId : req.userId ?? null,
    actorType: typeof req.userType === "string" ? req.userType : undefined,
    action: "auth.logout",
    ipAddress: typeof req.ip === "string" ? req.ip : undefined,
    userAgent: asNullableString(req.headers["user-agent"]) ?? undefined,
  });
  res.clearCookie("auth_token", { path: "/" });
  sendOk(res, { success: true });
  },
);

routerInternal.get("/auth/me", async (req: ReqLike, res: RouteResLike): Promise<void> => {
  const startedAt = Date.now();
  const reqId = getReqId(req);
  const cookieToken = getCookieToken(req);
  const authHeader = req.headers.authorization;
  const headerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const cookie = typeof cookieToken === "string" ? cookieToken : undefined;
  const bearer = typeof headerToken === "string" ? headerToken : undefined;
  const candidates = Array.from(new Set([cookie, bearer].filter(Boolean))) as string[];
  const tokenSource = cookie ? "COOKIE" : bearer ? "BEARER" : "NONE";
  logger.info(
    {
      route: getRoute(req),
      reqId,
      stage: "auth_inputs",
      cookiePresent: Boolean(cookie),
      bearerPresent: Boolean(bearer),
      candidateCount: candidates.length,
      tokenSource,
    },
    "auth.me_inputs",
  );

  if (candidates.length === 0) {
    sendOk(res, null);
    logger.info({ route: getRoute(req), reqId, stage: "no_token", ms: Date.now() - startedAt }, "auth.me");
    return;
  }

  const ctxBase = { route: getRoute(req), reqId, stage: "start" };
  const t0 = Date.now();
  let sessionLookupMs = 0;
  let sessionLookupAttempts: number | null = null;
  let sessionLookupInflightShared: boolean | null = null;
  let sessionLookupPrimaryMs: number | null = null;
  let sessionLookupFallbackMs: number | null = null;
  let sessionLookupOutcome: "FOUND" | "NOT_FOUND" | "EXPIRED" | "INACTIVE" = "NOT_FOUND";
  let tenantContextDbConnectMs = 0;
  let tenantContextMs = 0;
  let roleLookupMs = 0;
  let permissionsLookupMs = 0;
  let firmLookupMs = 0;
  let responseBuildMs = 0;

  try {
    let found: Awaited<ReturnType<typeof lookupSessionAndUserByTokenHash>> | null = null;
    for (const token of candidates) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const r = await lookupSessionAndUserByTokenHash(tokenHash);
      if (r?.session) {
        found = r;
        break;
      }
      found = r;
    }
    sessionLookupMs = Date.now() - t0;
    sessionLookupAttempts = found?.timing?.attempts ?? null;
    sessionLookupInflightShared = found?.timing?.inflightShared ?? null;
    sessionLookupPrimaryMs = found?.timing?.primaryLookupMs ?? null;
    sessionLookupFallbackMs = found?.timing?.fallbackLookupMs ?? null;
    const session = found?.session;
    const user = found?.user;

    if (!session || !user || session.expiresAt < new Date() || user.status !== "active") {
      if (!session || !user) sessionLookupOutcome = "NOT_FOUND";
      else if (session.expiresAt < new Date()) sessionLookupOutcome = "EXPIRED";
      else if (user.status !== "active") sessionLookupOutcome = "INACTIVE";
      if (typeof cookieToken === "string") res.clearCookie("auth_token", { path: "/" });
      sendOk(res, null);
      logger.info(
        { ...ctxBase, stage: "not_authenticated", ms: Date.now() - startedAt, sessionLookupMs, sessionLookupOutcome },
        "auth.me",
      );
      return;
    }
    sessionLookupOutcome = "FOUND";

    const withFirmRlsDb = async <T,>(
      firmId: number,
      userId: number,
      fn: (r: ReturnType<typeof makeRlsDb>) => Promise<T>,
    ): Promise<T> => {
      if (process.env.NODE_ENV === "test") {
        return await fn(db as any);
      }
      const connectStartedAt = Date.now();
      const client = await pool.connect();
      tenantContextDbConnectMs += Date.now() - connectStartedAt;
      let destroy = false;
      try {
        const start = Date.now();
        await setTenantContextSession(client, firmId, userId);
        tenantContextMs += Date.now() - start;
        const r = makeRlsDb(client);
        return await fn(r);
      } catch (err) {
        destroy = true;
        throw err;
      } finally {
        try {
          await clearTenantContext(client);
        } catch {
        }
        client.release(destroy);
      }
    };

    let roleName: string | null = null;
    let firmName: string | null = null;
    let permissions: Array<{ module: string; action: string }> = [];

    if (user.userType === "firm_user" && user.firmId) {
      await withFirmRlsDb(user.firmId, user.id, async (r) => {
        if (user.roleId) {
          const start = Date.now();
          try {
            const [role] = await r
              .select({ name: rolesTable.name })
              .from(rolesTable)
              .where(and(eq(rolesTable.id, user.roleId!), eq(rolesTable.firmId, user.firmId!)));
            roleName = (role as { name?: unknown } | undefined)?.name as string | undefined ?? null;
          } catch (err) {
            logger.error({ route: getRoute(req), reqId, stage: "role_lookup", err }, "auth.me.degraded");
            roleName = null;
          } finally {
            roleLookupMs += Date.now() - start;
          }

          const startPerms = Date.now();
          try {
            permissions = await r
              .select({ module: permissionsTable.module, action: permissionsTable.action })
              .from(permissionsTable)
              .where(and(eq(permissionsTable.roleId, user.roleId!), eq(permissionsTable.allowed, true)));
          } catch (err) {
            logger.error({ route: getRoute(req), reqId, stage: "permissions_lookup", err }, "auth.me.degraded");
            permissions = [];
          } finally {
            permissionsLookupMs += Date.now() - startPerms;
          }
        }

        const startFirm = Date.now();
        try {
          const [firm] = await r
            .select({ name: firmsTable.name })
            .from(firmsTable)
            .where(eq(firmsTable.id, user.firmId!));
          firmName = (firm as { name?: unknown } | undefined)?.name as string | undefined ?? null;
        } catch (err) {
          logger.error({ route: getRoute(req), reqId, stage: "firm_lookup", err }, "auth.me.degraded");
          firmName = null;
        } finally {
          firmLookupMs += Date.now() - startFirm;
        }
      });
    } else {
      if (user.roleId) {
        const start = Date.now();
        const [role] = await db.select({ name: rolesTable.name }).from(rolesTable).where(eq(rolesTable.id, user.roleId));
        roleName = (role as { name?: unknown } | undefined)?.name as string | undefined ?? null;
        roleLookupMs += Date.now() - start;
      }
      if (user.firmId) {
        const startFirm = Date.now();
        const [firm] = await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, user.firmId));
        firmName = (firm as { name?: unknown } | undefined)?.name as string | undefined ?? null;
        firmLookupMs += Date.now() - startFirm;
      }
      if (user.userType === "firm_user" && user.roleId) {
        const startPerms = Date.now();
        permissions = await db
          .select({ module: permissionsTable.module, action: permissionsTable.action })
          .from(permissionsTable)
          .where(and(eq(permissionsTable.roleId, user.roleId), eq(permissionsTable.allowed, true)));
        permissionsLookupMs += Date.now() - startPerms;
      }
    }

    const founder = user.userType === "founder"
      ? await loadFounderPermissions({ userId: user.id, userType: "founder", email: user.email } as AuthRequest)
      : { permissions: [], highestLevel: null };

    const payload = {
      id: user.id,
      userType: user.userType,
      firmId: user.firmId,
      roleId: user.roleId,
      developerId: (user as any).developerId ?? null,
      roleName,
      firmName,
      permissions,
      founderPermissions: founder.permissions,
      founderRoleLevel: founder.highestLevel,
      email: user.email,
      name: user.name,
      department: null,
      status: user.status,
    };
    logger.info(
      { route: getRoute(req), reqId, stage: "response_shape", keys: Object.keys(payload).sort() },
      "auth.me_response_shape",
    );
    const startBuild = Date.now();
    sendOk(res, payload);
    responseBuildMs = Date.now() - startBuild;
    logger.info({ ...ctxBase, stage: "ok", ms: Date.now() - startedAt }, "auth.me");
    logger.info(
      {
        ...ctxBase,
        stage: "timing",
        ms: Date.now() - startedAt,
        sessionLookupMs,
        sessionLookupAttempts,
        sessionLookupInflightShared,
        sessionLookupPrimaryMs,
        sessionLookupFallbackMs,
        sessionLookupOutcome,
        tenantContextDbConnectMs,
        tenantContextMs,
        roleLookupMs,
        permissionsLookupMs,
        firmLookupMs,
        responseBuildMs,
        userId: user.id,
        firmId: user.firmId,
        roleId: user.roleId,
      },
      "auth.me_timing",
    );
  } catch (err) {
    logger.error(
      {
        ...ctxBase,
        stage: "me_error",
        durationMs: Date.now() - startedAt,
        sqlState: getSqlState(err) ?? null,
        errorCode: getSqlState(err) ?? null,
        err,
      },
      "auth.me_error",
    );
    if (isTransientDbConnectionError(err)) {
      sendError(res, new ApiError({ status: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE", message: "Auth temporarily unavailable", retryable: true }));
      return;
    }
    const sqlState = getSqlState(err);
    if (!(err instanceof ApiError) && (sqlState === "42P01" || sqlState === "42703" || sqlState === "42501")) {
      sendError(res, new ApiError({ status: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE", message: "Auth temporarily unavailable", retryable: true }));
      return;
    }
    sendError(res, err, { status: 503, code: "AUTH_TEMPORARILY_UNAVAILABLE", message: "Auth temporarily unavailable" });
  }
});

routerInternal.get(
  "/auth/permissions",
  requireAuth,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const startedAt = Date.now();
  const reqId = getReqId(req);
  const ctx = { route: req.path, reqId, userId: req.userId ?? null, firmId: req.firmId ?? null, roleId: req.roleId ?? null };
  try {
    if (req.userType !== "firm_user" || !req.roleId) {
      sendOk(res, { permissions: [] });
      logger.info({ ...ctx, stage: "not_firm_user", ms: Date.now() - startedAt }, "auth.permissions");
      return;
    }

    const started = Date.now();
    try {
      if (req.firmId && req.roleId) {
        await ensureRolePermissionsInitialized(db as any, req.firmId, req.roleId);
      }
    } catch (err) {
      logger.error({ ...ctx, err }, "auth.permissions_seed_failed");
    }
    const rows = await db
      .select({ module: permissionsTable.module, action: permissionsTable.action })
      .from(permissionsTable)
      .where(and(eq(permissionsTable.roleId, req.roleId), eq(permissionsTable.allowed, true)));

    sendOk(res, { permissions: rows });
    logger.info({ ...ctx, stage: "ok", ms: Date.now() - startedAt, permissionsLookupMs: Date.now() - started, count: rows.length }, "auth.permissions");
  } catch (err) {
    logger.error({ ...ctx, err }, "auth.permissions_failed");
    sendError(res, err, { status: 503, code: "AUTH_ADMIN_UNAVAILABLE", message: "Auth temporarily unavailable" });
  }
  },
);

routerInternal.get(
  "/auth/sessions",
  requireAuth,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const sessions = await db.select({
    id: sessionsTable.id,
    createdAt: sessionsTable.createdAt,
    expiresAt: sessionsTable.expiresAt,
    userAgent: sessionsTable.userAgent,
    ipAddress: sessionsTable.ipAddress,
  }).from(sessionsTable).where(eq(sessionsTable.userId, req.userId!));
  sendOk(res, { data: sessions });
  },
);

routerInternal.delete(
  "/auth/sessions/:id",
  requireAuth,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const id = getParam(req, "id");
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }
  const sessionId = Number(id);
  await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "auth.session_revoked",
    entityType: "session",
    entityId: sessionId,
    ipAddress: asOptionalString(req.ip),
    userAgent: getHeader(req, "user-agent"),
  });
  sendOk(res, { success: true });
  },
);

// Issue a short-lived (5 min, single-use) re-auth token.
// The client calls this when the user initiates a sensitive action.
// The returned token is stored in React state (memory only — never localStorage/sessionStorage).
routerInternal.post(
  "/auth/reauth-token",
  requireAuth,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const token = issueReauthToken(req.userId!);
  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: req.userType ?? "firm_user",
    action: "auth.reauth_token_issued", detail: getRoute(req),
    ipAddress: asOptionalString(req.ip), userAgent: getHeader(req, "user-agent"),
  });
  res.json({ reAuthToken: token });
  },
);

routerInternal.post(
  "/auth/totp/setup",
  sensitiveRateLimiter,
  requireAuth,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const [user] = await db.select({
    id: usersTable.id,
    email: usersTable.email,
    totpEnabled: usersTable.totpEnabled,
  }).from(usersTable).where(eq(usersTable.id, req.userId!));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (user.totpEnabled) { res.status(400).json({ error: "TOTP is already enabled" }); return; }

  const secretObj = new OTPAuth.Secret();
  const secret = secretObj.base32;
  await db.update(usersTable).set({ totpSecret: secret }).where(eq(usersTable.id, req.userId!));

  const totpSetup = new OTPAuth.TOTP({ issuer: "Lawcaspro", label: user.email, secret: secretObj, digits: 6, period: 30 });
  const otpAuthUrl = totpSetup.toString();
  const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

  res.json({ secret, qrCodeDataUrl, otpAuthUrl });
  },
);

routerInternal.post(
  "/auth/totp/confirm",
  sensitiveRateLimiter,
  requireAuth,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const { code } = req.body as { code: string };
  if (!code) { res.status(400).json({ error: "Code is required" }); return; }

  const [user] = await db.select({
    id: usersTable.id,
    totpEnabled: usersTable.totpEnabled,
    totpSecret: usersTable.totpSecret,
  }).from(usersTable).where(eq(usersTable.id, req.userId!));
  if (!user || !user.totpSecret) { res.status(400).json({ error: "TOTP setup not started" }); return; }
  if (user.totpEnabled) { res.status(400).json({ error: "TOTP is already enabled" }); return; }

  const confirmTotp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totpSecret), digits: 6, period: 30 });
  const isValid = confirmTotp.validate({ token: code, window: 1 }) !== null;
  if (!isValid) { res.status(400).json({ error: "Invalid code — check your authenticator app" }); return; }

  await db.update(usersTable).set({ totpEnabled: true, totpLastUsedAt: new Date() }).where(eq(usersTable.id, req.userId!));
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "auth.totp_enabled",
    ipAddress: asOptionalString(req.ip),
    userAgent: getHeader(req, "user-agent"),
  });

  res.json({ success: true });
  },
);

routerInternal.post(
  "/auth/totp/disable",
  sensitiveRateLimiter,
  requireAuth,
  requireReAuth,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const { code } = req.body as { code: string };
  if (!code) { res.status(400).json({ error: "Code is required to disable TOTP" }); return; }

  const [user] = await db.select({
    id: usersTable.id,
    totpEnabled: usersTable.totpEnabled,
    totpSecret: usersTable.totpSecret,
  }).from(usersTable).where(eq(usersTable.id, req.userId!));
  if (!user || !user.totpEnabled || !user.totpSecret) { res.status(400).json({ error: "TOTP is not enabled" }); return; }

  const disableTotp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totpSecret), digits: 6, period: 30 });
  const isValid = disableTotp.validate({ token: code, window: 1 }) !== null;
  if (!isValid) { res.status(400).json({ error: "Invalid code" }); return; }

  await db.update(usersTable).set({ totpEnabled: false, totpSecret: null, totpLastUsedAt: null }).where(eq(usersTable.id, req.userId!));
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "auth.totp_disabled",
    ipAddress: asOptionalString(req.ip),
    userAgent: getHeader(req, "user-agent"),
  });

  res.json({ success: true });
  },
);

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
