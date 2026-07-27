import express, { type NextFunction, type Response, type Router as ExpressRouter } from "express";
import { eq, and, desc, asc, inArray, ne } from "drizzle-orm";
import {
  accountingSettingsTable,
  caseLedgersTable,
  caseNotificationsTable,
  casePurchasersTable,
  casesTable,
  clientsTable,
  db,
  firmBankAccountsTable,
  ledgerEntriesTable,
  paymentVoucherActionsTable,
  paymentVoucherItemsTable,
  paymentVouchersTable,
  permissionsTable,
  sql,
  userNotificationsTable,
  usersTable,
} from "@workspace/db";
import { CreatePaymentVoucherBody, PaymentVoucherTransitionBody } from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requirePermission, requireReAuth, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { sensitiveRateLimiter } from "../lib/rate-limit.js";
import {
  addBusinessHours,
  normalizeAccountingSettings,
  resolveApprovalRequirement,
  resolvePaymentVoucherSlaHours,
} from "../modules/accounting/accounting-settings.js";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

type DbConn = Pick<typeof db, "select" | "insert" | "update" | "delete" | "transaction">;
type DbTxConn = Pick<typeof db, "select" | "insert" | "update" | "delete">;
const rdb = (req: AuthRequest): DbConn => (req.rlsDb ?? db) as unknown as DbConn;

async function getRoleName(req: AuthRequest): Promise<string> {
  return String((req as { roleName?: unknown }).roleName ?? "").trim();
}

async function roleHasPermission(req: AuthRequest, module: string, action: string): Promise<boolean> {
  if (!req.roleId) return false;
  const r = rdb(req);
  const rows = await r
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(and(
      eq(permissionsTable.roleId, req.roleId),
      eq(permissionsTable.module, module),
      eq(permissionsTable.action, action),
      eq(permissionsTable.allowed, true),
    ))
    .limit(1);
  return Boolean(rows[0]);
}

function classifyCaseWorkflowRole(roleName: string): "partner" | "lawyer" | "staff" {
  if (roleName === "Partner") return "partner";
  if (roleName === "Founder") return "partner";
  if (roleName === "Manager" || roleName === "Senior Lawyer" || roleName === "Lawyer") return "lawyer";
  return "staff";
}

async function getAccountingSettings(req: AuthRequest) {
  const r = rdb(req);
  const [row] = await r
    .select()
    .from(accountingSettingsTable)
    .where(eq(accountingSettingsTable.firmId, req.firmId!))
    .limit(1);
  return normalizeAccountingSettings(req.firmId!, row as Record<string, unknown> | undefined);
}

async function nextVoucherNo(r: DbConn, firmId: number): Promise<string> {
  const [row] = await r.select({ c: sql<number>`COUNT(*)` }).from(paymentVouchersTable).where(eq(paymentVouchersTable.firmId, firmId));
  const seq = (Number(row?.c ?? 0) + 1).toString().padStart(4, "0");
  const yr = new Date().getFullYear();
  return `PV-${yr}-${seq}`;
}

async function createUserNotification(args: {
  tx: DbTxConn;
  firmId: number;
  userId: number;
  sourceType: string;
  sourceId: number;
  caseId?: number | null;
  notificationType: string;
  title: string;
  message: string;
  actorUserId?: number | null;
  meta?: Record<string, unknown> | null;
}) {
  await args.tx.insert(userNotificationsTable).values({
    firmId: args.firmId,
    userId: args.userId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    caseId: args.caseId ?? null,
    notificationType: args.notificationType,
    title: args.title,
    message: args.message,
    meta: args.meta ?? null,
  });
  if (args.caseId) {
    await args.tx.insert(caseNotificationsTable).values({
      firmId: args.firmId,
      caseId: args.caseId,
      recipientUserId: args.userId,
      actorUserId: args.actorUserId ?? null,
      type: args.notificationType,
      title: args.title,
      message: args.message,
      meta: args.meta ?? null,
    });
  }
}

function normalizeLedgerAccountType(v: unknown): "client" | "office" | "balance_sheet" {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "trust") return "client";
  if (s === "balance_sheet" || s === "fixed_deposit") return "balance_sheet";
  if (s === "office") return "office";
  return "client";
}

async function postLedgerTx(tx: DbTxConn, args: {
  firmId: number;
  caseId: number | null;
  entryDate: string;
  entryType: string;
  accountType: string;
  debit: number;
  credit: number;
  description: string;
  referenceNo?: string | null;
  sourceType: string;
  sourceId: number;
  createdBy: number;
}) {
  const [last] = await tx
    .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
    .from(ledgerEntriesTable)
    .where(and(
      eq(ledgerEntriesTable.firmId, args.firmId),
      eq(ledgerEntriesTable.accountType, args.accountType),
      args.caseId ? eq(ledgerEntriesTable.caseId, args.caseId) : sql`case_id IS NULL`,
    ));
  const prevBal = Number(last?.bal ?? 0);
  const balanceAfter = prevBal + args.credit - args.debit;
  await tx.insert(ledgerEntriesTable).values({
    firmId: args.firmId,
    caseId: args.caseId,
    entryDate: args.entryDate,
    entryType: args.entryType,
    accountType: args.accountType,
    debit: args.debit.toFixed(2),
    credit: args.credit.toFixed(2),
    balanceAfter: balanceAfter.toFixed(2),
    description: args.description,
    referenceNo: args.referenceNo ?? null,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    createdBy: args.createdBy,
  });
}

// List
router.get("/payment-vouchers", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
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
router.get("/payment-vouchers/:id", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const idStr = one(req.params.id);
  const id = idStr ? parseInt(idStr) : NaN;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid voucher ID" }); return; }
  const r = rdb(req);
  const [pv] = await r.select().from(paymentVouchersTable).where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)));
  if (!pv) { res.status(404).json({ error: "Payment voucher not found" }); return; }
  const items = await r.select().from(paymentVoucherItemsTable).where(eq(paymentVoucherItemsTable.voucherId, id)).orderBy(paymentVoucherItemsTable.sortOrder);
  const actorIds = [
    pv.createdBy ? Number(pv.createdBy) : null,
    pv.preparedBy ? Number(pv.preparedBy) : null,
    pv.lawyerApprovedBy ? Number(pv.lawyerApprovedBy) : null,
    pv.partnerApprovedBy ? Number(pv.partnerApprovedBy) : null,
    pv.paidBy ? Number(pv.paidBy) : null,
  ].filter((x): x is number => Number.isFinite(x) && x > 0);
  const actorRows = actorIds.length > 0
    ? await r.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(and(eq(usersTable.firmId, req.firmId!), inArray(usersTable.id, actorIds)))
    : [];
  const nameById = new Map<number, string>();
  for (const u of actorRows) nameById.set(Number(u.id), String(u.name ?? ""));
  const createdByName = pv.createdBy ? (nameById.get(Number(pv.createdBy)) ?? null) : null;
  const preparedByName = pv.preparedBy ? (nameById.get(Number(pv.preparedBy)) ?? null) : null;
  const lawyerApprovedByName = pv.lawyerApprovedBy ? (nameById.get(Number(pv.lawyerApprovedBy)) ?? null) : null;
  const partnerApprovedByName = pv.partnerApprovedBy ? (nameById.get(Number(pv.partnerApprovedBy)) ?? null) : null;
  const paidByName = pv.paidBy ? (nameById.get(Number(pv.paidBy)) ?? null) : null;
  const caseId = pv.caseId ? Number(pv.caseId) : NaN;
  const caseInfo = Number.isFinite(caseId) && caseId > 0
    ? await r
      .select({
        referenceNo: casesTable.referenceNo,
        clientName: clientsTable.name,
        orderNo: casePurchasersTable.orderNo,
      })
      .from(casesTable)
      .leftJoin(casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
      .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
      .where(and(eq(casesTable.firmId, req.firmId!), eq(casesTable.id, caseId)))
      .orderBy(asc(casePurchasersTable.orderNo))
    : [];
  const caseReferenceNo = caseInfo?.[0]?.referenceNo ? String(caseInfo[0].referenceNo) : null;
  const clientNames = Array.from(new Set(caseInfo.map((x) => String(x.clientName ?? "").trim()).filter(Boolean))).join(", ");

  const targetCaseIdNum = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
  const targetCaseInfo = Number.isFinite(targetCaseIdNum) && targetCaseIdNum > 0
    ? await r
      .select({
        referenceNo: casesTable.referenceNo,
        clientName: clientsTable.name,
        orderNo: casePurchasersTable.orderNo,
      })
      .from(casesTable)
      .leftJoin(casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
      .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
      .where(and(eq(casesTable.firmId, req.firmId!), eq(casesTable.id, targetCaseIdNum)))
      .orderBy(asc(casePurchasersTable.orderNo))
    : [];
  const targetCaseReferenceNo = targetCaseInfo?.[0]?.referenceNo ? String(targetCaseInfo[0].referenceNo) : null;
  const targetClientNames = Array.from(new Set(targetCaseInfo.map((x) => String(x.clientName ?? "").trim()).filter(Boolean))).join(", ");

  res.json({
    ...pv,
    items,
    caseReferenceNo,
    clientNames: clientNames || null,
    targetCaseReferenceNo,
    targetClientNames: targetClientNames || null,
    createdByName,
    preparedByName,
    lawyerApprovedByName,
    partnerApprovedByName,
    paidByName,
  });
});

// Create
router.post("/payment-vouchers", sensitiveRateLimiter, requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = CreatePaymentVoucherBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const {
    caseId,
    voucherType,
    targetCaseId,
    targetAccountId,
    isAdvance,
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
  const roleKind = classifyCaseWorkflowRole(roleName);
  const canCreateAccountingRequest = await roleHasPermission(req, "accounting", "create");
  const canCreateCaseScopedRequest = await roleHasPermission(req, "cases", "update");
  if ((voucherType === "account_transfer" || voucherType === "internal_transfer" || voucherType === "file_to_file_transfer") && !canCreateAccountingRequest) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  if (voucherType === "external_payment" || voucherType === "file_transfer") {
    if (!caseId) {
      if (!canCreateAccountingRequest) {
        res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
        return;
      }
    } else if (!canCreateAccountingRequest && !canCreateCaseScopedRequest) {
      res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
      return;
    }
  } else if (!canCreateAccountingRequest) {
    res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    return;
  }
  if (voucherType === "internal_transfer") {
    if (!caseId) { res.status(400).json({ error: "caseId is required" }); return; }
  }
  if (voucherType === "file_transfer" || voucherType === "file_to_file_transfer") {
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
      if (canCreateAccountingRequest) return "pending_account";
      return roleKind === "partner"
        ? "pending_account"
        : roleKind === "lawyer"
          ? "pending_partner"
          : "pending_lawyer";
    })();

  const effectiveIsAdvance = Boolean(isAdvance);
  const effectiveFundStatus = effectiveIsAdvance ? "request_advance" : (fundStatus ?? "client_paid");
  const settings = await getAccountingSettings(req);
  const approvalDecision = resolveApprovalRequirement(effectiveAmount, voucherType, settings);
  const approvalStatus = (() => {
    if (voucherType === "account_transfer" || voucherType === "internal_transfer" || voucherType === "file_to_file_transfer") return "pending_approval";
    if (effectiveIsAdvance) return "pending_approval";
    if (effectiveFundStatus === "request_advance") return "pending_approval";
    if (approvalDecision.requiresPartnerApproval) return "pending_approval";
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

  const normalizedAccountType = accountType ? normalizeLedgerAccountType(accountType) : null;
  const now = new Date();
  const effectivePayeeName = (voucherType === "internal_transfer" && typeof payeeName === "string" && !payeeName.trim())
    ? "Client Account → Office Account Transfer"
    : payeeName;

  if (normalizedAccountType === "client") {
    const cid = caseId ? Number(caseId) : NaN;
    if (!Number.isFinite(cid) || cid <= 0) { res.status(400).json({ error: "caseId is required when deducting from Client Account" }); return; }
    const [row] = await r.select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` }).from(ledgerEntriesTable).where(and(
      eq(ledgerEntriesTable.firmId, req.firmId!),
      eq(ledgerEntriesTable.caseId, cid),
      sql`${ledgerEntriesTable.accountType} IN ('client','trust')`,
    )).limit(1);
    const bal = Number(row?.bal ?? 0);
    if (bal + 1e-9 < effectiveAmount) { res.status(400).json({ error: "Insufficient Client Account Balance", code: "INSUFFICIENT_CLIENT_BALANCE" }); return; }
  }

  const [pv] = await r.insert(paymentVouchersTable).values({
    firmId: req.firmId!,
    caseId: caseId ?? null,
    voucherType,
    targetCaseId: targetCaseId ?? null,
    targetAccountId: targetAccountId ?? null,
    approvalStatus,
    isAdvance: effectiveIsAdvance,
    approvedBy: null,
    voucherNo,
    status: initialStatus,
    fundStatus: effectiveFundStatus,
    payeeName: effectivePayeeName,
    payeeBank: payeeBank ?? beneficiaryBank ?? null,
    payeeAccountNo: payeeAccountNo ?? beneficiaryAccountNo ?? null,
    beneficiaryBank: beneficiaryBank ?? payeeBank ?? null,
    beneficiaryAccountNo: beneficiaryAccountNo ?? payeeAccountNo ?? null,
    paymentMethod: paymentMethod ?? null,
    bankAccountId: bankAccountId ?? null,
    accountType: normalizedAccountType,
    amount: effectiveAmount.toFixed(2),
    purpose: storedPurpose,
    notes: notes ?? null,
    preparedBy: req.userId!,
    preparedAt: now,
    createdBy: req.userId!,
  }).returning();

  await r.insert(paymentVoucherItemsTable).values(effectiveItems.map((i, idx) => ({
    voucherId: pv.id,
    description: i.description,
    itemType: i.itemType,
    amount: i.amount.toFixed(2),
    sortOrder: idx,
  })));

  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "payment_voucher.created", entityType: "payment_voucher", entityId: pv.id, detail: `voucherNo=${pv.voucherNo} status=${initialStatus} approvalStatus=${approvalStatus}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: "payment_voucher.submitted", entityType: "payment_voucher", entityId: pv.id, detail: `voucherNo=${pv.voucherNo}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  res.status(201).json(pv);
});

// Status transition
router.post("/payment-vouchers/:id/transition", sensitiveRateLimiter, requireAuth, requireFirmUser, requireReAuth, async (req: AuthRequest, res: Response): Promise<void> => {
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
  const roleKind = classifyCaseWorkflowRole(roleName);
  const now = new Date();
  const settings = await getAccountingSettings(req);
  const canReview = await roleHasPermission(req, "accounting", "review");
  const canApprove = await roleHasPermission(req, "accounting", "approve");
  const canMarkReceived = await roleHasPermission(req, "accounting", "mark_received");
  const canMarkPaid = await roleHasPermission(req, "accounting", "mark_paid");
  const canOverrideSla = await roleHasPermission(req, "accounting", "override_sla");

  const updateFields: Partial<typeof paymentVouchersTable.$inferInsert> = { updatedAt: now };
  const fromStatus = pv.status;
  let toStatus: string | null = null;
  let updatedPv: any | null = null;

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
    if (roleKind !== "partner" && !canApprove) { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    if (pv.approvalStatus !== "pending_approval") { res.status(409).json({ error: "Not pending approval", code: "NOT_PENDING_APPROVAL" }); return; }
    const decision = parsed.data.decision;
    updateFields.approvalStatus = decision;
    updateFields.approvedBy = decision === "approved" ? req.userId! : null;
    updateFields.partnerApprovedBy = req.userId!;
    updateFields.partnerApprovedAt = now;
    toStatus = fromStatus;
  } else if (parsed.data.action === "received_by_accounts") {
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (!canMarkReceived && !canReview) { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    if (pv.receivedAt) { res.status(409).json({ error: "Voucher already received by accounts", code: "ALREADY_RECEIVED" }); return; }
    const assignedAccountUserId = parsed.data.assignedAccountUserId ?? req.userId!;
    const [assignedUser] = await r
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.firmId, req.firmId!), eq(usersTable.id, assignedAccountUserId), eq(usersTable.status, "active")))
      .limit(1);
    if (!assignedUser) { res.status(400).json({ error: "Assigned account user is invalid", code: "INVALID_ASSIGNEE" }); return; }
    const slaHours = resolvePaymentVoucherSlaHours(Number(pv.amount), String(pv.voucherType ?? ""), parsed.data.isUrgent === true, settings);
    const paymentDueAt = addBusinessHours(now, slaHours, settings);
    updateFields.receivedBy = req.userId!;
    updateFields.receivedAt = now;
    updateFields.assignedAccountUserId = assignedAccountUserId;
    updateFields.paymentDueAt = paymentDueAt;
    updateFields.slaPolicySnapshot = {
      hours: slaHours,
      timezone: settings.timezone,
      dueSoonMinutes: settings.paymentVoucherSla.dueSoonMinutes,
      isUrgent: parsed.data.isUrgent === true,
    };
    toStatus = fromStatus;
  } else if (parsed.data.action === "reassign_account_user") {
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (!pv.receivedAt) { res.status(409).json({ error: "Voucher has not been received by accounts", code: "NOT_RECEIVED" }); return; }
    if (!canMarkReceived && !canReview) { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    const [assignedUser] = await r
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.firmId, req.firmId!), eq(usersTable.id, parsed.data.assignedAccountUserId), eq(usersTable.status, "active")))
      .limit(1);
    if (!assignedUser) { res.status(400).json({ error: "Assigned account user is invalid", code: "INVALID_ASSIGNEE" }); return; }
    updateFields.assignedAccountUserId = parsed.data.assignedAccountUserId;
    toStatus = fromStatus;
  } else if (parsed.data.action === "override_deadline") {
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (!pv.receivedAt) { res.status(409).json({ error: "Voucher has not been received by accounts", code: "NOT_RECEIVED" }); return; }
    if (!canOverrideSla && roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    updateFields.paymentDueAt = new Date(parsed.data.paymentDueAt);
    updateFields.deadlineOverrideReason = parsed.data.reason;
    updateFields.deadlineOverriddenBy = req.userId!;
    updateFields.deadlineOverriddenAt = now;
    toStatus = fromStatus;
  } else if (parsed.data.action === "mark_paid") {
    const markPaidData = parsed.data;
    if (pv.status !== "pending_account") { res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" }); return; }
    if (!canMarkPaid && roleKind !== "partner") { res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" }); return; }
    if (!pv.receivedAt) { res.status(409).json({ error: "Voucher must be received by accounts first", code: "NOT_RECEIVED" }); return; }
    if (pv.approvalStatus && pv.approvalStatus !== "approved") {
      res.status(409).json({ error: "Voucher pending approval", code: "PENDING_APPROVAL" });
      return;
    }
    toStatus = "paid_pending_collection";
    updateFields.status = toStatus;
    const normalizedPaidAccountType = normalizeLedgerAccountType(markPaidData.accountType);
    const paidAmountValue = Number(markPaidData.paidAmount ?? pv.amount);
    if (!Number.isFinite(paidAmountValue) || paidAmountValue <= 0) {
      res.status(400).json({ error: "Invalid payment amount", code: "INVALID_PAYMENT_AMOUNT" });
      return;
    }
    if (Math.abs(paidAmountValue - Number(pv.amount)) > 0.009) {
      res.status(409).json({ error: "Payment amount does not match approved voucher amount", code: "PAYMENT_AMOUNT_MISMATCH" });
      return;
    }
    if (settings.paymentProofRequired && !markPaidData.proofDocumentPath) {
      res.status(400).json({ error: "Proof of payment is required", code: "PROOF_REQUIRED" });
      return;
    }
    if (markPaidData.nextActionType === "Custom Action" && !markPaidData.nextActionCustom) {
      res.status(400).json({ error: "Custom next action requires details", code: "CUSTOM_ACTION_REQUIRED" });
      return;
    }
    const voucherCaseId = pv.caseId ? Number(pv.caseId) : NaN;
    const requiresClerkAction = Number.isFinite(voucherCaseId) && voucherCaseId > 0;
    if (requiresClerkAction && !markPaidData.assignedClerkUserId) {
      res.status(400).json({ error: "Assigned clerk is required for case-linked payment vouchers", code: "CLERK_REQUIRED" });
      return;
    }
    if (!requiresClerkAction && !markPaidData.clerkActionExemptReason) {
      res.status(400).json({ error: "Exemption reason is required when no clerk action will be created", code: "CLERK_ACTION_EXEMPTION_REQUIRED" });
      return;
    }
    updateFields.accountType = normalizedPaidAccountType;
    updateFields.paymentMethod = markPaidData.paymentMethod;
    updateFields.bankChequeRefNo = markPaidData.bankChequeRefNo;
    updateFields.paidAmount = paidAmountValue.toFixed(2);
    updateFields.proofDocumentPath = markPaidData.proofDocumentPath ?? null;
    updateFields.nextActionType = markPaidData.nextActionType;
    updateFields.nextActionCustom = markPaidData.nextActionCustom ?? null;
    updateFields.nextActionRemarks = markPaidData.nextActionRemarks ?? null;
    updateFields.assignedClerkUserId = markPaidData.assignedClerkUserId ?? null;
    updateFields.clerkActionExemptReason = markPaidData.clerkActionExemptReason ?? null;
    updateFields.lateCompletionReason = markPaidData.lateCompletionReason ?? null;
    updateFields.paidAt = now;
    updateFields.paidBy = req.userId!;
    const amountNum = paidAmountValue;
    const amt = Number.isFinite(amountNum) ? amountNum.toFixed(2) : "0";
    const accountType = normalizedPaidAccountType;
    try {
      updatedPv = await r.transaction(async (tx) => {
        let createdActionId: number | null = null;
        const amtNum = Number(amt);
        const getClientBalance = async (caseId: number): Promise<number> => {
          const [row] = await tx
            .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
            .from(ledgerEntriesTable)
            .where(and(
              eq(ledgerEntriesTable.firmId, req.firmId!),
              eq(ledgerEntriesTable.caseId, caseId),
              sql`${ledgerEntriesTable.accountType} IN ('client','trust')`,
            ))
            .limit(1);
          return Number(row?.bal ?? 0);
        };

        if (pv.isAdvance && accountType !== "office") {
          throw Object.assign(new Error("ADVANCE_MUST_USE_OFFICE_ACCOUNT"), { code: "ADVANCE_MUST_USE_OFFICE_ACCOUNT" });
        }

        if (pv.voucherType === "file_to_file_transfer") {
          const targetCaseId = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
          const sourceCaseId = pv.caseId ? Number(pv.caseId) : NaN;
          if (!Number.isFinite(sourceCaseId) || !Number.isFinite(targetCaseId) || sourceCaseId <= 0 || targetCaseId <= 0) return null;
          if (sourceCaseId === targetCaseId) return null;
          const bal = await getClientBalance(sourceCaseId);
          if (bal + 1e-9 < amtNum) {
            throw Object.assign(new Error("INSUFFICIENT_CLIENT_BALANCE"), { code: "INSUFFICIENT_CLIENT_BALANCE", balance: bal });
          }
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: sourceCaseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "ledger_transfer_voucher",
            accountType: "client",
            debit: amtNum,
            credit: 0,
            description: `Ledger Transfer ${pv.voucherNo} — case ${sourceCaseId} -> ${targetCaseId}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: targetCaseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "ledger_transfer_voucher",
            accountType: "client",
            debit: 0,
            credit: amtNum,
            description: `Ledger Transfer ${pv.voucherNo} — case ${sourceCaseId} -> ${targetCaseId}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        } else if (pv.voucherType === "account_transfer") {
          const sourceId = pv.bankAccountId ? Number(pv.bankAccountId) : NaN;
          const targetId = pv.targetAccountId ? Number(pv.targetAccountId) : NaN;
          if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) return null;
          const [sourceAcct] = await tx
            .select({ accountType: firmBankAccountsTable.accountType })
            .from(firmBankAccountsTable)
            .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, sourceId)))
            .limit(1);
          const [targetAcct] = await tx
            .select({ accountType: firmBankAccountsTable.accountType })
            .from(firmBankAccountsTable)
            .where(and(eq(firmBankAccountsTable.firmId, req.firmId!), eq(firmBankAccountsTable.id, targetId)))
            .limit(1);
          const srcType = String(sourceAcct?.accountType ?? "client");
          const tgtType = String(targetAcct?.accountType ?? "office");
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: null,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher_transfer",
            accountType: srcType,
            debit: Number(amt),
            credit: 0,
            description: `Account Transfer ${pv.voucherNo} — ${srcType} -> ${tgtType}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: null,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher_transfer",
            accountType: tgtType,
            debit: 0,
            credit: Number(amt),
            description: `Account Transfer ${pv.voucherNo} — ${srcType} -> ${tgtType}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        } else if (pv.voucherType === "file_transfer") {
          const targetCaseId = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
          const sourceCaseId = pv.caseId ? Number(pv.caseId) : NaN;
          if (!Number.isFinite(sourceCaseId) || !Number.isFinite(targetCaseId)) return null;
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: sourceCaseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher_file_transfer",
            accountType,
            debit: Number(amt),
            credit: 0,
            description: `File Transfer ${pv.voucherNo} — case ${sourceCaseId} -> ${targetCaseId}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: targetCaseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher_file_transfer",
            accountType,
            debit: 0,
            credit: Number(amt),
            description: `File Transfer ${pv.voucherNo} — case ${sourceCaseId} -> ${targetCaseId}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        } else if (pv.voucherType === "internal_transfer") {
          const caseId = pv.caseId ? Number(pv.caseId) : NaN;
          if (!Number.isFinite(caseId) || caseId <= 0) return null;
          const bal = await getClientBalance(caseId);
          if (bal + 1e-9 < amtNum) {
            throw Object.assign(new Error("INSUFFICIENT_CLIENT_BALANCE"), { code: "INSUFFICIENT_CLIENT_BALANCE", balance: bal });
          }
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "internal_payment_voucher",
            accountType: "client",
            debit: Number(amt),
            credit: 0,
            description: `Internal PV ${pv.voucherNo} — Client -> Office`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "internal_payment_voucher",
            accountType: "office",
            debit: 0,
            credit: Number(amt),
            description: `Internal PV ${pv.voucherNo} — Client -> Office`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        } else {
          if (accountType === "client") {
            const caseId = pv.caseId ? Number(pv.caseId) : NaN;
            if (!Number.isFinite(caseId) || caseId <= 0) return null;
            const bal = await getClientBalance(caseId);
            if (bal + 1e-9 < amtNum) {
              throw Object.assign(new Error("INSUFFICIENT_CLIENT_BALANCE"), { code: "INSUFFICIENT_CLIENT_BALANCE", balance: bal });
            }
          }
          await postLedgerTx(tx, {
            firmId: req.firmId!,
            caseId: pv.caseId ? Number(pv.caseId) : null,
            entryDate: now.toISOString().slice(0, 10),
            entryType: "payment_voucher",
            accountType,
            debit: Number(amt),
            credit: 0,
            description: `Payment Voucher ${pv.voucherNo} — ${pv.payeeName}`,
            referenceNo: pv.voucherNo,
            sourceType: "payment_voucher",
            sourceId: id,
            createdBy: req.userId!,
          });
        }

        const pvCaseId = pv.caseId ? Number(pv.caseId) : NaN;
        const fundStatus = String(pv.fundStatus ?? "client_paid");
        const entryCategory = fundStatus === "request_advance" ? "office" : "client";
        const entryType = fundStatus === "request_advance" ? "disbursement_paid" : "trust_paid";

        if (pv.voucherType !== "internal_transfer" && pv.voucherType !== "account_transfer" && Number.isFinite(pvCaseId) && pvCaseId > 0) {
          const [existing] = await tx
            .select({ id: caseLedgersTable.id })
            .from(caseLedgersTable)
            .where(and(
              eq(caseLedgersTable.firmId, req.firmId!),
              eq(caseLedgersTable.caseId, pvCaseId),
              eq(caseLedgersTable.sourceType, "payment_voucher"),
              eq(caseLedgersTable.sourceId, id),
            ))
            .limit(1);
          if (!existing) {
            await tx.insert(caseLedgersTable).values({
              firmId: req.firmId!,
              caseId: pvCaseId,
              transactionDate: now.toISOString().slice(0, 10),
              entryCategory,
              entryType,
              description: `PV ${pv.voucherNo} — ${String(pv.purpose ?? "").trim()}`,
              amount: amt,
              sourceType: "payment_voucher",
              sourceId: id,
            } as any);
          }
        }

        if (pv.isAdvance && Number.isFinite(pvCaseId) && pvCaseId > 0) {
          const [existing] = await tx
            .select({ id: caseLedgersTable.id })
            .from(caseLedgersTable)
            .where(and(
              eq(caseLedgersTable.firmId, req.firmId!),
              eq(caseLedgersTable.caseId, pvCaseId),
              eq(caseLedgersTable.sourceType, "payment_voucher_advance"),
              eq(caseLedgersTable.sourceId, id),
            ))
            .limit(1);
          if (!existing) {
            await tx.insert(caseLedgersTable).values({
              firmId: req.firmId!,
              caseId: pvCaseId,
              transactionDate: now.toISOString().slice(0, 10),
              entryCategory: "office",
              entryType: "advance_paid",
              description: `Advance PV ${pv.voucherNo} — ${String(pv.purpose ?? "").trim()}`,
              amount: amt,
              sourceType: "payment_voucher_advance",
              sourceId: id,
            } as any);
          }
        }

        if ((pv.voucherType === "file_transfer" || pv.voucherType === "file_to_file_transfer") && entryType === "trust_paid") {
        const targetCaseId = pv.targetCaseId ? Number(pv.targetCaseId) : NaN;
        if (Number.isFinite(targetCaseId) && targetCaseId > 0) {
          const [existing] = await tx
            .select({ id: caseLedgersTable.id })
            .from(caseLedgersTable)
            .where(and(
              eq(caseLedgersTable.firmId, req.firmId!),
              eq(caseLedgersTable.caseId, targetCaseId),
              eq(caseLedgersTable.sourceType, "payment_voucher"),
              eq(caseLedgersTable.sourceId, id),
            ))
            .limit(1);
          if (!existing) {
            await tx.insert(caseLedgersTable).values({
              firmId: req.firmId!,
              caseId: targetCaseId,
              transactionDate: now.toISOString().slice(0, 10),
              entryCategory,
              entryType: "trust_received",
              description: `PV ${pv.voucherNo} — File Transfer In`,
              amount: amt,
              sourceType: "payment_voucher",
              sourceId: id,
            } as any);
          }
        }
      }

        if (requiresClerkAction && markPaidData.assignedClerkUserId) {
        const [existingAction] = await tx
          .select({ id: paymentVoucherActionsTable.id })
          .from(paymentVoucherActionsTable)
          .where(and(
            eq(paymentVoucherActionsTable.firmId, req.firmId!),
            eq(paymentVoucherActionsTable.paymentVoucherId, id),
            inArray(paymentVoucherActionsTable.status, ["assigned", "acknowledged"]),
          ))
          .limit(1);
        if (existingAction) {
          throw Object.assign(new Error("ACTIVE_CLERK_ACTION_EXISTS"), { code: "ACTIVE_CLERK_ACTION_EXISTS" });
        }
        const acknowledgeDueAt = addBusinessHours(now, settings.clerkActionSla.acknowledgeHours, settings);
        const completionDueAt = addBusinessHours(now, settings.clerkActionSla.completionHours, settings);
          const [createdAction] = await tx.insert(paymentVoucherActionsTable).values({
          firmId: req.firmId!,
          paymentVoucherId: id,
          caseId: voucherCaseId,
            assignedUserId: markPaidData.assignedClerkUserId,
            actionType: markPaidData.nextActionType,
            customAction: markPaidData.nextActionCustom ?? null,
          status: "assigned",
          priority: "normal",
          assignedAt: now,
          acknowledgeDueAt,
          completionDueAt,
          createdBy: req.userId!,
        }).returning({ id: paymentVoucherActionsTable.id });
          createdActionId = Number(createdAction.id);
        await createUserNotification({
          tx,
          firmId: req.firmId!,
            userId: markPaidData.assignedClerkUserId,
          sourceType: "payment_voucher_action",
          sourceId: createdAction.id,
          caseId: voucherCaseId,
          notificationType: "payment_voucher.action_assigned",
          title: `Payment completed for ${pv.voucherNo}`,
            message: `Next action required: ${markPaidData.nextActionType}`,
          actorUserId: req.userId!,
            meta: { paymentVoucherId: id, voucherNo: pv.voucherNo, nextActionType: markPaidData.nextActionType },
        });
      }

      const [updated] = await tx
        .update(paymentVouchersTable)
        .set(updateFields)
        .where(and(
          eq(paymentVouchersTable.id, id),
          eq(paymentVouchersTable.firmId, req.firmId!),
          eq(paymentVouchersTable.status, "pending_account"),
        ))
        .returning();
        return updated ? { voucher: updated, createdActionId } : null;
      });
    } catch (err: any) {
      const code = typeof err?.code === "string" ? err.code : "";
      if (code === "INSUFFICIENT_CLIENT_BALANCE") {
        res.status(400).json({ error: "Insufficient Client Account Balance", code: "INSUFFICIENT_CLIENT_BALANCE" });
        return;
      }
      if (code === "ADVANCE_MUST_USE_OFFICE_ACCOUNT") {
        res.status(400).json({ error: "Client Advance must be paid from Office Account", code: "ADVANCE_MUST_USE_OFFICE_ACCOUNT" });
        return;
      }
      if (code === "ACTIVE_CLERK_ACTION_EXISTS") {
        res.status(409).json({ error: "Active clerk action already exists", code: "ACTIVE_CLERK_ACTION_EXISTS" });
        return;
      }
      throw err;
    }
    if (!updatedPv) {
      res.status(400).json({ error: "Missing required accounts/cases, or voucher already transitioned", code: "INVALID_REQUEST" });
      return;
    }
  }

  if (!toStatus) { res.status(400).json({ error: "Invalid transition", code: "INVALID_TRANSITION" }); return; }

  const [updated] = updatedPv?.voucher ? [updatedPv.voucher] : await r
    .update(paymentVouchersTable)
    .set(updateFields)
    .where(and(eq(paymentVouchersTable.id, id), eq(paymentVouchersTable.firmId, req.firmId!)))
    .returning();
  const auditAction = parsed.data.action === "lawyer_approve"
    ? "payment_voucher.lawyer_approved"
    : parsed.data.action === "partner_approve"
      ? "payment_voucher.partner_approved"
      : parsed.data.action === "approve"
        ? (parsed.data.decision === "approved" ? "payment_voucher.approved" : "payment_voucher.rejected")
        : parsed.data.action === "received_by_accounts"
          ? "payment_voucher.account_received"
          : parsed.data.action === "reassign_account_user"
            ? "payment_voucher.reassigned"
            : parsed.data.action === "override_deadline"
              ? "payment_voucher.deadline_overridden"
              : parsed.data.action === "mark_paid"
                ? "payment_voucher.payment_completed"
                : "payment_voucher.transition";
  await writeAuditLog({ firmId: req.firmId, actorId: req.userId, actorType: req.userType, action: auditAction, entityType: "payment_voucher", entityId: id, detail: `action=${parsed.data.action} from=${fromStatus} to=${toStatus}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
  if (parsed.data.action === "received_by_accounts" && updated?.assignedAccountUserId) {
    await createUserNotification({
      tx: r,
      firmId: req.firmId!,
      userId: Number(updated.assignedAccountUserId),
      sourceType: "payment_voucher",
      sourceId: id,
      caseId: updated.caseId ? Number(updated.caseId) : null,
      notificationType: "payment_voucher.account_received",
      title: `Voucher received: ${updated.voucherNo}`,
      message: `Payment processing deadline starts now${updated.paymentDueAt ? ` and is due by ${new Date(updated.paymentDueAt).toLocaleString("en-MY")}` : ""}.`,
      actorUserId: req.userId!,
      meta: { paymentVoucherId: id, voucherNo: updated.voucherNo },
    });
  }
  if (parsed.data.action === "reassign_account_user" && updated?.assignedAccountUserId) {
    await createUserNotification({
      tx: r,
      firmId: req.firmId!,
      userId: Number(updated.assignedAccountUserId),
      sourceType: "payment_voucher",
      sourceId: id,
      caseId: updated.caseId ? Number(updated.caseId) : null,
      notificationType: "payment_voucher.reassigned",
      title: `Voucher reassigned: ${updated.voucherNo}`,
      message: "You have been assigned to process this payment voucher.",
      actorUserId: req.userId!,
      meta: { paymentVoucherId: id, voucherNo: updated.voucherNo },
    });
  }
  if (parsed.data.action === "mark_paid" && updatedPv?.createdActionId) {
    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "payment_voucher.action_created",
      entityType: "payment_voucher_action",
      entityId: updatedPv.createdActionId,
      detail: `paymentVoucherId=${id}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }
  res.json(updated);
});

// Ledger: view by case and account type
router.get("/ledger", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const accountType = one((req.query as any).accountType);
  const conds = [eq(ledgerEntriesTable.firmId, req.firmId!)];
  if (caseId) {
    const n = Number(caseId);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Invalid caseId" }); return; }
    conds.push(eq(ledgerEntriesTable.caseId, n));
  }
  if (accountType) {
    const normalized = normalizeLedgerAccountType(accountType);
    if (normalized === "client") conds.push(sql`${ledgerEntriesTable.accountType} IN ('client','trust')`);
    else conds.push(eq(ledgerEntriesTable.accountType, normalized));
  }
  const r = rdb(req);
  const rows = await r.select().from(ledgerEntriesTable).where(and(...conds)).orderBy(ledgerEntriesTable.entryDate, ledgerEntriesTable.createdAt);
  res.json(rows);
});

// Ledger summary (balance per account type per case)
router.get("/ledger/summary", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = one((req.query as any).caseId);
  const conds = [eq(ledgerEntriesTable.firmId, req.firmId!)];
  if (caseId) {
    const n = Number(caseId);
    if (!Number.isFinite(n)) { res.status(400).json({ error: "Invalid caseId" }); return; }
    conds.push(eq(ledgerEntriesTable.caseId, n));
  }
  const cond = and(...conds);
  const r = rdb(req);
  const accountTypeExpr = sql<string>`CASE WHEN ${ledgerEntriesTable.accountType} = 'trust' THEN 'client' ELSE ${ledgerEntriesTable.accountType} END`;
  const rows = await r.select({
    accountType: accountTypeExpr,
    totalDebit: sql<string>`COALESCE(SUM(debit), 0)`,
    totalCredit: sql<string>`COALESCE(SUM(credit), 0)`,
    balance: sql<string>`COALESCE(SUM(credit - debit), 0)`,
  }).from(ledgerEntriesTable).where(cond).groupBy(accountTypeExpr).orderBy(accountTypeExpr);
  res.json(rows);
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
