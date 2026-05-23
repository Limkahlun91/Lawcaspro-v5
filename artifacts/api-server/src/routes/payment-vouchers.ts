import express, { type NextFunction, type Response, type Router as ExpressRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, firmBankAccountsTable, ledgerEntriesTable, paymentVoucherItemsTable, paymentVouchersTable, rolesTable, sql } from "@workspace/db";
import { CreatePaymentVoucherBody, PaymentVoucherTransitionBody } from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { sensitiveRateLimiter } from "../lib/rate-limit.js";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

async function getRoleName(req: AuthRequest): Promise<string> {
  if (!req.firmId || !req.roleId) return "";
  const r = rdb(req);
  const rows = await r
    .select({ name: rolesTable.name })
    .from(rolesTable)
    .where(and(eq(rolesTable.id, req.roleId), eq(rolesTable.firmId, req.firmId)))
    .limit(1);
  return typeof rows?.[0]?.name === "string" ? rows[0].name : "";
}

function classifyRole(roleName: string): "partner" | "lawyer" | "clerk" | "account" {
  if (roleName === "Partner") return "partner";
  if (roleName === "Manager" || roleName === "Senior Lawyer" || roleName === "Lawyer") return "lawyer";
  if (roleName === "Account" || roleName === "Accounts" || roleName === "Finance" || roleName === "Accountant") return "account";
  return "clerk";
}

function isAccountingRoleAllowed(roleName: string): boolean {
  const rn = roleName.trim().toLowerCase();
  if (rn === "partner") return true;
  if (rn === "account" || rn === "accounts" || rn === "finance" || rn === "accountant") return true;
  if (rn.startsWith("manager") && rn.includes("account")) return true;
  return false;
}

const requireAccountingReadRole = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const roleName = await getRoleName(req);
  if (isAccountingRoleAllowed(roleName)) {
    next();
    return;
  }
  await writeAuditLog({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: req.userType,
    action: "auth.forbidden.accounting_read_role_denied",
    entityType: "firm",
    entityId: req.firmId ?? undefined,
    detail: `roleName=${roleName}`,
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  }, { db: req.rlsDb });
  res.status(403).json({ error: "Forbidden", code: "ACCOUNTING_ROLE_REQUIRED" });
};

async function nextVoucherNo(r: DbConn, firmId: number): Promise<string> {
  const [row] = await r.select({ c: sql<number>`COUNT(*)` }).from(paymentVouchersTable).where(eq(paymentVouchersTable.firmId, firmId));
  const seq = (Number(row?.c ?? 0) + 1).toString().padStart(4, "0");
  const yr = new Date().getFullYear();
  return `PV-${yr}-${seq}`;
}

function approvalThresholdRm(): number {
  const raw = process.env.PAYMENT_VOUCHER_APPROVAL_THRESHOLD_RM ?? process.env.PAYMENT_VOUCHER_APPROVAL_THRESHOLD;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 5000;
  return n;
}

// List
router.get("/payment-vouchers", requireAuth, requireFirmUser, requireAccountingReadRole, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const status = one((req.query as any).status);
  const conds = [eq(paymentVouchersTable.firmId, req.firmId!)];
  if (caseId) {
    const n = Number(caseId);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Invalid caseId" }); return; }
    conds.push(eq(paymentVouchersTable.caseId, n));
  }
  if (status) conds.push(eq(paymentVouchersTable.status, status));
  const r = rdb(req);
  const rows = await r.select().from(paymentVouchersTable).where(and(...conds)).orderBy(desc(paymentVouchersTable.createdAt));
  res.json(rows);
});

// Detail
router.get("/payment-vouchers/:id", requireAuth, requireFirmUser, requireAccountingReadRole, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voucher ID" }); return; }
  const r = rdb(req);
  const [pv] = await r.select().from(paymentVouchersTable).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)));
  if (!pv) { res.status(404).json({ error: "Payment voucher not found" }); return; }
  const items = await r.select().from(paymentVoucherItemsTable).where(eq(paymentVoucherItemsTable.voucherId, id)).orderBy(paymentVoucherItemsTable.sortOrder);
  res.json({ ...pv, items });
});

// Create
router.post("/payment-vouchers", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = CreatePaymentVoucherBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const {
    caseId,
    voucherType,
    targetCaseId,
    targetAccountId,
    payeeName,
    payeeBank,
    payeeAccountNo,
    beneficiaryBank,
    beneficiaryAccountNo,
    paymentMethod,
    bankAccountId,
    accountType,
    amount,
    purpose,
    notes,
    items,
    lineItems,
    fundStatus,
  } = parsed.data;

  const normalizedLineItems =
    Array.isArray(lineItems) && lineItems.length > 0
      ? lineItems.map((x) => ({ purpose: String(x.purpose ?? "").trim(), amount: Number(x.amount) })).filter((x) => x.purpose && Number.isFinite(x.amount) && x.amount > 0)
      : null;

  const effectiveItems = (Array.isArray(items) && items.length > 0)
    ? items
    : (normalizedLineItems && normalizedLineItems.length > 0)
      ? normalizedLineItems.map((i) => ({ description: i.purpose, itemType: "disbursement" as const, amount: i.amount }))
      : [{ description: purpose, itemType: "disbursement" as const, amount }];

  const effectiveAmount = effectiveItems.reduce((sum, i) => sum + Number(i.amount), 0);
  const storedPurpose =
    normalizedLineItems && normalizedLineItems.length > 1
      ? `${normalizedLineItems[0].purpose} (+${normalizedLineItems.length - 1} more)`
      : purpose;

  const roleName = await getRoleName(req);
  const roleKind = classifyRole(roleName);
  if (voucherType === "account_transfer" && roleKind !== "partner" && roleKind !== "account") {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  if (voucherType === "file_transfer") {
    if (!caseId || !targetCaseId) { res.status(400).json({ error: "caseId and targetCaseId are required" }); return; }
    if (caseId === targetCaseId) { res.status(400).json({ error: "targetCaseId must be different from caseId" }); return; }
  }
  if (voucherType === "account_transfer") {
    if (!bankAccountId || !targetAccountId) { res.status(400).json({ error: "bankAccountId and targetAccountId are required" }); return; }
    if (bankAccountId === targetAccountId) { res.status(400).json({ error: "targetAccountId must be different from bankAccountId" }); return; }
  }
  const initialStatus =
    (() => {
      const isSimplified = !paymentMethod && !accountType && !bankAccountId;
      if (isSimplified) return "pending_account";
      return roleKind === "partner"
        ? "pending_account"
        : roleKind === "lawyer"
          ? "pending_partner"
          : "pending_lawyer";
    })();

  const effectiveFundStatus = fundStatus ?? "client_paid";
  const approvalStatus = (() => {
    if (voucherType === "account_transfer") return "pending_approval";
    if (effectiveFundStatus === "request_advance") return "pending_approval";
    if (effectiveAmount >= approvalThresholdRm()) return "pending_approval";
    return "approved";
  })();

  const r = rdb(req);
  const voucherNo = await nextVoucherNo(r, req.firmId!);
  if (voucherType === "account_transfer") {
    const rows = await r
      .select({ id: firmBankAccountsTable.id })
      .from(firmBankAccountsTable)
      .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, bankAccountId!)))
      .limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Source bank account not found" }); return; }
    const rows2 = await r
      .select({ id: firmBankAccountsTable.id })
      .from(firmBankAccountsTable)
      .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, targetAccountId!)))
      .limit(1);
    if (!rows2[0]) { res.status(404).json({ error: "Target bank account not found" }); return; }
  }

  const [pv] = await r.insert(paymentVouchersTable).values({
    firmId: req.firmId!,
    caseId: caseId ?? null,
    voucherType,
    targetCaseId: targetCaseId ?? null,
    targetAccountId: targetAccountId ?? null,
    approvalStatus,
    voucherNo,
    status: initialStatus,
    fundStatus: effectiveFundStatus,
    payeeName,
    payeeBank: payeeBank ?? beneficiaryBank ?? null,
    payeeAccountNo: payeeAccountNo ?? beneficiaryAccountNo ?? null,
    beneficiaryBank: beneficiaryBank ?? payeeBank ?? null,
    beneficiaryAccountNo: beneficiaryAccountNo ?? payeeAccountNo ?? null,
    paymentMethod: paymentMethod ?? null,
    bankAccountId: bankAccountId ?? null,
    accountType: accountType ?? null,
    amount: effectiveAmount.toFixed(2),
    purpose: storedPurpose,
    notes: notes ?? null,
    createdBy: req.userId!,
  }).returning();

  await r.insert(paymentVoucherItemsTable).values(effectiveItems.map((i, idx) => ({
    voucherId: pv.id,
    description: i.description,
    itemType: i.itemType,
    amount: i.amount.toFixed(2),
    sortOrder: idx,
  })));

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.payment_voucher.create", entityType: "payment_voucher", entityId: pv.id, detail: `voucherNo=${pv.voucherNo} status=${initialStatus}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(pv);
});

// Status transition
router.post("/payment-vouchers/:id/transition", sensitiveRateLimiter, requireAuth, requireFirmUser, requirePermission("accounting", "write"), requireReAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voucher ID" }); return; }
  const parsed = PaymentVoucherTransitionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const r = rdb(req);
  const [pv] = await r.select().from(paymentVouchersTable).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)));
  if (!pv) { res.status(404).json({ error: "Voucher not found" }); return; }
  if (pv.isReversed) { res.status(400).json({ error: "Reversed voucher cannot be transitioned" }); return; }

  const roleName = await getRoleName(req);
  const roleKind = classifyRole(roleName);
  const now = new Date();

  const updateFields: Partial<typeof paymentVouchersTable.$inferInsert> = { updatedAt: now };
  const fromStatus = pv.status;
  let toStatus: string | null = null;

  if (parsed.data.action === "lawyer_approve") {
    if (pv.status !== "pending_lawyer") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (roleKind !== "lawyer" && roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    toStatus = "pending_partner";
    updateFields.status = toStatus;
    updateFields.lawyerApprovedBy = req.userId!;
    updateFields.lawyerApprovedAt = now;
  } else if (parsed.data.action === "partner_approve") {
    if (pv.status !== "pending_partner") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    toStatus = "pending_account";
    updateFields.status = toStatus;
    updateFields.partnerApprovedBy = req.userId!;
    updateFields.partnerApprovedAt = now;
  } else if (parsed.data.action === "approve") {
    if (roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    if (pv.approvalStatus !== "pending_approval") { res.status(409).json({ error: "Not pending approval", code: "NOT_PENDING_APPROVAL" }); return; }
    const decision = parsed.data.decision;
    updateFields.approvalStatus = decision;
    updateFields.partnerApprovedBy = req.userId!;
    updateFields.partnerApprovedAt = now;
    toStatus = fromStatus;
  } else if (parsed.data.action === "mark_paid") {
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (roleKind !== "partner" && roleKind !== "account") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    if (pv.approvalStatus && pv.approvalStatus !== "approved") {
      res.status(409).json({ error: "Voucher pending approval", code: "PENDING_APPROVAL" });
      return;
    }
    toStatus = "paid_pending_collection";
    updateFields.status = toStatus;
    updateFields.accountType = parsed.data.accountType;
    updateFields.paymentMethod = parsed.data.paymentMethod;
    updateFields.bankChequeRefNo = parsed.data.bankChequeRefNo;
    updateFields.paidAt = now;
    updateFields.paidBy = req.userId!;
    const amountNum = Number(pv.amount);
    const amt = Number.isFinite(amountNum) ? amountNum.toFixed(2) : "0";
    if (pv.voucherType === "account_transfer") {
      const sourceId = pv.bankAccountId ? Number(pv.bankAccountId) : NaN;
      const targetId = pv.targetAccountId ? Number(pv.targetAccountId) : NaN;
      if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) {
        res.status(400).json({ error: "Missing bank accounts for account transfer", code: "MISSING_ACCOUNTS" });
        return;
      }
      const [sourceAcct] = await r
        .select({ accountType: firmBankAccountsTable.accountType })
        .from(firmBankAccountsTable)
        .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, sourceId)))
        .limit(1);
      const [targetAcct] = await r
        .select({ accountType: firmBankAccountsTable.accountType })
        .from(firmBankAccountsTable)
        .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, targetId)))
        .limit(1);
      const srcType = String(sourceAcct?.accountType ?? "client");
      const tgtType = String(targetAcct?.accountType ?? "office");
      await r.insert(ledgerEntriesTable).values([
        {
          firmId: req.firmId!,
          caseId: null,
          entryDate: now.toISOString().slice(0, 10),
          entryType: "payment_voucher_transfer",
          accountType: srcType,
          debit: amt,
          credit: "0",
          balanceAfter: "0",
          description: `Account Transfer ${pv.voucherNo} — ${srcType} -> ${tgtType}`,
          referenceNo: pv.voucherNo,
          sourceType: "payment_voucher",
          sourceId: id,
          createdBy: req.userId!,
        },
        {
          firmId: req.firmId!,
          caseId: null,
          entryDate: now.toISOString().slice(0, 10),
          entryType: "payment_voucher_transfer",
          accountType: tgtType,
          debit: "0",
          credit: amt,
          balanceAfter: "0",
          description: `Account Transfer ${pv.voucherNo} — ${srcType} -> ${tgtType}`,
          referenceNo: pv.voucherNo,
          sourceType: "payment_voucher",
          sourceId: id,
          createdBy: req.userId!,
        },
      ]);
    } else if (pv.voucherType === "file_transfer") {
      const targetCase = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
      const sourceCase = pv.caseId ? Number(pv.caseId) : NaN;
      if (!Number.isFinite(sourceCase) || !Number.isFinite(targetCase)) {
        res.status(400).json({ error: "Missing cases for file transfer", code: "MISSING_CASES" });
        return;
      }
      await r.insert(ledgerEntriesTable).values([
        {
          firmId: req.firmId!,
          caseId: sourceCase,
          entryDate: now.toISOString().slice(0, 10),
          entryType: "payment_voucher_file_transfer",
          accountType: parsed.data.accountType,
          debit: amt,
          credit: "0",
          balanceAfter: "0",
          description: `File Transfer ${pv.voucherNo} — case ${sourceCase} -> ${targetCase}`,
          referenceNo: pv.voucherNo,
          sourceType: "payment_voucher",
          sourceId: id,
          createdBy: req.userId!,
        },
        {
          firmId: req.firmId!,
          caseId: targetCase,
          entryDate: now.toISOString().slice(0, 10),
          entryType: "payment_voucher_file_transfer",
          accountType: parsed.data.accountType,
          debit: "0",
          credit: amt,
          balanceAfter: "0",
          description: `File Transfer ${pv.voucherNo} — case ${sourceCase} -> ${targetCase}`,
          referenceNo: pv.voucherNo,
          sourceType: "payment_voucher",
          sourceId: id,
          createdBy: req.userId!,
        },
      ]);
    } else {
      await r.insert(ledgerEntriesTable).values({
        firmId: req.firmId!,
        caseId: pv.caseId ?? null,
        entryDate: now.toISOString().slice(0, 10),
        entryType: "payment_voucher",
        accountType: parsed.data.accountType,
        debit: amt,
        credit: "0",
        balanceAfter: "0",
        description: `Payment Voucher ${pv.voucherNo} — ${pv.payeeName}`,
        referenceNo: pv.voucherNo, sourceType: "payment_voucher", sourceId: id, createdBy: req.userId!,
      });
    }
  } else if (parsed.data.action === "acknowledge_file_return") {
    if (pv.status !== "paid_pending_collection") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (roleKind !== "clerk") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    toStatus = "completed";
    updateFields.status = toStatus;
  }

  if (!toStatus) { res.status(400).json({ error: "Invalid transition", code: "INVALID_TRANSITION" }); return; }

  const [updated] = await r
    .update(paymentVouchersTable)
    .set(updateFields)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)))
    .returning();
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "accounting.payment_voucher.transition", entityType: "payment_voucher", entityId: id, detail: `action=${parsed.data.action} from=${fromStatus} to=${toStatus}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.json(updated);
});

// Ledger: view by case and account type
router.get("/ledger", requireAuth, requireFirmUser, requireAccountingReadRole, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const accountType = one((req.query as any).accountType);
  const conds = [eq(ledgerEntriesTable.firmId, req.firmId!)];
  if (caseId) {
    const n = Number(caseId);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Invalid caseId" }); return; }
    conds.push(eq(ledgerEntriesTable.caseId, n));
  }
  if (accountType) conds.push(eq(ledgerEntriesTable.accountType, accountType));
  const r = rdb(req);
  const rows = await r.select().from(ledgerEntriesTable).where(and(...conds)).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt);
  res.json(rows);
});

// Ledger summary (balance per account type per case)
router.get("/ledger/summary", requireAuth, requireFirmUser, requireAccountingReadRole, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const conds = [eq(ledgerEntriesTable.firmId, req.firmId!)];
  if (caseId) {
    const n = Number(caseId);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Invalid caseId" }); return; }
    conds.push(eq(ledgerEntriesTable.caseId, n));
  }
  const cond = and(...conds);
  const r = rdb(req);
  const rows = await r.select({
    accountType: ledgerEntriesTable.accountType,
    totalDebit: sql<string>`COALESCE(SUM(debit), 0)`,
    totalCredit: sql<string>`COALESCE(SUM(credit), 0)`,
    balance: sql<string>`COALESCE(SUM(credit - debit), 0)`,
  }).from(ledgerEntriesTable).where(cond).groupBy(ledgerEntriesTable.accountType);
  res.json(rows);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
