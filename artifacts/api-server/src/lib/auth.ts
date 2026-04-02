import { Request, Response, NextFunction } from "express";
import { db, sessionsTable, usersTable, auditLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "crypto";

export interface AuthRequest extends Request {
  userId?: number;
  userType?: string;
  firmId?: number | null;
  roleId?: number | null;
  supportSessionId?: number | null;
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

export function requireFirmUser(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.userType !== "firm_user" || !req.firmId) {
    writeAuditLog({ actorId: req.userId, firmId: req.firmId, actorType: req.userType ?? "unknown", action: "auth.forbidden.firm_user_required", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(403).json({ error: "Firm user access required" });
    return;
  }
  next();
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
  const tokenHash = crypto.createHash("sha256").update(reAuthToken).digest("hex");
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
  if (!session || session.expiresAt < new Date() || session.userId !== req.userId) {
    await writeAuditLog({ actorId: req.userId, firmId: req.firmId, actorType: req.userType ?? "firm_user", action: "auth.reauth_failed", detail: `${req.method} ${req.path}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    res.status(403).json({ error: "Re-authentication token invalid or expired", code: "REAUTH_FAILED" });
    return;
  }
  next();
}
