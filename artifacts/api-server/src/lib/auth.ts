import { Request, Response, NextFunction } from "express";
import { db, sessionsTable, usersTable } from "@workspace/db";
import { eq, gt } from "drizzle-orm";
import crypto from "crypto";

export interface AuthRequest extends Request {
  userId?: number;
  userType?: string;
  firmId?: number | null;
  roleId?: number | null;
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
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.tokenHash, tokenHash));

  if (!session || session.expiresAt < new Date()) {
    res.status(401).json({ error: "Session expired" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.userId));

  if (!user || user.status !== "active") {
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
    res.status(403).json({ error: "Firm user access required" });
    return;
  }
  next();
}
