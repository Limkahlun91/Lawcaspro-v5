import { Router, type IRouter } from "express";
import { Readable } from "stream";
import PizZip from "pizzip";
import { eq, ilike, count, desc, and, isNull, or } from "drizzle-orm";
import {
  db,
  firmsTable,
  usersTable,
  casesTable,
  rolesTable,
  systemFoldersTable,
  platformDocumentsTable,
  platformClausesTable,
  platformMessagesTable,
  platformMessageAttachmentsTable,
  sql,
  type SQL,
} from "@workspace/db";
import { CreateFirmBody, UpdateFirmBody, ListFirmsQueryParams, GetFirmParams, UpdateFirmParams } from "@workspace/api-zod";
import { requireAuth, requireFounder, writeAuditLog, type AuthRequest } from "../lib/auth";
import { withAuthSafeDb } from "../lib/auth-safe-db";
import { logger } from "../lib/logger";
import bcrypt from "bcryptjs";
import { ApiError, sendError, sendOk, parseIntParam } from "../lib/api-response";
import {
  ObjectNotFoundError,
  SupabaseStorageService,
  getSupabaseStorageConfigError,
} from "../lib/objectStorage";
import { assertActiveSupportSessionForFirm, assertFounderPermission, loadFounderGovernanceContext } from "../services/founder-governance";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const firstRow = (result: unknown): Record<string, unknown> | undefined => {
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
};

type PgError = {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
};

const isPgError = (err: unknown): err is PgError =>
  typeof err === "object" && err !== null && ("code" in err || "constraint" in err || "detail" in err);

function mapCreateFirmError(err: unknown): { status: number; body: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  const pg = isPgError(err) ? err : undefined;
  const code = pg?.code;
  const constraint = pg?.constraint;

  if (code === "23505") {
    if (constraint === "users_email_key") {
      return { status: 409, body: { error: "Partner email already exists", code: "DUPLICATE_EMAIL" } };
    }
    if (constraint === "firms_slug_key") {
      return { status: 409, body: { error: "Workspace slug already taken", code: "DUPLICATE_SLUG" } };
    }
    return { status: 409, body: { error: "Duplicate value", code: "DUPLICATE" } };
  }

  if (code === "23502") {
    return { status: 400, body: { error: "Missing required field", code: "NOT_NULL" } };
  }

  if (code === "23503") {
    return { status: 400, body: { error: "Invalid reference", code: "FK" } };
  }

  if (code === "42501" && message.toLowerCase().includes("row-level security")) {
    return { status: 500, body: { error: "Database permission denied (RLS)", code: "RLS_DENIED" } };
  }

  if (code === "42501" || message.toLowerCase().includes("permission denied")) {
    return { status: 500, body: { error: "Database permission denied", code: "DB_PERMISSION" } };
  }

  return { status: 500, body: { error: "Failed to create firm", code: "INTERNAL_ERROR" } };
}

const router: IRouter = Router();
const storage = new SupabaseStorageService();

class RouteTimeoutError extends Error {
  public readonly ms: number;
  public readonly label: string;
  constructor(label: string, ms: number) {
    super(`Route timed out: ${label} (${ms}ms)`);
    this.name = "RouteTimeoutError";
    this.ms = ms;
    this.label = label;
    Object.setPrototypeOf(this, RouteTimeoutError.prototype);
  }
}

const getRouteTimeoutMs = (): number => {
  const raw = process.env.API_ROUTE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 10_000;
};

const withTimeout = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const ms = getRouteTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RouteTimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

function scanClausePlaceholdersInDocx(bytes: Buffer): { hasClausesPlaceholder: boolean; clauseCodePlaceholders: string[] } {
  const zip = new PizZip(bytes);
  const xml = zip.file("word/document.xml")?.asText() ?? "";
  const hasClausesPlaceholder = /\{\{\s*clauses\s*\}\}/g.test(xml);
  const out: string[] = [];
  const re = /\{\{\s*(clause_[^{}\s]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const key = m[1] ? String(m[1]).trim() : "";
    if (!key.startsWith("clause_")) continue;
    const code = key.slice("clause_".length);
    if (code && !out.includes(code)) out.push(code);
  }
  return { hasClausesPlaceholder, clauseCodePlaceholders: out };
}

// ─── Firms ────────────────────────────────────────────────────────────────────

router.get("/platform/firms", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = ListFirmsQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const status = params.success ? params.data.status : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  let query = db.select().from(firmsTable);
  if (search) query = query.where(ilike(firmsTable.name, `%${search}%`)) as typeof query;
  if (status) query = query.where(eq(firmsTable.status, status)) as typeof query;

  const firms = await query.orderBy(desc(firmsTable.createdAt)).limit(limit).offset(offset);
  const totalResult = await db.select({ total: count() }).from(firmsTable);
  const total = totalResult[0]?.total ?? 0;

  const enriched = await Promise.all(
    firms.map(async (firm) => {
      const [userCountRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.firmId, firm.id));
      const [partnerCountRes] = await db.select({ c: count() }).from(usersTable).where(sql`firm_id = ${firm.id} AND user_type = 'firm_user'`);
      const [caseCountRes] = await db.select({ c: count() }).from(casesTable).where(eq(casesTable.firmId, firm.id));
      const docRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_documents WHERE firm_id = ${firm.id}`);
      const docC = firstRow(docRes)?.c;
      const docCount = typeof docC === "string" || typeof docC === "number" ? Number(docC) : 0;
      const billingRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_billing_entries WHERE firm_id = ${firm.id}`);
      const billingC = firstRow(billingRes)?.c;
      const billingCount = typeof billingC === "string" || typeof billingC === "number" ? Number(billingC) : 0;
      const commRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_communications WHERE firm_id = ${firm.id}`);
      const commC = firstRow(commRes)?.c;
      const commCount = typeof commC === "string" || typeof commC === "number" ? Number(commC) : 0;
      return {
        ...firm,
        userCount: Number(userCountRes?.c ?? 0),
        partnerCount: Number(partnerCountRes?.c ?? 0),
        caseCount: Number(caseCountRes?.c ?? 0),
        user_count: Number(userCountRes?.c ?? 0),
        case_count: Number(caseCountRes?.c ?? 0),
        document_count: docCount,
        billing_entry_count: billingCount,
        comm_count: commCount,
      };
    })
  );

  res.json({ data: enriched, total: Number(total), page, limit });
});

router.post("/platform/firms", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreateFirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
    return;
  }
  const { name, slug, subscriptionPlan, partnerName, partnerEmail, partnerPassword } = parsed.data;
  const slugNormalized = slug.trim();
  const emailNormalized = partnerEmail.trim().toLowerCase();
  const nameNormalized = name.trim();
  const partnerNameNormalized = partnerName.trim();

  try {
    const result = await withAuthSafeDb(async (authDb) => {
      const [existingFirm] = await authDb
        .select({ id: firmsTable.id })
        .from(firmsTable)
        .where(eq(firmsTable.slug, slugNormalized));
      if (existingFirm) {
        return { ok: false as const, status: 409, error: "Workspace slug already taken", code: "DUPLICATE_SLUG" };
      }

      const [existingUser] = await authDb
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, emailNormalized));
      if (existingUser) {
        return { ok: false as const, status: 409, error: "Partner email already exists", code: "DUPLICATE_EMAIL" };
      }

      const [firm] = await authDb
        .insert(firmsTable)
        .values({ name: nameNormalized, slug: slugNormalized, subscriptionPlan: subscriptionPlan ?? "starter", status: "active" })
        .returning();

      const [partnerRole] = await authDb
        .insert(rolesTable)
        .values({ firmId: firm.id, name: "Partner", isSystemRole: true })
        .returning();

      const passwordHash = await bcrypt.hash(partnerPassword, 10);
      await authDb.insert(usersTable).values({
        firmId: firm.id,
        email: emailNormalized,
        name: partnerNameNormalized,
        passwordHash,
        userType: "firm_user",
        roleId: partnerRole.id,
        status: "active",
      });

      await writeAuditLog(
        {
          firmId: null,
          actorId: req.userId,
          actorType: req.userType,
          action: "platform.firm.create",
          entityType: "firm",
          entityId: firm.id,
          detail: `slug=${firm.slug} partnerEmail=${emailNormalized}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb }
      );

      return { ok: true as const, firm };
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }

    res.status(201).json({ ...result.firm, userCount: 1, partnerCount: 1, caseCount: 0 });
  } catch (err) {
    logger.error({ err, userId: req.userId }, "platform.create_firm.error");
    const mapped = mapCreateFirmError(err);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/platform/firms/:firmId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = GetFirmParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, params.data.firmId));
  if (!firm) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }
  const [userCountRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.firmId, firm.id));
  const [caseCountRes] = await db.select({ c: count() }).from(casesTable).where(eq(casesTable.firmId, firm.id));
  res.json({ ...firm, userCount: Number(userCountRes?.c ?? 0), partnerCount: 0, caseCount: Number(caseCountRes?.c ?? 0) });
});

router.patch("/platform/firms/:firmId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const params = UpdateFirmParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateFirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.subscriptionPlan !== undefined) updates.subscriptionPlan = parsed.data.subscriptionPlan;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  const [firm] = await db.update(firmsTable).set(updates).where(eq(firmsTable.id, params.data.firmId)).returning();
  if (!firm) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }
  res.json({ ...firm, userCount: 0, partnerCount: 0, caseCount: 0 });
});

// ─── Firm Users ───────────────────────────────────────────────────────────────

router.get("/platform/firms/:firmId/users", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const firmIdStr = one(req.params.firmId);
  const firmId = firmIdStr ? parseInt(firmIdStr, 10) : NaN;
  if (isNaN(firmId)) {
    res.status(400).json({ error: "Invalid firm ID" });
    return;
  }
  const users = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      userType: usersTable.userType,
      roleId: usersTable.roleId,
      status: usersTable.status,
      lastLoginAt: usersTable.lastLoginAt,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.firmId, firmId))
    .orderBy(usersTable.createdAt);

  const withRoles = await Promise.all(
    users.map(async (u) => {
      let roleName: string | null = null;
      if (u.roleId) {
        const [role] = await db.select({ name: rolesTable.name }).from(rolesTable).where(eq(rolesTable.id, u.roleId));
        roleName = role?.name ?? null;
      }
      return { ...u, roleName };
    })
  );

  res.json(withRoles);
});

router.post("/platform/firms/:firmId/users/:userId/reset-password", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 });
    const userId = parseIntParam("userId", req.params.userId, { required: true, min: 1 });
    const { newPassword } = req.body as { newPassword?: string };
    if (!newPassword || typeof newPassword !== "string" || newPassword.trim().length < 6) {
      throw new ApiError({
        status: 422,
        code: "INVALID_PASSWORD_POLICY",
        message: "New password must be at least 6 characters",
        retryable: false,
      });
    }
    const normalized = newPassword.trim();

    const result = await withAuthSafeDb(
      async (authDb) => {
        const statementTimeoutMs = 8000;
        await authDb.execute(sql`SET LOCAL statement_timeout = ${statementTimeoutMs}`);

        const ctx = await loadFounderGovernanceContext(authDb, req);
        assertFounderPermission(ctx, "founder.maintenance.reset.firm");
        assertActiveSupportSessionForFirm(ctx, firmId!);

        const [user] = await withTimeout("platform.reset_password.select_user", async () =>
          authDb.select({ id: usersTable.id, email: usersTable.email, firmId: usersTable.firmId }).from(usersTable).where(and(eq(usersTable.id, userId!), eq(usersTable.firmId, firmId!)))
        );
        if (!user) {
          throw new ApiError({ status: 404, code: "USER_NOT_FOUND", message: "User not found in this firm", retryable: false });
        }
        const passwordHash = await withTimeout("platform.reset_password.hash", async () => bcrypt.hash(normalized, 10));
        const updated = await withTimeout("platform.reset_password.update_user", async () =>
          authDb.update(usersTable).set({ passwordHash }).where(and(eq(usersTable.id, userId!), eq(usersTable.firmId, firmId!))).returning({ id: usersTable.id })
        );
        if (!updated?.[0]?.id) {
          throw new ApiError({ status: 409, code: "TARGET_STATE_CONFLICT", message: "User could not be updated", retryable: true });
        }
        await writeAuditLog(
          {
            firmId: firmId!,
            actorId: req.userId,
            actorType: req.userType,
            action: "platform.firm_user.password.reset",
            entityType: "user",
            entityId: userId!,
            detail: `email=${user.email}`,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
          },
          { db: authDb, strict: false }
        );
        return { userId: userId!, firmId: firmId! };
      },
      { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/firms/:firmId/users/:userId/reset-password", firmId, userId } }
    );

    sendOk(res, { result: { user_id: result.userId, password_reset: true } });
  } catch (err) {
    if (err instanceof RouteTimeoutError) {
      logger.error({ err, firmId: req.params.firmId, userId: req.params.userId }, "platform.reset_password.timeout");
      sendError(res, new ApiError({ status: 504, code: "QUERY_TIMEOUT", message: "Request timed out", retryable: true, stage: err.label }));
      return;
    }
    const code = typeof (err as any)?.code === "string" ? String((err as any).code) : undefined;
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (code === "57014" || message.toLowerCase().includes("statement timeout")) {
      sendError(res, new ApiError({
        status: 504,
        code: "QUERY_TIMEOUT",
        message: "Password reset query timed out. Please retry.",
        retryable: true,
        stage: "reset_password",
      }));
      return;
    }
    logger.error({ err, firmId: req.params.firmId, userId: req.params.userId }, "platform.reset_password.error");
    sendError(res, err);
  }
});

// ─── Platform Stats ───────────────────────────────────────────────────────────

router.get("/platform/stats", requireAuth, requireFounder, async (_req, res): Promise<void> => {
  const [totalFirmsRes] = await db.select({ c: count() }).from(firmsTable);
  const [activeFirmsRes] = await db.select({ c: count() }).from(firmsTable).where(eq(firmsTable.status, "active"));
  const [totalUsersRes] = await db.select({ c: count() }).from(usersTable).where(eq(usersTable.userType, "firm_user"));
  const [totalCasesRes] = await db.select({ c: count() }).from(casesTable);
  const docsRes = await db.execute(sql`SELECT COUNT(*) as c FROM case_documents`);
  const docsC = firstRow(docsRes)?.c;
  const totalDocuments = typeof docsC === "string" || typeof docsC === "number" ? Number(docsC) : 0;
  res.json({ totalFirms: Number(totalFirmsRes?.c ?? 0), activeFirms: Number(activeFirmsRes?.c ?? 0), totalUsers: Number(totalUsersRes?.c ?? 0), totalCases: Number(totalCasesRes?.c ?? 0), totalDocuments });
});

// ─── System Folders ───────────────────────────────────────────────────────────

router.get("/platform/folders", requireAuth, requireFounder, async (_req: AuthRequest, res): Promise<void> => {
  try {
    const folders = await withTimeout("platform.folders.list", async () =>
      db.select().from(systemFoldersTable).orderBy(systemFoldersTable.sortOrder, systemFoldersTable.name)
    );
    res.json(folders);
  } catch (err) {
    if (err instanceof RouteTimeoutError) {
      logger.error({ err }, "platform.folders.timeout");
      res.status(504).json({ error: "Request timed out", code: "TIMEOUT" });
      return;
    }
    logger.error({ err }, "platform.folders.error");
    res.status(500).json({ error: "Failed to load folders" });
  }
});

router.post("/platform/folders", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { name, parentId } = req.body as { name: string; parentId?: number | null };
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Folder name is required" });
    return;
  }
  const folder = await withAuthSafeDb(async (authDb) => {
    const maxSort = await authDb.execute(
      sql`SELECT COALESCE(MAX(sort_order), -1) + 1 as next_sort FROM system_folders WHERE ${parentId ? sql`parent_id = ${parentId}` : sql`parent_id IS NULL`}`
    );
    const nextSortV = firstRow(maxSort)?.next_sort;
    const nextSort = typeof nextSortV === "string" || typeof nextSortV === "number" ? Number(nextSortV) : 0;
    const [folder] = await authDb
      .insert(systemFoldersTable)
      .values({ name: name.trim(), parentId: parentId ?? null, sortOrder: nextSort })
      .returning();
    await writeAuditLog(
      {
        firmId: null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.system_folder.create",
        entityType: "system_folder",
        entityId: folder.id,
        detail: `name=${folder.name} parentId=${folder.parentId ?? ""}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return folder;
  });
  res.status(201).json(folder);
});

router.patch("/platform/folders/:folderId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const folderIdStr = one(req.params.folderId);
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : NaN;
  if (isNaN(folderId)) { res.status(400).json({ error: "Invalid folder ID" }); return; }
  const { name, isDisabled } = req.body as { name?: string; isDisabled?: boolean };
  const wantName = name !== undefined;
  const wantDisabled = isDisabled !== undefined;
  if (!wantName && !wantDisabled) { res.status(400).json({ error: "No fields to update" }); return; }
  if (wantName && !name?.trim()) { res.status(400).json({ error: "Folder name is required" }); return; }

  const result = await withAuthSafeDb(async (authDb) => {
    const [before] = await authDb.select().from(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
    if (!before) return { kind: "not_found" as const };

    const updates: Record<string, unknown> = {};
    if (wantName) updates.name = name!.trim();
    if (wantDisabled) updates.isDisabled = isDisabled!;

    const [folder] = await authDb.update(systemFoldersTable).set(updates).where(eq(systemFoldersTable.id, folderId)).returning();
    if (!folder) return { kind: "not_found" as const };

    let action = "platform.system_folder.update";
    if (wantName && !wantDisabled) action = "platform.system_folder.rename";
    if (!wantName && wantDisabled) action = isDisabled ? "platform.system_folder.disable" : "platform.system_folder.enable";

    const detailParts: string[] = [];
    if (wantName) detailParts.push(`from=${before.name} to=${folder.name}`);
    if (wantDisabled) detailParts.push(`isDisabled=${String(folder.isDisabled)}`);

    await writeAuditLog(
      {
        firmId: null,
        actorId: req.userId,
        actorType: req.userType,
        action,
        entityType: "system_folder",
        entityId: folderId,
        detail: detailParts.join(" "),
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return { kind: "ok" as const, folder };
  });

  if (result.kind === "not_found") { res.status(404).json({ error: "Folder not found" }); return; }
  res.json(result.folder);
});

router.delete("/platform/folders/:folderId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const folderIdStr = one(req.params.folderId);
  const folderId = folderIdStr ? parseInt(folderIdStr, 10) : NaN;
  if (isNaN(folderId)) { res.status(400).json({ error: "Invalid folder ID" }); return; }
  const result = await withAuthSafeDb(async (authDb) => {
    const [folder] = await authDb.select().from(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
    if (!folder) return { kind: "not_found" as const };

    const [childCount] = await authDb.select({ c: count() }).from(systemFoldersTable).where(eq(systemFoldersTable.parentId, folderId));
    if (Number(childCount?.c ?? 0) > 0) {
      return { kind: "bad_request" as const, error: "Cannot delete folder with subfolders. Remove subfolders first." };
    }

    const [docCount] = await authDb.select({ c: count() }).from(platformDocumentsTable).where(eq(platformDocumentsTable.folderId, folderId));
    if (Number(docCount?.c ?? 0) > 0) {
      return { kind: "bad_request" as const, error: "Cannot delete folder with documents. Remove or move documents first." };
    }

    await authDb.delete(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
    await writeAuditLog(
      {
        firmId: null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.system_folder.delete",
        entityType: "system_folder",
        entityId: folderId,
        detail: `name=${folder.name}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return { kind: "ok" as const };
  });

  if (result.kind === "not_found") { res.status(404).json({ error: "Folder not found" }); return; }
  if (result.kind === "bad_request") { res.status(400).json({ error: result.error }); return; }
  res.json({ success: true });
});

router.post("/platform/folders/reorder", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { folderId, direction } = req.body as { folderId: number; direction: "up" | "down" };
  if (!folderId || !direction) { res.status(400).json({ error: "folderId and direction required" }); return; }
  const result = await withAuthSafeDb(async (authDb) => {
    const [folder] = await authDb.select().from(systemFoldersTable).where(eq(systemFoldersTable.id, folderId));
    if (!folder) return { kind: "not_found" as const };

    const siblings = await authDb
      .select()
      .from(systemFoldersTable)
      .where(folder.parentId ? eq(systemFoldersTable.parentId, folder.parentId) : isNull(systemFoldersTable.parentId))
      .orderBy(systemFoldersTable.sortOrder);

    const idx = siblings.findIndex(s => s.id === folderId);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) {
      await writeAuditLog(
        {
          firmId: null,
          actorId: req.userId,
          actorType: req.userType,
          action: "platform.system_folder.reorder",
          entityType: "system_folder",
          entityId: folderId,
          detail: `direction=${direction} noop=true parentId=${folder.parentId ?? ""}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: authDb, strict: true }
      );
      return { kind: "ok" as const };
    }

    const swapFolder = siblings[swapIdx];
    await authDb.update(systemFoldersTable).set({ sortOrder: swapFolder.sortOrder }).where(eq(systemFoldersTable.id, folder.id));
    await authDb.update(systemFoldersTable).set({ sortOrder: folder.sortOrder }).where(eq(systemFoldersTable.id, swapFolder.id));
    await writeAuditLog(
      {
        firmId: null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.system_folder.reorder",
        entityType: "system_folder",
        entityId: folderId,
        detail: `direction=${direction} swapWith=${swapFolder.id} parentId=${folder.parentId ?? ""}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return { kind: "ok" as const };
  });

  if (result.kind === "not_found") { res.status(404).json({ error: "Folder not found" }); return; }
  res.json({ success: true });
});

// ─── Platform Documents ───────────────────────────────────────────────────────

router.get("/platform/documents", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  try {
    const firmId = (() => {
      const raw = one(req.query.firmId as any);
      if (raw === undefined) return null;
      if (!String(raw).trim()) return null;
      const n = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n < 1) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid firmId", retryable: false });
      return n;
    })();
    const folderId = (() => {
      const raw = one(req.query.folderId as any);
      if (raw === undefined) return null;
      if (!String(raw).trim()) return null;
      const n = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n < 1) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid folderId", retryable: false });
      return n;
    })();
    const limit = (() => {
      const raw = one(req.query.limit as any);
      if (raw === undefined) return 200;
      if (!String(raw).trim()) return 200;
      const n = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n < 1) throw new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid limit", retryable: false });
      return Math.min(Math.max(n, 1), 500);
    })();

    const docs = await withAuthSafeDb(
      async (authDb) => {
        return await withTimeout("platform.documents.list", async () => {
          const statementTimeoutMs = 8000;
          await authDb.execute(sql`SET LOCAL statement_timeout = ${statementTimeoutMs}`);

          let q = authDb.select().from(platformDocumentsTable);
          if (firmId !== null) q = q.where(eq(platformDocumentsTable.firmId, firmId)) as typeof q;
          if (folderId !== null) {
            const folderCond = eq(platformDocumentsTable.folderId, folderId);
            q = q.where(firmId !== null ? and(eq(platformDocumentsTable.firmId, firmId), folderCond) : folderCond) as typeof q;
          }
          return await q.orderBy(desc(platformDocumentsTable.createdAt), desc(platformDocumentsTable.id)).limit(limit);
        });
      },
      { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/documents", firmId: firmId ?? undefined } }
    );
    sendOk(res, { items: docs, page_info: { limit, has_more: docs.length === limit } });
  } catch (err) {
    if (err instanceof RouteTimeoutError) {
      logger.error({ err, firmId: req.query.firmId ?? null, folderId: req.query.folderId ?? null }, "platform.documents.timeout");
      sendError(res, new ApiError({ status: 504, code: "QUERY_TIMEOUT", message: "Request timed out", retryable: true, stage: err.label }));
      return;
    }
    const code = typeof (err as any)?.code === "string" ? String((err as any).code) : undefined;
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (code === "57014" || message.toLowerCase().includes("statement timeout")) {
      sendError(res, new ApiError({
        status: 504,
        code: "QUERY_TIMEOUT",
        message: "Documents query timed out. Try filtering by folder or reducing limit.",
        retryable: true,
        stage: "platform.documents.list",
        suggestion: "Filter by folder or pass a smaller limit.",
      }));
      return;
    }
    logger.error({ err, firmId: req.query.firmId ?? null, folderId: req.query.folderId ?? null }, "platform.documents.error");
    sendError(res, err, { status: 500, code: "DOCUMENTS_QUERY_FAILED", message: "Failed to load documents" });
  }
});

router.post("/platform/documents", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { name, description, category, fileName, fileType, fileSize, objectPath, firmId, folderId } = req.body as {
    name: string;
    description?: string;
    category?: string;
    fileName: string;
    fileType: string;
    fileSize?: number;
    objectPath: string;
    firmId?: number | null;
    folderId?: number | null;
  };
  if (!name || !fileName || !fileType || !objectPath) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  const doc = await withAuthSafeDb(async (authDb) => {
    const [doc] = await authDb
      .insert(platformDocumentsTable)
      .values({
        name,
        description: description ?? null,
        category: category ?? "general",
        fileName,
        fileType,
        fileSize: fileSize ?? null,
        objectPath,
        firmId: firmId ?? null,
        folderId: folderId ?? null,
        uploadedBy: req.userId!,
      })
      .returning();
    await writeAuditLog(
      {
        firmId: doc.firmId ?? null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.document.create",
        entityType: "platform_document",
        entityId: doc.id,
        detail: `name=${doc.name} category=${doc.category} folderId=${doc.folderId ?? ""}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return doc;
  });
  res.status(201).json(doc);
});

router.patch("/platform/documents/:docId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }

  const body = req.body as Record<string, unknown>;
  const hasIsActive = Object.prototype.hasOwnProperty.call(body, "isActive");
  const hasAppliesToPurchaseMode = Object.prototype.hasOwnProperty.call(body, "appliesToPurchaseMode");
  const hasAppliesToTitleType = Object.prototype.hasOwnProperty.call(body, "appliesToTitleType");
  const hasAppliesToCaseType = Object.prototype.hasOwnProperty.call(body, "appliesToCaseType");
  const hasDocumentGroup = Object.prototype.hasOwnProperty.call(body, "documentGroup");
  const hasSortOrder = Object.prototype.hasOwnProperty.call(body, "sortOrder");
  const hasCategory = Object.prototype.hasOwnProperty.call(body, "category");
  const hasFileNamingRule = Object.prototype.hasOwnProperty.call(body, "fileNamingRule");
  const hasClauseInsertionMode = Object.prototype.hasOwnProperty.call(body, "clauseInsertionMode");
  const hasApplicabilityMode = Object.prototype.hasOwnProperty.call(body, "applicabilityMode");
  const hasApplicabilityRules = Object.prototype.hasOwnProperty.call(body, "applicabilityRules");
  const hasChecklistMode = Object.prototype.hasOwnProperty.call(body, "checklistMode");
  const hasChecklistItems = Object.prototype.hasOwnProperty.call(body, "checklistItems");

  const isActiveVal: boolean | undefined = hasIsActive ? (typeof body.isActive === "boolean" ? body.isActive : undefined) : undefined;
  if (hasIsActive && isActiveVal === undefined) { res.status(400).json({ error: "Invalid isActive" }); return; }

  const purchaseModeVal: string | null | undefined =
    hasAppliesToPurchaseMode
      ? (typeof body.appliesToPurchaseMode === "string" ? (String(body.appliesToPurchaseMode).trim() || null) : body.appliesToPurchaseMode === null ? null : undefined)
      : undefined;
  if (hasAppliesToPurchaseMode && purchaseModeVal === undefined) { res.status(400).json({ error: "Invalid appliesToPurchaseMode" }); return; }

  const titleTypeVal: string | undefined =
    hasAppliesToTitleType
      ? (typeof body.appliesToTitleType === "string" ? (String(body.appliesToTitleType).trim() || "any") : undefined)
      : undefined;
  if (hasAppliesToTitleType && !titleTypeVal) { res.status(400).json({ error: "Invalid appliesToTitleType" }); return; }

  const caseTypeVal: string | null | undefined =
    hasAppliesToCaseType
      ? (typeof body.appliesToCaseType === "string" ? (String(body.appliesToCaseType).trim() || null) : body.appliesToCaseType === null ? null : undefined)
      : undefined;
  if (hasAppliesToCaseType && caseTypeVal === undefined) { res.status(400).json({ error: "Invalid appliesToCaseType" }); return; }

  const groupVal: string | undefined =
    hasDocumentGroup
      ? (typeof body.documentGroup === "string" ? (String(body.documentGroup).trim() || "Others") : undefined)
      : undefined;
  if (hasDocumentGroup && !groupVal) { res.status(400).json({ error: "Invalid documentGroup" }); return; }

  const sortOrderVal: number | undefined =
    hasSortOrder
      ? (typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder) ? body.sortOrder : undefined)
      : undefined;
  if (hasSortOrder && sortOrderVal === undefined) { res.status(400).json({ error: "Invalid sortOrder" }); return; }

  const categoryVal: string | undefined =
    hasCategory
      ? (typeof body.category === "string" ? (String(body.category).trim() || "general") : undefined)
      : undefined;
  if (hasCategory && !categoryVal) { res.status(400).json({ error: "Invalid category" }); return; }

  const fileNamingRuleVal: string | null | undefined =
    hasFileNamingRule
      ? (typeof body.fileNamingRule === "string" ? (String(body.fileNamingRule).trim() || null) : body.fileNamingRule === null ? null : undefined)
      : undefined;
  if (hasFileNamingRule && fileNamingRuleVal === undefined) { res.status(400).json({ error: "Invalid fileNamingRule" }); return; }

  const clauseInsertionModeVal: string | null | undefined =
    hasClauseInsertionMode
      ? (typeof body.clauseInsertionMode === "string" ? (String(body.clauseInsertionMode).trim() || null) : body.clauseInsertionMode === null ? null : undefined)
      : undefined;
  if (hasClauseInsertionMode && clauseInsertionModeVal === undefined) { res.status(400).json({ error: "Invalid clauseInsertionMode" }); return; }
  const applicabilityModeVal: string | null | undefined =
    hasApplicabilityMode
      ? (typeof body.applicabilityMode === "string" ? (String(body.applicabilityMode).trim() || null) : body.applicabilityMode === null ? null : undefined)
      : undefined;
  if (hasApplicabilityMode && applicabilityModeVal === undefined) { res.status(400).json({ error: "Invalid applicabilityMode" }); return; }
  const applicabilityRulesVal: Record<string, unknown> | null | undefined =
    hasApplicabilityRules
      ? (body.applicabilityRules && typeof body.applicabilityRules === "object" ? (body.applicabilityRules as Record<string, unknown>) : body.applicabilityRules === null ? null : undefined)
      : undefined;
  if (hasApplicabilityRules && applicabilityRulesVal === undefined) { res.status(400).json({ error: "Invalid applicabilityRules" }); return; }
  const checklistModeVal: string | null | undefined =
    hasChecklistMode
      ? (typeof body.checklistMode === "string" ? (String(body.checklistMode).trim() || null) : body.checklistMode === null ? null : undefined)
      : undefined;
  if (hasChecklistMode && checklistModeVal === undefined) { res.status(400).json({ error: "Invalid checklistMode" }); return; }
  const checklistItemsVal: Record<string, unknown>[] | null | undefined =
    hasChecklistItems
      ? (Array.isArray(body.checklistItems) ? (body.checklistItems as Record<string, unknown>[]) : body.checklistItems === null ? null : undefined)
      : undefined;
  if (hasChecklistItems && checklistItemsVal === undefined) { res.status(400).json({ error: "Invalid checklistItems" }); return; }

  const updated = await withAuthSafeDb(async (authDb) => {
    const [existing] = await authDb.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
    if (!existing) return null;

    const [row] = await authDb
      .update(platformDocumentsTable)
      .set({
        ...(hasIsActive ? { isActive: isActiveVal! } : {}),
        ...(hasAppliesToPurchaseMode ? { appliesToPurchaseMode: purchaseModeVal ?? null } : {}),
        ...(hasAppliesToTitleType ? { appliesToTitleType: titleTypeVal ?? "any" } : {}),
        ...(hasAppliesToCaseType ? { appliesToCaseType: caseTypeVal ?? null } : {}),
        ...(hasDocumentGroup ? { documentGroup: groupVal ?? "Others" } : {}),
        ...(hasSortOrder ? { sortOrder: sortOrderVal ?? 0 } : {}),
        ...(hasCategory ? { category: categoryVal ?? "general" } : {}),
        ...(hasFileNamingRule ? { fileNamingRule: fileNamingRuleVal ?? null } : {}),
        ...(hasClauseInsertionMode ? { clauseInsertionMode: clauseInsertionModeVal ?? null } : {}),
        ...(hasApplicabilityMode ? { applicabilityMode: applicabilityModeVal ?? null } : {}),
        ...(hasApplicabilityRules ? { applicabilityRules: applicabilityRulesVal ?? null } : {}),
        ...(hasChecklistMode ? { checklistMode: checklistModeVal ?? null } : {}),
        ...(hasChecklistItems ? { checklistItems: checklistItemsVal ?? null } : {}),
      })
      .where(eq(platformDocumentsTable.id, docId))
      .returning();

    const changed: string[] = [];
    if (hasIsActive) changed.push(`isActive=${String(isActiveVal)}`);
    if (hasAppliesToPurchaseMode) changed.push(`purchaseMode=${purchaseModeVal ?? "null"}`);
    if (hasAppliesToTitleType) changed.push(`titleType=${titleTypeVal ?? "any"}`);
    if (hasAppliesToCaseType) changed.push(`caseType=${caseTypeVal ?? "null"}`);
    if (hasDocumentGroup) changed.push(`group=${groupVal ?? "Others"}`);
    if (hasSortOrder) changed.push(`sortOrder=${String(sortOrderVal ?? 0)}`);
    if (hasCategory) changed.push(`category=${categoryVal ?? "general"}`);
    if (hasFileNamingRule) changed.push(`fileNamingRule=${fileNamingRuleVal ?? "null"}`);
    if (hasClauseInsertionMode) changed.push(`clauseInsertionMode=${clauseInsertionModeVal ?? "null"}`);
    if (hasApplicabilityMode) changed.push(`applicabilityMode=${applicabilityModeVal ?? "null"}`);
    if (hasApplicabilityRules) changed.push(`applicabilityRules=${applicabilityRulesVal ? "set" : "null"}`);
    if (hasChecklistMode) changed.push(`checklistMode=${checklistModeVal ?? "null"}`);
    if (hasChecklistItems) changed.push(`checklistItems=${checklistItemsVal ? "set" : "null"}`);

    await writeAuditLog(
      {
        firmId: existing.firmId ?? null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.document.update",
        entityType: "platform_document",
        entityId: docId,
        detail: changed.length ? changed.join(" ") : undefined,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );

    return row;
  });

  if (!updated) { res.status(404).json({ error: "Document not found" }); return; }
  res.json(updated);
});

router.delete("/platform/documents/:docId", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const fetched = await withAuthSafeDb(async (authDb) => {
    const [doc] = await authDb.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
    return doc ?? null;
  });
  if (!fetched) { res.status(404).json({ error: "Document not found" }); return; }

  try {
    await storage.deletePrivateObject(fetched.objectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      // proceed
    } else {
      const configErr = getSupabaseStorageConfigError(error);
      if (configErr) {
        res.status(configErr.statusCode).json({ error: configErr.error });
        return;
      }
      req.log.error({ err: error, docId }, "platform.document.delete_failed_storage");
      res.status(500).json({ error: "Failed to delete document object" });
      return;
    }
  }

  await withAuthSafeDb(async (authDb) => {
    await authDb.delete(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
    await writeAuditLog(
      {
        firmId: fetched.firmId ?? null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.document.delete",
        entityType: "platform_document",
        entityId: docId,
        detail: `name=${fetched.name}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
  });

  res.json({ success: true });
});

router.get("/platform/documents/:docId/download", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const [doc] = await withAuthSafeDb(async (authDb) => authDb.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  try {
    const response = await storage.fetchPrivateObjectResponse(doc.objectPath);
    await writeAuditLog(
      {
        firmId: doc.firmId ?? null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.document.download",
        entityType: "platform_document",
        entityId: docId,
        detail: `name=${doc.name} fileName=${doc.fileName}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { strict: true }
    );
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const ascii = String(doc.fileName ?? "download").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "download";
    const encoded = encodeURIComponent(String(doc.fileName ?? ascii));
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    const configErr = getSupabaseStorageConfigError(error);
    if (configErr) {
      res.status(configErr.statusCode).json({ error: configErr.error });
      return;
    }
    req.log.error({ err: error, docId }, "platform.document.download_failed");
    res.status(500).json({ error: "Failed to download document" });
  }
});

router.get("/platform/documents/:docId/clause-placeholders", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const [doc] = await withAuthSafeDb(async (authDb) => authDb.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const fileName = String(doc.fileName ?? "");
  const ext = fileName.toLowerCase().endsWith(".docx") ? "docx" : "";
  if (ext !== "docx") {
    res.json({ supported: false, hasClausesPlaceholder: false, clauseCodePlaceholders: [] });
    return;
  }
  try {
    const response = await storage.fetchPrivateObjectResponse(doc.objectPath);
    if (!response.ok) {
      res.status(response.status).json({ error: "Failed to download document" });
      return;
    }
    const ab = await response.arrayBuffer();
    const bytes = Buffer.from(ab);
    const scan = scanClausePlaceholdersInDocx(bytes);
    res.json({ supported: true, ...scan });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "Object not found" }); return; }
    const configErr = getSupabaseStorageConfigError(error);
    if (configErr) { res.status(configErr.statusCode).json({ error: configErr.error }); return; }
    req.log.error({ err: error, docId }, "platform.document.clause_placeholders_failed");
    res.status(500).json({ error: "Failed to detect placeholders" });
  }
});

// ─── PDF Mappings ─────────────────────────────────────────────────────────────

router.get("/platform/documents/:docId/pdf-mappings", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const [doc] = await db.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  res.json({ mappings: doc.pdfMappings ?? { pages: [] } });
});

router.put("/platform/documents/:docId/pdf-mappings", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const docIdStr = one(req.params.docId);
  const docId = docIdStr ? parseInt(docIdStr, 10) : NaN;
  if (isNaN(docId)) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const mappings = (req.body as { mappings?: unknown }).mappings;
  if (!mappings || typeof mappings !== "object") { res.status(400).json({ error: "Invalid mappings" }); return; }

  const result = await withAuthSafeDb(async (authDb) => {
    const [doc] = await authDb.select().from(platformDocumentsTable).where(eq(platformDocumentsTable.id, docId));
    if (!doc) return { kind: "not_found" as const };
    await authDb.update(platformDocumentsTable).set({ pdfMappings: mappings }).where(eq(platformDocumentsTable.id, docId));
    await writeAuditLog(
      {
        firmId: doc.firmId ?? null,
        actorId: req.userId,
        actorType: req.userType,
        action: "platform.document.update_pdf_mappings",
        entityType: "platform_document",
        entityId: docId,
        detail: `name=${doc.name}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: authDb, strict: true }
    );
    return { kind: "ok" as const };
  });

  if (result.kind === "not_found") { res.status(404).json({ error: "Document not found" }); return; }
  res.json({ success: true });
});

router.get("/platform/clauses", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const tag = typeof req.query.tag === "string" ? req.query.tag.trim() : "";
  const language = typeof req.query.language === "string" ? req.query.language.trim() : "";

  const where: SQL[] = [];
  if (status) where.push(eq(platformClausesTable.status, status));
  if (category) where.push(eq(platformClausesTable.category, category));
  if (language) where.push(eq(platformClausesTable.language, language));
  if (q) {
    const qCond = or(
      ilike(platformClausesTable.clauseCode, `%${q}%`),
      ilike(platformClausesTable.title, `%${q}%`),
      ilike(platformClausesTable.body, `%${q}%`),
      ilike(sql`COALESCE(${platformClausesTable.notes}, '')`, `%${q}%`),
    );
    if (qCond) where.push(qCond);
  }
  if (tag) where.push(sql`${platformClausesTable.tags} @> ARRAY[${tag}]::text[]`);

  const rows = await withAuthSafeDb(async (authDb) =>
    authDb.select().from(platformClausesTable).where(where.length ? and(...where) : undefined).orderBy(platformClausesTable.sortOrder, platformClausesTable.clauseCode).limit(500)
  );
  res.json(rows);
});

router.post("/platform/clauses", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const clauseCodeRaw = typeof body.clauseCode === "string" ? body.clauseCode.trim() : "";
  const clauseCode = clauseCodeRaw ? clauseCodeRaw.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") : "";
  const category = typeof body.category === "string" ? body.category.trim() : "General";
  const language = typeof body.language === "string" ? body.language.trim() : "en";
  const clauseBody = typeof body.body === "string" ? body.body : "";
  const notes = typeof body.notes === "string" ? body.notes : null;
  const tags = Array.isArray(body.tags) ? body.tags.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map((x) => x.trim()) : [];
  const status = typeof body.status === "string" ? body.status : "draft";
  const isSystem = typeof body.isSystem === "boolean" ? body.isSystem : false;
  const sortOrder = typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder) ? Math.floor(body.sortOrder) : 0;
  const applicability = body.applicability && typeof body.applicability === "object" ? body.applicability : null;

  if (!title || !clauseBody) { res.status(400).json({ error: "Missing title or body" }); return; }
  const finalCode = clauseCode || title.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "CLAUSE";

  const created = await withAuthSafeDb(async (authDb) => {
    const [row] = await authDb
      .insert(platformClausesTable)
      .values({
        clauseCode: finalCode,
        title,
        category,
        language,
        body: clauseBody,
        notes,
        tags,
        status,
        isSystem,
        sortOrder,
        applicability,
        createdBy: req.userId ?? null,
        updatedBy: req.userId ?? null,
      })
      .returning();
    await writeAuditLog({ firmId: null, actorId: req.userId, actorType: req.userType, action: "clauses.platform.create", entityType: "platform_clause", entityId: row.id, detail: `clauseCode=${finalCode}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: true });
    return row;
  });
  res.status(201).json(created);
});

router.put("/platform/clauses/:id", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};

  const patch: Partial<typeof platformClausesTable.$inferInsert> = {};
  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.clauseCode === "string") {
    const cleaned = body.clauseCode.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    if (cleaned) patch.clauseCode = cleaned;
  }
  if (typeof body.category === "string") patch.category = body.category.trim();
  if (typeof body.language === "string") patch.language = body.language.trim();
  if (typeof body.body === "string") patch.body = body.body;
  if (Object.prototype.hasOwnProperty.call(body, "notes")) patch.notes = typeof body.notes === "string" ? body.notes : null;
  if (Object.prototype.hasOwnProperty.call(body, "tags")) patch.tags = Array.isArray(body.tags) ? body.tags.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map((x) => x.trim()) : [];
  if (typeof body.status === "string") patch.status = body.status;
  if (typeof body.isSystem === "boolean") patch.isSystem = body.isSystem;
  if (typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)) patch.sortOrder = Math.floor(body.sortOrder);
  if (Object.prototype.hasOwnProperty.call(body, "applicability")) patch.applicability = body.applicability && typeof body.applicability === "object" ? body.applicability : null;
  patch.updatedBy = req.userId ?? null;
  patch.updatedAt = new Date();

  const updated = await withAuthSafeDb(async (authDb) => {
    const [row] = await authDb.update(platformClausesTable).set(patch).where(eq(platformClausesTable.id, id)).returning();
    if (!row) return null;
    await writeAuditLog({ firmId: null, actorId: req.userId, actorType: req.userType, action: "clauses.platform.update", entityType: "platform_clause", entityId: id, detail: `clauseId=${id}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: true });
    return row;
  });
  if (!updated) { res.status(404).json({ error: "Clause not found" }); return; }
  res.json(updated);
});

// ─── Platform Messages (Communication Hub) ───────────────────────────────────

router.get("/platform/messages", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const firmIdStr = one(req.query.firmId as any);
  const firmId = firmIdStr ? parseInt(firmIdStr, 10) : undefined;

  const msgs = await db
    .select()
    .from(platformMessagesTable)
    .where(
      firmId
        ? or(eq(platformMessagesTable.fromFirmId, firmId), eq(platformMessagesTable.toFirmId, firmId))
        : undefined
    )
    .orderBy(desc(platformMessagesTable.createdAt))
    .limit(100);

  const enriched = await Promise.all(
    msgs.map(async (m) => {
      const [sender] = await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, m.fromUserId));
      const attachments = await db.select().from(platformMessageAttachmentsTable).where(eq(platformMessageAttachmentsTable.messageId, m.id));
      let firmName: string | null = null;
      if (m.fromFirmId) {
        const [f] = await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, m.fromFirmId));
        firmName = f?.name ?? null;
      } else if (m.toFirmId) {
        const [f] = await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, m.toFirmId));
        firmName = f?.name ?? null;
      }
      return { ...m, senderName: sender?.name ?? "Unknown", senderEmail: sender?.email ?? "", firmName, attachments };
    })
  );

  res.json(enriched);
});

router.post("/platform/messages", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const { subject, body, toFirmId, parentId, attachments } = req.body as {
    subject: string;
    body: string;
    toFirmId: number;
    parentId?: number;
    attachments?: Array<{ fileName: string; fileType: string; fileSize?: number; objectPath: string }>;
  };
  if (!subject || !body || !toFirmId) {
    res.status(400).json({ error: "subject, body and toFirmId are required" });
    return;
  }
  const [msg] = await db
    .insert(platformMessagesTable)
    .values({
      subject,
      body,
      fromFirmId: null,
      fromUserId: req.userId!,
      toFirmId,
      parentId: parentId ?? null,
    })
    .returning();

  if (attachments && attachments.length > 0) {
    await db.insert(platformMessageAttachmentsTable).values(
      attachments.map((a) => ({ messageId: msg.id, fileName: a.fileName, fileType: a.fileType, fileSize: a.fileSize ?? null, objectPath: a.objectPath }))
    );
  }

  res.status(201).json(msg);
});

router.patch("/platform/messages/:msgId/read", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const msgIdStr = one(req.params.msgId);
  const msgId = msgIdStr ? parseInt(msgIdStr, 10) : NaN;
  if (isNaN(msgId)) { res.status(400).json({ error: "Invalid message ID" }); return; }
  await db.update(platformMessagesTable).set({ readAt: new Date() }).where(eq(platformMessagesTable.id, msgId));
  res.json({ success: true });
});

router.get("/platform/messages/:msgId/attachments/:attachmentId/download", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const msgIdStr = one(req.params.msgId);
  const attachmentIdStr = one(req.params.attachmentId);
  const msgId = msgIdStr ? parseInt(msgIdStr, 10) : NaN;
  const attachmentId = attachmentIdStr ? parseInt(attachmentIdStr, 10) : NaN;
  if (!Number.isFinite(msgId) || !Number.isFinite(attachmentId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [att] = await db
    .select()
    .from(platformMessageAttachmentsTable)
    .where(and(eq(platformMessageAttachmentsTable.id, attachmentId), eq(platformMessageAttachmentsTable.messageId, msgId)));
  if (!att) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }

  try {
    const response = await storage.fetchPrivateObjectResponse(att.objectPath);
    await writeAuditLog({
      firmId: null,
      actorId: req.userId,
      actorType: req.userType,
      action: "platform.message_attachment.download",
      entityType: "platform_message_attachment",
      entityId: attachmentId,
      detail: `messageId=${msgId} fileName=${att.fileName}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    }, { strict: true });

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const ascii = String(att.fileName ?? "download").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "download";
    const encoded = encodeURIComponent(String(att.fileName ?? ascii));
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "File not found" }); return; }
    const cfgErr = getSupabaseStorageConfigError(err);
    if (cfgErr) { res.status(cfgErr.statusCode).json({ error: cfgErr.error }); return; }
    res.status(500).json({ error: "Failed to download attachment" });
  }
});

export default router;
