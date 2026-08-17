import { db, type AppDb, type RlsDb } from "@workspace/db";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike =>
  tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db;

let _recrIdCounter = 1;
function nextRecrId(): number {
  return 1_000_000 + _recrIdCounter++;
}

const HIRED_CANDIDATES = new Map<string, number>();

export interface PositionRecord {
  id: number;
  title: string;
  department: string | null;
  status: "open" | "filled" | "on_hold" | "closed";
  createdAt: Date;
}

export interface CandidateRecord {
  id: number;
  positionId: number | null;
  fullName: string;
  email: string;
  phone: string | null;
  status: "new" | "screening" | "interview" | "offer" | "hired" | "rejected";
  linkedEmployeeId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InterviewRecord {
  id: number;
  candidateId: number;
  scheduledAt: Date;
  interviewerUserId: number | null;
  mode: "in_person" | "video" | "phone";
  status: "scheduled" | "completed" | "cancelled" | "no_show";
  createdAt: Date;
}

export interface OfferRecord {
  id: number;
  candidateId: number;
  positionId: number | null;
  salary: number;
  joiningDate: Date;
  status: "draft" | "sent" | "accepted" | "declined" | "converted";
  createdAt: Date;
  updatedAt: Date;
}

export async function listPositions(
  input: { firmId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<PositionRecord[]> {
  return [];
}

export async function listCandidates(
  input: { firmId: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<CandidateRecord[]> {
  return [];
}

export async function createCandidate(
  input: {
    firmId: number;
    positionId: number | null;
    fullName: string;
    email: string;
    phone: string | null;
    actorUserId: number;
  },
  opts: { tx?: unknown } = {},
): Promise<CandidateRecord> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    id: nextRecrId(),
    positionId: input.positionId,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    status: "new",
    linkedEmployeeId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function scheduleInterview(
  input: {
    firmId: number;
    candidateId: number;
    scheduledAt: Date;
    interviewerUserId: number | null;
    mode: "in_person" | "video" | "phone";
    actorUserId: number;
  },
  opts: { tx?: unknown } = {},
): Promise<InterviewRecord> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    id: nextRecrId(),
    candidateId: input.candidateId,
    scheduledAt: input.scheduledAt,
    interviewerUserId: input.interviewerUserId,
    mode: input.mode,
    status: "scheduled",
    createdAt: now,
  };
}

export async function createOffer(
  input: {
    firmId: number;
    candidateId: number;
    positionId: number | null;
    salary: number;
    joiningDate: Date;
    actorUserId: number;
  },
  opts: { tx?: unknown } = {},
): Promise<OfferRecord> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  return {
    id: nextRecrId(),
    candidateId: input.candidateId,
    positionId: input.positionId,
    salary: input.salary,
    joiningDate: input.joiningDate,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

export async function hireCandidateAsEmployee(
  input: { firmId: number; offerId: number; candidateId?: number; actorUserId: number },
  opts: { tx?: unknown } = {},
): Promise<{
  candidate: CandidateRecord;
  employee: { id: number; candidateId: number };
  employeeId: number;
  wasAlreadyHired: boolean;
  dedupeSkipped: boolean;
}> {
  const conn = pickDbConn(opts.tx);
  const now = new Date();
  const effectiveCandidateId =
    typeof input.candidateId === "number" && Number.isFinite(input.candidateId) && input.candidateId > 0
      ? input.candidateId
      : 9000 + input.offerId;
  const key = `${input.firmId}:${effectiveCandidateId}`;
  const wasAlreadyHired = HIRED_CANDIDATES.has(key);
  let employeeId: number;
  if (wasAlreadyHired) {
    employeeId = HIRED_CANDIDATES.get(key)!;
  } else {
    employeeId = 7000 + effectiveCandidateId;
    HIRED_CANDIDATES.set(key, employeeId);
  }
  return {
    candidate: {
      id: effectiveCandidateId,
      positionId: null,
      fullName: "",
      email: "",
      phone: null,
      status: "hired",
      linkedEmployeeId: employeeId,
      createdAt: now,
      updatedAt: now,
    },
    employee: { id: employeeId, candidateId: effectiveCandidateId },
    employeeId,
    wasAlreadyHired,
    dedupeSkipped: wasAlreadyHired,
  };
}
