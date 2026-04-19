import { Request, Response, NextFunction } from "express";
import { db, pool, sessionsTable, usersTable, auditLogsTable, makeRlsDb, setTenantContextSession, clearTenantContext, RlsDb, rolesTable, permissionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "./logger";
import { isTransientDbConnectionError } from "./auth-safe-db";

export interface AuthRequest extends Request {
  userId?: number;
  email?: string;
  userType?: string;
  firmId?: number | null;
  roleId?: number | null;
  supportSessionId?: number | null;
  /**
   * Per-request RLS-enforced Drizzle instance.
   * Set by requireFirmUser. Runs inside a transaction as app_user with
   * app.current_firm_id set to req.firmId. All firm-scoped queries in
   * Phase 2+ route handlers must use this instead of the global db.
   */
  rlsDb?: RlsDb;
}

const getReqId = (req: unknown): string | undefined => {
  const id = (req as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
};

const FOUNDER_EMAIL = "lun.6923@hotmail.com";

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
}, options?: { db?: RlsDb; strict?: boolean }) {
  const targetDb = options?.db;
  const strict = options?.strict ?? false;
  try {
    if (targetDb) {
      await targetDb.insert(auditLogsTable).values({
        firmId: params.firmId ?? null,
        actorId: params.actorId ?? null,
        actorType: params.actorType ?? "firm_user",
        action: params.action,
        entityType: params.entityType ?? null,
        entityId: params.entityId ?? null,
        detail: params.detail ?? null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      });
    } else {
      await db.insert(auditLogsTable).values({
        firmId: params.firmId ?? null,
        actorId: params.actorId ?? null,
        actorType: params.actorType ?? "firm_user",
        action: params.action,
        entityType: params.entityType ?? null,
        entityId: params.entityId ?? null,
        detail: params.detail ?? null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      });
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
  let token = req.cookies?.["auth_token"] as string | undefined;
  if (!token) {
    const authHeader = req.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }
  if (!token) {
    await writeAuditLog({ action: "auth.missing_token", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

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
  try {
    const reqId = getReqId(req);
    const lookupStartedAt = Date.now();
    const [s] = await db.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
    if (s) {
      const [u] = await db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          userType: usersTable.userType,
          firmId: usersTable.firmId,
          roleId: usersTable.roleId,
          status: usersTable.status,
        })
        .from(usersTable)
        .where(eq(usersTable.id, s.userId));
      session = s;
      user = u;
    }
    const ms = Date.now() - lookupStartedAt;
    if (ms > 1000) {
      logger.warn({ route: req.path, reqId, ms }, "auth.require_auth.slow");
    }
  } catch (err) {
    logger.error({ err }, "auth.require_auth.db_error");
    res.status(503).json({ error: "Auth temporarily unavailable" });
    return;
  }

  if (!session || session.expiresAt < new Date()) {
    await writeAuditLog({ action: "auth.session_expired", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(401).json({ error: "Session expired" });
    return;
  }

  if (!user || user.status !== "active") {
    await writeAuditLog({ action: "auth.user_inactive", detail: `userId=${session.userId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(401).json({ error: "User not found or inactive" });
    return;
  }

  req.userId = user.id;
  req.email = user.email;
  req.userType = user.userType;
  req.firmId = user.firmId;
  req.roleId = user.roleId;

  next();
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
  if (email !== FOUNDER_EMAIL) {
    await writeAuditLog({ actorId: req.userId, actorType: req.userType ?? "unknown", action: "auth.forbidden.founder_email_mismatch", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(403).json({ error: "Founder access required" });
    return;
  }
  next();
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
  const client = await pool.connect();

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
    await setTenantContextSession(client, req.firmId, req.userId ?? undefined);
    req.rlsDb = makeRlsDb(client);
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
    res.status(503).json({ error: "Tenant context temporarily unavailable", code });
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
    try {
      if (req.userType !== "firm_user" || !req.firmId || !req.roleId) {
        await writeAuditLog({
          actorId: req.userId,
          firmId: req.firmId,
          actorType: req.userType ?? "unknown",
          action: "auth.forbidden.permission",
          detail: `${moduleName}:${action} ${req.method} ${req.path}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
        res.status(403).json({ error: "Permission denied" });
        return;
      }

      const rlsDb = req.rlsDb ?? db;

      const [role] = await rlsDb
        .select()
        .from(rolesTable)
        .where(and(eq(rolesTable.id, req.roleId), eq(rolesTable.firmId, req.firmId)));

      if (!role) {
        await writeAuditLog({
          actorId: req.userId,
          firmId: req.firmId,
          actorType: req.userType ?? "unknown",
          action: "auth.forbidden.permission",
          detail: `${moduleName}:${action} ${req.method} ${req.path} reason=role_not_found`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
        res.status(403).json({ error: "Permission denied" });
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

      if (!perm && role.isSystemRole && (role.name === "Partner" || role.name === "Clerk")) {
        try {
          await ensureBaselinePermissions(rlsDb, role.id, role.name);
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
        await writeAuditLog({
          actorId: req.userId,
          firmId: req.firmId,
          actorType: req.userType ?? "unknown",
          action: "auth.forbidden.permission",
          detail: `${moduleName}:${action} ${req.method} ${req.path}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        });
        res.status(403).json({ error: "Permission denied", code: "PERMISSION_DENIED" });
        return;
      }

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
    }
  };
}

async function ensureBaselinePermissions(rlsDb: RlsDb | typeof db, roleId: number, roleName: "Partner" | "Clerk"): Promise<void> {
  if (roleName === "Partner") {
    await rlsDb.execute(sql`
      INSERT INTO permissions (role_id, module, action, allowed)
      SELECT ${roleId}, v.module, v.action, TRUE
      FROM (
        VALUES
          ('dashboard','read'),
          ('cases','read'),('cases','create'),('cases','update'),('cases','delete'),
          ('projects','read'),('projects','create'),('projects','update'),('projects','delete'),
          ('developers','read'),('developers','create'),('developers','update'),('developers','delete'),
          ('documents','read'),('documents','create'),('documents','update'),('documents','delete'),('documents','generate'),('documents','export'),
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
    return;
  }

  await rlsDb.execute(sql`
    INSERT INTO permissions (role_id, module, action, allowed)
    SELECT ${roleId}, v.module, v.action, TRUE
    FROM (
      VALUES
        ('dashboard','read'),
        ('cases','read'),('cases','create'),('cases','update'),
        ('projects','read'),('projects','create'),('projects','update'),
        ('developers','read'),('developers','create'),('developers','update'),
        ('documents','read'),('documents','export'),
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
