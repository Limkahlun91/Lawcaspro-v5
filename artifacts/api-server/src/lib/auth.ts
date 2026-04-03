import { Request, Response, NextFunction } from "express";
import { db, pool, sessionsTable, usersTable, auditLogsTable, makeRlsDb, setTenantContextSession, clearTenantContext, RlsDb } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "crypto";

export interface AuthRequest extends Request {
  userId?: number;
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
}) {
  try {
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
  } catch {
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

  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.tokenHash, tokenHash));

  if (!session || session.expiresAt < new Date()) {
    await writeAuditLog({ action: "auth.session_expired", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(401).json({ error: "Session expired" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.userId));

  if (!user || user.status !== "active") {
    await writeAuditLog({ action: "auth.user_inactive", detail: `userId=${session.userId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(401).json({ error: "User not found or inactive" });
    return;
  }

  req.userId = user.id;
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
    await setTenantContextSession(client, req.firmId);
    req.rlsDb = makeRlsDb(client);
  } catch (err) {
    client.release(true);
    next(err);
    return;
  }

  res.on("finish", () => { releaseClient(true); });
  res.on("close", () => { releaseClient(false); });

  next();
}

/**
 * Restricts access to users with the Partner role (role_id = 1).
 * Must be used after requireAuth + requireFirmUser.
 */
export function requirePartner(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.roleId !== 1) {
    writeAuditLog({ actorId: req.userId, firmId: req.firmId, actorType: req.userType ?? "unknown", action: "auth.forbidden.partner_required", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(403).json({ error: "Partner access required for this action", code: "PARTNER_REQUIRED" });
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
