import express, { type Router as ExpressRouter } from "express";
import { and, count, eq, or } from "drizzle-orm";
import { db, permissionsTable, rolesTable, sql, usersTable } from "@workspace/db";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { z } from "zod/v4";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";

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

const CreateRoleBodySchema = z.object({
  name: z.string().min(1),
  permissions: z.array(PermissionItemSchema).optional(),
});
type CreateRoleBody = z.infer<typeof CreateRoleBodySchema>;

const UpdateRoleBodySchema = z.object({
  name: z.string().min(1).optional(),
  permissions: z.array(PermissionItemSchema).optional(),
});
type UpdateRoleBody = z.infer<typeof UpdateRoleBodySchema>;

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequestLike): DbConn => req.rlsDb ?? db;

type TransactionCapable = {
  transaction: <T>(fn: (tx: DbConn) => Promise<T>) => Promise<T>;
};
const asTransactionCapable = (conn: DbConn): TransactionCapable => conn as unknown as TransactionCapable;

const standardRoleNames = ["Partner", "Senior Lawyer", "Lawyer", "Senior Clerk", "Clerk", "Manager", "Admin", "Viewer"] as const;

async function canBackfillStandardRoles(r: DbConn, req: AuthRequest): Promise<boolean> {
  if (!req.roleId) return false;
  const perms = await r
    .select({ allowed: permissionsTable.allowed })
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, req.roleId),
      eq(permissionsTable.allowed, true),
      or(
        and(eq(permissionsTable.module, "roles"), eq(permissionsTable.action, "create")),
        and(eq(permissionsTable.module, "users"), eq(permissionsTable.action, "create")),
      ),
    ));
  return perms.length > 0;
}

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
    await tx.insert(rolesTable).values(missing.map((name) => ({ firmId, name })));
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
  if (req.firmId) {
    const allowed = await canBackfillStandardRoles(r, req);
    if (allowed) {
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
      }
    }
  }
  const roles = await r.select().from(rolesTable).where(eq(rolesTable.firmId, req.firmId!));
  const enriched = await Promise.all(roles.map((role: typeof rolesTable.$inferSelect) => enrichRole(r, role)));
  res.json(enriched);
});

routerInternal.post("/roles", requireAuth, requireFirmUser, requirePermission("roles", "create"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
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

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "roles.create", entityType: "role", entityId: role.id, detail: `name=${role.name}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.status(201).json(await enrichRole(r, role));
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
  const params = RoleIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const p: RoleIdParams = params.data;

  const parsed = UpdateRoleBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body: UpdateRoleBody = parsed.data;

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;

  const r = rdb(req);
  const [role] = await r
    .update(rolesTable)
    .set(updates)
    .where(eq(rolesTable.id, p.roleId))
    .returning();

  if (!role || role.firmId !== req.firmId) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  if (body.permissions) {
    await r.delete(permissionsTable).where(eq(permissionsTable.roleId, role.id));
    if (body.permissions.length > 0) {
      await r.insert(permissionsTable).values(
        body.permissions.map((p) => ({
          roleId: role.id,
          module: p.module,
          action: p.action,
          allowed: p.allowed,
        }))
      );
    }
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "roles.update", entityType: "role", entityId: role.id, detail: `fields=${Object.keys(updates).join(",")}${body.permissions ? " permissions=replaced" : ""}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.json(await enrichRole(r, role));
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
