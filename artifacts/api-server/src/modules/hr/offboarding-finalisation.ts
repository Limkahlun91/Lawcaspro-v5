import { eq, and, isNull, desc, count, sql } from "drizzle-orm";
import {
  db,
  caseAssignmentsTable,
  hrEmployeesTable,
  usersTable,
  paymentVouchersTable,
} from "@workspace/db";

export type OffboardingFinalisationScope = {
  actorId: number;
  firmId: number;
  employeeId: number;
  terminationDate: Date | null;
  lastWorkingDate: Date | null;
  dryRun?: boolean;
  ip?: string;
  ua?: string;
};

export type OffboardingChecklistSummary = {
  employee: { id: number; employeeNo: string | null; name: string | null; linkedUserId: number | null };
  activeCaseCount: number;
  pendingApprovalPvCount: number;
  pendingOwnedPvCount: number;
  activeAssignmentsPreview: Array<{ id: number; caseId: number; role: string | null }>;
};

type DbConnLike = {
  select: (cols: any) => any;
  insert: (t: any) => any;
  update: (t: any) => any;
  $count?: (t: any) => any;
};

function pickDbConn(tx: unknown): DbConnLike {
  if (tx && typeof (tx as any).select === "function") return tx as DbConnLike;
  return db as unknown as DbConnLike;
}

async function lazyAudit(args: {
  firmId: number;
  actorId: number;
  actorType?: "firm_user" | "system" | "founder";
  action: string;
  entityType?: string;
  entityId?: number;
  detail?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  try {
    const mod = await import("../../lib/auth.js");
    if (mod && typeof mod.writeAuditLog === "function") {
      await mod.writeAuditLog(args);
      return;
    }
  } catch {
    // test context without compiled lib/auth.js
  }
}

export async function buildOffboardingChecklist(
  firmId: number,
  employeeId: number,
  tx?: unknown,
): Promise<OffboardingChecklistSummary | null> {
  const d = pickDbConn(tx);
  const empQ = d
    .select({
      id: hrEmployeesTable.id,
      employeeNo: hrEmployeesTable.employeeNo,
      name: hrEmployeesTable.legalFullName,
      linkedUserId: hrEmployeesTable.linkedUserId,
    })
    .from(hrEmployeesTable)
    .where(and(eq(hrEmployeesTable.firmId, firmId), eq(hrEmployeesTable.id, employeeId)))
    .limit(1);
  const empRows = await (typeof empQ.execute === "function" ? empQ.execute() : empQ);
  const emp = empRows && empRows[0];
  if (!emp) return null;
  const linkedUserId = emp.linkedUserId ? Number(emp.linkedUserId) : null;

  const assignmentsTbl: any = caseAssignmentsTable;

  let activeAssignments: Array<{ id: number; caseId: number; role: string | null }> = [];
  if (linkedUserId) {
    const aQ = d
      .select({
        id: assignmentsTbl.id,
        caseId: assignmentsTbl.caseId,
        role: assignmentsTbl.assignmentRole ?? assignmentsTbl.roleInCase,
      })
      .from(caseAssignmentsTable)
      .where(and(
        assignmentsTbl.firmId ? eq(assignmentsTbl.firmId, firmId) : eq(assignmentsTbl.userId, linkedUserId),
        eq(assignmentsTbl.userId, linkedUserId),
        isNull(assignmentsTbl.unassignedAt),
      ))
      .orderBy(desc(assignmentsTbl.id));
    const aRows = await (typeof aQ.execute === "function" ? aQ.execute() : aQ);
    activeAssignments = (aRows ?? []).map((a: any) => ({
      id: Number(a.id), caseId: Number(a.caseId), role: a.role != null ? String(a.role) : null,
    }));
  }

  let apvCount = 0;
  let opvCount = 0;
  if (linkedUserId) {
    const apvQ = d
      .select({ n: count() })
      .from(paymentVouchersTable)
      .where(and(eq(paymentVouchersTable.firmId, firmId), eq((paymentVouchersTable as any).approvingPartnerId ?? paymentVouchersTable.approvingPartnerId, linkedUserId)));
    const apvRows = await (typeof apvQ.execute === "function" ? apvQ.execute() : apvQ);
    apvCount = toNum0(apvRows?.[0]?.n);
    const opvQ = d
      .select({ n: count() })
      .from(paymentVouchersTable)
      .where(and(eq(paymentVouchersTable.firmId, firmId), eq((paymentVouchersTable as any).responsibleLawyerId ?? paymentVouchersTable.responsibleLawyerId, linkedUserId)));
    const opvRows = await (typeof opvQ.execute === "function" ? opvQ.execute() : opvQ);
    opvCount = toNum0(opvRows?.[0]?.n);
  }

  return {
    employee: {
      id: Number(emp.id),
      employeeNo: emp.employeeNo ?? null,
      name: emp.name ?? null,
      linkedUserId,
    },
    activeCaseCount: activeAssignments.length,
    pendingApprovalPvCount: apvCount,
    pendingOwnedPvCount: opvCount,
    activeAssignmentsPreview: activeAssignments,
  };
}

export async function finaliseEmployeeOffboarding(
  tx: unknown,
  scope: OffboardingFinalisationScope,
): Promise<{
  dryRun: boolean;
  assignmentsUnassigned: number;
  employeeStatusUpdated: boolean;
  userStatusInactivated: boolean;
  summary: OffboardingChecklistSummary | null;
}> {
  const d = pickDbConn(tx);
  const summary = await buildOffboardingChecklist(scope.firmId, scope.employeeId, tx);
  if (!summary) {
    return {
      dryRun: scope.dryRun ?? false,
      assignmentsUnassigned: 0,
      employeeStatusUpdated: false,
      userStatusInactivated: false,
      summary: null,
    };
  }
  const linkedUserId = summary.employee.linkedUserId;
  let assignmentsUnassigned = 0;
  if (!scope.dryRun && linkedUserId) {
    const assignmentsTbl: any = caseAssignmentsTable;
    try {
      const unassignQuery = sql`
        UPDATE case_assignments
           SET unassigned_at = ${new Date()},
               updated_at = ${new Date()},
               unassigned_by_user_id = ${scope.actorId}::int,
               removal_reason = ${"offboarding_finalize"}::text
         WHERE user_id = ${linkedUserId}::int
           AND unassigned_at IS NULL
           ${scope.firmId != null ? sql`AND firm_id = ${scope.firmId}::int` : sql``}
        RETURNING id::int
      `;
      let rows: any[] = [];
      if (typeof (d as any).execute === "function") {
        const res = await (d as any).execute(unassignQuery);
        rows = (res && res.rows) ? res.rows : (Array.isArray(res) ? res : []);
      } else {
        const set: any = { unassignedAt: new Date() };
        if (assignmentsTbl.updatedAt !== undefined) set.updatedAt = new Date();
        if (assignmentsTbl.unassignedByUserId !== undefined) set.unassignedByUserId = scope.actorId;
        if (assignmentsTbl.removalReason !== undefined) set.removalReason = "offboarding_finalize";
        const whereConds: any[] = [eq(assignmentsTbl.userId, linkedUserId), isNull(assignmentsTbl.unassignedAt)];
        if (assignmentsTbl.firmId !== undefined) whereConds.push(eq(assignmentsTbl.firmId, scope.firmId));
        const upd = d
          .update(caseAssignmentsTable)
          .set(set)
          .where(and(...whereConds))
          .returning({ id: assignmentsTbl.id });
        rows = await (typeof upd.execute === "function" ? upd.execute() : upd);
      }
      assignmentsUnassigned = (rows ?? []).length;
    } catch {
      assignmentsUnassigned = 0;
    }
  }

  let employeeStatusUpdated = false;
  if (!scope.dryRun) {
    const empTbl: any = hrEmployeesTable;
    const set: any = { employmentStatus: "terminated" as any };
    if (empTbl.terminationDate !== undefined) set.terminationDate = scope.terminationDate;
    if (empTbl.lastWorkingDate !== undefined) set.lastWorkingDate = scope.lastWorkingDate;
    if (empTbl.terminatedAt !== undefined) set.terminatedAt = new Date();
    if (empTbl.lastStatusChangeAt !== undefined) set.lastStatusChangeAt = new Date();
    if (empTbl.updatedByUserId !== undefined) set.updatedByUserId = scope.actorId;
    if (empTbl.updatedAt !== undefined) set.updatedAt = new Date();
    const upd = d
      .update(hrEmployeesTable)
      .set(set)
      .where(and(eq(hrEmployeesTable.firmId, scope.firmId), eq(hrEmployeesTable.id, scope.employeeId)))
      .returning({ id: hrEmployeesTable.id });
    const rows = await (typeof upd.execute === "function" ? upd.execute() : upd);
    employeeStatusUpdated = Boolean(rows && rows[0]);
  }

  let userStatusInactivated = false;
  if (!scope.dryRun && linkedUserId) {
    const usersTbl: any = usersTable;
    const set: any = { status: "inactive" as any };
    if (usersTbl.updatedAt !== undefined) set.updatedAt = new Date();
    const upd = d
      .update(usersTable)
      .set(set)
      .where(and(eq(usersTbl.firmId ?? usersTable.firmId, scope.firmId), eq(usersTable.id, linkedUserId)))
      .returning({ id: usersTable.id });
    const rows = await (typeof upd.execute === "function" ? upd.execute() : upd);
    userStatusInactivated = Boolean(rows && rows[0]);
  }

  await lazyAudit({
    firmId: scope.firmId,
    actorId: scope.actorId,
    actorType: "firm_user",
    action: "hr.offboarding.finalise",
    entityType: "hr_employee",
    entityId: scope.employeeId,
    detail: JSON.stringify({
      dryRun: scope.dryRun ?? false,
      linkedUserId,
      assignmentsUnassigned,
      employeeStatusUpdated,
      userStatusInactivated,
      summary: {
        activeCaseCount: summary.activeCaseCount,
        pendingApprovalPvCount: summary.pendingApprovalPvCount,
        pendingOwnedPvCount: summary.pendingOwnedPvCount,
      },
    }),
    ipAddress: scope.ip,
    userAgent: scope.ua,
  });
  return {
    dryRun: scope.dryRun ?? false,
    assignmentsUnassigned,
    employeeStatusUpdated,
    userStatusInactivated,
    summary,
  };
}

function toNum0(n: unknown): number {
  if (n == null) return 0;
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}
void sql;
