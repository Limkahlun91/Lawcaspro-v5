import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  paymentVouchersTable,
  rolesTable,
} from "@workspace/db";

type DbConnLike = {
  select: (cols?: any) => any;
  insert: (t: any) => any;
  update: (t: any) => any;
};

function pickDbConn(tx: unknown | undefined): DbConnLike {
  if (tx && typeof (tx as any).select === "function") return tx as DbConnLike;
  return db as unknown as DbConnLike;
}
import {
  upsertIdempotentNotification,
  resolveNotificationsByEventKey,
  buildNotificationEventKey,
  type NotificationIdempotentKey,
} from "../shared/notifications-canonical.js";

export type PvEscalationLevel = "L1_RESPONSIBLE" | "L2_PARTNER";

export const DEFAULT_L1_DELAY_HOURS = 72;
export const DEFAULT_L2_DELAY_HOURS = 168;

export async function findPartnerRoleIds(firmId: number, tx?: unknown): Promise<number[]> {
  const d = pickDbConn(tx);
  const rowsQ = d
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(
      eq(rolesTable.firmId, firmId),
      inArray(rolesTable.name, [
        "Partner", "partner", "Managing Partner", "Senior Partner",
        "managing partner", "senior partner", "Director", "director",
      ] as unknown as string[]),
    ));
  const rows = await (typeof rowsQ.execute === "function" ? rowsQ.execute() : rowsQ);
  return (rows ?? []).map((r: any) => Number(r.id));
}

export type PvEscalationInspection = {
  pvId: number;
  firmId: number;
  status: string;
  fundStatus: string;
  responsibleLawyerId: number | null;
  approvingPartnerId: number | null;
  hoursSinceApproved: number;
  shouldEscalateL1: boolean;
  shouldEscalateL2: boolean;
  completed: boolean;
};

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
    // test context
  }
}

export async function inspectPvForEscalation(
  firmId: number,
  pvId: number,
  opts: { l1Hours?: number; l2Hours?: number; tx?: unknown } = {},
): Promise<PvEscalationInspection | null> {
  const d = pickDbConn(opts.tx);
  const pvTbl: any = paymentVouchersTable;
  const sel: Record<string, any> = { id: pvTbl.id };
  function addCol(label: string, candidates: string[]) {
    for (const c of candidates) if (pvTbl[c] !== undefined) { sel[label] = pvTbl[c]; return; }
  }
  addCol("firmId", ["firmId", "firm_id"]);
  addCol("caseId", ["caseId", "case_id"]);
  addCol("status", ["status"]);
  addCol("fundStatus", ["fundStatus", "fund_status"]);
  addCol("responsibleLawyerId", ["responsibleLawyerId", "responsible_lawyer_id"]);
  addCol("approvingPartnerId", ["approvingPartnerId", "approving_partner_id"]);
  addCol("approvedAt", ["approvedAt", "approved_at"]);
  addCol("createdAt", ["createdAt", "created_at"]);
  addCol("completedAt", ["completedAt", "completed_at", "paidAt", "paid_at"]);

  let firmEq: any;
  if (pvTbl.firmId !== undefined) firmEq = eq(pvTbl.firmId, firmId);
  else if (pvTbl.firm_id !== undefined) firmEq = eq(pvTbl.firm_id, firmId);
  else firmEq = eq(pvTbl.id, pvTbl.id);

  const q = d
    .select(sel as any)
    .from(paymentVouchersTable)
    .where(and(firmEq, eq(pvTbl.id, pvId)))
    .limit(1);
  const rows = await (typeof q.execute === "function" ? q.execute() : q);
  const pv = rows && rows[0];
  if (!pv) return null;
  const anyPv: any = pv;

  const l1 = opts.l1Hours ?? DEFAULT_L1_DELAY_HOURS;
  const l2 = opts.l2Hours ?? DEFAULT_L2_DELAY_HOURS;
  const now = Date.now();
  const refDate = anyPv.approvedAt ?? anyPv.partnerApprovedAt ?? anyPv.lawyerApprovedAt ?? anyPv.createdAt ?? now;
  const hoursSinceApproved = Math.max(0, Math.floor((now - new Date(refDate).getTime()) / 3_600_000));
  const status = String(anyPv.status ?? "").toLowerCase();
  const fundStatus = String(anyPv.fundStatus ?? "").toLowerCase();
  const completed =
    ["paid", "rejected", "cancelled", "voided"].includes(status)
    || fundStatus === "transferred"
    || anyPv.completedAt != null;

  const openTransfers =
    !completed
    && status === "approved"
    && fundStatus !== "transferred";

  const shouldEscalateL1 = openTransfers && hoursSinceApproved >= l1;
  const shouldEscalateL2 = openTransfers && hoursSinceApproved >= l2;

  const responsibleLawyerId = anyPv.responsibleLawyerId ? Number(anyPv.responsibleLawyerId) : null;
  const approvingPartnerId = anyPv.approvingPartnerId ? Number(anyPv.approvingPartnerId) : null;

  return {
    pvId,
    firmId,
    status: String(anyPv.status ?? ""),
    fundStatus: String(anyPv.fundStatus ?? ""),
    responsibleLawyerId,
    approvingPartnerId,
    hoursSinceApproved,
    shouldEscalateL1,
    shouldEscalateL2,
    completed,
  };
}

export async function emitPvEscalationIfNeeded(
  inspection: PvEscalationInspection,
  opts: { tx?: unknown } = {},
): Promise<{
  created: Array<{ level: PvEscalationLevel; userId: number }>;
  updated: Array<{ level: PvEscalationLevel; userId: number }>;
  resolvedCount: number;
}> {
  const tx = opts.tx;
  const created: Array<{ level: PvEscalationLevel; userId: number }> = [];
  const updated: Array<{ level: PvEscalationLevel; userId: number }> = [];
  if (inspection.completed) {
    const prefix = `PV_OVERDUE:${inspection.pvId}:`;
    const resolved = await resolveNotificationsByEventKey(inspection.firmId, prefix, {
      entityType: "payment_voucher",
      resolvedReason: "pv_completed",
      tx,
    });
    return { created, updated, resolvedCount: resolved };
  }

  const recipients: Array<{ level: PvEscalationLevel; userId: number }> = [];
  if (inspection.shouldEscalateL1) {
    if (inspection.responsibleLawyerId) {
      recipients.push({ level: "L1_RESPONSIBLE", userId: inspection.responsibleLawyerId });
    }
  }
  if (inspection.shouldEscalateL2) {
    if (inspection.approvingPartnerId) {
      recipients.push({ level: "L2_PARTNER", userId: inspection.approvingPartnerId });
    }
  }

  for (const r of recipients) {
    const k: NotificationIdempotentKey = { kind: "pv_overdue", pvId: inspection.pvId, level: r.level };
    const eventKey = `${buildNotificationEventKey(k)}:U${r.userId}`;
    const res = await upsertIdempotentNotification({
      firmId: inspection.firmId,
      userId: r.userId,
      sourceType: "payment_voucher",
      sourceId: inspection.pvId,
      caseId: null,
      notificationType: r.level === "L2_PARTNER" ? "pv_overdue_partner" : "pv_overdue_responsible",
      title: `[PV Escalation ${r.level}] PV #${inspection.pvId} stuck ${inspection.hoursSinceApproved}h`,
      message: `PV #${inspection.pvId} (status=${inspection.status}, fund=${inspection.fundStatus}) has not been transferred for ${inspection.hoursSinceApproved}h.`,
      severity: r.level === "L2_PARTNER" ? "urgent" : "high",
      targetScope: r.level === "L2_PARTNER" ? "selected_partner" : "lawyer",
      eventKey,
      entityType: "payment_voucher",
      entityId: inspection.pvId,
      repeatHours: r.level === "L2_PARTNER" ? 48 : 24,
    }, tx);
    if (res.created) created.push(r);
    else if (res.updated) updated.push(r);
  }

  if (created.length || updated.length) {
    await lazyAudit({
      firmId: inspection.firmId,
      actorId: 0,
      actorType: "system",
      action: "pv.escalation.notify",
      entityType: "payment_voucher",
      entityId: inspection.pvId,
      detail: JSON.stringify({
        hoursSinceApproved: inspection.hoursSinceApproved,
        responsibleLawyerId: inspection.responsibleLawyerId,
        approvingPartnerId: inspection.approvingPartnerId,
        created,
        updated,
      }),
    });
  }
  return { created, updated, resolvedCount: 0 };
}
