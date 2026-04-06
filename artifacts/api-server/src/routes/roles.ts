import { Router, type IRouter } from "express";
import { eq, count } from "drizzle-orm";
import { db, rolesTable, permissionsTable, usersTable } from "@workspace/db";
import {
  CreateRoleBody, UpdateRoleBody,
  GetRoleParams, UpdateRoleParams, DeleteRoleParams
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth";

const router: IRouter = Router();

async function enrichRole(role: typeof rolesTable.$inferSelect) {
  const perms = await db.select().from(permissionsTable).where(eq(permissionsTable.roleId, role.id));
  const [userCountRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.roleId, role.id));
  return {
    id: role.id,
    firmId: role.firmId,
    name: role.name,
    isSystemRole: role.isSystemRole,
    userCount: Number(userCountRes?.c ?? 0),
    permissions: perms.map(p => ({ id: p.id, module: p.module, action: p.action, allowed: p.allowed })),
    createdAt: role.createdAt.toISOString(),
  };
}

router.get("/roles", requireAuth, requireFirmUser, requirePermission("roles", "read"), async (req: AuthRequest, res): Promise<void> => {
  const roles = await db.select().from(rolesTable).where(eq(rolesTable.firmId, req.firmId!));
  const enriched = await Promise.all(roles.map(enrichRole));
  res.json(enriched);
});

router.post("/roles", requireAuth, requireFirmUser, requirePermission("roles", "create"), async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreateRoleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [role] = await db
    .insert(rolesTable)
    .values({ firmId: req.firmId!, name: parsed.data.name })
    .returning();

  if (parsed.data.permissions?.length) {
    await db.insert(permissionsTable).values(
      parsed.data.permissions.map((p) => ({
        roleId: role.id,
        module: p.module,
        action: p.action,
        allowed: p.allowed,
      }))
    );
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "roles.create", entityType: "role", entityId: role.id, detail: `name=${role.name}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(await enrichRole(role));
});

router.get("/roles/:roleId", requireAuth, requireFirmUser, requirePermission("roles", "read"), async (req: AuthRequest, res): Promise<void> => {
  const params = GetRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, params.data.roleId));
  if (!role || role.firmId !== req.firmId) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  res.json(await enrichRole(role));
});

router.patch("/roles/:roleId", requireAuth, requireFirmUser, requirePermission("roles", "update"), async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateRoleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;

  const [role] = await db
    .update(rolesTable)
    .set(updates)
    .where(eq(rolesTable.id, params.data.roleId))
    .returning();

  if (!role || role.firmId !== req.firmId) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  if (parsed.data.permissions) {
    await db.delete(permissionsTable).where(eq(permissionsTable.roleId, role.id));
    if (parsed.data.permissions.length > 0) {
      await db.insert(permissionsTable).values(
        parsed.data.permissions.map((p) => ({
          roleId: role.id,
          module: p.module,
          action: p.action,
          allowed: p.allowed,
        }))
      );
    }
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "roles.update", entityType: "role", entityId: role.id, detail: `fields=${Object.keys(updates).join(",")}${parsed.data.permissions ? " permissions=replaced" : ""}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(await enrichRole(role));
});

router.delete("/roles/:roleId", requireAuth, requireFirmUser, requirePermission("roles", "delete"), async (req: AuthRequest, res): Promise<void> => {
  const params = DeleteRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.delete(permissionsTable).where(eq(permissionsTable.roleId, params.data.roleId));
  const [role] = await db.delete(rolesTable).where(eq(rolesTable.id, params.data.roleId)).returning();

  if (!role || role.firmId !== req.firmId) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "roles.delete", entityType: "role", entityId: role.id, detail: `name=${role.name}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.sendStatus(204);
});

export default router;
