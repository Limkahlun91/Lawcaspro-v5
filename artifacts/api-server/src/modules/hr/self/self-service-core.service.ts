import { db, type AppDb, type RlsDb } from "@workspace/db";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

export interface EmployeeProfile {
  employeeId: number;
  userId: number | null;
  fullName: string;
  email: string;
  position: string | null;
  department: string | null;
  dateOfJoining: Date | null;
  contactInfo: Record<string, unknown> | null;
}

export interface LeaveSummary {
  leaveType: string;
  entitled: number;
  used: number;
  remaining: number;
  pending: number;
}

export interface ClaimSummary {
  id: number;
  claimType: string;
  amount: number;
  status: string;
  submittedAt: Date | null;
}

export interface PayslipSummary {
  id: number;
  payrollRunId: number;
  periodName: string;
  grossPay: number;
  netPay: number;
  issuedAt: Date;
}

export interface AttendanceSummary {
  date: Date;
  status: string;
  clockIn: Date | null;
  clockOut: Date | null;
  hoursWorked: number;
}

export interface DocumentSummary {
  id: number;
  documentType: string;
  fileName: string;
  uploadedAt: Date;
  expiresAt: Date | null;
}

export interface AssetSummary {
  id: number;
  assetType: string;
  assetName: string;
  serialNumber: string | null;
  assignedAt: Date;
}

export async function getProfile(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<EmployeeProfile | null> {
  return null;
}

export async function getMyLeave(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<LeaveSummary[]> {
  return [];
}

export async function getMyClaims(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<ClaimSummary[]> {
  return [];
}

export async function getMyPayslips(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<PayslipSummary[]> {
  return [];
}

export async function getMyAttendance(
  input: { firmId: number; userId: number; employeeId: number; startDate?: Date; endDate?: Date },
  opts: { tx?: unknown } = {},
): Promise<AttendanceSummary[]> {
  return [];
}

export async function getMyDocuments(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<DocumentSummary[]> {
  return [];
}

export async function getMyAssets(
  input: { firmId: number; userId: number; employeeId: number },
  opts: { tx?: unknown } = {},
): Promise<AssetSummary[]> {
  return [];
}
