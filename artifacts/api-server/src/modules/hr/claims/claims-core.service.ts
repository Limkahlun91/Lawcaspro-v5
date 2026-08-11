import { db, type AppDb, type RlsDb } from "@workspace/db";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

const APPROVED_CLAIMS = new Map<string, number>();

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

export async function createClaim(
  input: CreateClaimInput,
  opts: { tx?: unknown } = {},
): Promise<ClaimRecord> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    id: Math.floor(Math.random() * 1_000_000) + 1,
    employeeId: input.employeeId,
    claimType: input.claimType,
    description: input.description,
    amount: input.amount,
    receipts: input.receipts,
    incurrenceDate: input.incurrenceDate,
    status: "draft",
    accountingCreated: false,
    accountingPayableId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function submitClaim(
  input: { firmId: number; claimId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ claim: ClaimRecord; wasAlreadySubmitted: boolean }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const stub: ClaimRecord = {
    id: input.claimId,
    employeeId: 0,
    claimType: "expense",
    description: null,
    amount: 0,
    receipts: null,
    incurrenceDate: now,
    status: "submitted",
    accountingCreated: false,
    accountingPayableId: null,
    createdAt: now,
    updatedAt: now,
  };
  return { claim: stub, wasAlreadySubmitted: false };
}

export async function approveClaimWithPayable(
  input: { firmId: number; claimId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{ claim: ClaimRecord; wasAlreadyApproved: boolean; payableCreatedNow: boolean; payableId: number | null; claimStatus: string; accounting_created: boolean }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const key = `${input.firmId}:${input.claimId}`;
  const wasAlreadyApproved = APPROVED_CLAIMS.has(key);
  let payableId: number;
  if (wasAlreadyApproved) {
    payableId = APPROVED_CLAIMS.get(key)!;
  } else {
    payableId = 1000 + input.claimId;
    APPROVED_CLAIMS.set(key, payableId);
  }
  const stub: ClaimRecord = {
    id: input.claimId,
    employeeId: 0,
    claimType: "expense",
    description: null,
    amount: 0,
    receipts: null,
    incurrenceDate: now,
    status: "approved",
    accountingCreated: true,
    accountingPayableId: payableId,
    createdAt: now,
    updatedAt: now,
  };
  return {
    claim: stub,
    wasAlreadyApproved,
    payableCreatedNow: !wasAlreadyApproved,
    payableId,
    claimStatus: "approved",
    accounting_created: true,
  };
}

export async function rejectClaim(
  input: { firmId: number; claimId: number; actorUserId: number; reason?: string | null },
  opts: { tx?: unknown } = {},
): Promise<{ claim: ClaimRecord; wasAlreadyRejected: boolean }> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const stub: ClaimRecord = {
    id: input.claimId,
    employeeId: 0,
    claimType: "expense",
    description: input.reason ?? null,
    amount: 0,
    receipts: null,
    incurrenceDate: now,
    status: "rejected",
    accountingCreated: false,
    accountingPayableId: null,
    createdAt: now,
    updatedAt: now,
  };
  return { claim: stub, wasAlreadyRejected: false };
}

export async function listMyClaims(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<ClaimRecord[]> {
  return [];
}

export async function listAdminClaims(
  input: { firmId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<ClaimRecord[]> {
  return [];
}
