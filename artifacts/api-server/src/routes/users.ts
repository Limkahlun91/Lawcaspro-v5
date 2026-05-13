import express, { type Router as ExpressRouter } from "express";
import bcrypt from "bcryptjs";
import { and, count, desc, eq, ilike } from "drizzle-orm";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { db, rolesTable, sql, usersTable } from "@workspace/db";
import {
  CreateUserBody, UpdateUserBody, ListUsersQueryParams,
  GetUserParams, UpdateUserParams
} from "@workspace/api-zod";
import { ensureRolePermissionsInitialized, requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { logger } from "../lib/logger.js";

type ReqLike = IncomingMessage & {
  body?: unknown;
  headers: IncomingHttpHeaders & Record<string, string | string[] | undefined>;
  ip?: string;
  originalUrl?: string;
  params?: Record<string, unknown>;
  path?: string;
  query?: Record<string, unknown>;
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

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequestLike): DbConn => req.rlsDb ?? db;

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

async function columnExists(r: DbConn, table: string, column: string): Promise<boolean> {
  const rows = await queryRows(r, sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
    LIMIT 1
  `);
  return rows.length > 0;
}

let usersDepartmentExistsCache: boolean | null = null;
async function usersDepartmentExists(r: DbConn): Promise<boolean> {
  if (usersDepartmentExistsCache !== null) return usersDepartmentExistsCache;
  usersDepartmentExistsCache = await columnExists(r, "users", "department");
  return usersDepartmentExistsCache;
}

let usersBarCouncilNoExistsCache: boolean | null = null;
async function usersBarCouncilNoExists(r: DbConn): Promise<boolean> {
  if (usersBarCouncilNoExistsCache !== null) return usersBarCouncilNoExistsCache;
  usersBarCouncilNoExistsCache = await columnExists(r, "users", "bar_council_no");
  return usersBarCouncilNoExistsCache;
}

let usersNricNoExistsCache: boolean | null = null;
async function usersNricNoExists(r: DbConn): Promise<boolean> {
  if (usersNricNoExistsCache !== null) return usersNricNoExistsCache;
  usersNricNoExistsCache = await columnExists(r, "users", "nric_no");
  return usersNricNoExistsCache;
}

type UserRow = {
  id: number;
  firmId: number | null;
  email: string;
  name: string;
  roleId: number | null;
  developerId?: number | null;
  department?: string | null;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
};

async function enrichUser(r: DbConn, firmId: number, user: UserRow) {
  let roleName: string | null = null;
  if (user.roleId) {
    const [role] = await r
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.id, user.roleId), eq(rolesTable.firmId, firmId)));
    roleName = role?.name ?? null;
  }
  return {
    id: user.id,
    firmId: user.firmId,
    email: user.email,
    name: user.name,
    roleId: user.roleId ?? null,
    roleName,
    developerId: user.developerId ?? null,
    department: user.department ?? null,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

routerInternal.get("/users", requireAuth, requireFirmUser, requirePermission("users", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = ListUsersQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const roleId = params.success ? params.data.roleId : undefined;
  const status = params.success ? params.data.status : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  const hasDepartment = await usersDepartmentExists(r);

  const where = [
    eq(usersTable.firmId, req.firmId!),
    ...(status ? [eq(usersTable.status, status)] : []),
    ...(roleId ? [eq(usersTable.roleId, roleId)] : []),
    ...(search ? [ilike(usersTable.name, `%${search}%`)] : []),
  ];

  const baseSelect = {
    id: usersTable.id,
    firmId: usersTable.firmId,
    email: usersTable.email,
    name: usersTable.name,
    roleId: usersTable.roleId,
    developerId: usersTable.developerId,
    status: usersTable.status,
    lastLoginAt: usersTable.lastLoginAt,
    createdAt: usersTable.createdAt,
  };

  const users = hasDepartment
    ? await r
        .select({ ...baseSelect, department: usersTable.department })
        .from(usersTable)
        .where(and(...where))
        .orderBy(desc(usersTable.createdAt))
        .limit(limit)
        .offset(offset)
    : await r
        .select(baseSelect)
        .from(usersTable)
        .where(and(...where))
        .orderBy(desc(usersTable.createdAt))
        .limit(limit)
        .offset(offset);

  const [totalRes] = await r
    .select({ c: count() })
    .from(usersTable)
    .where(and(...where));

  const enriched = await Promise.all(users.map((u: UserRow) => enrichUser(r, req.firmId!, u)));
  res.json({ data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
});

routerInternal.post("/users", requireAuth, requireFirmUser, requirePermission("users", "create"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const startedAt = Date.now();
  const r = rdb(req);
  const reqId = (req as { id?: unknown } | null)?.id;
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "users.create.attempt", detail: req.path, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, name, password, roleId, developerId, department, barCouncilNo, nricNo } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const created = await (r as any).transaction(async (tx: DbConn) => {
      const [row] = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, normalizedEmail))
        .limit(1);
      if (row) {
        return { kind: "email_taken" as const };
      }

      const [role] = await tx
        .select({ id: rolesTable.id, name: rolesTable.name })
        .from(rolesTable)
        .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, req.firmId!)));
      if (!role) {
        return { kind: "bad_role" as const };
      }
      const isDeveloperUser = role.name === "Developer_User";
      if (isDeveloperUser) {
        const normalizedDeveloperId = developerId === null || developerId === undefined ? null : Number(developerId);
        if (!normalizedDeveloperId || !Number.isInteger(normalizedDeveloperId) || normalizedDeveloperId <= 0) {
          return { kind: "missing_developer_id" as const };
        }
        const devRows = await queryRows(
          tx,
          sql`SELECT 1 FROM developers WHERE firm_id = ${req.firmId!} AND id = ${normalizedDeveloperId} LIMIT 1`
        );
        if (!devRows[0]) {
          return { kind: "invalid_developer_id" as const };
        }
      }

      const legalRoleNames = new Set(["Lawyer", "Senior Lawyer", "Partner"]);
      const isLegalRole = legalRoleNames.has(role.name);

      const hasDepartment = await usersDepartmentExists(tx);
      const hasBarCouncilNo = await usersBarCouncilNoExists(tx);
      const hasNricNo = await usersNricNoExists(tx);

      if (hasBarCouncilNo && isLegalRole && !barCouncilNo?.trim()) {
        return { kind: "missing_bar_council" as const };
      }

      const values: typeof usersTable.$inferInsert = {
        firmId: req.firmId!,
        email: normalizedEmail,
        name,
        passwordHash,
        roleId,
        developerId: developerId ?? null,
        userType: "firm_user",
        status: "active",
      };
      if (hasDepartment) values.department = department ?? null;
      if (hasBarCouncilNo) values.barCouncilNo = isLegalRole ? (barCouncilNo?.trim() ? barCouncilNo.trim() : null) : null;
      if (hasNricNo) values.nricNo = nricNo?.trim() ? nricNo.trim() : null;

      const [user] = await tx.insert(usersTable).values(values).returning();
      await ensureRolePermissionsInitialized(tx as any, req.firmId!, roleId);
      return { kind: "ok" as const, user };
    });

    if (created.kind === "email_taken") {
      res.status(400).json({ error: "Email already in use" });
      return;
    }
    if (created.kind === "bad_role") {
      res.status(400).json({ error: "Invalid roleId" });
      return;
    }
    if (created.kind === "missing_developer_id") {
      res.status(400).json({ error: "developerId is required for Developer_User" });
      return;
    }
    if (created.kind === "invalid_developer_id") {
      res.status(400).json({ error: "Invalid developerId" });
      return;
    }
    if (created.kind === "missing_bar_council") {
      res.status(400).json({ error: "Bar Council No. is required for legal roles" });
      return;
    }

    await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "users.create", entityType: "user", entityId: created.user.id, detail: `email=${created.user.email}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
    res.status(201).json(await enrichUser(r, req.firmId!, created.user));
  } catch (err) {
    const code = (err as any)?.code;
    logger.error(
      {
        err,
        route: req.originalUrl,
        firmId: req.firmId ?? null,
        userId: req.userId ?? null,
        requestId: reqId ?? null,
        sqlState: typeof code === "string" ? code : null,
        errorCode: typeof code === "string" ? code : null,
        durationMs: Date.now() - startedAt,
      },
      "users.create_failed",
    );
    if (code === "23505") {
      res.status(400).json({ error: "Email already in use" });
      return;
    }
    res.status(503).json({ error: "Failed to create user" });
  }
});

routerInternal.get("/users/:userId", requireAuth, requireFirmUser, requirePermission("users", "read"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const hasDepartment = await usersDepartmentExists(r);
  const baseSelect = {
    id: usersTable.id,
    firmId: usersTable.firmId,
    email: usersTable.email,
    name: usersTable.name,
    roleId: usersTable.roleId,
    status: usersTable.status,
    lastLoginAt: usersTable.lastLoginAt,
    createdAt: usersTable.createdAt,
  };
  const [user] = hasDepartment
    ? await r
        .select({ ...baseSelect, department: usersTable.department })
        .from(usersTable)
        .where(eq(usersTable.id, params.data.userId))
    : await r
        .select(baseSelect)
        .from(usersTable)
        .where(eq(usersTable.id, params.data.userId));

  if (!user || user.firmId !== req.firmId) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(await enrichUser(r, req.firmId!, user));
});

routerInternal.patch("/users/:userId", requireAuth, requireFirmUser, requirePermission("users", "update"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
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
  if (Object.prototype.hasOwnProperty.call(parsed.data, "developerId")) {
    updates.developerId = (parsed.data as any).developerId;
  }
  if (parsed.data.department !== undefined && await usersDepartmentExists(r)) updates.department = parsed.data.department;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;

  const result = await (r as any).transaction(async (tx: DbConn) => {
    if (typeof updates.roleId === "number") {
      const [role] = await tx
        .select({ name: rolesTable.name })
        .from(rolesTable)
        .where(and(eq(rolesTable.id, updates.roleId), eq(rolesTable.firmId, req.firmId!)))
        .limit(1);
      if (role?.name === "Developer_User") {
        const normalizedDeveloperId = updates.developerId === null || updates.developerId === undefined ? null : Number(updates.developerId);
        if (!normalizedDeveloperId || !Number.isInteger(normalizedDeveloperId) || normalizedDeveloperId <= 0) {
          return { kind: "missing_developer_id" as const };
        }
        const devRows = await queryRows(
          tx,
          sql`SELECT 1 FROM developers WHERE firm_id = ${req.firmId!} AND id = ${normalizedDeveloperId} LIMIT 1`
        );
        if (!devRows[0]) return { kind: "invalid_developer_id" as const };
      } else if (Object.prototype.hasOwnProperty.call(updates, "developerId")) {
        updates.developerId = null;
      }
    }
    const [user] = await tx
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, params.data.userId))
      .returning();
    if (!user || user.firmId !== req.firmId) return { kind: "not_found" as const };
    if (typeof updates.roleId === "number") {
      await ensureRolePermissionsInitialized(tx as any, req.firmId!, updates.roleId);
    }
    return { kind: "ok" as const, user };
  });

  if (result.kind === "missing_developer_id") {
    res.status(400).json({ error: "developerId is required for Developer_User" });
    return;
  }
  if (result.kind === "invalid_developer_id") {
    res.status(400).json({ error: "Invalid developerId" });
    return;
  }
  if (result.kind === "not_found") {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "users.update", entityType: "user", entityId: result.user.id, detail: `fields=${Object.keys(updates).join(",")}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.json(await enrichUser(r, req.firmId!, result.user));
});

routerInternal.delete("/users/:userId", requireAuth, requireFirmUser, requirePermission("users", "delete"), async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await r.delete(usersTable)
    .where(eq(usersTable.id, params.data.userId))
    .returning();

  if (!user || user.firmId !== req.firmId) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "users.delete", entityType: "user", entityId: user.id, detail: `email=${user.email}`, ipAddress: req.ip, userAgent: getHeader(req, "user-agent") });
  res.sendStatus(204);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
