import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, usersTable, sessionsTable, rolesTable, permissionsTable, firmsTable, auditLogsTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { requireAuth, requireReAuth, issueReauthToken, type AuthRequest, writeAuditLog } from "../lib/auth";
import { authRateLimiter, sensitiveRateLimiter } from "../lib/rate-limit";
import { logger } from "../lib/logger";
import { withAuthSafeDb } from "../lib/auth-safe-db";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const router: IRouter = Router();

router.post("/auth/login", authRateLimiter, async (req, res): Promise<void> => {
  const startedAt = Date.now();
  let stage: string = "parse";
  let emailHash: string | undefined;
  let userId: number | undefined;
  try {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
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

    logger.info({ emailHash }, "auth.login.start");

    stage = "user_lookup";
    const userLookupStartedAt = Date.now();
    const user = await withAuthSafeDb(async (authDb) => {
      const [u] = await authDb
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, emailNormalized));
      if (!u) {
        await authDb.insert(auditLogsTable).values({
          firmId: null,
          actorId: null,
          actorType: "firm_user",
          action: "auth.login_failed",
          detail: `email=${emailNormalized} reason=user_not_found`,
          ipAddress: ip ?? null,
          userAgent: ua ?? null,
        });
      }
      return u ?? null;
    });

    if (!user) {
      logger.info({ emailHash, ms: Date.now() - startedAt }, "auth.login.user_not_found");
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    userId = user.id;
    const userLookupMs = Date.now() - userLookupStartedAt;

    stage = "password_compare";
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      logger.info({ emailHash, userId: user.id, userLookupMs, ms: Date.now() - startedAt }, "auth.login.wrong_password");
      await withAuthSafeDb(async (authDb) => {
        await authDb.insert(auditLogsTable).values({
          firmId: user.firmId,
          actorId: user.id,
          actorType: user.userType,
          action: "auth.login_failed",
          detail: "reason=wrong_password",
          ipAddress: ip ?? null,
          userAgent: ua ?? null,
        });
      });
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (user.status !== "active") {
      logger.info({ emailHash, userId: user.id, ms: Date.now() - startedAt }, "auth.login.inactive");
      await withAuthSafeDb(async (authDb) => {
        await authDb.insert(auditLogsTable).values({
          firmId: user.firmId,
          actorId: user.id,
          actorType: user.userType,
          action: "auth.login_failed",
          detail: "reason=inactive_account",
          ipAddress: ip ?? null,
          userAgent: ua ?? null,
        });
      });
      res.status(401).json({ error: "Account is inactive" });
      return;
    }

    let didUseTotp = false;
    if (user.totpEnabled) {
      stage = "totp";
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
        await withAuthSafeDb(async (authDb) => {
          await authDb.insert(auditLogsTable).values({
            firmId: user.firmId,
            actorId: user.id,
            actorType: user.userType,
            action: "auth.totp_failed",
            detail: "reason=invalid_totp_code",
            ipAddress: ip ?? null,
            userAgent: ua ?? null,
          });
        });
        res.status(401).json({ error: "Invalid authenticator code" });
        return;
      }
      didUseTotp = true;
    }

    stage = "session_create";
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    stage = "persist";
    const { roleName, firmName } = await withAuthSafeDb(async (authDb) => {
      await authDb.insert(sessionsTable).values({
        userId: user.id,
        tokenHash,
        expiresAt,
        userAgent: ua ?? null,
        ipAddress: ip ?? null,
      });

      const updateFields: Partial<typeof usersTable.$inferInsert> = { lastLoginAt: new Date() };
      if (didUseTotp) updateFields.totpLastUsedAt = new Date();
      await authDb.update(usersTable).set(updateFields).where(eq(usersTable.id, user.id));

      await authDb.insert(auditLogsTable).values({
        firmId: user.firmId,
        actorId: user.id,
        actorType: user.userType,
        action: "auth.login_success",
        detail: null,
        ipAddress: ip ?? null,
        userAgent: ua ?? null,
      });

      let roleName: string | null = null;
      if (user.roleId) {
        const [role] = await authDb.select().from(rolesTable).where(eq(rolesTable.id, user.roleId));
        roleName = role?.name ?? null;
      }

      let firmName: string | null = null;
      if (user.firmId) {
        const [firm] = await authDb.select().from(firmsTable).where(eq(firmsTable.id, user.firmId));
        firmName = firm?.name ?? null;
      }

      return { roleName, firmName };
    });

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

    logger.info({ emailHash, userId: user.id, userLookupMs, ms: Date.now() - startedAt }, "auth.login.success");
  } catch (err) {
    logger.error({ emailHash, userId, stage, err }, "auth.login.error");
    res.status(500).json({ error: "Login temporarily unavailable" });
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

router.get("/auth/me", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  try {
    const result = await withAuthSafeDb(async (authDb) => {
      const [user] = await authDb.select().from(usersTable).where(eq(usersTable.id, req.userId!));
      if (!user) return null;

      let roleName: string | null = null;
      if (user.roleId) {
        const [role] = await authDb.select().from(rolesTable).where(eq(rolesTable.id, user.roleId));
        roleName = role?.name ?? null;
      }

      let firmName: string | null = null;
      if (user.firmId) {
        const [firm] = await authDb.select().from(firmsTable).where(eq(firmsTable.id, user.firmId));
        firmName = firm?.name ?? null;
      }

      let permissions =
        user.userType === "firm_user" && user.roleId
          ? await authDb
              .select({ module: permissionsTable.module, action: permissionsTable.action })
              .from(permissionsTable)
              .where(and(eq(permissionsTable.roleId, user.roleId), eq(permissionsTable.allowed, true)))
          : [];

      if (user.userType === "firm_user" && user.roleId && permissions.length === 0 && (roleName === "Partner" || roleName === "Clerk")) {
        const roleId = user.roleId;
        if (roleName === "Partner") {
          await authDb.execute(sql`
            INSERT INTO permissions (role_id, module, action, allowed)
            SELECT ${roleId}, v.module, v.action, TRUE
            FROM (
              VALUES
                ('dashboard','read'),
                ('cases','read'),('cases','create'),('cases','update'),('cases','delete'),
                ('projects','read'),('projects','create'),('projects','update'),('projects','delete'),
                ('developers','read'),('developers','create'),('developers','update'),('developers','delete'),
                ('documents','read'),('documents','create'),('documents','update'),('documents','delete'),
                ('communications','read'),('communications','create'),('communications','update'),('communications','delete'),
                ('accounting','read'),('accounting','write'),
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
        } else {
          await authDb.execute(sql`
            INSERT INTO permissions (role_id, module, action, allowed)
            SELECT ${roleId}, v.module, v.action, TRUE
            FROM (
              VALUES
                ('dashboard','read'),
                ('cases','read'),('cases','create'),('cases','update'),
                ('projects','read'),('projects','create'),('projects','update'),
                ('developers','read'),('developers','create'),('developers','update'),
                ('documents','read'),
                ('communications','read'),('communications','create'),
                ('accounting','read'),
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

        permissions = await authDb
          .select({ module: permissionsTable.module, action: permissionsTable.action })
          .from(permissionsTable)
          .where(and(eq(permissionsTable.roleId, user.roleId), eq(permissionsTable.allowed, true)));
      }

      return {
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
        permissions,
      };
    });

    if (!result) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.userId }, "auth.me.error");
    res.status(500).json({ error: "Auth temporarily unavailable" });
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
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));
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

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));
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

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));
  if (!user || !user.totpEnabled || !user.totpSecret) { res.status(400).json({ error: "TOTP is not enabled" }); return; }

  const disableTotp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(user.totpSecret), digits: 6, period: 30 });
  const isValid = disableTotp.validate({ token: code, window: 1 }) !== null;
  if (!isValid) { res.status(400).json({ error: "Invalid code" }); return; }

  await db.update(usersTable).set({ totpEnabled: false, totpSecret: null, totpLastUsedAt: null }).where(eq(usersTable.id, req.userId!));
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "auth.totp_disabled", ipAddress: req.ip, userAgent: req.headers["user-agent"] });

  res.json({ success: true });
});

export default router;
