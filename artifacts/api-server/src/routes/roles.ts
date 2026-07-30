import express, { type Router as ExpressRouter } from "express";
import { and, count, eq } from "drizzle-orm";
import { db, permissionsTable, rolesTable, sql, usersTable } from "@workspace/db";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { z } from "zod/v4";
import { ensureRolePermissionsInitialized, requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";

type ReqLike = IncomingMessage & {
  body?: unknown;
  headers: IncomingHttpHeaders & Record<string, string | string[] | undefined>;
  ip?: string;
  originalUrl?: string;
  params?: Record<string, unknown>;
  path?: string;
  query?: Record<string, unknown>;
  roleId?: number | null;
  userId?: number | null;
  userType?: string | null;
  firmId?: number | null;
  [key: string]: unknown;
};

type RouteResLike = {
  status: (code: number) => RouteResLike;
  json: (body: unknown) => unknown;
  sendStatus: (code: number) => unknown;
  [key: string]: unknown;
};

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const routerInternal = expressRouter as unknown as RouterInternalLike;

type AuthRequestLike = AuthRequest & ReqLike;

const asOptionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const getHeader = (req: AuthRequestLike, key: string): string | undefined => {
  const lower = key.toLowerCase();
  const value = req.headers?.[lower] ?? req.headers?.[key];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return asOptionalString(value);
};

const RoleIdParamsSchema = z.object({ roleId: z.coerce.number().int().min(1) });
type RoleIdParams = z.infer<typeof RoleIdParamsSchema>;

const PermissionItemSchema = z.object({
  module: z.string().min(1),
  action: z.string().min(1),
  allowed: z.boolean(),
});

const UpdatePermissionItemSchema = z.object({
  module: z.string().min(1),
  action: z.string().min(1),
  allowed: z.boolean().optional().nullable(),
});

const CreateRoleBodySchema = z.object({
  name: z.string().min(1),
  permissions: z.array(PermissionItemSchema).optional(),
});
type CreateRoleBody = z.infer<typeof CreateRoleBodySchema>;

const UpdateRoleBodySchema = z.object({
  name: z.string().min(1).optional(),
  permissions: z.array(UpdatePermissionItemSchema).optional(),
});
type UpdateRoleBody = z.infer<typeof UpdateRoleBodySchema>;

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequestLike): DbConn => req.rlsDb ?? db;

type TransactionCapable = {
  transaction: <T>(fn: (tx: DbConn) => Promise<T>) => Promise<T>;
};
const asTransactionCapable = (conn: DbConn): TransactionCapable => conn as unknown as TransactionCapable;

const standardRoleNames = ["Partner", "Account Admin", "Account Manager", "Senior Lawyer", "Lawyer", "Senior Clerk", "Clerk", "Staff", "Manager", "Admin", "Viewer", "Developer_User"] as const;

const shouldAutoGrantRoleByName = (name: string): boolean => {
  const n = name.trim().toLowerCase();
  return n.includes("partner") || n.includes("lawyer") || n.includes("clerk") || n === "staff" || (n.includes("account") && (n.includes("admin") || n.includes("manager")));
};

async function backfillStandardRoles(r: DbConn, firmId: number): Promise<string[]> {
  return asTransactionCapable(r).transaction(async (tx: DbConn) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${firmId})`);
    const existing = await tx
      .select({ name: rolesTable.name })
      .from(rolesTable)
      .where(eq(rolesTable.firmId, firmId));
    const existingNames = new Set(existing.map((x: { name: string }) => x.name));
    const missing = standardRoleNames.filter((name) => !existingNames.has(name));
    if (missing.length === 0) return [];
    const inserted = await tx
      .insert(rolesTable)
      .values(missing.map((name) => ({ firmId, name, isSystemRole: true })))
      .returning({ id: rolesTable.id, name: rolesTable.name });
    for (const role of inserted) {
      if (shouldAutoGrantRoleByName(role.name)) {
        await ensureRolePermissionsInitialized(tx as any, firmId, role.id);
      }
    }
    return [...missing];
  });
}

async function enrichRole(r: DbConn, role: typeof rolesTable.$inferSelect) {
  const perms = await r.select().from(permissionsTable).where(eq(permissionsTable.roleId, role.id));
  const [userCountRes] = await r.select({ c: count() }).from(usersTable).where(eq(usersTable.roleId, role.id));
  return {
    id: role.id,
    firmId: role.firmId,
    name: role.name,
    isSystemRole: role.isSystemRole,
    userCount: Number(userCountRes?.c ?? 0),
    permissions: perms.map((p: typeof permissionsTable.$inferSelect) => ({ id: p.id, module: p.module, action: p.action, allowed: p.allowed })),
    createdAt: role.createdAt.toISOString(),
  };
}

routerInternal.get("/roles", requireAuth, requireFirmUser, requirePermission("roles", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  let roles = await r.select().from(rolesTable).where(eq(rolesTable.firmId, req.firmId!));
  if (roles.length === 0 && req.firmId) {
    const created = await backfillStandardRoles(r, req.firmId);
    if (created.length > 0) {
      await writeAuditLog({
        firmId: req.firmId,
        actorId: req.userId,
        actorType: req.userType,
        action: "roles.standard_roles_backfilled",
        detail: `created=${created.join(",")}`,
        ipAddress: req.ip,
        userAgent: getHeader(req, "user-agent"),
      }, { db: req.rlsDb });
      roles = await r.select().from(rolesTable).where(eq(rolesTable.firmId, req.firmId!));
    }
  }
  const enriched = await Promise.all(roles.map((role: typeof rolesTable.$inferSelect) => enrichRole(r, role)));
  res.json(enriched);
});

routerInternal.post("/roles", requireAuth, requireFirmUser, requirePermission("roles", "create"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const parsed = CreateRoleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body: CreateRoleBody = parsed.data;

    const r = rdb(req);
    const [role] = await r
      .insert(rolesTable)
      .values({ firmId: req.firmId!, name: body.name })
      .returning();

    if (body.permissions?.length) {
      await r.insert(permissionsTable).values(
        body.permissions.map((p) => ({
          roleId: role.id,
          module: p.module,
          action: p.action,
          allowed: p.allowed,
        }))
      );
    }
    if (shouldAutoGrantRoleByName(role.name)) {
      await ensureRolePermissionsInitialized(r as any, req.firmId!, role.id);
    }

    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "roles.create", entityType: "role", entityId: role.id, detail: `name=${role.name}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
    res.status(201).json(await enrichRole(r, role));
  } catch (err) {
    console.error("SQL ERR:", err);
    res.status(500).json({ error: "Update failed" });
  }
});

routerInternal.get("/roles/:roleId", requireAuth, requireFirmUser, requirePermission("roles", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const params = RoleIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const p: RoleIdParams = params.data;

  const r = rdb(req);
  const [role] = await r.select().from(rolesTable).where(eq(rolesTable.id, p.roleId));
  if (!role || role.firmId !== req.firmId) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  res.json(await enrichRole(r, role));
});

routerInternal.patch("/roles/:roleId", requireAuth, requireFirmUser, requirePermission("roles", "update"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  try {
    const params = RoleIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid data" });
      return;
    }
    const p: RoleIdParams = params.data;

    const parsed = UpdateRoleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid data" });
      return;
    }
    const body: UpdateRoleBody = parsed.data;

    const r = rdb(req);
    if (body.name === undefined && body.permissions === undefined) {
      res.status(400).json({ error: "Invalid data" });
      return;
    }

    const normalizedPermissions = body.permissions?.map((perm) => ({
      module: perm.module,
      action: perm.action,
      allowed: perm.allowed ?? false,
    }));

    const result = await asTransactionCapable(r).transaction(async (tx: DbConn) => {
      const [existing] = await tx
        .select()
        .from(rolesTable)
        .where(and(eq(rolesTable.id, p.roleId), eq(rolesTable.firmId, req.firmId!)));

      if (!existing) return { ok: false as const };

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;

      let role = existing;
      if (Object.keys(updates).length > 0) {
        const [updated] = await tx
          .update(rolesTable)
          .set(updates)
          .where(and(eq(rolesTable.id, p.roleId), eq(rolesTable.firmId, req.firmId!)))
          .returning();
        if (updated) role = updated;
      }

      if (normalizedPermissions !== undefined) {
        if (normalizedPermissions.length === 0) {
          await tx.delete(permissionsTable).where(eq(permissionsTable.roleId, role.id));
        } else {
          const existingPerms = await tx
            .select({ module: permissionsTable.module, action: permissionsTable.action, allowed: permissionsTable.allowed })
            .from(permissionsTable)
            .where(eq(permissionsTable.roleId, role.id));

          const merged = new Map<string, { module: string; action: string; allowed: boolean }>();
          for (const p of existingPerms) {
            merged.set(`${p.module}::${p.action}`, { module: p.module, action: p.action, allowed: p.allowed });
          }
          for (const p of normalizedPermissions) {
            merged.set(`${p.module}::${p.action}`, { module: p.module, action: p.action, allowed: p.allowed });
          }

          const final = Array.from(merged.values());
          await tx.delete(permissionsTable).where(eq(permissionsTable.roleId, role.id));
          await tx.insert(permissionsTable).values(
            final.map((perm) => ({
              roleId: role.id,
              module: perm.module,
              action: perm.action,
              allowed: perm.allowed,
            }))
          );
        }
      }
      if (shouldAutoGrantRoleByName(role.name)) {
        await ensureRolePermissionsInitialized(tx as any, req.firmId!, role.id);
      }

      return {
        ok: true as const,
        updatedFields: Object.keys(updates),
        permissionsReplaced: normalizedPermissions !== undefined,
        role,
        enriched: await enrichRole(tx, role),
      };
    });

    if (!result.ok) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "roles.update",
      entityType: "role",
      entityId: result.role.id,
      detail: `fields=${result.updatedFields.join(",")}${result.permissionsReplaced ? " permissions=merged" : ""}`,
      ipAddress: req.ip,
      userAgent: getHeader(req, "user-agent"),
    });
    res.json(result.enriched);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update role" });
  }
});

routerInternal.delete("/roles/:roleId", requireAuth, requireFirmUser, requirePermission("roles", "delete"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const params = RoleIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const p: RoleIdParams = params.data;

  const r = rdb(req);
  await r.delete(permissionsTable).where(eq(permissionsTable.roleId, p.roleId));
  const [role] = await r.delete(rolesTable).where(eq(rolesTable.id, p.roleId)).returning();

  if (!role || role.firmId !== req.firmId) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "roles.delete", entityType: "role", entityId: role.id, detail: `name=${role.name}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.sendStatus(204);
});

routerInternal.post("/roles/bootstrap", requireAuth, requireFirmUser, requirePermission("roles", "create"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const created = await backfillStandardRoles(r, req.firmId!);
  if (created.length > 0) {
    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "roles.bootstrap",
      detail: `created=${created.join(",")}`,
      ipAddress: req.ip,
      userAgent: getHeader(req, "user-agent"),
    }, { db: req.rlsDb });
  }
  res.json({ message: `Bootstrapped ${created.length} roles` });
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
