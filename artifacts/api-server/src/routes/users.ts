import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, ilike, count, desc } from "drizzle-orm";
import { db, usersTable, rolesTable } from "@workspace/db";
import {
  CreateUserBody, UpdateUserBody, ListUsersQueryParams,
  GetUserParams, UpdateUserParams, DeleteUserParams
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

async function enrichUser(user: typeof usersTable.$inferSelect) {
  let roleName: string | null = null;
  if (user.roleId) {
    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, user.roleId));
    roleName = role?.name ?? null;
  }
  return {
    id: user.id,
    firmId: user.firmId,
    email: user.email,
    name: user.name,
    roleId: user.roleId ?? null,
    roleName,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

router.get("/users", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = ListUsersQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const roleId = params.success ? params.data.roleId : undefined;
  const status = params.success ? params.data.status : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  let query = db.select().from(usersTable).where(eq(usersTable.firmId, req.firmId!));

  if (search) {
    query = db.select().from(usersTable)
      .where(eq(usersTable.firmId, req.firmId!)) as typeof query;
  }

  const users = await db.select().from(usersTable)
    .where(eq(usersTable.firmId, req.firmId!))
    .orderBy(desc(usersTable.createdAt))
    .limit(limit)
    .offset(offset);

  const [totalRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.firmId, req.firmId!));

  const enriched = await Promise.all(users.map(enrichUser));
  res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
});

router.post("/users", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, name, password, roleId } = parsed.data;

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
  if (existing) {
    res.status(400).json({ error: "Email already in use" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      firmId: req.firmId!,
      email: email.toLowerCase(),
      name,
      passwordHash,
      roleId,
      userType: "firm_user",
      status: "active",
    })
    .returning();

  res.status(201).json(await enrichUser(user));
});

router.get("/users/:userId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable)
    .where(eq(usersTable.id, params.data.userId));

  if (!user || user.firmId !== req.firmId) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(await enrichUser(user));
});

router.patch("/users/:userId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.roleId !== undefined) updates.roleId = parsed.data.roleId;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;

  const [user] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, params.data.userId))
    .returning();

  if (!user || user.firmId !== req.firmId) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(await enrichUser(user));
});

router.delete("/users/:userId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const params = DeleteUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.delete(usersTable)
    .where(eq(usersTable.id, params.data.userId))
    .returning();

  if (!user || user.firmId !== req.firmId) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
