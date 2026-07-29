import express, { type Response, type Router as ExpressRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { caseAssignmentsTable, casePurchasersTable, casesTable, clientsTable, db, developersTable, invoicesTable, paymentVouchersTable, projectsTable, quotationsTable, receiptsTable, usersTable } from "@workspace/db";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import OpenAI from "openai";
import * as XLSX from "xlsx";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, requireRlsDb, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { computeInvoiceMetrics } from "../services/invoice-metrics.js";

type SqlChunk = ReturnType<typeof sql>;

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

function safeFilenameAscii(filename: string): string {
  const clean = String(filename || "export").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return clean.length ? clean : "export";
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      const err = new Error("UNSUPPORTED_FILE_TYPE");
      (err as any).code = "UNSUPPORTED_FILE_TYPE";
      cb(err);
      return;
    }
    cb(null, true);
  },
});

async function queryRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

async function queryRowsFrom(
  executor: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  query: ReturnType<typeof sql>,
): Promise<Record<string, unknown>[]> {
  const result = await executor.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const AiStatementTx = z.object({
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(1).max(2000),
  reference_no: z.preprocess((v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s ? s : null;
  }, z.string().max(200).nullable()),
  withdrawal: z.preprocess((v) => {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return v;
    const s = String(v).replace(/,/g, "").trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : v;
  }, z.number().finite().nonnegative()),
  deposit: z.preprocess((v) => {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return v;
    const s = String(v).replace(/,/g, "").trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : v;
  }, z.number().finite().nonnegative()),
  balance: z.preprocess((v) => {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return v;
    const s = String(v).replace(/,/g, "").trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : v;
  }, z.number().finite().nonnegative()),
});
const AiStatementTxList = z.array(AiStatementTx);

const AI_BANK_STATEMENT_SYSTEM_PROMPT = [
  "你是一個專業的馬來西亞銀行會計。請分析以下銀行對帳單的文本，精準提取每一筆交易明細，並以 JSON 陣列回傳。",
  "【重要排版特性與規則】：",
  "1. 這份對帳單來自 RHB, CIMB, Maybank, Public Bank 或 Alliance Bank。",
  "2. 忽略頁首、頁尾、頁碼。",
  "3. 嚴格忽略『Brought Forward (B/F)』與『Carried Forward (C/F)』的餘額行，不要把它們當作交易。",
  "4. 將馬來西亞常見的日期格式 (如 DD/MM/YYYY 或 DD-MMM-YY) 統一轉換為 YYYY-MM-DD。",
  "5. 金額欄位可能包含千分位逗號 (如 1,500.00)，請轉換為純數字浮點數 (1500.00)。無金額則補 0。",
  "6. 將多行的 Description 組合為單一字串。嘗試從 Description 中分離出支票號碼 (Cheque No) 或參考號碼 (Ref) 填入 reference_no，若無則填 null。",
  "7. 欄位為：transaction_date, description, reference_no, withdrawal, deposit, balance。",
].join("\n");

function extractJsonArray(text: string): string | null {
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first < 0 || last < 0 || last <= first) return null;
  return text.slice(first, last + 1);
}

function isCarryForwardLine(description: string): boolean {
  const s = String(description || "").toLowerCase();
  if (!s) return false;
  if (s.includes("brought forward") || s.includes("carried forward")) return true;
  if (/\b(b\/f|c\/f)\b/.test(s)) return true;
  return false;
}

function parseNumeric12_2(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "").trim()) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseDateYmd(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function parseIdInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

const CATEGORIES = ["legal_fee", "disbursement", "stamp_duty", "professional_fee", "other"] as const;

router.get("/accounting", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req);
  const rows = await queryRowsFrom(r, sql`
    SELECT be.id, be.case_id, be.description, be.amount, be.quantity,
      be.is_paid as "isPaid", be.created_at as "billedAt",
      c.reference_no as "caseReferenceNo"
    FROM case_billing_entries be
    LEFT JOIN cases c ON be.case_id = c.id
    WHERE be.firm_id = ${req.firmId!}
    ORDER BY be.created_at DESC
    LIMIT 100
  `);
  res.json(rows);
});

router.get("/accounting/cases/:caseId/summary", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = Number(req.params.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    res.status(400).json({ error: "Invalid caseId" });
    return;
  }

  const r = requireRlsDb(req) as unknown as Pick<typeof db, "select">;
  const firmId = req.firmId!;
  const [row] = await r
    .select({
      id: casesTable.id,
      referenceNo: casesTable.referenceNo,
      caseType: casesTable.caseType,
      status: casesTable.status,
      createdAt: casesTable.createdAt,
      projectName: projectsTable.name,
      developerName: developersTable.name,
      parcelNo: casesTable.parcelNo,
      spaPrice: casesTable.spaPrice,
      loanAmountNum: sql<string | null>`${casesTable.loanDetails}->>'loanAmountNum'`,
      borrowers: casesTable.borrowers,
      outstandingBalance: casesTable.outstandingBalance,
    })
    .from(casesTable)
    .leftJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .leftJoin(developersTable, eq(developersTable.id, casesTable.developerId))
    .where(and(eq(casesTable.firmId, firmId), eq(casesTable.id, caseId)))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const purchasers = await r
    .select({ name: clientsTable.name })
    .from(casePurchasersTable)
    .innerJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
    .where(eq(casePurchasersTable.caseId, caseId))
    .orderBy(casePurchasersTable.orderNo);

  const assignments = await r
    .select({
      roleInCase: caseAssignmentsTable.roleInCase,
      userId: usersTable.id,
      userName: usersTable.name,
    })
    .from(caseAssignmentsTable)
    .innerJoin(usersTable, eq(usersTable.id, caseAssignmentsTable.userId))
    .where(and(eq(caseAssignmentsTable.caseId, caseId), sql`${caseAssignmentsTable.unassignedAt} IS NULL` as any));

  const lawyerName =
    assignments.find((a) => String(a.roleInCase ?? "") === "lawyer")?.userName
    ?? null;
  const clerkName =
    assignments.find((a) => String(a.roleInCase ?? "") === "clerk")?.userName
    ?? null;

  const [latestQuotation] = await r
    .select({ id: quotationsTable.id, status: quotationsTable.status })
    .from(quotationsTable)
    .where(and(eq(quotationsTable.firmId, firmId), eq(quotationsTable.caseId, caseId), sql`${quotationsTable.deletedAt} IS NULL` as any))
    .orderBy(desc(quotationsTable.createdAt))
    .limit(1);

  const [latestInvoice] = await r
    .select({ id: invoicesTable.id, status: invoicesTable.status, invoiceNo: invoicesTable.invoiceNo, amountDue: invoicesTable.amountDue })
    .from(invoicesTable)
    .where(and(eq(invoicesTable.firmId, firmId), eq(invoicesTable.caseId, caseId), sql`${invoicesTable.deletedAt} IS NULL` as any))
    .orderBy(desc(invoicesTable.createdAt))
    .limit(1);

  const [latestReceipt] = await r
    .select({ id: receiptsTable.id, receiptNo: receiptsTable.receiptNo, amount: receiptsTable.amount, receivedDate: receiptsTable.receivedDate })
    .from(receiptsTable)
    .where(and(eq(receiptsTable.firmId, firmId), eq(receiptsTable.caseId, caseId), eq(receiptsTable.isReversed, false)))
    .orderBy(desc(receiptsTable.createdAt))
    .limit(1);

  const [pvCountRow] = await r
    .select({ c: sql<string>`COUNT(*)` })
    .from(paymentVouchersTable)
    .where(and(eq(paymentVouchersTable.firmId, firmId), eq(paymentVouchersTable.caseId, caseId)));

  const purchaserNames = purchasers.map((p) => String(p.name ?? "").trim()).filter(Boolean);
  const borrowerNames =
    Array.isArray(row.borrowers)
      ? (row.borrowers as any[])
        .map((b) => (b && typeof b === "object" ? String((b as any).name ?? "").trim() : ""))
        .filter(Boolean)
      : [];

  res.json({
    case: {
      id: row.id,
      referenceNo: row.referenceNo,
      caseType: row.caseType,
      status: row.status,
      openDate: row.createdAt,
      projectName: row.projectName,
      developerName: row.developerName,
      parcelNo: row.parcelNo,
      spaPrice: row.spaPrice,
      loanAmountNum: row.loanAmountNum,
      outstandingBalance: row.outstandingBalance,
      responsibleLawyer: lawyerName,
      assignedClerk: clerkName,
    },
    parties: {
      purchasers: purchaserNames,
      borrowers: borrowerNames,
    },
    accounting: {
      latestQuotationId: latestQuotation?.id ?? null,
      latestQuotationStatus: latestQuotation?.status ?? null,
      latestInvoiceId: latestInvoice?.id ?? null,
      latestInvoiceNo: latestInvoice?.invoiceNo ?? null,
      latestInvoiceStatus: latestInvoice?.status ?? null,
      latestInvoiceAmountDue: latestInvoice?.amountDue ?? null,
      latestReceiptId: latestReceipt?.id ?? null,
      latestReceiptNo: latestReceipt?.receiptNo ?? null,
      latestReceiptAmount: latestReceipt?.amount ?? null,
      latestReceiptDate: latestReceipt?.receivedDate ?? null,
      paymentVoucherCount: Number(pvCountRow?.c ?? 0),
    },
  });
});

router.get("/cases/:caseId/billing", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req);
  const caseId = Number(req.params.caseId);
  const rows = await queryRowsFrom(r, sql`
    SELECT be.*, u.name as created_by_name
    FROM case_billing_entries be
    LEFT JOIN users u ON be.created_by = u.id
    WHERE be.case_id = ${caseId} AND be.firm_id = ${req.firmId!}
    ORDER BY be.created_at ASC
  `);
  res.json(rows);
});

router.post("/cases/:caseId/billing", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const { category, description, amount, quantity, isPaid } = req.body as {
    category: string;
    description: string;
    amount: number;
    quantity?: number;
    isPaid?: boolean;
  };

  if (!description || amount == null) {
    res.status(400).json({ error: "description and amount are required" });
    return;
  }

  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }

  const created = await r.transaction(async (tx) => {
    const rows = await queryRowsFrom(tx, sql`
      INSERT INTO case_billing_entries (case_id, firm_id, category, description, amount, quantity, is_paid, created_by)
      VALUES (${caseId}, ${req.firmId!}, ${category ?? "disbursement"}, ${description}, ${amount}, ${quantity ?? 1}, ${isPaid ?? false}, ${req.userId!})
      RETURNING *
    `);
    const created = rows[0];
    const createdId = created && typeof created === "object" && "id" in created && typeof (created as { id?: unknown }).id === "number"
      ? (created as { id: number }).id
      : undefined;
    await writeAuditLog(
      { firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.billing.create", entityType: "case_billing_entry", entityId: createdId, detail: `caseId=${caseId} amount=${amount}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
      { db: tx, strict: true },
    );
    return created;
  });

  res.status(201).json(created);
});

router.patch("/cases/:caseId/billing/:entryId", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const entryId = Number(req.params.entryId);
  const { category, description, amount, quantity, isPaid } = req.body as Partial<{
    category: string;
    description: string;
    amount: number;
    quantity: number;
    isPaid: boolean;
  }>;

  const parts: SqlChunk[] = [];

  if (category !== undefined) parts.push(sql`category = ${category}`);
  if (description !== undefined) parts.push(sql`description = ${description}`);
  if (amount !== undefined) parts.push(sql`amount = ${amount}`);
  if (quantity !== undefined) parts.push(sql`quantity = ${quantity}`);
  if (isPaid !== undefined) {
    parts.push(sql`is_paid = ${isPaid}`);
    parts.push(isPaid ? sql`paid_at = NOW()` : sql`paid_at = NULL`);
  }
  parts.push(sql`updated_at = NOW()`);

  if (parts.length <= 1) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const setClause = sql.join(parts, sql`, `);

  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }

  const updated = await r.transaction(async (tx) => {
    const rows = await queryRowsFrom(tx, sql`
      UPDATE case_billing_entries SET ${setClause}
      WHERE id = ${entryId} AND case_id = ${caseId} AND firm_id = ${req.firmId!}
      RETURNING *
    `);
    if (!rows[0]) return null;
    await writeAuditLog(
      { firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.billing.update", entityType: "case_billing_entry", entityId: entryId, detail: `caseId=${caseId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
      { db: tx, strict: true },
    );
    return rows[0];
  });

  if (!updated) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json(updated);
});

router.delete("/cases/:caseId/billing/:entryId", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const entryId = Number(req.params.entryId);

  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }

  const ok = await r.transaction(async (tx) => {
    const rows = await queryRowsFrom(tx, sql`
      DELETE FROM case_billing_entries
      WHERE id = ${entryId} AND case_id = ${caseId} AND firm_id = ${req.firmId!}
      RETURNING *
    `);
    if (!rows[0]) return false;
    await writeAuditLog(
      { firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.billing.delete", entityType: "case_billing_entry", entityId: entryId, detail: `caseId=${caseId}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
      { db: tx, strict: true },
    );
    return true;
  });

  if (!ok) { res.status(404).json({ error: "Entry not found" }); return; }
  res.sendStatus(204);
});

router.get("/cases/:caseId/billing/summary", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req);
  const caseId = Number(req.params.caseId);
  const rows = await queryRowsFrom(r, sql`
    SELECT 
      category,
      COUNT(*) as entry_count,
      SUM(amount * quantity) as total,
      SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as paid,
      SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as outstanding
    FROM case_billing_entries
    WHERE case_id = ${caseId} AND firm_id = ${req.firmId!}
    GROUP BY category
    ORDER BY category
  `);

  const overall = await queryRowsFrom(r, sql`
    SELECT 
      COUNT(*) as entry_count,
      SUM(amount * quantity) as total,
      SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as paid,
      SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as outstanding
    FROM case_billing_entries
    WHERE case_id = ${caseId} AND firm_id = ${req.firmId!}
  `);

  res.json({ byCategory: rows, overall: overall[0] ?? { total: 0, paid: 0, outstanding: 0 } });
});

router.get("/accounting/invoice-metrics", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req) as unknown as typeof db;
  const metrics = await computeInvoiceMetrics(r, { firmId: req.firmId! });
  res.json(metrics);
});

router.get("/accounting/summary", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req);
  const topCases = await queryRowsFrom(r, sql`
    SELECT c.reference_no, c.id as case_id,
      SUM(be.amount * be.quantity) as total,
      SUM(CASE WHEN be.is_paid THEN be.amount * be.quantity ELSE 0 END) as paid,
      SUM(CASE WHEN NOT be.is_paid THEN be.amount * be.quantity ELSE 0 END) as outstanding
    FROM case_billing_entries be
    JOIN cases c ON be.case_id = c.id
    WHERE be.firm_id = ${req.firmId!}
      AND c.deleted_at IS NULL
    GROUP BY c.id, c.reference_no
    ORDER BY total DESC
    LIMIT 10
  `);

  const monthly = await queryRowsFrom(r, sql`
    SELECT 
      TO_CHAR(created_at, 'YYYY-MM') as month,
      SUM(amount * quantity) as total,
      COUNT(*) as entry_count
    FROM case_billing_entries
    WHERE firm_id = ${req.firmId!}
    GROUP BY TO_CHAR(created_at, 'YYYY-MM')
    ORDER BY month DESC
    LIMIT 12
  `);

  const totals = await queryRowsFrom(r, sql`
    SELECT 
      SUM(amount * quantity) as total,
      SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as paid,
      SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as outstanding,
      COUNT(DISTINCT case_id) as case_count
    FROM case_billing_entries
    WHERE firm_id = ${req.firmId!}
  `);

  const byCategory = await queryRowsFrom(r, sql`
    SELECT category, SUM(amount * quantity) as total
    FROM case_billing_entries
    WHERE firm_id = ${req.firmId!}
    GROUP BY category
    ORDER BY total DESC
  `);

  res.json({
    totals: totals[0] ?? { total: 0, paid: 0, outstanding: 0, case_count: 0 },
    byCategory,
    topCases,
    monthly: monthly.reverse(),
  });
});

router.get("/accounting/bank-accounts", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req);
  const rows = await queryRowsFrom(r, sql`
    SELECT
      id,
      bank_name,
      account_name,
      account_no,
      account_type,
      gl_code,
      opening_balance,
      opening_balance_date,
      is_default,
      created_at,
      updated_at
    FROM firm_bank_accounts
    WHERE firm_id = ${req.firmId!}
    ORDER BY is_default DESC, id DESC
  `);
  res.json({ data: rows });
});

router.post("/accounting/bank-accounts", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }

  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const bankName = typeof body.bankName === "string" ? body.bankName.trim() : "";
  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  const accountNo = typeof body.accountNo === "string" ? body.accountNo.trim() : "";
  const accountType = typeof body.accountType === "string" ? body.accountType.trim() : "office";
  const glCode = typeof body.glCode === "string" ? body.glCode.trim() : "";
  const openingBalance = parseNumeric12_2(body.openingBalance) ?? 0;
  const openingBalanceDate = parseDateYmd(body.openingBalanceDate);
  const isDefault = Boolean(body.isDefault ?? false);

  if (!bankName || !accountNo) { res.status(422).json({ error: "bankName and accountNo are required" }); return; }
  if (openingBalanceDate === null) { res.status(422).json({ error: "openingBalanceDate is required (YYYY-MM-DD)" }); return; }

  const created = await r.transaction(async (tx) => {
    const rows = await queryRowsFrom(tx, sql`
      INSERT INTO firm_bank_accounts
        (firm_id, bank_name, account_name, account_no, account_type, gl_code, opening_balance, opening_balance_date, is_default, created_at, updated_at)
      VALUES
        (${req.firmId!}, ${bankName}, ${accountName || null}, ${accountNo}, ${accountType}, ${glCode || null}, ${openingBalance}, ${openingBalanceDate}, ${isDefault}, now(), now())
      RETURNING *
    `);
    const created = rows[0];
    await writeAuditLog(
      { firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.bank_accounts.create", entityType: "firm_bank_account", detail: `bank=${bankName} accountNo=${accountNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
      { db: tx, strict: true },
    );
    return created;
  });
  res.status(201).json(created);
});

router.patch("/accounting/bank-accounts/:id", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = parseIdInt((req.params as any).id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const patch: SqlChunk[] = [];

  if (Object.prototype.hasOwnProperty.call(body, "bankName")) {
    const v = typeof body.bankName === "string" ? body.bankName.trim() : "";
    if (!v) { res.status(422).json({ error: "bankName cannot be empty" }); return; }
    patch.push(sql`bank_name = ${v}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "accountName")) {
    const v = typeof body.accountName === "string" ? body.accountName.trim() : "";
    patch.push(sql`account_name = ${v || null}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "accountNo")) {
    const v = typeof body.accountNo === "string" ? body.accountNo.trim() : "";
    if (!v) { res.status(422).json({ error: "accountNo cannot be empty" }); return; }
    patch.push(sql`account_no = ${v}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "accountType")) {
    const v = typeof body.accountType === "string" ? body.accountType.trim() : "";
    patch.push(sql`account_type = ${v || "office"}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "glCode")) {
    const v = typeof body.glCode === "string" ? body.glCode.trim() : "";
    patch.push(sql`gl_code = ${v || null}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "openingBalance")) {
    const v = parseNumeric12_2(body.openingBalance);
    if (v === null) { res.status(422).json({ error: "openingBalance invalid" }); return; }
    patch.push(sql`opening_balance = ${v}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "openingBalanceDate")) {
    const v = parseDateYmd(body.openingBalanceDate);
    if (!v) { res.status(422).json({ error: "openingBalanceDate invalid (YYYY-MM-DD)" }); return; }
    patch.push(sql`opening_balance_date = ${v}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "isDefault")) {
    patch.push(sql`is_default = ${Boolean(body.isDefault)}`);
  }

  if (patch.length === 0) { res.status(400).json({ error: "No changes" }); return; }
  patch.push(sql`updated_at = now()`);

  const updated = await r.transaction(async (tx) => {
    const rows = await queryRowsFrom(tx, sql`
      UPDATE firm_bank_accounts
      SET ${sql.join(patch, sql`, `)}
      WHERE firm_id = ${req.firmId!} AND id = ${id}
      RETURNING *
    `);
    const updated = rows[0];
    if (!updated) return null;
    await writeAuditLog(
      { firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.bank_accounts.update", entityType: "firm_bank_account", detail: `id=${id}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
      { db: tx, strict: true },
    );
    return updated;
  });

  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/accounting/bank-accounts/:id", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = parseIdInt((req.params as any).id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const ok = await r.transaction(async (tx) => {
    const rows = await queryRowsFrom(tx, sql`
      DELETE FROM firm_bank_accounts
      WHERE firm_id = ${req.firmId!} AND id = ${id}
      RETURNING id
    `);
    if (!rows[0]) return false;
    await writeAuditLog(
      { firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.bank_accounts.delete", entityType: "firm_bank_account", detail: `id=${id}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] },
      { db: tx, strict: true },
    );
    return true;
  });
  if (!ok) { res.status(404).json({ error: "Not found" }); return; }
  res.sendStatus(204);
});

router.post(
  "/accounting/bank-statements/parse",
  requireAuth,
  requireFirmUser,
  requirePermission("accounting", "write"),
  upload.single("file"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const r = requireRlsDb(req);
    const file = (req as any).file as { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined;
    if (!file?.buffer) {
      res.status(400).json({ error: "Missing file" });
      return;
    }
    const bankAccountId = parseIdInt((req.body as any)?.bankAccountId);
    if (!bankAccountId) { res.status(422).json({ error: "bankAccountId is required" }); return; }
    const acct = await queryRowsFrom(r, sql`SELECT id FROM firm_bank_accounts WHERE firm_id = ${req.firmId!} AND id = ${bankAccountId} LIMIT 1`);
    if (!acct[0]) { res.status(404).json({ error: "Bank account not found" }); return; }

    let rawText = "";
    try {
      const parser = new PDFParse({ data: file.buffer });
      const parsed = await parser.getText();
      rawText = String(parsed?.text ?? "").trim();
      await parser.destroy().catch(() => undefined);
    } catch {
      res.status(400).json({ error: "無法提取文字，請確保上傳的是非加密且文字可選取的 PDF。" });
      return;
    }

    if (rawText.length < 30) {
      res.status(400).json({ error: "無法提取文字，請確保上傳的是非加密且文字可選取的 PDF。" });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "OPENAI_API_KEY is not configured" });
      return;
    }

    const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini");
    const client = new OpenAI({ apiKey });

    const prompt = [
      "只輸出 JSON 陣列，不要加上任何額外文字或 markdown。",
      "",
      "Bank Statement Text:",
      rawText.slice(0, 120_000),
    ].join("\n");

    let aiText = "";
    try {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: AI_BANK_STATEMENT_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      });
      aiText = String(completion.choices?.[0]?.message?.content ?? "").trim();
    } catch {
      res.status(500).json({ error: "AI statement parsing failed" });
      return;
    }

    let parsedTx: unknown;
    try {
      const jsonArrayText = extractJsonArray(aiText) ?? aiText;
      parsedTx = JSON.parse(jsonArrayText);
    } catch {
      res.status(500).json({ error: "AI output is not valid JSON" });
      return;
    }

    const txList = AiStatementTxList.safeParse(parsedTx);
    if (!txList.success) {
      res.status(500).json({ error: "AI output schema validation failed" });
      return;
    }

    const items = txList.data.slice(0, 5000);
    if (items.length === 0) {
      res.status(422).json({ error: "No transactions found from statement" });
      return;
    }

    const values: SqlChunk[] = [];
    for (const t of items) {
      const d = parseDateYmd(t.transaction_date);
      if (!d) continue;
      if (isCarryForwardLine(t.description)) continue;
      const withdrawal = t.withdrawal > 0 ? Math.round(t.withdrawal * 100) / 100 : null;
      const deposit = t.deposit > 0 ? Math.round(t.deposit * 100) / 100 : null;
      const balance = t.balance > 0 ? Math.round(t.balance * 100) / 100 : null;
      const refNo = t.reference_no && t.reference_no.trim() ? t.reference_no.trim() : null;

      values.push(sql`(${req.firmId!}, ${bankAccountId}, ${d}, ${t.description}, ${refNo}, ${withdrawal}, ${deposit}, ${balance}, false)`);
    }

    if (values.length === 0) {
      res.status(422).json({ error: "No valid transactions found after validation" });
      return;
    }

    try {
      const inserted = await r.transaction(async (tx) => {
        const rows = await queryRowsFrom(tx, sql`
          INSERT INTO bank_transactions (firm_id, bank_account_id, transaction_date, description, reference_no, withdrawal, deposit, balance, is_exported)
          VALUES ${sql.join(values, sql`, `)}
          RETURNING id
        `);
        await writeAuditLog(
          {
            firmId: req.firmId,
            actorId: req.userId,
            actorType: req.userType,
            action: "accounting.bank_statements.parse.ai",
            entityType: "bank_transaction",
            detail: `file=${String(file.originalname ?? "")} inserted=${rows.length}`,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"],
          },
          { db: tx, strict: true },
        );
        return rows.length;
      });
      res.status(201).json({ inserted });
    } catch {
      res.status(500).json({ error: "Failed to save parsed transactions" });
      return;
    }
  }
);

router.get("/accounting/bank-transactions", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req);
  const firmId = req.firmId!;
  const bankAccountId = parseIdInt((req.query as any)?.bankAccountId);
  if (!bankAccountId) { res.status(422).json({ error: "bankAccountId is required" }); return; }
  const acct = await queryRowsFrom(r, sql`SELECT id FROM firm_bank_accounts WHERE firm_id = ${firmId} AND id = ${bankAccountId} LIMIT 1`);
  if (!acct[0]) { res.status(404).json({ error: "Bank account not found" }); return; }

  const rows = await queryRowsFrom(r, sql`
    SELECT
      id,
      bank_account_id,
      case_id,
      transaction_date,
      description,
      reference_no,
      withdrawal,
      deposit,
      balance,
      is_exported,
      exported_at,
      created_at,
      updated_at
    FROM bank_transactions
    WHERE firm_id = ${firmId}
      AND bank_account_id = ${bankAccountId}
    ORDER BY transaction_date DESC, created_at DESC
    LIMIT 2000
  `);

  const boundCaseIds = Array.from(new Set(
    rows
      .map((r: any) => parseIdInt(r.case_id))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0),
  ));

  const caseInfoRows = boundCaseIds.length
    ? await queryRowsFrom(r, sql`
        SELECT
          c.id,
          c.reference_no,
          COALESCE(cl.name, '') as client_name
        FROM cases c
        LEFT JOIN case_purchasers cp ON cp.case_id = c.id AND cp.role = 'main'
        LEFT JOIN clients cl ON cl.id = cp.client_id AND cl.firm_id = ${firmId}
        WHERE c.firm_id = ${firmId}
          AND c.id IN (${sql.join(boundCaseIds.map((id) => sql`${id}`), sql`, `)})
          AND c.deleted_at IS NULL
      `)
    : [];

  const caseInfoMap = new Map<number, { case_id: number; title: string }>();
  for (const r of caseInfoRows as any[]) {
    const id = parseIdInt(r.id);
    if (!id) continue;
    const ref = String((r as any).reference_no ?? "");
    const clientName = String((r as any).client_name ?? "");
    const title = clientName ? `${ref} • ${clientName}` : ref;
    caseInfoMap.set(id, { case_id: id, title });
  }

  const hasCandidates = rows.some((r: any) => !parseIdInt(r.case_id) && (toNumber(r.deposit) ?? 0) > 0);
  let candidates: Array<{ case_id: number; title: string; client_name: string }> = [];
  let outstandingMap = new Map<number, number>();

  if (hasCandidates) {
    const candidateRows = await queryRowsFrom(r, sql`
      SELECT
        c.id,
        c.reference_no,
        COALESCE(cl.name, '') as client_name
      FROM cases c
      LEFT JOIN case_purchasers cp ON cp.case_id = c.id AND cp.role = 'main'
      LEFT JOIN clients cl ON cl.id = cp.client_id AND cl.firm_id = ${firmId}
      WHERE c.firm_id = ${firmId}
        AND c.deleted_at IS NULL
      ORDER BY c.updated_at DESC
      LIMIT 200
    `);

    candidates = (candidateRows as any[])
      .map((r) => {
        const id = parseIdInt(r.id);
        if (!id) return null;
        const ref = String((r as any).reference_no ?? "");
        const clientName = String((r as any).client_name ?? "");
        const title = clientName ? `${ref} • ${clientName}` : ref;
        return { case_id: id, title, client_name: clientName };
      })
      .filter(Boolean) as Array<{ case_id: number; title: string; client_name: string }>;

    const candidateIds = candidates.map((c) => c.case_id);
    if (candidateIds.length) {
      const outstandingRows = await queryRowsFrom(r, sql`
        SELECT
          case_id,
          SUM(CASE WHEN status = 'void' THEN 0 ELSE amount_due END) as outstanding
        FROM invoices
        WHERE firm_id = ${firmId}
          AND deleted_at IS NULL
          AND status IN ('issued','partially_paid','paid','void')
          AND case_id IN (${sql.join(candidateIds.map((id) => sql`${id}`), sql`, `)})
        GROUP BY case_id
      `);

      for (const r of outstandingRows as any[]) {
        const id = parseIdInt(r.case_id);
        if (!id) continue;
        const out = toNumber(r.outstanding);
        if (out == null) continue;
        outstandingMap.set(id, Math.round(out * 100) / 100);
      }
    }
  }

  const data = (rows as any[]).map((r) => {
    const caseId = parseIdInt(r.case_id);
    const deposit = toNumber(r.deposit) ?? 0;
    const descLower = String(r.description ?? "").toLowerCase();

    const boundCase = caseId ? (caseInfoMap.get(caseId) ?? { case_id: caseId, title: `Case #${caseId}` }) : null;
    let recommendedCase: { case_id: number; title: string; match_reason: string } | null = null;

    if (!caseId && deposit > 0 && candidates.length) {
      const amountMatch = (() => {
        for (const c of candidates) {
          const outstanding = outstandingMap.get(c.case_id);
          if (outstanding == null) continue;
          if (Math.abs(outstanding - deposit) <= 0.005) return { c, outstanding };
        }
        return null;
      })();

      if (amountMatch) {
        recommendedCase = {
          case_id: amountMatch.c.case_id,
          title: amountMatch.c.title,
          match_reason: `Amount match: deposit RM ${deposit.toFixed(2)} equals outstanding RM ${amountMatch.outstanding.toFixed(2)}`,
        };
      } else {
        const nameMatch = candidates.find((c) => {
          const n = String(c.client_name ?? "").trim().toLowerCase();
          if (!n || n.length < 3) return false;
          return descLower.includes(n);
        });
        if (nameMatch) {
          recommendedCase = {
            case_id: nameMatch.case_id,
            title: nameMatch.title,
            match_reason: `Name match: description contains '${nameMatch.client_name}'`,
          };
        }
      }
    }

    return {
      ...r,
      case: boundCase,
      recommended_case: recommendedCase,
    };
  });

  res.json({ data });
});

router.get("/accounting/cases/search", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req);
  const firmId = req.firmId!;
  const q = typeof (req.query as any)?.query === "string" ? String((req.query as any).query).trim() : "";
  if (!q) { res.json({ data: [] }); return; }

  const like = `%${q.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const rows = await queryRowsFrom(r, sql`
    SELECT
      c.id,
      c.reference_no,
      COALESCE(cl.name, '') as client_name
    FROM cases c
    LEFT JOIN case_purchasers cp ON cp.case_id = c.id AND cp.role = 'main'
    LEFT JOIN clients cl ON cl.id = cp.client_id AND cl.firm_id = ${firmId}
    WHERE c.firm_id = ${firmId}
      AND c.deleted_at IS NULL
      AND (
        c.reference_no ILIKE ${like}
        OR COALESCE(cl.name, '') ILIKE ${like}
      )
    ORDER BY c.updated_at DESC
    LIMIT 20
  `);

  const data = (rows as any[]).map((r) => {
    const id = parseIdInt(r.id);
    const ref = String(r.reference_no ?? "");
    const clientName = String(r.client_name ?? "");
    const title = clientName ? `${ref} • ${clientName}` : ref;
    return { case_id: id, title };
  }).filter((x) => x.case_id);

  res.json({ data });
});

router.post("/accounting/bank-transactions/:id/bind-case", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const firmId = req.firmId!;
  const rlsDb = requireRlsDb(req);
  const id = String(req.params.id ?? "").trim();
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const caseId = parseIdInt((body as any).caseId ?? (body as any).case_id);
  if (!caseId) { res.status(422).json({ error: "caseId is required" }); return; }

  const fail = (status: number, message: string) => {
    const e = new Error(message) as any;
    e.status = status;
    throw e;
  };

  try {
    const result = await rlsDb.transaction(async (tx) => {
      const txRows = await queryRowsFrom(tx as any, sql`
        SELECT id, bank_account_id, case_id, transaction_date, description, deposit
        FROM bank_transactions
        WHERE firm_id = ${firmId} AND id = ${id}::uuid
        FOR UPDATE
      `);
      const bt = txRows[0] as any;
      if (!bt) fail(404, "Bank transaction not found");
      if (parseIdInt(bt.case_id)) fail(409, "Bank transaction already bound");

      const deposit = toNumber(bt.deposit) ?? 0;
      if (deposit <= 0) fail(422, "Only deposit transactions can be bound");

      const caseRows = await queryRowsFrom(tx as any, sql`
        SELECT id, reference_no
        FROM cases
        WHERE firm_id = ${firmId} AND id = ${caseId} AND deleted_at IS NULL
        LIMIT 1
      `);
      const c = caseRows[0] as any;
      if (!c) fail(404, "Case not found");

      const acctRows = await queryRowsFrom(tx as any, sql`
        SELECT account_type
        FROM firm_bank_accounts
        WHERE firm_id = ${firmId} AND id = ${bt.bank_account_id}
        LIMIT 1
      `);
      const accountType = String((acctRows[0] as any)?.account_type ?? "client");
      const entryCategory = accountType === "office" ? "office" : "client";
      const entryType = accountType === "office" ? "payment_received" : "trust_received";

      await tx.execute(sql`
        UPDATE bank_transactions
        SET case_id = ${caseId}, updated_at = NOW()
        WHERE firm_id = ${firmId} AND id = ${id}::uuid
      `);

      await tx.execute(sql`
        INSERT INTO case_ledgers (firm_id, case_id, transaction_date, entry_category, entry_type, description, amount, created_at, updated_at)
        VALUES (${firmId}, ${caseId}, ${bt.transaction_date}, ${entryCategory}, ${entryType}, ${bt.description}, ${deposit}, NOW(), NOW())
      `);

      await writeAuditLog(
        {
          firmId: req.firmId,
          actorId: req.userId,
          actorType: req.userType,
          action: "accounting.bank_transactions.bind_case",
          entityType: "bank_transaction",
          detail: `id=${id} caseId=${caseId} entryType=${entryType}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: tx, strict: true },
      );

      return {
        case_id: caseId,
        case_title: String(c.reference_no ?? ""),
        entry_category: entryCategory,
        entry_type: entryType,
      };
    });

    res.json({ ok: true, ...result });
  } catch (err: any) {
    const status = err?.status && Number.isInteger(err.status) ? Number(err.status) : 500;
    res.status(status).json({ error: status === 500 ? "Bind failed" : String(err?.message ?? "Bind failed") });
  }
});

router.patch("/accounting/bank-transactions/:id", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = requireRlsDb(req);
  const id = String(req.params.id ?? "").trim();
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};
  const parts: SqlChunk[] = [];

  if (Object.prototype.hasOwnProperty.call(body, "transactionDate")) {
    const v = typeof body.transactionDate === "string" ? body.transactionDate.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { res.status(422).json({ error: "Invalid transactionDate" }); return; }
    parts.push(sql`transaction_date = ${v}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    parts.push(sql`description = ${typeof body.description === "string" ? body.description : ""}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "referenceNo")) {
    const v = typeof body.referenceNo === "string" ? body.referenceNo : null;
    parts.push(sql`reference_no = ${v as any}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "withdrawal")) {
    const v = body.withdrawal === null ? null : Number(body.withdrawal);
    parts.push(sql`withdrawal = ${Number.isFinite(v as any) ? v : null}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "deposit")) {
    const v = body.deposit === null ? null : Number(body.deposit);
    parts.push(sql`deposit = ${Number.isFinite(v as any) ? v : null}`);
  }
  if (Object.prototype.hasOwnProperty.call(body, "balance")) {
    const v = body.balance === null ? null : Number(body.balance);
    parts.push(sql`balance = ${Number.isFinite(v as any) ? v : null}`);
  }

  if (parts.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  parts.push(sql`updated_at = NOW()`);
  const setClause = sql.join(parts, sql`, `);

  try {
    const updated = await r.transaction(async (tx) => {
      const rows = await queryRowsFrom(tx, sql`
        UPDATE bank_transactions
        SET ${setClause}
        WHERE id = ${id}::uuid AND firm_id = ${req.firmId!}
        RETURNING *
      `);
      const row = rows[0];
      if (!row) return null;
      await writeAuditLog(
        {
          firmId: req.firmId,
          actorId: req.userId,
          actorType: req.userType,
          action: "accounting.bank_transactions.update",
          entityType: "bank_transaction",
          detail: `id=${id}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: tx, strict: true },
      );
      return row;
    });
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Update failed" });
    return;
  }
});

async function exportBankTransactionsXlsx(req: AuthRequest, res: Response): Promise<void> {
  const r = requireRlsDb(req);
  const bankAccountId = parseIdInt((req.query as any)?.bankAccountId);
  if (!bankAccountId) { res.status(422).json({ error: "bankAccountId is required" }); return; }
  const acctRows = await queryRowsFrom(r, sql`
    SELECT id, account_name, bank_name, gl_code
    FROM firm_bank_accounts
    WHERE firm_id = ${req.firmId!} AND id = ${bankAccountId}
    LIMIT 1
  `);
  const acct = acctRows[0];
  if (!acct) { res.status(404).json({ error: "Bank account not found" }); return; }
  const bankAccountName = String((acct as any).account_name ?? (acct as any).bank_name ?? "");
  const glCode = (acct as any).gl_code ? String((acct as any).gl_code) : "";
  const rows = await queryRowsFrom(r, sql`
    SELECT
      id,
      transaction_date,
      description,
      reference_no,
      withdrawal,
      deposit,
      balance,
      case_id,
      is_exported,
      exported_at,
      created_at,
      updated_at
    FROM bank_transactions
    WHERE firm_id = ${req.firmId!}
      AND bank_account_id = ${bankAccountId}
    ORDER BY transaction_date ASC, created_at ASC
    LIMIT 5000
  `);

  const exportRows = rows.map((r: any) => ({
    "Transaction ID": String(r.id ?? ""),
    "Bank Account ID": bankAccountId,
    "Transaction Date": typeof r.transaction_date === "string" ? r.transaction_date : String(r.transaction_date ?? ""),
    Description: String(r.description ?? ""),
    "Reference No": r.reference_no == null ? "" : String(r.reference_no),
    Withdrawal: r.withdrawal == null ? "" : Number(r.withdrawal),
    Deposit: r.deposit == null ? "" : Number(r.deposit),
    Balance: r.balance == null ? "" : Number(r.balance),
    "Bank Account Name": bankAccountName,
    "GL Code": glCode,
    "Assigned Case ID": r.case_id == null ? "" : Number(r.case_id),
    Exported: Boolean(r.is_exported),
    "Exported At": r.exported_at == null ? "" : (typeof r.exported_at === "string" ? r.exported_at : String(r.exported_at)),
    "Created At": r.created_at == null ? "" : (typeof r.created_at === "string" ? r.created_at : String(r.created_at)),
    "Updated At": r.updated_at == null ? "" : (typeof r.updated_at === "string" ? r.updated_at : String(r.updated_at)),
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportRows);
  XLSX.utils.book_append_sheet(wb, ws, "Export");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Buffer;

  const ids = rows.map((x: any) => String(x.id)).filter(Boolean);
  await r.transaction(async (tx) => {
    if (ids.length > 0) {
      await tx.execute(sql`
        UPDATE bank_transactions
        SET is_exported = true, exported_at = COALESCE(exported_at, NOW()), updated_at = NOW()
        WHERE firm_id = ${req.firmId!}
          AND id = ANY(${ids}::uuid[])
      `);
    }
    await writeAuditLog(
      {
        firmId: req.firmId,
        actorId: req.userId,
        actorType: req.userType,
        action: "accounting.bank_transactions.export_excel",
        entityType: "bank_transaction",
        detail: `exported=${rows.length}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: tx, strict: true },
    );
  });

  const fileName = safeFilenameAscii(`bank_transactions_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(buf);
}

router.get("/accounting/bank-transactions/export", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  await exportBankTransactionsXlsx(req, res);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
