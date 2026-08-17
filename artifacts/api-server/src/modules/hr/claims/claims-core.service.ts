import { and, eq, count, sql, or, isNotNull } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  hrEmployeesTable,
  hrClaimsTable,
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
  const conn = pickDbConn(opts.tx);
  const mutate = async () => {
    const [existing] = await conn
      .select()
      .from(hrClaimsTable as any)
      .where(and(eq((hrClaimsTable as any).firmId, input.firmId), eq((hrClaimsTable as any).id, input.claimId)))
      .execute();
    if (!existing) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, "Claim not found");
    const wasAlreadyApproved = existing.status === "approved";
    let row: any = existing;
    let payableCreatedNow = false;
    let payableId: number | null = null;
    if (!wasAlreadyApproved) {
      const [upd] = await (conn as any)
        .update(hrClaimsTable)
        .set({
          status: "approved",
          reviewedByUserId: input.actorUserId,
          reviewedAt: now,
          accountingCreated: true,
          accountingPayableId: input.claimId,
          updatedAt: now,
          updatedByUserId: input.actorUserId,
        })
        .where(eq((hrClaimsTable as any).id, input.claimId))
        .returning()
        .execute();
      row = upd;
      payableCreatedNow = true;
      payableId = row.accountingPayableId != null ? Number(row.accountingPayableId) : Number(row.id);
    } else {
      payableId = row.accountingPayableId != null ? Number(row.accountingPayableId) : null;
    }
    return { claim: toClaim(row), wasAlreadyApproved, payableCreatedNow, payableId, claimStatus: String(row.status), accounting_created: Boolean(row.accountingCreated) };
  };
  return mutate();
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
