import express, { type Router as ExpressRouter } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { auditLogsTable, db, firmsTable, permissionsTable, rolesTable, sessionsTable, sql, type SQL, usersTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { loadFounderPermissions, requireAuth, requireReAuth, issueReauthToken, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { ApiError, sendError, sendOk } from "../lib/api-response.js";
import { authRateLimiter, sensitiveRateLimiter } from "../lib/rate-limit.js";
import { logger } from "../lib/logger.js";
import { isTransientDbConnectionError } from "../lib/auth-safe-db.js";
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
  const id = (req as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
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
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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

async function tableExistsAuthDb(
  authDb: { execute: (q: SQL<unknown>) => Promise<unknown> },
  reg: string,
): Promise<boolean> {
  const result: unknown = await authDb.execute(sql`SELECT to_regclass(${reg}) AS reg`);
  const rows: Record<string, unknown>[] = (() => {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    if (
      result &&
      typeof result === "object" &&
      "rows" in result &&
      Array.isArray((result as { rows?: unknown }).rows)
    ) {
      return (result as { rows: Record<string, unknown>[] }).rows;
    }
    return [];
  })();

  return Boolean(rows[0]?.reg);
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
        const rows = await withTransientDbRetry(
          async () =>
            await db
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
              .where(eq(sql`lower(trim(${usersTable.email}))`, emailNormalized)),
          { ...ctx, stage: "user_lookup.query" },
          2,
        );
        const u = rows[0] as LoginUser | undefined;
        return u ?? null;
      } catch (err) {
        if (!isUndefinedColumnError(err)) throw err;
        const errMessageShort =
          err instanceof Error ? err.message.slice(0, 180) : String(err ?? "").slice(0, 180);
        logger.warn({ ...ctx, stage: "user_lookup_fallback", errMessageShort, err }, "auth.login.degraded_schema");

        const rows = await withTransientDbRetry(
          async () =>
            await db
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
              .where(eq(sql`lower(trim(${usersTable.email}))`, emailNormalized)),
          { ...ctx, stage: "user_lookup_fallback.query" },
          2,
        );
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
      logger.info({ emailHash, ms: Date.now() - startedAt }, "auth.login.user_not_found");
      try {
        const hasAuditLogs = await tableExistsAuthDb(db, "public.audit_logs");
        if (hasAuditLogs) {
          type AuditLogInsert = typeof auditLogsTable.$inferInsert;
          const row: AuditLogInsert = {
            firmId: null,
            actorId: null,
            actorType: "firm_user",
            action: "auth.login_failed",
            detail: `email=${emailNormalized} reason=user_not_found`,
            ipAddress: asNullableString(ip),
            userAgent: asNullableString(ua),
          };
          await db.insert(auditLogsTable).values(row);
        }
      } catch (err) {
        logger.error({ emailHash, stage: "audit_log_user_not_found", err }, "auth.login.audit_log_error");
      }
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    userId = user.id;
    ctx.userId = user.id;
    ctx.firmId = optionalNumber(user.firmId) ?? undefined;
    const userLookupMs = Date.now() - userLookupStartedAt;
    logger.info({ ...ctx, ms: userLookupMs }, "auth.login.stage.user_lookup_done");

    if (user.userType === "founder" && emailNormalized !== FOUNDER_EMAIL) {
      logger.warn({ emailHash, userId: user.id, ms: Date.now() - startedAt }, "auth.login.founder_email_mismatch");
      try {
        const hasAuditLogs = await tableExistsAuthDb(db, "public.audit_logs");
        if (hasAuditLogs) {
          type AuditLogInsert = typeof auditLogsTable.$inferInsert;
          const row: AuditLogInsert = {
            firmId: null,
            actorId: user.id,
            actorType: "founder",
            action: "auth.login_failed",
            detail: "reason=founder_email_mismatch",
            ipAddress: asNullableString(ip),
            userAgent: asNullableString(ua),
          };
          await db.insert(auditLogsTable).values(row);
        }
      } catch (err) {
        logger.error({ emailHash, userId: user.id, stage: "audit_log_founder_email_mismatch", err }, "auth.login.audit_log_error");
      }
      res.status(403).json({ error: "Founder access required" });
      return;
    }

    stage = "password_verify";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      logger.info({ emailHash, userId: user.id, userLookupMs, ms: Date.now() - startedAt }, "auth.login.wrong_password");
      try {
        const hasAuditLogs = await tableExistsAuthDb(db, "public.audit_logs");
        if (hasAuditLogs) {
          type AuditLogInsert = typeof auditLogsTable.$inferInsert;
          const row: AuditLogInsert = {
            firmId: user.firmId,
            actorId: user.id,
            actorType: user.userType,
            action: "auth.login_failed",
            detail: "reason=wrong_password",
            ipAddress: asNullableString(ip),
            userAgent: asNullableString(ua),
          };
          await db.insert(auditLogsTable).values(row);
        }
      } catch (err) {
        logger.error({ emailHash, userId: user.id, stage: "audit_log_wrong_password", err }, "auth.login.audit_log_error");
      }
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (user.status !== "active") {
      logger.info({ emailHash, userId: user.id, ms: Date.now() - startedAt }, "auth.login.inactive");
      try {
        const hasAuditLogs = await tableExistsAuthDb(db, "public.audit_logs");
        if (hasAuditLogs) {
          type AuditLogInsert = typeof auditLogsTable.$inferInsert;
          const row: AuditLogInsert = {
            firmId: user.firmId,
            actorId: user.id,
            actorType: user.userType,
            action: "auth.login_failed",
            detail: "reason=inactive_account",
            ipAddress: asNullableString(ip),
            userAgent: asNullableString(ua),
          };
          await db.insert(auditLogsTable).values(row);
        }
      } catch (err) {
        logger.error({ emailHash, userId: user.id, stage: "audit_log_inactive", err }, "auth.login.audit_log_error");
      }
      res.status(401).json({ error: "Account is inactive" });
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
        try {
          const hasAuditLogs = await tableExistsAuthDb(db, "public.audit_logs");
          if (hasAuditLogs) {
            type AuditLogInsert = typeof auditLogsTable.$inferInsert;
            const row: AuditLogInsert = {
              firmId: user.firmId,
              actorId: user.id,
              actorType: user.userType,
              action: "auth.totp_failed",
              detail: "reason=invalid_totp_code",
              ipAddress: asNullableString(ip),
              userAgent: asNullableString(ua),
            };
            await db.insert(auditLogsTable).values(row);
          }
        } catch (err) {
          logger.error({ emailHash, userId: user.id, stage: "audit_log_totp_failed", err }, "auth.login.audit_log_error");
        }
        res.status(401).json({ error: "Invalid authenticator code" });
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
        await db.insert(sessionsTable).values(row);
      },
      { ...ctx, stage: "session_persist.query" },
      2,
    );

    stage = "side_effects";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");
    void (async () => {
      try {
        const updateFields: Partial<typeof usersTable.$inferInsert> = { lastLoginAt: new Date() };
        if (didUseTotp) updateFields.totpLastUsedAt = new Date();
        await db.update(usersTable).set(updateFields).where(eq(usersTable.id, user.id));

        const hasAuditLogs = await tableExistsAuthDb(db, "public.audit_logs");
        if (!hasAuditLogs) return;
        type AuditLogInsert = typeof auditLogsTable.$inferInsert;
        const row: AuditLogInsert = {
          firmId: user.firmId,
          actorId: user.id,
          actorType: user.userType,
          action: "auth.login_success",
          detail: null,
          ipAddress: asNullableString(ip),
          userAgent: asNullableString(ua),
        };
        await db.insert(auditLogsTable).values(row);
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

    let roleName: string | null = null;
    if (user.roleId) {
      try {
        const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, user.roleId));
        roleName = (role as { name?: unknown } | undefined)?.name as string | undefined ?? null;
      } catch (err) {
        logger.error({ ...ctx, stage: "role_lookup", err }, "auth.login.degraded");
        roleName = null;
      }
    }

    let firmName: string | null = null;
    if (user.firmId) {
      try {
        const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, user.firmId));
        firmName = (firm as { name?: unknown } | undefined)?.name as string | undefined ?? null;
      } catch (err) {
        logger.error({ ...ctx, stage: "firm_lookup", err }, "auth.login.degraded");
        firmName = null;
      }
    }

    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
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
    });

    stage = "response_sent";
    ctx.stage = stage;
    logger.info({ ...ctx, userLookupMs, ms: Date.now() - startedAt }, "auth.login.stage");
    logger.info({ emailHash, userId: user.id, userLookupMs, ms: Date.now() - startedAt }, "auth.login.success");
  } catch (err) {
    const errMessageShort =
      err instanceof Error ? err.message.slice(0, 180) : String(err ?? "").slice(0, 180);
    logger.error(
      {
        emailHash,
        userId,
        route: getRoute(req),
        reqId: getReqId(req) ?? null,
        stage,
        durationMs: Date.now() - startedAt,
        sqlState: getSqlState(err) ?? null,
        errorCode: getSqlState(err) ?? null,
        errMessageShort,
        err,
      },
      "auth.login_failed",
    );
    if (isTransientDbConnectionError(err)) {
      res.status(503).json({ error: "Login temporarily unavailable" });
      return;
    }
    res.status(503).json({ error: "Login temporarily unavailable" });
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
  const token = (typeof cookieToken === "string" ? cookieToken : undefined) || headerToken;

  if (!token) {
    sendOk(res, null);
    logger.info({ route: getRoute(req), reqId, stage: "no_token", ms: Date.now() - startedAt }, "auth.me");
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const ctxBase = { route: getRoute(req), reqId, stage: "start" };

  try {
    const [s] = await db
      .select({ userId: sessionsTable.userId, expiresAt: sessionsTable.expiresAt })
      .from(sessionsTable)
      .where(eq(sessionsTable.tokenHash, tokenHash));
    if (!s) {
      if (typeof cookieToken === "string") res.clearCookie("auth_token", { path: "/" });
      throw new ApiError({ status: 401, code: "UNAUTHORIZED", message: "Not authenticated", retryable: false });
      logger.info({ ...ctxBase, stage: "no_session", ms: Date.now() - startedAt }, "auth.me");
    }
    if (s.expiresAt < new Date()) {
      if (typeof cookieToken === "string") res.clearCookie("auth_token", { path: "/" });
      throw new ApiError({ status: 401, code: "SESSION_EXPIRED", message: "Not authenticated", retryable: false });
      logger.info({ ...ctxBase, stage: "expired", ms: Date.now() - startedAt }, "auth.me");
    }

    const [user] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        userType: usersTable.userType,
        firmId: usersTable.firmId,
        roleId: usersTable.roleId,
        department: usersTable.department,
        status: usersTable.status,
      })
      .from(usersTable)
      .where(eq(usersTable.id, s.userId));

    if (!user) {
      if (typeof cookieToken === "string") res.clearCookie("auth_token", { path: "/" });
      throw new ApiError({ status: 404, code: "USER_NOT_FOUND", message: "User not found", retryable: false });
      logger.warn({ ...ctxBase, stage: "missing_user", ms: Date.now() - startedAt }, "auth.me");
    }
    if (user.status !== "active") {
      if (typeof cookieToken === "string") res.clearCookie("auth_token", { path: "/" });
      throw new ApiError({ status: 401, code: "UNAUTHORIZED", message: "Not authenticated", retryable: false });
      logger.warn({ ...ctxBase, stage: "inactive_user", ms: Date.now() - startedAt }, "auth.me");
    }

    let roleName: string | null = null;
    if (user.roleId) {
      try {
        const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, user.roleId));
        roleName = (role as { name?: unknown } | undefined)?.name as string | undefined ?? null;
      } catch (err) {
        logger.error({ route: getRoute(req), reqId, stage: "role_lookup", err }, "auth.me.degraded");
      }
    }

    let firmName: string | null = null;
    if (user.firmId) {
      try {
        const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, user.firmId));
        firmName = (firm as { name?: unknown } | undefined)?.name as string | undefined ?? null;
      } catch (err) {
        logger.error({ route: getRoute(req), reqId, stage: "firm_lookup", err }, "auth.me.degraded");
      }
    }

    let permissions: Array<{ module: string; action: string }> = [];
    if (user.userType === "firm_user" && user.roleId) {
      try {
        permissions = await db
          .select({ module: permissionsTable.module, action: permissionsTable.action })
          .from(permissionsTable)
          .where(and(eq(permissionsTable.roleId, user.roleId), eq(permissionsTable.allowed, true)));
      } catch (err) {
        logger.error({ route: getRoute(req), reqId, stage: "permissions_lookup", err }, "auth.me.degraded");
        permissions = [];
      }
    }

    const founder = user.userType === "founder"
      ? await loadFounderPermissions({ userId: user.id, userType: "founder", email: user.email } as AuthRequest)
      : { permissions: [], highestLevel: null };

    sendOk(res, {
      id: user.id,
      userType: user.userType,
      firmId: user.firmId,
      roleId: user.roleId,
      roleName,
      firmName,
      permissions,
      founderPermissions: founder.permissions,
      founderRoleLevel: founder.highestLevel,
      email: user.email,
      name: user.name,
      department: user.department ?? null,
      status: user.status,
    });
    logger.info({ ...ctxBase, stage: "ok", ms: Date.now() - startedAt }, "auth.me");
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
    if (typeof cookieToken === "string") res.clearCookie("auth_token", { path: "/" });
    sendError(res, err, { status: 401, code: "UNAUTHORIZED", message: "Not authenticated" });
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
