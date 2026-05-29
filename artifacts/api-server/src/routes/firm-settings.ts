import express, { type Response, type Router as ExpressRouter } from "express";
import { Readable } from "stream";
import { eq, and } from "drizzle-orm";
import { db, firmBankAccountsTable, firmsTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { one } from "../lib/http.js";
import { getSupabaseStorageConfigError, ObjectNotFoundError, SupabaseStorageService } from "../lib/objectStorage.js";

const VALID_ACCOUNT_TYPES = ["office", "client"];

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const supabaseStorage = new SupabaseStorageService();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await (r as any).execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

router.get("/firm-settings", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response) => {
  const firmId = req.firmId!;
  const defaults = {
    useMasterDocuments: true,
    firmLetterheadEnabled: false,
  };
  const emptyFirm = {
    id: firmId,
    name: "",
    slug: "",
    showMasterDocuments: true,
    logoUrl: "",
    address: "",
    stNumber: "",
    tinNumber: "",
    registrationNo: "",
    sstNo: "",
    phone: "",
    email: "",
    bankAccounts: [],
  };
  try {
    const r = rdb(req);
    const getPgCode = (err: unknown): string | null => {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      return typeof code === "string" && code ? code : null;
    };
    let firm: any | null = null;
    let schemaFallback = false;
    try {
      const firmRows = await queryRows(r, sql`
        SELECT
          id,
          name,
          slug,
          logo_url,
          address,
          st_number,
          tin_number,
          registration_no,
          sst_no,
          phone,
          email,
          show_master_documents
        FROM firms
        WHERE id = ${firmId}
        LIMIT 1
      `);
      firm = (firmRows[0] as any) ?? null;
    } catch (err) {
      const code = getPgCode(err);
      if (code === "42703") {
        schemaFallback = true;
        const firmRows = await queryRows(r, sql`
          SELECT
            id,
            name,
            slug,
            logo_url,
            address,
            st_number,
            tin_number,
            registration_no,
            sst_no,
            phone,
            email
          FROM firms
          WHERE id = ${firmId}
          LIMIT 1
        `);
        firm = (firmRows[0] as any) ?? null;
      } else {
        throw err;
      }
    }
    if (!firm) {
      res.status(200).json({ ok: true, data: { ...emptyFirm, ...defaults }, fallback: true });
      return;
    }
    const showMasterDocuments = schemaFallback ? true : firm.show_master_documents !== false;
    const bankAccounts = await (async () => {
      try {
        const rows = await (r as any).select().from(firmBankAccountsTable)
          .where(eq(firmBankAccountsTable.firmId, firmId));
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    })();

    res.status(200).json({
      ok: true,
      data: {
        id: Number(firm.id),
        name: String(firm.name ?? ""),
        slug: String(firm.slug ?? ""),
        useMasterDocuments: Boolean(showMasterDocuments),
        showMasterDocuments: Boolean(showMasterDocuments),
        firmLetterheadEnabled: false,
        logoUrl: typeof firm.logo_url === "string" ? firm.logo_url : "",
        address: typeof firm.address === "string" ? firm.address : "",
        stNumber: typeof firm.st_number === "string" ? firm.st_number : "",
        tinNumber: typeof firm.tin_number === "string" ? firm.tin_number : "",
        registrationNo: typeof firm.registration_no === "string" ? firm.registration_no : "",
        sstNo: typeof firm.sst_no === "string" ? firm.sst_no : "",
        phone: typeof firm.phone === "string" ? firm.phone : "",
        email: typeof firm.email === "string" ? firm.email : "",
        bankAccounts: bankAccounts.map((b: any) => ({
          id: b.id,
          bankName: b.bankName,
          accountNo: b.accountNo,
          accountType: b.accountType,
          isDefault: b.isDefault,
        })),
      },
      fallback: schemaFallback,
    });
    return;
  } catch (err: any) {
    req.log.error({ err }, "firm_settings.get failed");
    res.status(200).json({ ok: true, data: { ...emptyFirm, ...defaults }, fallback: true });
    return;
  }
});

router.get("/firm-settings/logo", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response) => {
  try {
    const r = rdb(req);
    const firmId = req.firmId!;
    const [firm] = await r.select({ logoUrl: firmsTable.logoUrl }).from(firmsTable).where(eq(firmsTable.id, firmId));
    const logoUrl = typeof firm?.logoUrl === "string" ? firm.logoUrl : "";
    if (!logoUrl) { res.status(404).json({ error: "Logo not set" }); return; }
    if (!logoUrl.startsWith("/objects/")) { res.status(400).json({ error: "Invalid logoUrl" }); return; }

    const response = await supabaseStorage.fetchPrivateObjectResponse(logoUrl);
    res.status(response.status);
    response.headers.forEach?.((value, key) => res.setHeader(key, value));
    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res as any);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) { res.status(404).json({ error: "Logo not found" }); return; }
    const configErr = getSupabaseStorageConfigError(error);
    if (configErr) { res.status(configErr.statusCode).json({ error: configErr.error, code: configErr.code, missing: configErr.missing }); return; }
    req.log.error({ err: error }, "firm_settings.logo failed");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/firm-settings", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = rdb(req);
    const firmId = req.firmId!;
    const { name, logoUrl, address, stNumber, tinNumber, registrationNo, sstNo, phone, email, showMasterDocuments, useMasterDocuments } = req.body;
    const desiredUseMasterDocuments = useMasterDocuments !== undefined ? Boolean(useMasterDocuments) : (showMasterDocuments !== undefined ? Boolean(showMasterDocuments) : undefined);
    const getPgCode = (err: unknown): string | null => {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      return typeof code === "string" && code ? code : null;
    };

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (logoUrl !== undefined) updates.logoUrl = logoUrl;
    if (address !== undefined) updates.address = address;
    if (stNumber !== undefined) updates.stNumber = stNumber;
    if (tinNumber !== undefined) updates.tinNumber = tinNumber;
    if (registrationNo !== undefined) updates.registrationNo = registrationNo;
    if (sstNo !== undefined) updates.sstNo = sstNo;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (desiredUseMasterDocuments !== undefined) updates.showMasterDocuments = Boolean(desiredUseMasterDocuments);

    let schemaFallback = false;
    try {
      await r.update(firmsTable)
        .set(updates)
        .where(eq(firmsTable.id, firmId))
        .returning({ id: firmsTable.id });
    } catch (err) {
      const code = getPgCode(err);
      if (code === "42703") {
        schemaFallback = true;
      } else {
        throw err;
      }
    }

    let firm: any | null = null;
    try {
      const firmRows = await queryRows(r, sql`
        SELECT
          id,
          name,
          slug,
          logo_url,
          address,
          st_number,
          tin_number,
          registration_no,
          sst_no,
          phone,
          email,
          show_master_documents
        FROM firms
        WHERE id = ${firmId}
        LIMIT 1
      `);
      firm = (firmRows[0] as any) ?? null;
    } catch (err) {
      const code = getPgCode(err);
      if (code === "42703") {
        schemaFallback = true;
        const firmRows = await queryRows(r, sql`
          SELECT
            id,
            name,
            slug,
            logo_url,
            address,
            st_number,
            tin_number,
            registration_no,
            sst_no,
            phone,
            email
          FROM firms
          WHERE id = ${firmId}
          LIMIT 1
        `);
        firm = (firmRows[0] as any) ?? null;
      } else {
        throw err;
      }
    }
    const bankAccounts = await (async () => {
      try {
        const rows = await (r as any).select().from(firmBankAccountsTable)
          .where(eq(firmBankAccountsTable.firmId, firmId));
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    })();

    const showMasterDocumentsResolved = schemaFallback ? true : (firm?.show_master_documents !== false);
    res.status(200).json({
      ok: true,
      data: {
        id: firmId,
        name: String(firm?.name ?? ""),
        slug: String(firm?.slug ?? ""),
        useMasterDocuments: Boolean(showMasterDocumentsResolved),
        showMasterDocuments: Boolean(showMasterDocumentsResolved),
        firmLetterheadEnabled: false,
        logoUrl: typeof firm?.logo_url === "string" ? firm.logo_url : "",
        address: typeof firm?.address === "string" ? firm.address : "",
        stNumber: typeof firm?.st_number === "string" ? firm.st_number : "",
        tinNumber: typeof firm?.tin_number === "string" ? firm.tin_number : "",
        registrationNo: typeof firm?.registration_no === "string" ? firm.registration_no : "",
        sstNo: typeof firm?.sst_no === "string" ? firm.sst_no : "",
        phone: typeof firm?.phone === "string" ? firm.phone : "",
        email: typeof firm?.email === "string" ? firm.email : "",
        bankAccounts: bankAccounts.map((b: any) => ({
          id: b.id,
          bankName: b.bankName,
          accountNo: b.accountNo,
          accountType: b.accountType,
          isDefault: b.isDefault,
        })),
      },
      fallback: schemaFallback,
    });
    if (!schemaFallback) {
      await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "settings.update", entityType: "firm", entityId: firmId, detail: `fields=${Object.keys(updates).join(",")}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    }
    return;
  } catch (err: any) {
    req.log.error({ err }, "firm_settings.update failed");
    res.status(200).json({
      ok: true,
      data: {
        id: req.firmId ?? null,
        name: "",
        slug: "",
        useMasterDocuments: true,
        showMasterDocuments: true,
        firmLetterheadEnabled: false,
        logoUrl: "",
        address: "",
        stNumber: "",
        tinNumber: "",
        registrationNo: "",
        sstNo: "",
        phone: "",
        email: "",
        bankAccounts: [],
      },
      fallback: true,
    });
    return;
  }
});

router.post("/firm-settings/bank-accounts", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log.error({ route: "POST /api/firm-settings/bank-accounts", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const firmId = req.firmId!;
    const { bankName, accountNo, accountType } = req.body;

    if (!bankName || !accountNo) {
      res.status(400).json({ error: "Bank name and account number are required" });
      return;
    }

    const resolvedType = accountType || "office";
    if (!VALID_ACCOUNT_TYPES.includes(resolvedType)) {
      res.status(400).json({ error: "Account type must be 'office' or 'client'" });
      return;
    }

    let ctxFirmId: string | null = null;
    let ctxIsFounder: string | null = null;
    try {
      const result = await r.execute(sql`
        select
          current_setting('app.current_firm_id', true) as firm_id,
          current_setting('app.is_founder', true) as is_founder
      `);
      const rows = Array.isArray(result)
        ? result
        : ("rows" in (result as any) ? (result as any).rows : []);
      const row = rows?.[0] as any;
      ctxFirmId = typeof row?.firm_id === "string" ? row.firm_id : null;
      ctxIsFounder = typeof row?.is_founder === "string" ? row.is_founder : null;
    } catch {
    }
    req.log.info({
      route: "POST /api/firm-settings/bank-accounts",
      userId: req.userId,
      firmId,
      insertFirmId: firmId,
      ctxFirmId,
      ctxIsFounder,
    }, "create route tenant context");

    const [account] = await r.insert(firmBankAccountsTable).values({
      firmId,
      bankName,
      accountNo,
      accountType: resolvedType,
    }).returning();

    res.status(201).json({
      id: account.id,
      bankName: account.bankName,
      accountNo: account.accountNo,
      accountType: account.accountType,
      isDefault: account.isDefault,
    });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "settings.bank_account.create", entityType: "firm_bank_account", entityId: account.id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    return;
  } catch (err: any) {
    const pg = (() => {
      let cur: any = err;
      for (let i = 0; i < 6 && cur; i++) {
        if (
          typeof cur?.code === "string"
          || typeof cur?.message === "string"
          || typeof cur?.detail === "string"
          || typeof cur?.constraint === "string"
        ) {
          const code = typeof cur.code === "string" ? cur.code : undefined;
          const message = typeof cur.message === "string" ? cur.message : undefined;
          const detail = typeof cur.detail === "string" ? cur.detail : undefined;
          const constraint = typeof cur.constraint === "string" ? cur.constraint : undefined;
          return { code, message, detail, constraint };
        }
        cur = cur?.cause;
      }
      return {};
    })();
    req.log.error({ err, pg }, "firm_settings.bank_accounts.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.patch("/firm-settings/bank-accounts/:id", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log.error({ route: "PATCH /api/firm-settings/bank-accounts/:id", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const firmId = req.firmId!;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;

    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid bank account ID" });
      return;
    }

    const { bankName, accountNo, accountType, isDefault } = req.body as {
      bankName?: string;
      accountNo?: string;
      accountType?: string;
      isDefault?: boolean;
    };

    const updates: Record<string, unknown> = {};
    if (bankName !== undefined) updates.bankName = bankName;
    if (accountNo !== undefined) updates.accountNo = accountNo;
    if (accountType !== undefined) {
      if (!VALID_ACCOUNT_TYPES.includes(accountType)) {
        res.status(400).json({ error: "Account type must be 'office' or 'client'" });
        return;
      }
      updates.accountType = accountType;
    }
    if (isDefault !== undefined) updates.isDefault = !!isDefault;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [existing] = await r
      .select()
      .from(firmBankAccountsTable)
      .where(and(eq(firmBankAccountsTable.id, id), eq(firmBankAccountsTable.firmId, firmId)));
    if (!existing) {
      res.status(404).json({ error: "Bank account not found" });
      return;
    }

    if (updates.isDefault === true) {
      await r
        .update(firmBankAccountsTable)
        .set({ isDefault: false })
        .where(and(eq(firmBankAccountsTable.firmId, firmId), sql`${firmBankAccountsTable.id} <> ${id}`));
    }

    const [updated] = await r
      .update(firmBankAccountsTable)
      .set(updates)
      .where(and(eq(firmBankAccountsTable.id, id), eq(firmBankAccountsTable.firmId, firmId)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Bank account not found" });
      return;
    }

    res.json({
      id: updated.id,
      bankName: updated.bankName,
      accountNo: updated.accountNo,
      accountType: updated.accountType,
      isDefault: updated.isDefault,
    });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "settings.bank_account.update", entityType: "firm_bank_account", entityId: updated.id, detail: `fields=${Object.keys(updates).join(",")}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    return;
  } catch (err: any) {
    const pg = (() => {
      let cur: any = err;
      for (let i = 0; i < 6 && cur; i++) {
        if (
          typeof cur?.code === "string"
          || typeof cur?.message === "string"
          || typeof cur?.detail === "string"
          || typeof cur?.constraint === "string"
        ) {
          const code = typeof cur.code === "string" ? cur.code : undefined;
          const message = typeof cur.message === "string" ? cur.message : undefined;
          const detail = typeof cur.detail === "string" ? cur.detail : undefined;
          const constraint = typeof cur.constraint === "string" ? cur.constraint : undefined;
          return { code, message, detail, constraint };
        }
        cur = cur?.cause;
      }
      return {};
    })();
    req.log.error({ err, pg }, "firm_settings.bank_accounts.update failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.delete("/firm-settings/bank-accounts/:id", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      req.log.error({ route: "DELETE /api/firm-settings/bank-accounts/:id", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const firmId = req.firmId!;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;

    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid bank account ID" });
      return;
    }

    const [existing] = await r.select().from(firmBankAccountsTable)
      .where(and(eq(firmBankAccountsTable.id, id), eq(firmBankAccountsTable.firmId, firmId)));

    if (!existing) { res.status(404).json({ error: "Bank account not found" }); return; }

    await r.delete(firmBankAccountsTable).where(and(eq(firmBankAccountsTable.id, id), eq(firmBankAccountsTable.firmId, firmId)));
    res.json({ success: true });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "settings.bank_account.delete", entityType: "firm_bank_account", entityId: id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    return;
  } catch (err: any) {
    const pg = (() => {
      let cur: any = err;
      for (let i = 0; i < 6 && cur; i++) {
        if (
          typeof cur?.code === "string"
          || typeof cur?.message === "string"
          || typeof cur?.detail === "string"
          || typeof cur?.constraint === "string"
        ) {
          const code = typeof cur.code === "string" ? cur.code : undefined;
          const message = typeof cur.message === "string" ? cur.message : undefined;
          const detail = typeof cur.detail === "string" ? cur.detail : undefined;
          const constraint = typeof cur.constraint === "string" ? cur.constraint : undefined;
          return { code, message, detail, constraint };
        }
        cur = cur?.cause;
      }
      return {};
    })();
    req.log.error({ err, pg }, "firm_settings.bank_accounts.delete failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
