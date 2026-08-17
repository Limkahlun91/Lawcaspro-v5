import { randomUUID } from "node:crypto";
import { logger } from "../../../lib/logger.js";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export interface HrTaskChecklistItem {
  id: string;
  templateCode: string;
  title: string;
  category: string;
  assigneeRole?: string | null;
  assigneeUserId?: number | null;
  dueDate?: string | null;
  completedAt?: string | null;
  completedByUserId?: number | null;
  status: "pending" | "in_progress" | "completed" | "blocked" | "skipped";
  notes?: string | null;
  sortOrder: number;
  attachments?: string[];
}

export interface HrOnboardingSession {
  id: string;
  firmId: number;
  employeeId: number;
  status: "draft" | "in_progress" | "completed" | "cancelled";
  tasks: HrTaskChecklistItem[];
  startedAt?: string;
  completedAt?: string;
  createdByUserId?: number;
  updatedAt?: string;
  version: number;
}

export interface HrOffboardingSession {
  id: string;
  firmId: number;
  employeeId: number;
  terminationDate?: string | null;
  lastWorkingDate?: string | null;
  status: "draft" | "in_progress" | "completed" | "cancelled";
  tasks: HrTaskChecklistItem[];
  initiatedAt?: string;
  completedAt?: string;
  initiatedByUserId?: number;
  exitInterviewDone: boolean;
  handoverNotes?: string | null;
  version: number;
}

const ONBOARDING_MEM_STORE: Map<string, HrOnboardingSession[]> = new Map();
const OFFBOARDING_MEM_STORE: Map<string, HrOffboardingSession[]> = new Map();

function getOnboardingStore(firmId: number): HrOnboardingSession[] {
  const k = String(firmId);
  if (!ONBOARDING_MEM_STORE.has(k)) ONBOARDING_MEM_STORE.set(k, []);
  return ONBOARDING_MEM_STORE.get(k) as HrOnboardingSession[];
}

function getOffboardingStore(firmId: number): HrOffboardingSession[] {
  const k = String(firmId);
  if (!OFFBOARDING_MEM_STORE.has(k)) OFFBOARDING_MEM_STORE.set(k, []);
  return OFFBOARDING_MEM_STORE.get(k) as HrOffboardingSession[];
}

function writeAudit(entry: { type: string; firmId: number; employeeId: number; actorUserId?: number; note?: string }) {
  logger.info(
    { type: entry.type, firmId: entry.firmId, employeeId: entry.employeeId, actor: entry.actorUserId, note: entry.note },
    "[hrOnboardingOffboarding] audit log entry",
  );
}

export function createOnboardingSession(
  firmId: number,
  employeeId: number,
  template: string[],
  actorUserId: number,
): HrOnboardingSession {
  if (!firmId || !employeeId) throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId + employeeId required");
  const store = getOnboardingStore(firmId);
  const now = new Date().toISOString();
  const tasks: HrTaskChecklistItem[] = template.map((code, idx) => ({
    id: `task-onb-${firmId}-${employeeId}-${idx}-${shortId()}`,
    templateCode: code,
    title: code,
    category: "onboarding",
    status: "pending",
    sortOrder: idx,
  }));
  const session: HrOnboardingSession = {
    id: `onb-${firmId}-${employeeId}-${shortId()}`,
    firmId,
    employeeId,
    status: "in_progress",
    tasks,
    startedAt: now,
    createdByUserId: actorUserId,
    version: 1,
  };
  store.push(session);
  writeAudit({ type: "HR_ONBOARDING_INITIATED", firmId, employeeId, actorUserId, note: `template codes=${template.join(",")}` });
  return session;
}

export function markOnboardingTask(
  firmId: number,
  sessionId: string,
  taskId: string,
  status: HrTaskChecklistItem["status"],
  actorUserId: number,
): HrOnboardingSession {
  const store = getOnboardingStore(firmId);
  const idx = store.findIndex((s) => s.id === sessionId);
  if (idx < 0) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `onboarding session ${sessionId} not found`);
  const session = store[idx];
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `task ${taskId} not found`);
  task.status = status;
  if (status === "completed") {
    task.completedAt = new Date().toISOString();
    task.completedByUserId = actorUserId;
  }
  session.version += 1;
  session.updatedAt = new Date().toISOString();
  writeAudit({ type: "HR_ONBOARDING_TASK_UPDATED", firmId, employeeId: session.employeeId, actorUserId, note: `task=${taskId} status=${status}` });
  if (session.tasks.every((t) => t.status === "completed" || t.status === "skipped")) {
    session.status = "completed";
    session.completedAt = new Date().toISOString();
    writeAudit({ type: "HR_ONBOARDING_COMPLETED", firmId, employeeId: session.employeeId, actorUserId });
  }
  return session;
}

export function initiateOffboardingSession(
  firmId: number,
  employeeId: number,
  options: { terminationDate?: string; lastWorkingDate?: string; template?: string[]; reason?: string },
  actorUserId: number,
): HrOffboardingSession {
  if (!firmId || !employeeId) throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId + employeeId required");
  const store = getOffboardingStore(firmId);
  const now = new Date().toISOString();
  const tpl = options.template ?? ["handover_documents", "return_assets", "exit_interview", "revoke_access", "final_payroll_check"];
  const tasks: HrTaskChecklistItem[] = tpl.map((code, idx) => ({
    id: `task-off-${firmId}-${employeeId}-${idx}-${shortId()}`,
    templateCode: code,
    title: code,
    category: "offboarding",
    status: "pending",
    sortOrder: idx,
  }));
  const session: HrOffboardingSession = {
    id: `off-${firmId}-${employeeId}-${shortId()}`,
    firmId,
    employeeId,
    terminationDate: options.terminationDate ?? null,
    lastWorkingDate: options.lastWorkingDate ?? null,
    status: "in_progress",
    tasks,
    initiatedAt: now,
    initiatedByUserId: actorUserId,
    exitInterviewDone: false,
    handoverNotes: options.reason ?? null,
    version: 1,
  };
  store.push(session);
  writeAudit({ type: "HR_OFFBOARDING_INITIATED", firmId, employeeId, actorUserId, note: options.reason });
  return session;
}

export function markOffboardingTask(
  firmId: number,
  sessionId: string,
  taskId: string,
  status: HrTaskChecklistItem["status"],
  actorUserId: number,
): HrOffboardingSession {
  const store = getOffboardingStore(firmId);
  const idx = store.findIndex((s) => s.id === sessionId);
  if (idx < 0) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `offboarding session ${sessionId} not found`);
  const session = store[idx];
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) throw createHRError(HR_ERROR_CODES.HR_EMPLOYEE_NOT_FOUND, `task ${taskId} not found`);
  task.status = status;
  if (status === "completed") {
    task.completedAt = new Date().toISOString();
    task.completedByUserId = actorUserId;
    if (task.templateCode === "exit_interview") session.exitInterviewDone = true;
  }
  session.version += 1;
  writeAudit({ type: "HR_OFFBOARDING_TASK_UPDATED", firmId, employeeId: session.employeeId, actorUserId, note: `task=${taskId} status=${status}` });
  if (session.tasks.every((t) => t.status === "completed" || t.status === "skipped") && session.exitInterviewDone) {
    session.status = "completed";
    session.completedAt = new Date().toISOString();
    writeAudit({ type: "HR_OFFBOARDING_COMPLETED", firmId, employeeId: session.employeeId, actorUserId });
  }
  return session;
}

export const hrOnboardingOffboardingScaffold = {
  createOnboardingSession,
  markOnboardingTask,
  initiateOffboardingSession,
  markOffboardingTask,
};

export default hrOnboardingOffboardingScaffold;
