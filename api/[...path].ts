import express, { type RequestHandler } from "express";
import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";
import { and, count, desc, eq, ilike } from "drizzle-orm";
import {
  clearTenantContext,
  db,
  firmsTable,
  makeRlsDb,
  permissionsTable,
  pool,
  rolesTable,
  sessionsTable,
  setFounderContextSession,
  setTenantContextSession,
  sql,
  usersTable,
} from "@workspace/db";
import {
  CreateFirmBody,
  CreateUserBody,
  GetFirmParams,
  GetUserParams,
  ListFirmsQueryParams,
  ListUsersQueryParams,
  LoginBody,
  UpdateFirmBody,
  UpdateFirmParams,
  UpdateUserBody,
  UpdateUserParams,
} from "@workspace/api-zod";
import type { ApiRequest, ApiResponse } from "./_lib";
import {
  clearAuthCookie,
  FOUNDER_EMAIL,
  getBearerToken,
  getIp,
  getUrl,
  parseCookies,
  randomTokenHex,
  sendEmpty,
  sendJson,
  setAuthCookie,
  setCors,
  sha256Hex,
  stripApiPrefix,
  writeAuditLog,
  readJsonBody,
} from "./_lib";
import apiServerApp from "../artifacts/api-server/src/app";
import type { IncomingMessage, ServerResponse } from "node:http";

type AuthContext = {
  userId: number;
  email: string;
  userType: string;
  firmId: number | null;
  roleId: number | null;
};

type DbConn = typeof db;

async function getAuthFromRequest(req: ApiRequest): Promise<
  | { ok: true; token: string; tokenFromCookie: boolean; sessionId: number; auth: AuthContext }
  | { ok: false; status: 401 | 503; code: "NO_TOKEN" | "INVALID_SESSION" | "EXPIRED" | "INACTIVE" | "DB" }
> {
  const cookies = parseCookies(req);
  const cookieToken = cookies["auth_token"];
  const headerToken = getBearerToken(req);
  const token = cookieToken || headerToken;
  if (!token) return { ok: false, status: 401, code: "NO_TOKEN" };

  const tokenHash = sha256Hex(token);
  try {
    const [s] = await db.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash)).limit(1);
    if (!s) return { ok: false, status: 401, code: "INVALID_SESSION" };
    if (s.expiresAt < new Date()) return { ok: false, status: 401, code: "EXPIRED" };

    const [u] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        userType: usersTable.userType,
        firmId: usersTable.firmId,
        roleId: usersTable.roleId,
        status: usersTable.status,
      })
      .from(usersTable)
      .where(eq(usersTable.id, s.userId))
      .limit(1);
    if (!u || u.status !== "active") return { ok: false, status: 401, code: "INACTIVE" };

    return {
      ok: true,
      token,
      tokenFromCookie: Boolean(cookieToken),
      sessionId: s.id,
      auth: { userId: u.id, email: String(u.email), userType: String(u.userType), firmId: u.firmId ?? null, roleId: u.roleId ?? null },
    };
  } catch {
    return { ok: false, status: 503, code: "DB" };
  }
}

async function withFirmDb<T>(firmId: number, userId: number, fn: (r: DbConn) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await setTenantContextSession(client, firmId, userId);
    const rlsDb = makeRlsDb(client);
    return await fn(rlsDb as unknown as DbConn);
  } catch (err) {
    destroyClient = true;
    throw err;
  } finally {
    try {
      await clearTenantContext(client);
    } catch {
    }
    client.release(destroyClient);
  }
}

async function withFounderDb<T>(fn: (r: DbConn) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await setFounderContextSession(client);
    const rlsDb = makeRlsDb(client);
    return await fn(rlsDb as unknown as DbConn);
  } catch (err) {
    destroyClient = true;
    throw err;
  } finally {
    try {
      await clearTenantContext(client);
    } catch {
    }
    client.release(destroyClient);
  }
}

async function requireFounder(auth: AuthContext, req: ApiRequest, res: ApiResponse): Promise<boolean> {
  if (auth.userType !== "founder") {
    await writeAuditLog({
      firmId: null,
      actorId: auth.userId,
      actorType: auth.userType,
      action: "auth.forbidden.founder_required",
      detail: `${req.method} ${stripApiPrefix(getUrl(req).pathname)}`,
      ipAddress: getIp(req),
      userAgent: req.headers["user-agent"],
    });
    sendJson(res, 403, { error: "Founder access required" });
    return false;
  }
  const email = auth.email.trim().toLowerCase();
  if (email !== FOUNDER_EMAIL) {
    await writeAuditLog({
      firmId: null,
      actorId: auth.userId,
      actorType: auth.userType,
      action: "auth.forbidden.founder_email_mismatch",
      detail: `${req.method} ${stripApiPrefix(getUrl(req).pathname)}`,
      ipAddress: getIp(req),
      userAgent: req.headers["user-agent"],
    });
    sendJson(res, 403, { error: "Founder access required" });
    return false;
  }
  return true;
}

async function withFirmPermission<T>(
  auth: AuthContext,
  req: ApiRequest,
  res: ApiResponse,
  moduleName: string,
  action: string,
  fn: (rlsDb: DbConn) => Promise<T>,
): Promise<T | null> {
  if (auth.userType !== "firm_user" || !auth.firmId || !auth.roleId) {
    await writeAuditLog({
      firmId: auth.firmId ?? null,
      actorId: auth.userId,
      actorType: auth.userType,
      action: "auth.forbidden.permission",
      detail: `${moduleName}:${action} ${req.method} ${stripApiPrefix(getUrl(req).pathname)}`,
      ipAddress: getIp(req),
      userAgent: req.headers["user-agent"],
    });
    sendJson(res, 403, { error: "Permission denied" });
    return null;
  }

  return await withFirmDb(auth.firmId, auth.userId, async (rlsDb) => {
    const [role] = await rlsDb
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.id, auth.roleId!), eq(rolesTable.firmId, auth.firmId!)))
      .limit(1);
    if (!role) {
      await writeAuditLog({
        firmId: auth.firmId,
        actorId: auth.userId,
        actorType: auth.userType,
        action: "auth.forbidden.permission",
        detail: `${moduleName}:${action} ${req.method} ${stripApiPrefix(getUrl(req).pathname)} reason=role_not_found`,
        ipAddress: getIp(req),
        userAgent: req.headers["user-agent"],
      });
      sendJson(res, 403, { error: "Permission denied" });
      return null;
    }

    let [perm] = await rlsDb
      .select()
      .from(permissionsTable)
      .where(and(
        eq(permissionsTable.roleId, auth.roleId!),
        eq(permissionsTable.module, moduleName),
        eq(permissionsTable.action, action),
      ))
      .limit(1);

    if (!perm && role.isSystemRole && (role.name === "Partner" || role.name === "Clerk")) {
      const roleName = role.name as "Partner" | "Clerk";
      if (roleName === "Partner") {
        await rlsDb.execute(sql`
          INSERT INTO permissions (role_id, module, action, allowed)
          SELECT ${auth.roleId!}, v.module, v.action, TRUE
          FROM (
            VALUES
              ('dashboard','read'),
              ('cases','read'),('cases','create'),('cases','update'),('cases','delete'),
              ('projects','read'),('projects','create'),('projects','update'),('projects','delete'),
              ('developers','read'),('developers','create'),('developers','update'),('developers','delete'),
              ('documents','read'),('documents','create'),('documents','update'),('documents','delete'),('documents','generate'),('documents','export'),
              ('communications','read'),('communications','create'),('communications','update'),('communications','delete'),
              ('accounting','read'),('accounting','write'),
              ('reports','read'),('reports','export'),
              ('audit','read'),
              ('settings','read'),('settings','update'),
              ('users','read'),('users','create'),('users','update'),('users','delete'),
              ('roles','read'),('roles','create'),('roles','update'),('roles','delete')
          ) AS v(module, action)
          WHERE NOT EXISTS (
            SELECT 1 FROM permissions p
            WHERE p.role_id = ${auth.roleId!} AND p.module = v.module AND p.action = v.action
          )
        `);
      } else {
        await rlsDb.execute(sql`
          INSERT INTO permissions (role_id, module, action, allowed)
          SELECT ${auth.roleId!}, v.module, v.action, TRUE
          FROM (
            VALUES
              ('dashboard','read'),
              ('cases','read'),('cases','create'),('cases','update'),
              ('projects','read'),('projects','create'),('projects','update'),
              ('developers','read'),('developers','create'),('developers','update'),
              ('documents','read'),('documents','export'),
              ('communications','read'),('communications','create'),
              ('accounting','read'),
              ('reports','read'),
              ('settings','read'),
              ('users','read')
          ) AS v(module, action)
          WHERE NOT EXISTS (
            SELECT 1 FROM permissions p
            WHERE p.role_id = ${auth.roleId!} AND p.module = v.module AND p.action = v.action
          )
        `);
      }
      [perm] = await rlsDb
        .select()
        .from(permissionsTable)
        .where(and(
          eq(permissionsTable.roleId, auth.roleId!),
          eq(permissionsTable.module, moduleName),
          eq(permissionsTable.action, action),
        ))
        .limit(1);
    }

    if (!perm || !perm.allowed) {
      await writeAuditLog({
        firmId: auth.firmId,
        actorId: auth.userId,
        actorType: auth.userType,
        action: "auth.forbidden.permission",
        detail: `${moduleName}:${action} ${req.method} ${stripApiPrefix(getUrl(req).pathname)}`,
        ipAddress: getIp(req),
        userAgent: req.headers["user-agent"],
      });
      sendJson(res, 403, { error: "Permission denied", code: "PERMISSION_DENIED" });
      return null;
    }

    return await fn(rlsDb as unknown as DbConn);
  });
}

type PgError = { code?: string; constraint?: string; detail?: string; message?: string };
function isPgError(err: unknown): err is PgError {
  return typeof err === "object" && err !== null && ("code" in err || "constraint" in err || "detail" in err);
}

function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) {
    const row = result[0];
    return row && typeof row === "object" ? (row as Record<string, unknown>) : undefined;
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      const row = rows[0];
      return row && typeof row === "object" ? (row as Record<string, unknown>) : undefined;
    }
  }
  return undefined;
}

async function handleAuthLogin(req: ApiRequest, res: ApiResponse): Promise<void> {
  const ip = getIp(req);
  const ua = req.headers["user-agent"];
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid body" });
    return;
  }

  const parsed = LoginBody.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: parsed.error.message });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const password = parsed.data.password;

  try {
    const [user] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        passwordHash: usersTable.passwordHash,
        userType: usersTable.userType,
        firmId: usersTable.firmId,
        roleId: usersTable.roleId,
        department: usersTable.department,
        status: usersTable.status,
        totpEnabled: usersTable.totpEnabled,
        totpSecret: usersTable.totpSecret,
      })
      .from(usersTable)
      .where(eq(sql`lower(trim(${usersTable.email}))`, email))
      .limit(1);

    if (!user || user.status !== "active") {
      await writeAuditLog({ action: "auth.login_failed", detail: "reason=not_found_or_inactive", ipAddress: ip, userAgent: ua });
      sendJson(res, 401, { error: "Invalid email or password" });
      return;
    }

    if (user.userType === "founder" && email !== FOUNDER_EMAIL) {
      await writeAuditLog({ action: "auth.login_failed", actorId: user.id, actorType: "founder", detail: "reason=founder_email_mismatch", ipAddress: ip, userAgent: ua });
      sendJson(res, 403, { error: "Founder access required" });
      return;
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      await writeAuditLog({ firmId: user.firmId ?? null, actorId: user.id, actorType: user.userType, action: "auth.login_failed", detail: "reason=bad_password", ipAddress: ip, userAgent: ua });
      sendJson(res, 401, { error: "Invalid email or password" });
      return;
    }

    const maybeTotpCode = typeof (body as any)?.totpCode === "string" ? String((body as any).totpCode).trim() : "";
    if (user.totpEnabled) {
      if (!user.totpSecret) {
        sendJson(res, 503, { error: "TOTP temporarily unavailable" });
        return;
      }
      if (!maybeTotpCode) {
        sendJson(res, 401, { error: "TOTP code required", code: "TOTP_REQUIRED" });
        return;
      }
      const totp = new OTPAuth.TOTP({ issuer: "Lawcaspro", label: user.email, algorithm: "SHA1", digits: 6, period: 30, secret: user.totpSecret });
      const delta = totp.validate({ token: maybeTotpCode, window: 1 });
      if (delta === null) {
        sendJson(res, 401, { error: "Invalid TOTP code", code: "TOTP_INVALID" });
        return;
      }
    }

    const token = randomTokenHex(32);
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(sessionsTable).values({
      userId: user.id,
      tokenHash,
      expiresAt,
      userAgent: ua ? String(ua) : null,
      ipAddress: ip ?? null,
    });

    setAuthCookie(res, token);

    const [role] = user.roleId
      ? await db.select({ name: rolesTable.name }).from(rolesTable).where(eq(rolesTable.id, user.roleId)).limit(1)
      : [undefined];
    const [firm] = user.firmId
      ? await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, user.firmId)).limit(1)
      : [undefined];

    await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
    await writeAuditLog({ firmId: user.firmId ?? null, actorId: user.id, actorType: user.userType, action: "auth.login_success", ipAddress: ip, userAgent: ua });

    sendJson(res, 200, {
      token,
      id: user.id,
      email: user.email,
      name: user.name,
      userType: user.userType,
      firmId: user.firmId,
      firmName: firm?.name ?? null,
      roleId: user.roleId,
      roleName: role?.name ?? null,
      department: user.department ?? null,
      status: user.status,
      totpEnabled: user.totpEnabled,
    });
  } catch (err) {
    sendJson(res, 503, { error: "Login temporarily unavailable" });
  }
}

async function handleAuthMe(req: ApiRequest, res: ApiResponse): Promise<void> {
  const authResult = await getAuthFromRequest(req);
  if (!authResult.ok) {
    if (authResult.code === "NO_TOKEN") {
      sendEmpty(res, 204);
      return;
    }
    if (authResult.code === "INVALID_SESSION" || authResult.code === "EXPIRED" || authResult.code === "INACTIVE") {
      clearAuthCookie(res);
      sendEmpty(res, 204);
      return;
    }
    sendJson(res, authResult.status, { error: "Auth temporarily unavailable" });
    return;
  }

  const user = authResult.auth;

  const [full] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      userType: usersTable.userType,
      firmId: usersTable.firmId,
      roleId: usersTable.roleId,
      department: usersTable.department,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(eq(usersTable.id, user.userId))
    .limit(1);

  if (!full || full.status !== "active") {
    if (authResult.tokenFromCookie) clearAuthCookie(res);
    sendEmpty(res, 204);
    return;
  }

  const [role] = full.roleId
    ? await db.select({ name: rolesTable.name }).from(rolesTable).where(eq(rolesTable.id, full.roleId)).limit(1)
    : [undefined];
  const [firm] = full.firmId
    ? await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, full.firmId)).limit(1)
    : [undefined];

  sendJson(res, 200, {
    id: full.id,
    email: full.email,
    name: full.name,
    userType: full.userType,
    firmId: full.firmId,
    firmName: firm?.name ?? null,
    roleId: full.roleId,
    roleName: role?.name ?? null,
    department: full.department ?? null,
    status: full.status,
  });
}

async function handleAuthLogout(req: ApiRequest, res: ApiResponse): Promise<void> {
  const authResult = await getAuthFromRequest(req);
  const ip = getIp(req);
  const ua = req.headers["user-agent"];

  if (!authResult.ok) {
    clearAuthCookie(res);
    sendJson(res, 200, { success: true });
    return;
  }

  try {
    await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, sha256Hex(authResult.token)));
  } catch {
  }
  await writeAuditLog({ firmId: authResult.auth.firmId, actorId: authResult.auth.userId, actorType: authResult.auth.userType, action: "auth.logout", ipAddress: ip, userAgent: ua });
  clearAuthCookie(res);
  sendJson(res, 200, { success: true });
}

async function handleHealthz(_req: ApiRequest, res: ApiResponse): Promise<void> {
  sendJson(res, 200, { status: "ok" });
}

async function handleHealthzDb(_req: ApiRequest, res: ApiResponse): Promise<void> {
  try {
    await pool.query("select 1 as ok");
    sendJson(res, 200, { status: "ok", db: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "DB connection failed";
    sendJson(res, 500, { status: "error", db: "error", error: message });
  }
}

async function handleHealthzVersion(_req: ApiRequest, res: ApiResponse): Promise<void> {
  const commit =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.COMMIT_SHA ??
    null;
  sendJson(res, 200, { status: "ok", commit });
}

async function handlePlatformFirmsList(req: ApiRequest, res: ApiResponse, auth: AuthContext): Promise<void> {
  if (!(await requireFounder(auth, req, res))) return;
  const url = getUrl(req);
  const qp: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) qp[k] = v;
  const params = ListFirmsQueryParams.safeParse(qp);
  const search = params.success ? params.data.search : undefined;
  const status = params.success ? params.data.status : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  try {
    const firms = await db
      .select()
      .from(firmsTable)
      .where(and(
        ...(search ? [ilike(firmsTable.name, `%${search}%`)] : []),
        ...(status ? [eq(firmsTable.status, status)] : []),
      ))
      .orderBy(desc(firmsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [totalRes] = await db
      .select({ c: count() })
      .from(firmsTable)
      .where(and(
        ...(search ? [ilike(firmsTable.name, `%${search}%`)] : []),
        ...(status ? [eq(firmsTable.status, status)] : []),
      ))
      .limit(1);

    const enriched = await Promise.all(
      firms.map(async (firm) => {
        const [userCountRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.firmId, firm.id));
        const [partnerCountRes] = await db.select({ c: count() }).from(usersTable).where(sql`firm_id = ${firm.id} AND user_type = 'firm_user'`);
        const docRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_documents WHERE firm_id = ${firm.id}`);
        const docC = firstRow(docRes)?.c;
        const docCount = typeof docC === "string" || typeof docC === "number" ? Number(docC) : 0;
        return {
          ...firm,
          userCount: Number(userCountRes?.c ?? 0),
          partnerCount: Number(partnerCountRes?.c ?? 0),
          document_count: docCount,
        };
      }),
    );

    sendJson(res, 200, { data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
  } catch {
    sendJson(res, 503, { error: "Platform list firms temporarily unavailable" });
  }
}

function mapCreateFirmError(err: unknown): { status: number; body: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  const pg = isPgError(err) ? err : undefined;
  const code = pg?.code;
  const constraint = pg?.constraint;

  if (code === "23505") {
    if (constraint === "users_email_key") return { status: 409, body: { error: "Partner email already exists", code: "DUPLICATE_EMAIL" } };
    if (constraint === "firms_slug_key") return { status: 409, body: { error: "Workspace slug already taken", code: "DUPLICATE_SLUG" } };
    return { status: 409, body: { error: "Duplicate value", code: "DUPLICATE" } };
  }
  if (code === "23502") return { status: 400, body: { error: "Missing required field", code: "NOT_NULL" } };
  if (code === "23503") return { status: 400, body: { error: "Invalid reference", code: "FK" } };
  if (code === "42501" && message.toLowerCase().includes("row-level security")) return { status: 500, body: { error: "Database permission denied (RLS)", code: "RLS_DENIED" } };
  if (code === "42501" || message.toLowerCase().includes("permission denied")) return { status: 500, body: { error: "Database permission denied", code: "DB_PERMISSION" } };
  return { status: 500, body: { error: "Failed to create firm", code: "INTERNAL_ERROR" } };
}

async function handlePlatformFirmsCreate(req: ApiRequest, res: ApiResponse, auth: AuthContext): Promise<void> {
  if (!(await requireFounder(auth, req, res))) return;
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid body" });
    return;
  }
  const parsed = CreateFirmBody.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: parsed.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const { name, slug, subscriptionPlan, partnerName, partnerEmail, partnerPassword } = parsed.data;
  const slugNormalized = slug.trim();
  const emailNormalized = partnerEmail.trim().toLowerCase();
  const nameNormalized = name.trim();
  const partnerNameNormalized = partnerName.trim();

  const ip = getIp(req);
  const ua = req.headers["user-agent"];

  try {
    const result = await withFounderDb(async (authDb) => {
      const [existingFirm] = await authDb.select({ id: firmsTable.id }).from(firmsTable).where(eq(firmsTable.slug, slugNormalized)).limit(1);
      if (existingFirm) return { ok: false as const, status: 409, body: { error: "Workspace slug already taken", code: "DUPLICATE_SLUG" } };

      const [existingUser] = await authDb.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, emailNormalized)).limit(1);
      if (existingUser) return { ok: false as const, status: 409, body: { error: "Partner email already exists", code: "DUPLICATE_EMAIL" } };

      const passwordHash = await bcrypt.hash(partnerPassword, 10);
      const created = await (authDb as any).transaction(async (tx: DbConn) => {
        const [firm] = await tx.insert(firmsTable).values({ name: nameNormalized, slug: slugNormalized, subscriptionPlan: subscriptionPlan ?? "starter", status: "active" }).returning();
        const [partnerRole] = await tx.insert(rolesTable).values({ firmId: firm.id, name: "Partner", isSystemRole: true }).returning();
        await tx.insert(usersTable).values({
          firmId: firm.id,
          email: emailNormalized,
          name: partnerNameNormalized,
          passwordHash,
          userType: "firm_user",
          roleId: partnerRole.id,
          status: "active",
        });
        await writeAuditLog(
          { firmId: null, actorId: auth.userId, actorType: auth.userType, action: "platform.firm.create", entityType: "firm", entityId: firm.id, detail: `slug=${firm.slug} partnerEmail=${emailNormalized}`, ipAddress: ip, userAgent: ua },
          { db: tx as any, strict: true },
        );
        return firm;
      });

      return { ok: true as const, status: 201, firm: created };
    });

    if (!result.ok) {
      sendJson(res, result.status, result.body);
      return;
    }

    sendJson(res, 201, result.firm);
  } catch (err) {
    const mapped = mapCreateFirmError(err);
    sendJson(res, mapped.status, mapped.body);
  }
}

async function handlePlatformFirmGet(req: ApiRequest, res: ApiResponse, auth: AuthContext, firmId: number): Promise<void> {
  if (!(await requireFounder(auth, req, res))) return;
  const params = GetFirmParams.safeParse({ firmId });
  if (!params.success) {
    sendJson(res, 400, { error: params.error.message });
    return;
  }
  try {
    const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, firmId)).limit(1);
    if (!firm) {
      sendJson(res, 404, { error: "Not Found", code: "NOT_FOUND" });
      return;
    }
    sendJson(res, 200, firm);
  } catch {
    sendJson(res, 503, { error: "Platform get firm temporarily unavailable" });
  }
}

async function handlePlatformFirmUpdate(req: ApiRequest, res: ApiResponse, auth: AuthContext, firmId: number): Promise<void> {
  if (!(await requireFounder(auth, req, res))) return;
  const params = UpdateFirmParams.safeParse({ firmId });
  if (!params.success) {
    sendJson(res, 400, { error: params.error.message });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid body" });
    return;
  }
  const parsed = UpdateFirmBody.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: parsed.error.message });
    return;
  }

  try {
    const result = await withFounderDb(async (authDb) => {
      const [before] = await authDb.select().from(firmsTable).where(eq(firmsTable.id, firmId)).limit(1);
      if (!before) return { kind: "not_found" as const };
      const [firm] = await authDb.update(firmsTable).set(parsed.data as any).where(eq(firmsTable.id, firmId)).returning();
      if (!firm) return { kind: "not_found" as const };
      await writeAuditLog(
        { firmId: null, actorId: auth.userId, actorType: auth.userType, action: "platform.firm.update", entityType: "firm", entityId: firmId, detail: `from=${before.status} to=${firm.status}`, ipAddress: getIp(req), userAgent: req.headers["user-agent"] },
        { db: authDb as any },
      );
      return { kind: "ok" as const, firm };
    });

    if (result.kind === "not_found") {
      sendJson(res, 404, { error: "Not Found", code: "NOT_FOUND" });
      return;
    }
    sendJson(res, 200, result.firm);
  } catch {
    sendJson(res, 503, { error: "Platform update firm temporarily unavailable" });
  }
}

async function handlePlatformStats(req: ApiRequest, res: ApiResponse, auth: AuthContext): Promise<void> {
  if (!(await requireFounder(auth, req, res))) return;
  try {
    const [totalFirmsRes] = await db.select({ c: count() }).from(firmsTable);
    const [activeFirmsRes] = await db.select({ c: count() }).from(firmsTable).where(eq(firmsTable.status, "active"));
    const [totalUsersRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.userType, "firm_user"));
    const docsRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_documents`);
    const docsC = firstRow(docsRes)?.c;
    const totalDocuments = typeof docsC === "string" || typeof docsC === "number" ? Number(docsC) : 0;
    sendJson(res, 200, { totalFirms: Number(totalFirmsRes?.c ?? 0), activeFirms: Number(activeFirmsRes?.c ?? 0), totalUsers: Number(totalUsersRes?.c ?? 0), totalDocuments });
  } catch {
    sendJson(res, 503, { error: "Platform stats temporarily unavailable" });
  }
}

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

async function enrichUser(r: DbConn, firmId: number, user: any) {
  let roleName: string | null = null;
  if (user.roleId) {
    const [role] = await r.select({ name: rolesTable.name }).from(rolesTable).where(and(eq(rolesTable.id, user.roleId), eq(rolesTable.firmId, firmId))).limit(1);
    roleName = role?.name ?? null;
  }
  return {
    id: user.id,
    firmId: user.firmId,
    email: user.email,
    name: user.name,
    roleId: user.roleId ?? null,
    roleName,
    department: user.department ?? null,
    status: user.status,
    lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
  };
}

async function handleUsersList(req: ApiRequest, res: ApiResponse, auth: AuthContext): Promise<void> {
  await withFirmPermission(auth, req, res, "users", "read", async (r) => {
    const url = getUrl(req);
    const qp: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) qp[k] = v;
    const params = ListUsersQueryParams.safeParse(qp);
    const search = params.success ? params.data.search : undefined;
    const roleId = params.success ? params.data.roleId : undefined;
    const status = params.success ? params.data.status : undefined;
    const page = params.success ? (params.data.page ?? 1) : 1;
    const limit = params.success ? (params.data.limit ?? 20) : 20;
    const offset = (page - 1) * limit;

    const hasDepartment = await usersDepartmentExists(r);
    const where = [
      eq(usersTable.firmId, auth.firmId!),
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
      status: usersTable.status,
      lastLoginAt: usersTable.lastLoginAt,
      createdAt: usersTable.createdAt,
    };

    const users = hasDepartment
      ? await r.select({ ...baseSelect, department: usersTable.department }).from(usersTable).where(and(...where)).orderBy(desc(usersTable.createdAt)).limit(limit).offset(offset)
      : await r.select(baseSelect).from(usersTable).where(and(...where)).orderBy(desc(usersTable.createdAt)).limit(limit).offset(offset);

    const [totalRes] = await r.select({ c: count() }).from(usersTable).where(and(...where)).limit(1);
    const enriched = await Promise.all(users.map((u) => enrichUser(r, auth.firmId!, u)));
    sendJson(res, 200, { data: enriched, total: Number(totalRes?.c ?? 0), page, limit });
  });
}

async function handleUsersCreate(req: ApiRequest, res: ApiResponse, auth: AuthContext): Promise<void> {
  await withFirmPermission(auth, req, res, "users", "create", async (r) => {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid body" });
      return;
    }
    const parsed = CreateUserBody.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.message });
      return;
    }

    const { email, name, password, roleId, department, barCouncilNo, nricNo } = parsed.data as any;
    const normalizedEmail = String(email).toLowerCase();

    await writeAuditLog({ firmId: auth.firmId, actorId: auth.userId, actorType: auth.userType, action: "users.create.attempt", detail: stripApiPrefix(getUrl(req).pathname), ipAddress: getIp(req), userAgent: req.headers["user-agent"] });

    const [row] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
    if (row) {
      sendJson(res, 400, { error: "Email already in use" });
      return;
    }

    try {
      const passwordHash = await bcrypt.hash(String(password), 10);
      const created = await (r as any).transaction(async (tx: DbConn) => {
        const [role] = await tx.select({ id: rolesTable.id, name: rolesTable.name }).from(rolesTable).where(and(eq(rolesTable.id, roleId), eq(rolesTable.firmId, auth.firmId!))).limit(1);
        if (!role) return { kind: "bad_role" as const };

        const hasDepartment = await usersDepartmentExists(tx);
        const hasBarCouncilNo = await usersBarCouncilNoExists(tx);
        const hasNricNo = await usersNricNoExists(tx);

        const legalRoleNames = new Set(["Lawyer", "Senior Lawyer", "Partner"]);
        const isLegalRole = legalRoleNames.has(role.name);
        if (hasBarCouncilNo && isLegalRole && !String(barCouncilNo ?? "").trim()) {
          return { kind: "missing_bar_council" as const };
        }

        const values: typeof usersTable.$inferInsert = {
          firmId: auth.firmId!,
          email: normalizedEmail,
          name: String(name),
          passwordHash,
          roleId,
          userType: "firm_user",
          status: "active",
        };
        if (hasDepartment) values.department = department ?? null;
        if (hasBarCouncilNo) values.barCouncilNo = isLegalRole ? (String(barCouncilNo ?? "").trim() ? String(barCouncilNo).trim() : null) : null;
        if (hasNricNo) values.nricNo = String(nricNo ?? "").trim() ? String(nricNo).trim() : null;
        const [u] = await tx.insert(usersTable).values(values).returning();
        return { kind: "ok" as const, user: u };
      });

      if (created.kind === "bad_role") {
        sendJson(res, 400, { error: "Invalid roleId" });
        return;
      }
      if (created.kind === "missing_bar_council") {
        sendJson(res, 400, { error: "Bar Council No. is required for legal roles" });
        return;
      }
      await writeAuditLog({ firmId: auth.firmId, actorId: auth.userId, actorType: auth.userType, action: "users.create", entityType: "user", entityId: created.user.id, detail: `email=${created.user.email}`, ipAddress: getIp(req), userAgent: req.headers["user-agent"] });
      sendJson(res, 201, await enrichUser(r, auth.firmId!, created.user));
    } catch (err) {
      const code = isPgError(err) ? err.code : undefined;
      if (code === "23505") {
        sendJson(res, 400, { error: "Email already in use" });
        return;
      }
      sendJson(res, 503, { error: "Create user temporarily unavailable" });
    }
  });
}

async function handleUserGet(req: ApiRequest, res: ApiResponse, auth: AuthContext, userId: number): Promise<void> {
  await withFirmPermission(auth, req, res, "users", "read", async (r) => {
    const params = GetUserParams.safeParse({ userId });
    if (!params.success) {
      sendJson(res, 400, { error: params.error.message });
      return;
    }

    const hasDepartment = await usersDepartmentExists(r);
    const [u] = hasDepartment
      ? await r.select({ id: usersTable.id, firmId: usersTable.firmId, email: usersTable.email, name: usersTable.name, roleId: usersTable.roleId, department: usersTable.department, status: usersTable.status, lastLoginAt: usersTable.lastLoginAt, createdAt: usersTable.createdAt }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.firmId, auth.firmId!))).limit(1)
      : await r.select({ id: usersTable.id, firmId: usersTable.firmId, email: usersTable.email, name: usersTable.name, roleId: usersTable.roleId, status: usersTable.status, lastLoginAt: usersTable.lastLoginAt, createdAt: usersTable.createdAt }).from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.firmId, auth.firmId!))).limit(1);

    if (!u) {
      sendJson(res, 404, { error: "Not Found", code: "NOT_FOUND" });
      return;
    }
    sendJson(res, 200, await enrichUser(r, auth.firmId!, u));
  });
}

async function handleUserUpdate(req: ApiRequest, res: ApiResponse, auth: AuthContext, userId: number): Promise<void> {
  await withFirmPermission(auth, req, res, "users", "update", async (r) => {
    const params = UpdateUserParams.safeParse({ userId });
    if (!params.success) {
      sendJson(res, 400, { error: params.error.message });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid body" });
      return;
    }
    const parsed = UpdateUserBody.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.message });
      return;
    }

    try {
      const result = await (r as any).transaction(async (tx: DbConn) => {
        const [before] = await tx.select().from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.firmId, auth.firmId!))).limit(1);
        if (!before) return { kind: "not_found" as const };
        const updates: Record<string, unknown> = { ...parsed.data };
        if ((parsed.data as any).password) {
          updates.passwordHash = await bcrypt.hash(String((parsed.data as any).password), 10);
          delete updates.password;
        }
        const [u] = await tx.update(usersTable).set(updates as any).where(and(eq(usersTable.id, userId), eq(usersTable.firmId, auth.firmId!))).returning();
        if (!u) return { kind: "not_found" as const };
        return { kind: "ok" as const, user: u };
      });

      if (result.kind === "not_found") {
        sendJson(res, 404, { error: "Not Found", code: "NOT_FOUND" });
        return;
      }
      await writeAuditLog({ firmId: auth.firmId, actorId: auth.userId, actorType: auth.userType, action: "users.update", entityType: "user", entityId: userId, detail: null, ipAddress: getIp(req), userAgent: req.headers["user-agent"] });
      sendJson(res, 200, await enrichUser(r, auth.firmId!, result.user));
    } catch {
      sendJson(res, 503, { error: "Update user temporarily unavailable" });
    }
  });
}

async function handleUserDelete(req: ApiRequest, res: ApiResponse, auth: AuthContext, userId: number): Promise<void> {
  await withFirmPermission(auth, req, res, "users", "delete", async (r) => {
    try {
      const result = await (r as any).transaction(async (tx: DbConn) => {
        const [before] = await tx.select().from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.firmId, auth.firmId!))).limit(1);
        if (!before) return { kind: "not_found" as const };
        await tx.delete(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.firmId, auth.firmId!)));
        return { kind: "ok" as const, email: before.email };
      });

      if (result.kind === "not_found") {
        sendJson(res, 404, { error: "Not Found", code: "NOT_FOUND" });
        return;
      }
      await writeAuditLog({ firmId: auth.firmId, actorId: auth.userId, actorType: auth.userType, action: "users.delete", entityType: "user", entityId: userId, detail: `email=${result.email}`, ipAddress: getIp(req), userAgent: req.headers["user-agent"] });
      sendEmpty(res, 204);
    } catch {
      sendJson(res, 503, { error: "Delete user temporarily unavailable" });
    }
  });
}

const app = express();

const ensureApiPrefix: RequestHandler = (req, _res, next) => {
  const mutableReq = req as unknown as { url?: string };
  const rawUrl = mutableReq.url ?? "/";
  if (!rawUrl.startsWith("/api")) {
    mutableReq.url = rawUrl.startsWith("/") ? `/api${rawUrl}` : `/api/${rawUrl}`;
  }
  next();
};

app.use(ensureApiPrefix);
app.use(apiServerApp as unknown as RequestHandler);

type NodeServerlessHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

const invokeExpress = app as unknown as NodeServerlessHandler;

export default function handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> {
  return invokeExpress(req, res);
}
