import { and, eq, count, sql, or, isNotNull } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  hrEmployeesTable,
  hrClaimsTable,
  paymentVouchersTable,
  ledgerEntriesTable,
} from "@workspace/db";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

async function assertEmployeeBelongs(
  conn: DbConnLike,
  firmId: number,
  employeeId: number,
): Promise<void> {
  const [existing] = await conn
    .select({ n: count() })
    .from(hrEmployeesTable as any)
    .where(and(eq((hrEmployeesTable as any).firmId, firmId), eq((hrEmployeesTable as any).id, employeeId)))
    .execute();
  if (Number(existing?.n ?? 0) <= 0) {
    throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `Employee ${employeeId} not found in firm ${firmId}`);
  }
}

export interface CreateClaimInput {
  firmId: number;
  employeeId: number;
  claimType: string;
  description: string | null;
  amount: number;
  receipts: unknown[] | null;
  incurrenceDate: Date;
  actorUserId: number;
}

export interface ClaimRecord {
  id: number;
  employeeId: number;
  claimType: string;
  description: string | null;
  amount: number;
  receipts: unknown[] | null;
  incurrenceDate: Date;
  status: "draft" | "submitted" | "approved" | "rejected";
  accountingCreated: boolean;
  accountingPayableId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const toClaim = (r: any): ClaimRecord => {
  const receipts = r.receipts ?? (r.receiptDocumentRef ? [r.receiptDocumentRef] : null);
  return {
    id: Number(r.id),
    employeeId: Number(r.employeeId),
    claimType: String(r.claimTypeCode),
    description: r.description ?? null,
    amount: Number(r.amount ?? 0),
    receipts,
    incurrenceDate: new Date(r.claimDate),
    status: r.status as any,
    accountingCreated: Boolean(r.accountingCreated),
    accountingPayableId: r.accountingPayableId != null ? Number(r.accountingPayableId) : null,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
};

const HR_CLAIM_PV_CLIENT_KEY = (firmId: number, claimId: number): string =>
  `HR_CLAIM_APPROVED:${firmId}:${claimId}`;

const HR_CLAIM_PV_VOUCHER_NO = (firmId: number, claimId: number): string =>
  `HR-CLM-${firmId}-${claimId}`;

const formatEntryDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const isUniqueViolation = (err: unknown): boolean =>
  err != null && typeof err === "object" && (err as { code?: unknown }).code === "23505";

const isSchemaMissing = (err: unknown): boolean => {
  const code = err != null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return code === "42P01" || code === "42703";
};

async function createHrClaimDownstreamInTx(
  tx: any,
  args: {
    firmId: number;
    claimId: number;
    employeeId: number;
    employeeName: string | null;
    claimTypeCode: string;
    description: string | null;
    amount: number;
    claimDate: Date;
    actorUserId: number;
  },
): Promise<{ paymentVoucherId: number; createdNow: boolean }> {
  const clientRequestId = HR_CLAIM_PV_CLIENT_KEY(args.firmId, args.claimId);
  const existingPv = await tx
    .select({ id: paymentVouchersTable.id })
    .from(paymentVouchersTable)
    .where(and(
      eq(paymentVouchersTable.firmId, args.firmId),
      eq(paymentVouchersTable.clientRequestId, clientRequestId),
    ))
    .limit(1);
  if (existingPv?.[0]) {
    return { paymentVoucherId: Number(existingPv[0].id), createdNow: false };
  }
  const payeeName = args.employeeName?.trim() || `Employee #${args.employeeId}`;
  const purpose = args.description?.trim()
    ? `HR Claim (${args.claimTypeCode}) — ${args.description.trim()}`
    : `HR Claim (${args.claimTypeCode})`;
  const voucherNo = HR_CLAIM_PV_VOUCHER_NO(args.firmId, args.claimId);
  let pvRow: any = null;
  try {
    const inserted = await tx
      .insert(paymentVouchersTable)
      .values({
        firmId: args.firmId,
        voucherType: "hr_staff_claim",
        approvalStatus: "approved",
        voucherNo,
        clientRequestId,
        status: "pending_accounting",
        payeeName,
        amount: String(args.amount.toFixed(2)),
        purpose,
        preparedBy: args.actorUserId,
        createdBy: args.actorUserId,
      })
      .returning({ id: paymentVouchersTable.id });
    pvRow = inserted?.[0];
  } catch (insertErr: unknown) {
    if (isUniqueViolation(insertErr)) {
      const retry = await tx
        .select({ id: paymentVouchersTable.id })
        .from(paymentVouchersTable)
        .where(and(
          eq(paymentVouchersTable.firmId, args.firmId),
          eq(paymentVouchersTable.clientRequestId, clientRequestId),
        ))
        .limit(1);
      if (retry?.[0]) {
        return { paymentVoucherId: Number(retry[0].id), createdNow: false };
      }
    }
    throw createHRError(
      HR_ERROR_CODES.HR_ACCOUNTING_DOWNSTREAM_FAILED,
      `Failed to create accounting payment voucher for claim ${args.claimId}`,
      { details: isSchemaMissing(insertErr) ? "SCHEMA_MISSING" : undefined },
    );
  }
  const paymentVoucherId = pvRow?.id != null ? Number(pvRow.id) : 0;
  if (paymentVoucherId <= 0) {
    throw createHRError(
      HR_ERROR_CODES.HR_ACCOUNTING_DOWNSTREAM_FAILED,
      `Payment voucher id not returned for claim ${args.claimId}`,
    );
  }
  const entryDate = formatEntryDate(args.claimDate || new Date());
  const amt = Math.max(0, Number(args.amount) || 0);
  const expenseRows = await tx
    .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
    .from(ledgerEntriesTable)
    .where(and(
      eq(ledgerEntriesTable.firmId, args.firmId),
      eq(ledgerEntriesTable.accountType, "office"),
      sql`case_id IS NULL`,
    ));
  const prevBal = Number(expenseRows?.[0]?.bal ?? 0);
  const afterExpense = prevBal - amt;
  await tx.insert(ledgerEntriesTable).values({
    firmId: args.firmId,
    caseId: null,
    entryDate,
    entryType: "hr_claim_expense",
    accountType: "office",
    debit: amt.toFixed(2),
    credit: "0.00",
    balanceAfter: afterExpense.toFixed(2),
    description: `HR Claim expense: ${payeeName} / ${args.claimTypeCode}`,
    referenceNo: voucherNo,
    sourceType: "hr_claim",
    sourceId: args.claimId,
    createdBy: args.actorUserId,
  });
  const liabRows = await tx
    .select({ bal: sql<string>`COALESCE(SUM(credit - debit), 0)` })
    .from(ledgerEntriesTable)
    .where(and(
      eq(ledgerEntriesTable.firmId, args.firmId),
      eq(ledgerEntriesTable.accountType, "balance_sheet"),
      sql`case_id IS NULL`,
    ));
  const prevLiab = Number(liabRows?.[0]?.bal ?? 0);
  const afterLiab = prevLiab + amt;
  await tx.insert(ledgerEntriesTable).values({
    firmId: args.firmId,
    caseId: null,
    entryDate,
    entryType: "hr_claim_payable",
    accountType: "balance_sheet",
    debit: "0.00",
    credit: amt.toFixed(2),
    balanceAfter: afterLiab.toFixed(2),
    description: `HR Claim payable (PV#${paymentVoucherId})`,
    referenceNo: voucherNo,
    sourceType: "hr_claim",
    sourceId: args.claimId,
    createdBy: args.actorUserId,
  });
  return { paymentVoucherId, createdNow: true };
}

export async function createClaim(
  input: CreateClaimInput,
  opts: { tx?: unknown } = {},
): Promise<ClaimRecord> {
  const { firmId, employeeId, claimType, description, amount, incurrenceDate, actorUserId, receipts } = input;
  if (amount < 0) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "claim amount must be >= 0");
  }
  const now = new Date();
  const ref = receipts && receipts.length ? String(receipts[0]) : null;
  const conn = pickDbConn(opts.tx);
  const mutate = async (): Promise<ClaimRecord> => {
    await assertEmployeeBelongs(conn, firmId, employeeId);
    const [inserted] = await (conn as any)
      .insert(hrClaimsTable)
      .values({
        firmId,
        employeeId,
        claimTypeCode: claimType,
        description,
        amount,
        claimDate: incurrenceDate,
        receiptDocumentRef: ref,
        status: "draft",
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      })
      .returning()
      .execute();
    return toClaim(inserted);
  };
  return mutate();
}

export async function submitClaim(
  input: { firmId: number; claimId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ claim: ClaimRecord; wasAlreadySubmitted: boolean }> {
  const now = new Date();
  const conn = pickDbConn(opts.tx);
  const mutate = async () => {
    const [existing] = await conn
      .select()
      .from(hrClaimsTable as any)
      .where(and(eq((hrClaimsTable as any).firmId, input.firmId), eq((hrClaimsTable as any).id, input.claimId)))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Claim not found");
    const wasAlreadySubmitted = existing.status === "submitted" || existing.status === "approved";
    let row: any = existing;
    if (!wasAlreadySubmitted) {
      const [upd] = await (conn as any)
        .update(hrClaimsTable)
        .set({ status: "submitted", submittedAt: now, updatedAt: now, updatedByUserId: input.actorUserId })
        .where(eq((hrClaimsTable as any).id, input.claimId))
        .returning()
        .execute();
      row = upd;
    }
    return { claim: toClaim(row), wasAlreadySubmitted };
  };
  return mutate();
}

export async function approveClaimWithPayable(
  input: { firmId: number; claimId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ claim: ClaimRecord; wasAlreadyApproved: boolean; payableCreatedNow: boolean; payableId: number | null; claimStatus: string; accounting_created: boolean }> {
  const now = new Date();
  const outerConn = pickDbConn(opts.tx);
  const runInTx = async (tx: any) => {
    const [existing] = await tx
      .select()
      .from(hrClaimsTable as any)
      .where(and(eq((hrClaimsTable as any).firmId, input.firmId), eq((hrClaimsTable as any).id, input.claimId)))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Claim not found");
    await assertEmployeeBelongs(tx, input.firmId, Number(existing.employeeId));
    const wasAlreadyApproved = existing.status === "approved";
    let row: any = existing;
    let payableCreatedNow = false;
    let payableId: number | null = null;
    if (wasAlreadyApproved) {
      payableId = existing.accountingPayableId != null ? Number(existing.accountingPayableId) : null;
      if (payableId == null) {
        const key = HR_CLAIM_PV_CLIENT_KEY(input.firmId, input.claimId);
        const [pvRow] = await tx
          .select({ id: paymentVouchersTable.id })
          .from(paymentVouchersTable)
          .where(and(eq(paymentVouchersTable.firmId, input.firmId), eq(paymentVouchersTable.clientRequestId, key)))
          .limit(1);
        if (pvRow) {
          payableId = Number(pvRow.id);
          const [backfill] = await (tx as any)
            .update(hrClaimsTable)
            .set({ accountingCreated: true, accountingPayableId: payableId, updatedAt: now, updatedByUserId: input.actorUserId })
            .where(eq((hrClaimsTable as any).id, input.claimId))
            .returning()
            .execute();
          row = backfill ?? row;
        }
      }
    } else {
      let empName: string | null = null;
      try {
        const [empRow] = await tx
          .select({ fullName: (hrEmployeesTable as any).fullName, displayName: (hrEmployeesTable as any).displayName })
          .from(hrEmployeesTable as any)
          .where(and(eq((hrEmployeesTable as any).firmId, input.firmId), eq((hrEmployeesTable as any).id, Number(existing.employeeId))))
          .limit(1);
        empName = String(empRow?.fullName || empRow?.displayName || "").trim() || null;
      } catch { empName = null; }
      const downstream = await createHrClaimDownstreamInTx(tx, {
        firmId: input.firmId,
        claimId: input.claimId,
        employeeId: Number(existing.employeeId),
        employeeName: empName,
        claimTypeCode: String(existing.claimTypeCode || "OTHER"),
        description: existing.description ?? null,
        amount: Number(existing.amount ?? 0),
        claimDate: existing.claimDate ? new Date(existing.claimDate) : now,
        actorUserId: input.actorUserId,
      });
      payableId = downstream.paymentVoucherId;
      payableCreatedNow = downstream.createdNow;
      const [upd] = await (tx as any)
        .update(hrClaimsTable)
        .set({
          status: "approved",
          reviewedByUserId: input.actorUserId,
          reviewedAt: now,
          accountingCreated: true,
          accountingPayableId: payableId,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrClaimsTable as any).id, input.claimId))
        .returning()
        .execute();
      row = upd;
    }
    return { claim: toClaim(row), wasAlreadyApproved, payableCreatedNow, payableId, claimStatus: String(row.status), accounting_created: Boolean(row.accountingCreated) };
  };
  if (opts.tx) return runInTx(outerConn);
  return db.transaction((tx: any) => runInTx(tx));
}

export async function rejectClaim(
  input: { firmId: number; claimId: number; actorUserId: number; reason?: string | null },
  opts: { tx?: unknown } = {},
): Promise<{ claim: ClaimRecord; wasAlreadyRejected: boolean }> {
  const now = new Date();
  const conn = pickDbConn(opts.tx);
  const mutate = async () => {
    const [existing] = await conn
      .select()
      .from(hrClaimsTable as any)
      .where(and(eq((hrClaimsTable as any).firmId, input.firmId), eq((hrClaimsTable as any).id, input.claimId)))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Claim not found");
    const wasAlreadyRejected = existing.status === "rejected";
    let row: any = existing;
    if (!wasAlreadyRejected) {
      const [upd] = await (conn as any)
        .update(hrClaimsTable)
        .set({
          status: "rejected",
          reviewedByUserId: input.actorUserId,
          reviewedAt: now,
          rejectionReason: input.reason ?? null,
          accountingCreated: false,
          accountingPayableId: null,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrClaimsTable as any).id, input.claimId))
        .returning()
        .execute();
      row = upd;
    }
    return { claim: toClaim(row), wasAlreadyRejected };
  };
  return mutate();
}

export async function listMyClaims(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<ClaimRecord[]> {
  const conn = pickDbConn(opts.tx);
  const rows: any[] = await conn
    .select()
    .from(hrClaimsTable as any)
    .where(and(
      eq((hrClaimsTable as any).firmId, input.firmId),
      eq((hrClaimsTable as any).employeeId, input.employeeId),
    ))
    .orderBy((hrClaimsTable as any).createdAt)
    .execute();
  return rows.map(toClaim);
}

export async function listAdminClaims(
  input: { firmId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<ClaimRecord[]> {
  const conn = pickDbConn(opts.tx);
  const rows: any[] = await conn
    .select()
    .from(hrClaimsTable as any)
    .where(eq((hrClaimsTable as any).firmId, input.firmId))
    .orderBy((hrClaimsTable as any).createdAt)
    .execute();
  return rows.map(toClaim);
}

void or;
void sql;
void isNotNull;
