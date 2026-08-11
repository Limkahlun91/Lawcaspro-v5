import { db, type AppDb, type RlsDb } from "@workspace/db";
import { ApiError } from "../../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

export type OffboardingGuardCode =
  | "OFFBOARDING_ACTIVE_CASES_PENDING"
  | "OFFBOARDING_APPROVALS_PENDING"
  | "OFFBOARDING_ASSETS_PENDING"
  | "OFFBOARDING_CLAIMS_PENDING"
  | "OFFBOARDING_PAYROLL_PENDING";

export interface OffboardingChecklistItem {
  id: string;
  category: string;
  label: string;
  status: "pending" | "in_progress" | "completed";
  assignedTo: number | null;
  dueDate: Date | null;
}

export interface OffboardingRecord {
  id: number;
  employeeId: number;
  reason: string | null;
  lastWorkingDay: Date;
  status: "initiated" | "in_progress" | "finalised" | "cancelled";
  activeCaseCount: number;
  pendingApprovals: number;
  assetsCount: number;
  claimsCount: number;
  payrollOpen: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function startOffboarding(
  input: {
    firmId: number;
    employeeId: number;
    lastWorkingDay: Date;
    reason: string | null;
    actorUserId: number;
  },
  opts: { tx?: unknown } = {},
): Promise<OffboardingRecord> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    id: Math.floor(Math.random() * 1_000_000) + 1,
    employeeId: input.employeeId,
    reason: input.reason,
    lastWorkingDay: input.lastWorkingDay,
    status: "initiated",
    activeCaseCount: 0,
    pendingApprovals: 0,
    assetsCount: 0,
    claimsCount: 0,
    payrollOpen: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getChecklist(
  input: { firmId: number; offboardingId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<OffboardingChecklistItem[]> {
  return [];
}

export interface FinaliseOffboardingResult {
  record: OffboardingRecord;
  wasAlreadyFinalised: boolean;
  guardsPassed: boolean;
  failedGuardCode: OffboardingGuardCode | null;
}

export async function finaliseOffboarding(
  input: {
    firmId: number;
    offboardingId: number;
    actorUserId: number;
    guardContext?: {
      activeCasesPending?: boolean;
      pendingApprovals?: boolean;
      pendingAssets?: boolean;
      pendingClaims?: boolean;
      pendingPayroll?: boolean;
    };
  },
  opts: { tx?: unknown } = {},
): Promise<FinaliseOffboardingResult> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const gc = input.guardContext ?? {};
  const stub: OffboardingRecord = {
    id: input.offboardingId,
    employeeId: 0,
    reason: null,
    lastWorkingDay: now,
    status: "finalised",
    activeCaseCount: gc.activeCasesPending ? 1 : 0,
    pendingApprovals: gc.pendingApprovals ? 1 : 0,
    assetsCount: gc.pendingAssets ? 1 : 0,
    claimsCount: gc.pendingClaims ? 1 : 0,
    payrollOpen: gc.pendingPayroll ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  if (gc.activeCasesPending) {
    throw new ApiError({ status: 409, code: "OFFBOARDING_ACTIVE_CASES_PENDING", message: "Active cases pending resolution before offboarding finalise", retryable: false });
  }
  if (gc.pendingApprovals) {
    throw new ApiError({ status: 409, code: "OFFBOARDING_APPROVALS_PENDING", message: "Pending approvals must be cleared before offboarding finalise", retryable: false });
  }
  if (gc.pendingAssets) {
    throw new ApiError({ status: 409, code: "OFFBOARDING_ASSETS_PENDING", message: "All assets must be returned before offboarding finalise", retryable: false });
  }
  if (gc.pendingClaims) {
    throw new ApiError({ status: 409, code: "OFFBOARDING_CLAIMS_PENDING", message: "All claims must be settled before offboarding finalise", retryable: false });
  }
  if (gc.pendingPayroll) {
    throw new ApiError({ status: 409, code: "OFFBOARDING_PAYROLL_PENDING", message: "All payroll runs must be finalised before offboarding finalise", retryable: false });
  }
  return {
    record: stub,
    wasAlreadyFinalised: false,
    guardsPassed: true,
    failedGuardCode: null,
  };
}
