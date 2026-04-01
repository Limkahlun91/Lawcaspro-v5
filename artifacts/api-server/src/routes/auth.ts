import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db, usersTable, sessionsTable, rolesTable, firmsTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { requireAuth, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, password } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase()));

  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  if (user.status !== "active") {
    res.status(401).json({ error: "Account is inactive" });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(sessionsTable).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  await db
    .update(usersTable)
    .set({ lastLoginAt: new Date() })
    .where(eq(usersTable.id, user.id));

  let roleName: string | null = null;
  if (user.roleId) {
    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, user.roleId));
    roleName = role?.name ?? null;
  }

  let firmName: string | null = null;
  if (user.firmId) {
    const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, user.firmId));
    firmName = firm?.name ?? null;
  }

  res.cookie("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    userType: user.userType,
    firmId: user.firmId,
    firmName,
    roleId: user.roleId,
    roleName,
    status: user.status,
  });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = req.cookies?.["auth_token"] as string | undefined;
  if (token) {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
  }
  res.clearCookie("auth_token");
  res.json({ success: true });
});

router.get("/auth/me", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.userId!));

  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  let roleName: string | null = null;
  if (user.roleId) {
    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, user.roleId));
    roleName = role?.name ?? null;
  }

  let firmName: string | null = null;
  if (user.firmId) {
    const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, user.firmId));
    firmName = firm?.name ?? null;
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    userType: user.userType,
    firmId: user.firmId,
    firmName,
    roleId: user.roleId,
    roleName,
    status: user.status,
  });
});

export default router;
