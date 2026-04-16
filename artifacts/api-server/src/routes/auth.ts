import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, usersTable, sessionsTable, rolesTable, permissionsTable, firmsTable, auditLogsTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { requireAuth, requireReAuth, issueReauthToken, type AuthRequest, writeAuditLog } from "../lib/auth";
import { authRateLimiter, sensitiveRateLimiter } from "../lib/rate-limit";
import { logger } from "../lib/logger";
import { isTransientDbConnectionError, withAuthSafeDb } from "../lib/auth-safe-db";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const router: IRouter = Router();

const getReqId = (req: unknown): string | undefined => {
  const id = (req as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
};

const getCookieToken = (req: unknown): string | undefined => {
  const cookies = (req as { cookies?: Record<string, unknown> } | null)?.cookies;
  const token = cookies?.["auth_token"];
  return typeof token === "string" ? token : undefined;
};

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

router.post("/auth/login", authRateLimiter, async (req, res): Promise<void> => {
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
    const ip = req.ip;
    const ua = req.headers["user-agent"];
    const reqId = getReqId(req);

    const ctx = { route: req.path, stage, reqId, emailHash, firmId: null as number | null, userId: null as number | null };

    stage = "login_start";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");

    stage = "user_lookup";
    ctx.stage = stage;
    const userLookupStartedAt = Date.now();
    logger.info({ ...ctx }, "auth.login.stage");
    const user = await withAuthSafeDb(async (authDb) => {
      const [u] = await authDb
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
      return u ?? null;
    }, { retry: true, maxRetries: 2, ctx, allowUnsafe: true });

    if (!user) {
      logger.info({ emailHash, ms: Date.now() - startedAt }, "auth.login.user_not_found");
      try {
        await withAuthSafeDb(async (authDb) => {
          const hasAuditLogs = await tableExistsAuthDb(authDb, "public.audit_logs");
          if (!hasAuditLogs) return;
          await authDb.insert(auditLogsTable).values({
            firmId: null,
            actorId: null,
            actorType: "firm_user",
            action: "auth.login_failed",
            detail: `email=${emailNormalized} reason=user_not_found`,
            ipAddress: ip ?? null,
            userAgent: ua ?? null,
          });
        }, { retry: false, ctx: { ...ctx, stage: "audit_log_user_not_found" }, allowUnsafe: true });
      } catch (err) {
        logger.error({ emailHash, stage: "audit_log_user_not_found", err }, "auth.login.audit_log_error");
      }
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    userId = user.id;
    ctx.userId = user.id;
    ctx.firmId = user.firmId;
    const userLookupMs = Date.now() - userLookupStartedAt;
    logger.info({ ...ctx, ms: userLookupMs }, "auth.login.stage.user_lookup_done");

    stage = "password_verify";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      logger.info({ emailHash, userId: user.id, userLookupMs, ms: Date.now() - startedAt }, "auth.login.wrong_password");
      try {
        await withAuthSafeDb(async (authDb) => {
          const hasAuditLogs = await tableExistsAuthDb(authDb, "public.audit_logs");
          if (!hasAuditLogs) return;
          await authDb.insert(auditLogsTable).values({
            firmId: user.firmId,
            actorId: user.id,
            actorType: user.userType,
            action: "auth.login_failed",
            detail: "reason=wrong_password",
            ipAddress: ip ?? null,
            userAgent: ua ?? null,
          });
        }, { retry: false, ctx: { ...ctx, stage: "audit_log_wrong_password" }, allowUnsafe: true });
      } catch (err) {
        logger.error({ emailHash, userId: user.id, stage: "audit_log_wrong_password", err }, "auth.login.audit_log_error");
      }
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (user.status !== "active") {
      logger.info({ emailHash, userId: user.id, ms: Date.now() - startedAt }, "auth.login.inactive");
      try {
        await withAuthSafeDb(async (authDb) => {
          const hasAuditLogs = await tableExistsAuthDb(authDb, "public.audit_logs");
          if (!hasAuditLogs) return;
          await authDb.insert(auditLogsTable).values({
            firmId: user.firmId,
            actorId: user.id,
            actorType: user.userType,
            action: "auth.login_failed",
            detail: "reason=inactive_account",
            ipAddress: ip ?? null,
            userAgent: ua ?? null,
          });
        }, { retry: false, ctx: { ...ctx, stage: "audit_log_inactive" }, allowUnsafe: true });
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
      const totpCode = req.body.totpCode as string | undefined;
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
          await withAuthSafeDb(async (authDb) => {
            const hasAuditLogs = await tableExistsAuthDb(authDb, "public.audit_logs");
            if (!hasAuditLogs) return;
            await authDb.insert(auditLogsTable).values({
              firmId: user.firmId,
              actorId: user.id,
              actorType: user.userType,
              action: "auth.totp_failed",
              detail: "reason=invalid_totp_code",
              ipAddress: ip ?? null,
              userAgent: ua ?? null,
            });
          }, { retry: false, ctx: { ...ctx, stage: "audit_log_totp_failed" }, allowUnsafe: true });
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
    await withAuthSafeDb(async (authDb) => {
      await authDb.insert(sessionsTable).values({
        userId: user.id,
        tokenHash,
        expiresAt,
        userAgent: ua ?? null,
        ipAddress: ip ?? null,
      });
    }, { maxRetries: 2, ctx: { ...ctx, stage }, allowUnsafe: true });

    stage = "side_effects";
    ctx.stage = stage;
    logger.info({ ...ctx }, "auth.login.stage");
    void (async () => {
      try {
        await withAuthSafeDb(async (authDb) => {
          const updateFields: Partial<typeof usersTable.$inferInsert> = { lastLoginAt: new Date() };
          if (didUseTotp) updateFields.totpLastUsedAt = new Date();
          await authDb.update(usersTable).set(updateFields).where(eq(usersTable.id, user.id));

          const hasAuditLogs = await tableExistsAuthDb(authDb, "public.audit_logs");
          if (!hasAuditLogs) return;
          await authDb.insert(auditLogsTable).values({
            firmId: user.firmId,
            actorId: user.id,
            actorType: user.userType,
            action: "auth.login_success",
            detail: null,
            ipAddress: ip ?? null,
            userAgent: ua ?? null,
          });
        }, { retry: false, ctx: { ...ctx, stage: "side_effects.persist" }, allowUnsafe: true });
      } catch (err) {
        logger.error({ emailHash, userId: user.id, stage: "side_effects", err }, "auth.login_side_effect_failed");
      }
    })();

    let roleName: string | null = null;
    if (user.roleId) {
      try {
        const role = await withAuthSafeDb(async (authDb) => {
          const [r] = await authDb.select().from(rolesTable).where(eq(rolesTable.id, user.roleId!));
          return r ?? null;
        }, { retry: false, ctx: { ...ctx, stage: "role_lookup" }, allowUnsafe: true });
        roleName = role?.name ?? null;
      } catch (err) {
        logger.error({ ...ctx, stage: "role_lookup", err }, "auth.login.degraded");
        roleName = null;
      }
    }

    let firmName: string | null = null;
    if (user.firmId) {
      try {
        const firm = await withAuthSafeDb(async (authDb) => {
          const [f] = await authDb.select().from(firmsTable).where(eq(firmsTable.id, user.firmId!));
          return f ?? null;
        }, { retry: false, ctx: { ...ctx, stage: "firm_lookup" }, allowUnsafe: true });
        firmName = firm?.name ?? null;
      } catch (err) {
        logger.error({ ...ctx, stage: "firm_lookup", err }, "auth.login.degraded");
        firmName = null;
      }
    }

    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
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
    logger.error({ emailHash, userId, stage, errMessageShort, err }, "auth.login_failed");
    if (isTransientDbConnectionError(err)) {
      res.status(503).json({ error: "Login temporarily unavailable" });
      return;
    }
    res.status(503).json({ error: "Login temporarily unavailable" });
  }
});

router.post("/auth/logout", requireAuth, async (req: AuthRequest, res): Promise<void> => {
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
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "auth.logout", ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.clearCookie("auth_token");
  res.json({ success: true });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const startedAt = Date.now();
  const reqId = getReqId(req);
  const cookieToken = getCookieToken(req);
  const authHeader = req.headers.authorization;
  const headerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const token = (typeof cookieToken === "string" ? cookieToken : undefined) || headerToken;

  if (!token) {
    res.sendStatus(204);
    logger.info({ route: req.path, reqId, stage: "no_token", ms: Date.now() - startedAt }, "auth.me");
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const ctxBase = { route: req.path, reqId, stage: "start" };

  try {
    const result = await withAuthSafeDb(async (authDb) => {
      const [s] = await authDb
        .select({ userId: sessionsTable.userId, expiresAt: sessionsTable.expiresAt })
        .from(sessionsTable)
        .where(eq(sessionsTable.tokenHash, tokenHash));
      if (!s) return { kind: "no_session" as const };
      if (s.expiresAt < new Date()) return { kind: "expired" as const };

      const [user] = await authDb
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

      if (!user) return { kind: "missing_user" as const };
      if (user.status !== "active") return { kind: "inactive_user" as const };

      let roleName: string | null = null;
      if (user.roleId) {
        try {
          const [role] = await authDb.select().from(rolesTable).where(eq(rolesTable.id, user.roleId));
          roleName = role?.name ?? null;
        } catch (err) {
          logger.error({ route: req.path, reqId, stage: "role_lookup", err }, "auth.me.degraded");
        }
      }

      let firmName: string | null = null;
      if (user.firmId) {
        try {
          const [firm] = await authDb.select().from(firmsTable).where(eq(firmsTable.id, user.firmId));
          firmName = firm?.name ?? null;
        } catch (err) {
          logger.error({ route: req.path, reqId, stage: "firm_lookup", err }, "auth.me.degraded");
        }
      }

      let permissions: Array<{ module: string; action: string }> = [];
      if (user.userType === "firm_user" && user.roleId) {
        try {
          permissions = await authDb
            .select({ module: permissionsTable.module, action: permissionsTable.action })
            .from(permissionsTable)
            .where(and(eq(permissionsTable.roleId, user.roleId), eq(permissionsTable.allowed, true)));
        } catch (err) {
          logger.error({ route: req.path, reqId, stage: "permissions_lookup", err }, "auth.me.degraded");
          permissions = [];
        }
      }

      return {
        kind: "ok" as const,
        user: {
          id: user.id,
          userType: user.userType,
          firmId: user.firmId,
          roleId: user.roleId,
          roleName,
          firmName,
          permissions,
          email: user.email,
          name: user.name,
          department: user.department ?? null,
          status: user.status,
        },
      };
    }, { maxRetries: 2, ctx: { route: req.path, stage: "me", reqId, firmId: null, userId: null }, allowUnsafe: true });

    if (result.kind === "no_session" || result.kind === "expired") {
      if (typeof cookieToken === "string") res.clearCookie("auth_token");
      res.status(401).json({ error: "Not authenticated" });
      logger.info({ ...ctxBase, stage: result.kind, ms: Date.now() - startedAt }, "auth.me");
      return;
    }
    if (result.kind === "missing_user") {
      if (typeof cookieToken === "string") res.clearCookie("auth_token");
      res.status(404).json({ error: "User not found" });
      logger.warn({ ...ctxBase, stage: "missing_user", ms: Date.now() - startedAt }, "auth.me");
      return;
    }
    if (result.kind === "inactive_user") {
      if (typeof cookieToken === "string") res.clearCookie("auth_token");
      res.status(401).json({ error: "Not authenticated" });
      logger.warn({ ...ctxBase, stage: "inactive_user", ms: Date.now() - startedAt }, "auth.me");
      return;
    }

    res.json(result.user);
    logger.info({ ...ctxBase, stage: "ok", ms: Date.now() - startedAt }, "auth.me");
  } catch (err) {
    logger.error({ ...ctxBase, stage: "me_error", err }, "auth.me_error");
    res.status(503).json({ error: "Auth temporarily unavailable" });
  }
});

router.get("/auth/permissions", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const startedAt = Date.now();
  const reqId = getReqId(req);
  const ctx = { route: req.path, reqId, userId: req.userId ?? null, firmId: req.firmId ?? null, roleId: req.roleId ?? null };
  try {
    if (req.userType !== "firm_user" || !req.roleId) {
      res.json({ permissions: [] });
      logger.info({ ...ctx, stage: "not_firm_user", ms: Date.now() - startedAt }, "auth.permissions");
      return;
    }

    const permissions = await withAuthSafeDb(async (authDb) => {
      const started = Date.now();
      const rows = await authDb
        .select({ module: permissionsTable.module, action: permissionsTable.action })
        .from(permissionsTable)
        .where(and(eq(permissionsTable.roleId, req.roleId!), eq(permissionsTable.allowed, true)));
      return { rows, ms: Date.now() - started };
    }, { retry: false, ctx: { ...ctx, stage: "permissions_lookup" }, allowUnsafe: true });

    res.json({ permissions: permissions.rows });
    logger.info({ ...ctx, stage: "ok", ms: Date.now() - startedAt, permissionsLookupMs: permissions.ms, count: permissions.rows.length }, "auth.permissions");
  } catch (err) {
    logger.error({ ...ctx, err }, "auth.permissions_failed");
    res.status(503).json({ error: "Auth temporarily unavailable" });
  }
});

router.get("/auth/sessions", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const sessions = await db.select({
    id: sessionsTable.id,
    createdAt: sessionsTable.createdAt,
    expiresAt: sessionsTable.expiresAt,
    userAgent: sessionsTable.userAgent,
    ipAddress: sessionsTable.ipAddress,
  }).from(sessionsTable).where(eq(sessionsTable.userId, req.userId!));
  res.json({ data: sessions });
});

router.delete("/auth/sessions/:id", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const sessionId = Number(req.params.id);
  await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "auth.session_revoked", entityType: "session", entityId: sessionId, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json({ success: true });
});

// Issue a short-lived (5 min, single-use) re-auth token.
// The client calls this when the user initiates a sensitive action.
// The returned token is stored in React state (memory only — never localStorage/sessionStorage).
router.post("/auth/reauth-token", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const token = issueReauthToken(req.userId!);
  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: req.userType ?? "firm_user",
    action: "auth.reauth_token_issued", detail: req.path,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });
  res.json({ reAuthToken: token });
});

router.post("/auth/totp/setup", sensitiveRateLimiter, requireAuth, async (req: AuthRequest, res): Promise<void> => {
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
});

router.post("/auth/totp/confirm", sensitiveRateLimiter, requireAuth, async (req: AuthRequest, res): Promise<void> => {
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
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "auth.totp_enabled", ipAddress: req.ip, userAgent: req.headers["user-agent"] });

  res.json({ success: true });
});

router.post("/auth/totp/disable", sensitiveRateLimiter, requireAuth, requireReAuth, async (req: AuthRequest, res): Promise<void> => {
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
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "auth.totp_disabled", ipAddress: req.ip, userAgent: req.headers["user-agent"] });

  res.json({ success: true });
});

export default router;
