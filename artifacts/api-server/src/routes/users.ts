import express, { type Router as ExpressRouter } from "express";
import bcrypt from "bcryptjs";
import { and, count, desc, eq, ilike, inArray } from "drizzle-orm";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import {
  db,
  rolesTable,
  sql,
  usersTable,
  firmUserFeatureAccessTable,
  FEATURE_REGISTRY_MAP,
  getFeatureDefinition,
  isFeatureRegistered,
} from "@workspace/db";
import {
  CreateUserBody, UpdateUserBody, ListUsersQueryParams,
  GetUserParams, UpdateUserParams
} from "@workspace/api-zod";
import { ensureRolePermissionsInitialized, requireAuth, requireFirmUser, requirePartner, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { ApiError } from "../lib/api-response.js";
import { checkFirmQuota } from "../lib/quota.js";
import { logger } from "../lib/logger.js";
import {
  resolveUserFeatureAccessBulk,
  invalidateUserFeatureCacheFor,
} from "../services/user-feature-access.js";

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
  put: (path: string, ...handlers: unknown[]) => unknown;
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

let usersInitialsExistsCache: boolean | null = null;
async function usersInitialsExists(r: DbConn): Promise<boolean> {
  if (usersInitialsExistsCache !== null) return usersInitialsExistsCache;
  usersInitialsExistsCache = await columnExists(r, "users", "initials");
  return usersInitialsExistsCache;
}

type UserRow = {
  id: number;
  firmId: number | null;
  email: string;
  name: string;
  initials?: string | null;
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
    initials: user.initials ?? null,
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
  const hasInitials = await usersInitialsExists(r);

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
    ...(hasInitials ? { initials: usersTable.initials } : {}),
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
  const initialsRaw = typeof (req.body as any)?.initials === "string" ? String((req.body as any).initials) : "";
  const initialsClean = initialsRaw.trim() ? initialsRaw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5) : "";
  if (initialsClean && initialsClean.length < 2) {
    res.status(400).json({ error: "Initials must be 2–5 characters" });
    return;
  }
  const initials = initialsClean ? initialsClean : null;
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

      await checkFirmQuota(tx as any, req.firmId!, "users");

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
      const hasInitials = await usersInitialsExists(tx);

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
      if (hasInitials) values.initials = initials;

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
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message, code: err.code });
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
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "initials") && await usersInitialsExists(r)) {
    const initialsRaw = typeof (req.body as any)?.initials === "string" ? String((req.body as any).initials) : "";
    const initialsClean = initialsRaw.trim() ? initialsRaw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5) : "";
    if (initialsClean && initialsClean.length < 2) {
      res.status(400).json({ error: "Initials must be 2–5 characters" });
      return;
    }
    updates.initials = initialsClean ? initialsClean : null;
  }
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

// ---------------------------------------------------------------------------
// Part 2 §9: Current user self effective features (bulk)
// Used by sidebar + UserFeatureGuard — ONE single effective feature source
// ---------------------------------------------------------------------------

routerInternal.get("/users/_self/effective-features", requireAuth, requireFirmUser, async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
  const r = rdb(req);
  if (!req.firmId || !req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  let roleName: string | null = null;
  let roleId: number | null = req.roleId ?? null;
  const cached = (req as any)._roleCache as
    | { firmId: number; roleId: number; name: string }
    | undefined;
  if (cached && cached.firmId === req.firmId && cached.roleId === roleId) {
    roleName = cached.name;
  } else if (roleId) {
    const [row] = await r
      .select({ name: rolesTable.name })
      .from(rolesTable)
      .where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, req.firmId)))
      .limit(1);
    roleName = row?.name ?? null;
  }

  // Load every registered feature key to get full coverage.
  const allKeys = Array.from(FEATURE_REGISTRY_MAP.keys()).slice().sort();

  // Permission checker fallback to roles table.
  const permCache = new Map<string, boolean>();
  let permRows: { module: unknown; action: unknown; allowed: unknown }[] = [];
  if (roleId) {
    permRows = (await r
      .execute(
        sql`SELECT module, action, allowed FROM permissions WHERE role_id = ${roleId} AND allowed = TRUE`,
      )
      .then(
        (res2) =>
          (Array.isArray(res2)
            ? (res2 as unknown as { module: unknown; action: unknown; allowed: unknown }[])
            : ("rows" in (res2 as any)
              ? ((res2 as any).rows as { module: unknown; action: unknown; allowed: unknown }[])
              : [])),
      )) as { module: unknown; action: unknown; allowed: unknown }[];
  }
  for (const pr of permRows) {
    if (typeof pr.module === "string" && typeof pr.action === "string") {
      permCache.set(`${pr.module}:${pr.action}`, true);
    }
  }

  const effective = await resolveUserFeatureAccessBulk({
    r,
    firmId: req.firmId,
    userId: req.userId,
    roleId,
    roleName,
    featureKeys: allKeys,
    permissionChecker: (mod: string, act: string) =>
      Promise.resolve(Boolean(permCache.get(`${mod}:${act}`))),
  });

  const explicitRows = await r
    .select({
      featureKey: firmUserFeatureAccessTable.featureKey,
      isEnabled: firmUserFeatureAccessTable.isEnabled,
    })
    .from(firmUserFeatureAccessTable)
    .where(
      and(
        eq(firmUserFeatureAccessTable.firmId, req.firmId),
        eq(firmUserFeatureAccessTable.userId, req.userId),
      ),
    );

  res.json({
    userId: req.userId,
    firmId: req.firmId,
    effective,
    explicitOverrides: explicitRows.map((r2) => ({
      featureKey: r2.featureKey,
      isEnabled: r2.isEnabled,
    })),
  });
});

// ---------------------------------------------------------------------------
// Part 2 §6 — Partner-only access profile GET/PUT — human labels, one TX.
// ---------------------------------------------------------------------------

type ModuleAccessCard = {
  featureKey: string;
  label: string;
  state: "full" | "limited" | "off";
  children: Array<{
    featureKey: string;
    label: string;
    enabled: boolean;
  }>;
};

const HUMAN_LABELS: Record<string, string> = {
  "module.cases": "Cases",
  "cases.dashboard": "My Work",
  "cases.create": "Create Cases",
  "cases.hub": "Cases",
  "cases.legacy_import": "Import Old Cases",
  "cases.projects": "Projects",
  "cases.developers": "Developers",
  "module.documents": "Documents",
  "documents.hub": "Documents",
  "documents.automation": "Document Automation",
  "documents.templates": "Templates",
  "documents.variables": "Variables",
  "documents.batch": "Batch Print",
  "documents.generated": "Generated Documents",
  "documents.logs": "Generation Logs",
  "module.accounting": "Accounting",
  "accounting.dashboard": "Overview",
  "accounting.monitor": "Monitor",
  "accounting.file_listing": "File Listing",
  "accounting.payment_voucher": "Payment Vouchers",
  "accounting.payment_voucher.create": "Create PV",
  "accounting.payment_voucher.approval": "Approve PV",
  "accounting.quotation": "Quotations",
  "accounting.invoice": "Invoices",
  "accounting.receipt": "Receipts",
  "accounting.bank_accounts": "Bank Accounts",
  "accounting.bank_reconciliation": "Bank Reconciliation",
  "accounting.case_ledger": "Ledger",
  "accounting.reports": "Reports",
  "module.hr": "HR",
  "hr.dashboard": "HR Dashboard",
  "hr.employees": "Employees",
  "hr.attendance": "Attendance",
  "hr.leave": "Leave",
  "hr.claims": "Claims",
  "hr.payroll": "Payroll",
  "hr.recruitment": "Recruitment",
  "hr.performance": "Performance",
  "hr.training": "Training",
  "hr.assets": "Assets",
  "hr.documents": "Documents",
  "hr.onboarding": "Onboarding",
  "hr.offboarding": "Offboarding",
  "hr.departments": "Departments",
  "hr.positions": "Positions",
  "hr.reports": "Reports",
  "hr.settings": "Settings",
  "hr.self_service": "My HR",
  "module.hims": "HIMS / eSPA",
  "hims.tracker": "Tracker",
  "hims.credentials": "Credentials",
  "hims.project_mapping": "Project Mapping",
  "hims.unit_lot_title": "Unit / Lot / Title",
  "hims.espa_status": "eSPA Status",
  "hims.spa_tracker": "SPA Tracker",
  "hims.spa_stamped_handover": "SPA Stamped / Handover",
  "hims.status_check": "Status Check",
  "hims.compare_lawcaspro_hims": "Data Match",
  "hims.notifications": "Notifications",
  "module.communications": "Communications",
  "communications.email": "Email",
  "communications.email.settings": "Email Settings",
  "communications.email.folders": "Folders",
  "communications.email.mark_read": "Mark as Read",
  "communications.email.reply": "Reply",
  "communications.email.forward": "Forward",
  "communications.email.remarks": "Remarks",
  "communications.email.assign_user": "Assign",
  "communications.email.link_case": "Link Case",
  "communications.email.search": "Search",
};

function labelOf(featureKey: string): string {
  if (HUMAN_LABELS[featureKey]) return HUMAN_LABELS[featureKey];
  const def = getFeatureDefinition(featureKey);
  if (def?.name) return def.name;
  const base = featureKey.split(".").slice(-1)[0] ?? featureKey;
  return base.replace(/[_\-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

const MODULE_ORDER: ReadonlyArray<string> = [
  "module.cases",
  "module.documents",
  "module.accounting",
  "module.hr",
  "module.communications",
  "module.hims",
];

function buildModulesView(
  effective: Record<string, { effectiveEnabled: boolean; firmEnabled: boolean }>,
  explicit: Map<string, boolean>,
): ModuleAccessCard[] {
  const out: ModuleAccessCard[] = [];
  for (const modKey of MODULE_ORDER) {
    if (!isFeatureRegistered(modKey)) continue;
    const childrenKeys = (() => {
      try {
        const ch = [] as string[];
        const def = getFeatureDefinition(modKey);
        if (def && (def as any).children && Array.isArray((def as any).children)) {
          for (const k of (def as any).children) if (typeof k === "string") ch.push(k);
          if (ch.length) return ch;
        }
        // fallback: registry keys that start with modKey (minus module. prefix)
        const prefix = modKey.replace(/^module\./, "") + ".";
        for (const k of Array.from(FEATURE_REGISTRY_MAP.keys())) {
          if (k.startsWith(prefix)) ch.push(k);
        }
        return Array.from(new Set(ch)).sort();
      } catch {
        return [] as string[];
      }
    })();
    const firmEnabled = effective[modKey]?.firmEnabled ?? false;
    const childStates = childrenKeys.map((k) => {
      const eff = effective[k];
      let enabled = explicit.get(k);
      if (enabled === undefined) enabled = !!eff?.effectiveEnabled;
      // If firm module OFF → children forced off regardless of explicit rows
      enabled = enabled && firmEnabled;
      return { featureKey: k, label: labelOf(k), enabled };
    });
    const total = childStates.length || 1;
    const onCount = childStates.filter((c) => c.enabled).length;
    let state: ModuleAccessCard["state"] = "off";
    if (firmEnabled) {
      if (onCount === 0) state = "off";
      else if (onCount === total) state = "full";
      else state = "limited";
    }
    out.push({
      featureKey: modKey,
      label: labelOf(modKey),
      state,
      children: childStates,
    });
  }
  return out;
}

routerInternal.get(
  "/users/:userId/access-profile",
  requireAuth,
  requireFirmUser,
  requirePartner,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
    const r = rdb(req);
    const params = GetUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [userRow] = await r
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, params.data.userId));
    if (!userRow || userRow.firmId !== req.firmId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const [role] = userRow.roleId
      ? await r
          .select({ id: rolesTable.id, name: rolesTable.name })
          .from(rolesTable)
          .where(and(eq(rolesTable.id, userRow.roleId), eq(rolesTable.firmId, req.firmId!)))
          .limit(1)
      : [];
    // Gather all keys needed for UI view
    const explicitKeys = new Set<string>();
    for (const modKey of MODULE_ORDER) {
      if (!isFeatureRegistered(modKey)) continue;
      explicitKeys.add(modKey);
      const def = getFeatureDefinition(modKey);
      if (def && (def as any).children && Array.isArray((def as any).children)) {
        for (const k of (def as any).children) if (typeof k === "string") explicitKeys.add(k);
      } else {
        const prefix = modKey.replace(/^module\./, "") + ".";
        for (const k of Array.from(FEATURE_REGISTRY_MAP.keys())) {
          if (k.startsWith(prefix)) explicitKeys.add(k);
        }
      }
    }
    const allKeys = Array.from(explicitKeys);
    const effective = await resolveUserFeatureAccessBulk({
      r,
      firmId: req.firmId!,
      userId: userRow.id,
      roleId: userRow.roleId ?? null,
      roleName: role?.name ?? null,
      featureKeys: allKeys,
    });
    const explicitRows = await r
      .select({
        featureKey: firmUserFeatureAccessTable.featureKey,
        isEnabled: firmUserFeatureAccessTable.isEnabled,
      })
      .from(firmUserFeatureAccessTable)
      .where(
        and(
          eq(firmUserFeatureAccessTable.firmId, req.firmId!),
          eq(firmUserFeatureAccessTable.userId, userRow.id),
        ),
      );
    const explicit = new Map<string, boolean>();
    for (const row of explicitRows) explicit.set(row.featureKey, row.isEnabled);
    const user = await enrichUser(r, req.firmId!, userRow as UserRow);
    res.json({
      user,
      modules: buildModulesView(effective, explicit),
      advanced: {
        allKeys,
      },
    });
  },
);

routerInternal.put(
  "/users/:userId/access-profile",
  requireAuth,
  requireFirmUser,
  requirePartner,
  async (req: AuthRequestLike, res: RouteResLike): Promise<void> => {
    const r = rdb(req);
    const params = GetUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
    if (!body) {
      res.status(400).json({ error: "Request body missing" });
      return;
    }
    const [userRow] = await r
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, params.data.userId));
    if (!userRow || userRow.firmId !== req.firmId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const features =
      body.features && typeof body.features === "object" && !Array.isArray(body.features)
        ? (body.features as Record<string, unknown>)
        : null;
    if (!features) {
      res.status(400).json({ error: "features object required" });
      return;
    }
    const featureEntries: Array<[string, boolean]> = [];
    for (const [k, v] of Object.entries(features)) {
      if (typeof v !== "boolean") {
        res.status(400).json({ error: `Invalid value for ${k}: expected boolean` });
        return;
      }
      if (!isFeatureRegistered(k)) continue;
      featureEntries.push([k, v]);
    }

    try {
      const result = await (r as any).transaction(async (tx: DbConn) => {
        // (A) Basic user fields if caller wants to save name/initials/status/role/developerId in same PUT (§23)
        const basicUpdate: Record<string, unknown> = {};
        if (typeof body.name === "string") basicUpdate.name = body.name;
        if (Object.prototype.hasOwnProperty.call(body, "initials")) {
          basicUpdate.initials =
            typeof body.initials === "string" && body.initials.trim() ? body.initials.trim() : null;
        }
        if (typeof body.status === "string") basicUpdate.status = body.status;
        if (typeof body.roleId === "number") basicUpdate.roleId = body.roleId;
        if (Object.prototype.hasOwnProperty.call(body, "developerId")) {
          const did = Number(body.developerId);
          basicUpdate.developerId = Number.isInteger(did) && did > 0 ? did : null;
        }
        let newRoleId = userRow.roleId;
        if (Object.keys(basicUpdate).length) {
          const [up] = await tx
            .update(usersTable)
            .set(basicUpdate)
            .where(eq(usersTable.id, userRow.id))
            .returning();
          if (up?.roleId !== undefined) newRoleId = up.roleId;
        }
        // (B) Upsert feature access rows one TX
        if (featureEntries.length) {
          for (const [featureKey, isEnabled] of featureEntries) {
            await tx.execute(sql`
              INSERT INTO firm_user_feature_access (firm_id, user_id, feature_key, is_enabled, updated_by_user_id, created_at, updated_at)
              VALUES (${req.firmId!}, ${userRow.id}, ${featureKey}, ${isEnabled}, ${req.userId ?? null}, NOW(), NOW())
              ON CONFLICT (firm_id, user_id, feature_key)
              DO UPDATE SET is_enabled = EXCLUDED.is_enabled,
                            updated_by_user_id = EXCLUDED.updated_by_user_id,
                            updated_at = NOW()
            `);
          }
        }
        // (C) Delete any explicit row where caller sent no feature key AND row existed
        // (optional cleanup if user wants to reset; otherwise keep explicit rows.)
        if (Array.isArray(body.resetFeatureKeys)) {
          const reset = (body.resetFeatureKeys as unknown[]).filter((x): x is string => typeof x === "string");
          if (reset.length) {
            await tx
              .delete(firmUserFeatureAccessTable)
              .where(
                and(
                  eq(firmUserFeatureAccessTable.firmId, req.firmId!),
                  eq(firmUserFeatureAccessTable.userId, userRow.id),
                  inArray(firmUserFeatureAccessTable.featureKey, reset),
                ),
              );
          }
        }
        if (typeof newRoleId === "number") {
          await ensureRolePermissionsInitialized(tx as any, req.firmId!, newRoleId);
        }
        const [refreshed] = await tx.select().from(usersTable).where(eq(usersTable.id, userRow.id));
        return refreshed;
      });

      invalidateUserFeatureCacheFor(req.firmId!, userRow.id);
      await writeAuditLog({
        firmId: req.firmId,
        actorId: req.userId,
        actorType: req.userType,
        action: "users.access_profile.update",
        entityType: "user",
        entityId: userRow.id,
        detail: `features=${featureEntries.length}; ` +
          featureEntries.slice(0, 20).map(([k, v]) => `${k}=${v}`).join(",") +
          (featureEntries.length > 20 ? `...+${featureEntries.length - 20}` : ""),
        ipAddress: req.ip,
        userAgent: getHeader(req, "user-agent"),
      });
      res.json({
        ok: true,
        user: result ? await enrichUser(r, req.firmId!, result as UserRow) : undefined,
      });
    } catch (err) {
      logger.error(
        {
          err,
          userId: params.data.userId,
          firmId: req.firmId ?? null,
          actorId: req.userId ?? null,
        },
        "users.access_profile.update_failed",
      );
      res.status(500).json({ error: "Failed to save access profile" });
    }
  },
);

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
