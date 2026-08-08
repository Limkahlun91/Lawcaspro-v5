import { and, eq, isNull, sql, lt, inArray, or, gte, ne, gt } from "drizzle-orm";
import {
  firmsTable,
  casesTable,
  caseWorkflowStepsTable,
  caseAssignmentsTable,
  caseBottleneckSnapshotsTable,
  caseMonitorLogsTable,
  paymentVouchersTable,
  accountingSettingsTable,
  db,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { writeAuditLog } from "../lib/auth.js";

const CASE_NO_MOVEMENT_DAYS = 3;
const SCAN_INTERVAL_MS = 60 * 60 * 1000;
const PV_DELAY_HOURS = 48;
const CASE_APPROVAL_STALE_HOURS = 24;
const CASE_WAITING_KEYWORDS = ["awaiting", "waiting", "pending", "to be", "hold on", "stand by"];
const CASE_ON_HOLD_KEYWORDS = ["on hold", "suspended", "paused", "halted", "freeze"];

let running = false;
let timer: NodeJS.Timeout | null = null;

type EscalationConfigShape = {
  escalateToPartnerAtSeverity: "attention" | "urgent" | "critical" | "never";
  autoEscalateKinds: Array<"case_no_movement" | "case_waiting" | "case_on_hold" | "pv_delay" | "approval_waiting" | "urgent">;
  partnerBottleneckDigestEnabled: boolean;
};

const DEFAULT_ESCALATION_CONFIG: EscalationConfigShape = {
  escalateToPartnerAtSeverity: "never",
  autoEscalateKinds: [],
  partnerBottleneckDigestEnabled: false,
};

function severityRank(s: string | undefined | null): number {
  if (s === "critical") return 3;
  if (s === "urgent") return 2;
  if (s === "attention") return 1;
  return 0;
}

function meetsEscalationThreshold(config: EscalationConfigShape, severity: string, kind: string): boolean {
  if (!config || typeof config !== "object") return false;
  if (config.escalateToPartnerAtSeverity === "never") return false;
  if (config.autoEscalateKinds && Array.isArray(config.autoEscalateKinds) && !config.autoEscalateKinds.includes(kind as never)) return false;
  return severityRank(severity) >= severityRank(config.escalateToPartnerAtSeverity);
}

async function loadEscalationConfig(firmId: number): Promise<EscalationConfigShape> {
  try {
    const rows = await db
      .select({ approvalRules: accountingSettingsTable.approvalRules })
      .from(accountingSettingsTable)
      .where(eq(accountingSettingsTable.firmId, firmId))
      .limit(1);
    const blob: any = rows?.[0]?.approvalRules ?? {};
    const candidate = typeof blob === "object" && blob && "bottleneckEscalation" in blob ? (blob as any).bottleneckEscalation : {};
    const cfg: EscalationConfigShape = {
      escalateToPartnerAtSeverity:
        candidate?.escalateToPartnerAtSeverity === "critical" || candidate?.escalateToPartnerAtSeverity === "urgent" || candidate?.escalateToPartnerAtSeverity === "attention"
          ? candidate.escalateToPartnerAtSeverity
          : DEFAULT_ESCALATION_CONFIG.escalateToPartnerAtSeverity,
      autoEscalateKinds: Array.isArray(candidate?.autoEscalateKinds)
        ? (candidate.autoEscalateKinds.filter((k: unknown) =>
            ["case_no_movement", "case_waiting", "case_on_hold", "pv_delay", "approval_waiting", "urgent"].includes(String(k))
          ) as EscalationConfigShape["autoEscalateKinds"])
        : DEFAULT_ESCALATION_CONFIG.autoEscalateKinds,
      partnerBottleneckDigestEnabled: typeof candidate?.partnerBottleneckDigestEnabled === "boolean"
        ? candidate.partnerBottleneckDigestEnabled
        : DEFAULT_ESCALATION_CONFIG.partnerBottleneckDigestEnabled,
    };
    return cfg;
  } catch {
    return { ...DEFAULT_ESCALATION_CONFIG };
  }
}

async function tryAcquireLock(): Promise<boolean> {
  const r = await db.execute(sql`SELECT pg_try_advisory_lock(hashtext('case_bottleneck_monitor')) as ok`);
  const rows = Array.isArray(r) ? r : ("rows" in (r as any) ? (r as any).rows : []);
  const ok = rows?.[0]?.ok;
  return ok === true || ok === "t" || ok === 1;
}

async function releaseLock(): Promise<void> {
  try { await db.execute(sql`SELECT pg_advisory_unlock(hashtext('case_bottleneck_monitor'))`); } catch { /* ignore */ }
}

export async function scanBottlenecksForFirm(firmId: number, opts: { dryRun?: boolean } = {}) {
  const now = new Date();
  const movementCutoff = new Date(now.getTime() - CASE_NO_MOVEMENT_DAYS * 24 * 60 * 60 * 1000);
  const pvDueCutoff = new Date(now.getTime() - PV_DELAY_HOURS * 60 * 60 * 1000);
  const approvalStaleCutoff = new Date(now.getTime() - CASE_APPROVAL_STALE_HOURS * 60 * 60 * 1000);
  const createdSnapshots: number[] = [];
  const resolvedSnapshots: number[] = [];
  const escalatedSnapshots: number[] = [];
  const escalationConfig = await loadEscalationConfig(firmId);

  const activeCaseIds = await db
    .selectDistinctOn([casesTable.id], { id: casesTable.id })
    .from(casesTable)
    .innerJoin(caseAssignmentsTable, eq(caseAssignmentsTable.caseId, casesTable.id))
    .where(and(
      eq(casesTable.firmId, firmId),
      eq(casesTable.deletedAt, sql`NULL`),
      eq(caseAssignmentsTable.roleInCase, "lawyer"),
      sql`${caseAssignmentsTable.unassignedAt} IS NULL`,
    ));

  const lawyerIdByCase = new Map<number, number>();
  const managerIdByCase = new Map<number, number>();
  const caseAssignmentsRows = await db
    .select({
      caseId: caseAssignmentsTable.caseId,
      userId: caseAssignmentsTable.userId,
      roleInCase: caseAssignmentsTable.roleInCase,
    })
    .from(caseAssignmentsTable)
    .where(and(
      inArray(caseAssignmentsTable.caseId, activeCaseIds.map((c) => c.id)),
      sql`${caseAssignmentsTable.unassignedAt} IS NULL`,
    ));
  for (const a of caseAssignmentsRows) {
    if (String(a.roleInCase).toLowerCase() === "lawyer" && Number.isFinite(a.userId) && !lawyerIdByCase.has(Number(a.caseId))) {
      lawyerIdByCase.set(Number(a.caseId), Number(a.userId));
    }
    if (String(a.roleInCase).toLowerCase() === "manager" && Number.isFinite(a.userId) && !managerIdByCase.has(Number(a.caseId))) {
      managerIdByCase.set(Number(a.caseId), Number(a.userId));
    }
  }

  if (activeCaseIds.length > 0) {
    const lastMovementByCase = new Map<number, Date>();
    const rows = await db
      .select({
        caseId: caseWorkflowStepsTable.caseId,
        lastUpdated: sql<Date>`MAX(COALESCE(${caseWorkflowStepsTable.completedAt}, ${caseWorkflowStepsTable.updatedAt}, ${caseWorkflowStepsTable.createdAt}))`,
      })
      .from(caseWorkflowStepsTable)
      .where(inArray(caseWorkflowStepsTable.caseId, activeCaseIds.map((c) => c.id)))
      .groupBy(caseWorkflowStepsTable.caseId);
    for (const r of rows) {
      if (r.lastUpdated) lastMovementByCase.set(Number(r.caseId), new Date(String(r.lastUpdated)));
    }

    for (const { id } of activeCaseIds) {
      const last = lastMovementByCase.get(id);
      if (!last || last <= movementCutoff) {
        const existsOpen = await db
          .select({ id: caseBottleneckSnapshotsTable.id })
          .from(caseBottleneckSnapshotsTable)
          .where(and(
            eq(caseBottleneckSnapshotsTable.firmId, firmId),
            eq(caseBottleneckSnapshotsTable.caseId, id),
            eq(caseBottleneckSnapshotsTable.monitorKind, "case_no_movement"),
            isNull(caseBottleneckSnapshotsTable.resolvedAt),
          ))
          .limit(1);
        if (existsOpen[0]) continue;
        const caseRows = await db
          .select({
            id: casesTable.id,
            referenceNo: casesTable.referenceNo,
            status: casesTable.status,
            caseType: casesTable.caseType,
          })
          .from(casesTable)
          .where(eq(casesTable.id, id))
          .limit(1);
        const firstCreated = await db
          .select({ createdAt: caseWorkflowStepsTable.createdAt })
          .from(caseWorkflowStepsTable)
          .where(eq(caseWorkflowStepsTable.caseId, id))
          .orderBy(caseWorkflowStepsTable.createdAt)
          .limit(1);
        const c = caseRows[0];
        if (!c) continue;
        const anchor = firstCreated[0]?.createdAt ? new Date(String(firstCreated[0].createdAt)) : new Date();
        const ms = Math.max(0, now.getTime() - anchor.getTime());
        const daysStuck = Math.max(CASE_NO_MOVEMENT_DAYS, Math.floor(ms / (24 * 60 * 60 * 1000)));
        const severity: "attention" | "urgent" | "critical" = daysStuck >= 7 ? "critical" : daysStuck >= 5 ? "urgent" : "attention";
        const responsibleLawyerUserId = lawyerIdByCase.get(id) ?? null;
        const responsibleManagerUserId = managerIdByCase.get(id) ?? null;
        if (opts.dryRun) continue;
        const title = c.referenceNo ? `Case ${c.referenceNo}` : `Case #${c.id}`;
        const detail = `No workflow step movement for ${daysStuck} days. Status=${c.status ?? "n/a"}; Type=${c.caseType ?? "n/a"}.`;
        const ins = await db.insert(caseBottleneckSnapshotsTable).values({
          firmId,
          caseId: id,
          monitorKind: "case_no_movement",
          severity,
          daysStuck,
          responsibleLawyerUserId,
          responsibleManagerUserId,
          title,
          detail,
          metadata: { status: c.status ?? null, caseType: c.caseType ?? null, lastMovementAt: last?.toISOString() ?? null },
        }).returning({ id: caseBottleneckSnapshotsTable.id });
        if (ins[0]) {
          const sid = ins[0].id;
          createdSnapshots.push(sid);
          if (meetsEscalationThreshold(escalationConfig, severity, "case_no_movement")) {
            await escalateSnapshot(firmId, sid, null, `Auto-escalated (threshold=${escalationConfig.escalateToPartnerAtSeverity}): ${detail}`);
            escalatedSnapshots.push(sid);
          }
        }
      }
    }
  }

  const overduePvs = await db
    .select({
      id: paymentVouchersTable.id,
      voucherNo: paymentVouchersTable.voucherNo,
      paymentDueAt: paymentVouchersTable.paymentDueAt,
      caseId: paymentVouchersTable.caseId,
      amount: paymentVouchersTable.amount,
      status: paymentVouchersTable.status,
      responsibleLawyerId: paymentVouchersTable.responsibleLawyerId,
      firmId: paymentVouchersTable.firmId,
    })
    .from(paymentVouchersTable)
    .where(and(
      eq(paymentVouchersTable.firmId, firmId),
      ne(paymentVouchersTable.status, "completed"),
      ne(paymentVouchersTable.status, "rejected"),
      lt(paymentVouchersTable.paymentDueAt, pvDueCutoff),
    ));

  for (const pv of overduePvs) {
    const existsOpen = await db
      .select({ id: caseBottleneckSnapshotsTable.id })
      .from(caseBottleneckSnapshotsTable)
      .where(and(
        eq(caseBottleneckSnapshotsTable.firmId, firmId),
        eq(caseBottleneckSnapshotsTable.paymentVoucherId, pv.id),
        eq(caseBottleneckSnapshotsTable.monitorKind, "pv_delay"),
        isNull(caseBottleneckSnapshotsTable.resolvedAt),
      ))
      .limit(1);
    if (existsOpen[0]) continue;
    const due = pv.paymentDueAt ? new Date(String(pv.paymentDueAt)) : now;
    const hours = Math.max(0, Math.floor((now.getTime() - due.getTime()) / (60 * 60 * 1000)));
    const daysStuck = Math.max(1, Math.floor(hours / 24));
    const severity: "attention" | "urgent" | "critical" = hours >= 96 ? "critical" : hours >= 72 ? "urgent" : "attention";
    const responsibleManagerUserId = pv.caseId ? managerIdByCase.get(Number(pv.caseId)) ?? null : null;
    if (opts.dryRun) continue;
    const ins = await db.insert(caseBottleneckSnapshotsTable).values({
      firmId,
      caseId: pv.caseId ?? null,
      paymentVoucherId: pv.id,
      monitorKind: "pv_delay",
      severity,
      daysStuck,
      responsibleLawyerUserId: pv.responsibleLawyerId ?? null,
      responsibleManagerUserId,
      title: `PV Overdue: ${pv.voucherNo ?? `#${pv.id}`}`,
      detail: `Payment voucher overdue ${hours}h (status=${pv.status}; amount=${pv.amount ?? "?"}).`,
      metadata: { status: pv.status, amount: pv.amount ?? null, overdueHours: hours },
    }).returning({ id: caseBottleneckSnapshotsTable.id });
    if (ins[0]) {
      const sid = ins[0].id;
      createdSnapshots.push(sid);
      if (meetsEscalationThreshold(escalationConfig, severity, "pv_delay")) {
        await escalateSnapshot(firmId, sid, null, `Auto-escalated (threshold=${escalationConfig.escalateToPartnerAtSeverity}): PV overdue ${hours}h.`);
        escalatedSnapshots.push(sid);
      }
    }
  }

  if (activeCaseIds.length > 0) {
    const ids = activeCaseIds.map((c) => c.id);
    const waitingAndHoldRows = await db
      .select({
        id: casesTable.id,
        referenceNo: casesTable.referenceNo,
        caseType: casesTable.caseType,
        status: casesTable.status,
        lawyerStatus: casesTable.lawyerStatus,
        developerStatus: casesTable.developerStatus,
        lawyerStatusUpdatedAt: casesTable.lawyerStatusUpdatedAt,
        developerStatusUpdatedAt: casesTable.developerStatusUpdatedAt,
      })
      .from(casesTable)
      .where(and(inArray(casesTable.id, ids), eq(casesTable.deletedAt, sql`NULL`)));

    for (const c of waitingAndHoldRows) {
      const caseId = Number(c.id);
      const lawyer = String(c.lawyerStatus ?? "").trim().toLowerCase();
      const developer = String(c.developerStatus ?? "").trim().toLowerCase();
      const textBag = [String(c.status ?? "").toLowerCase(), lawyer, developer];

      const isWaiting = CASE_WAITING_KEYWORDS.some((kw) => textBag.some((t) => t.includes(kw))) &&
        !CASE_ON_HOLD_KEYWORDS.some((kw) => textBag.some((t) => t.includes(kw)));
      const isOnHold = CASE_ON_HOLD_KEYWORDS.some((kw) => textBag.some((t) => t.includes(kw)));

      let statusAnchor = c.lawyerStatusUpdatedAt ?? c.developerStatusUpdatedAt ?? undefined as Date | undefined;
      const anchorDate = statusAnchor ? new Date(String(statusAnchor)) : new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const daysStuck = Math.max(1, Math.floor(Math.max(0, now.getTime() - anchorDate.getTime()) / (24 * 60 * 60 * 1000)));

      const kindsToInsert: Array<"case_waiting" | "case_on_hold"> = [];
      if (isWaiting && daysStuck >= 2) kindsToInsert.push("case_waiting");
      if (isOnHold && daysStuck >= 3) kindsToInsert.push("case_on_hold");

      for (const kind of kindsToInsert) {
        const existsOpen = await db
          .select({ id: caseBottleneckSnapshotsTable.id })
          .from(caseBottleneckSnapshotsTable)
          .where(and(
            eq(caseBottleneckSnapshotsTable.firmId, firmId),
            eq(caseBottleneckSnapshotsTable.caseId, caseId),
            eq(caseBottleneckSnapshotsTable.monitorKind, kind),
            isNull(caseBottleneckSnapshotsTable.resolvedAt),
          ))
          .limit(1);
        if (existsOpen[0]) continue;
        const severity: "attention" | "urgent" | "critical" = daysStuck >= 7 ? "critical" : daysStuck >= 4 ? "urgent" : "attention";
        const responsibleLawyerUserId = lawyerIdByCase.get(caseId) ?? null;
        const responsibleManagerUserId = managerIdByCase.get(caseId) ?? null;
        if (opts.dryRun) continue;
        const title = c.referenceNo ? `Case ${c.referenceNo}` : `Case #${caseId}`;
        const detail = kind === "case_waiting"
          ? `Case Waiting status (lawyer=${c.lawyerStatus ?? "—"} / developer=${c.developerStatus ?? "—"}): ${daysStuck}d.`
          : `Case On Hold status (lawyer=${c.lawyerStatus ?? "—"} / developer=${c.developerStatus ?? "—"}): ${daysStuck}d.`;
        const ins = await db.insert(caseBottleneckSnapshotsTable).values({
          firmId,
          caseId,
          monitorKind: kind,
          severity,
          daysStuck,
          responsibleLawyerUserId,
          responsibleManagerUserId,
          title,
          detail,
          metadata: {
            lawyerStatus: c.lawyerStatus ?? null,
            developerStatus: c.developerStatus ?? null,
            lawyerStatusUpdatedAt: statusAnchor ? statusAnchor.toISOString() : null,
          },
        }).returning({ id: caseBottleneckSnapshotsTable.id });
        if (ins[0]) {
          const sid = ins[0].id;
          createdSnapshots.push(sid);
          if (meetsEscalationThreshold(escalationConfig, severity, kind)) {
            await escalateSnapshot(firmId, sid, null, `Auto-escalated (threshold=${escalationConfig.escalateToPartnerAtSeverity}): ${detail}`);
            escalatedSnapshots.push(sid);
          }
        }
      }
    }

    const approvalWaitingRows = await db
      .select({
        id: casesTable.id,
        referenceNo: casesTable.referenceNo,
        caseType: casesTable.caseType,
        status: casesTable.status,
        approvalStatus: casesTable.approvalStatus,
        submittedAt: casesTable.submittedAt,
      })
      .from(casesTable)
      .where(and(
        inArray(casesTable.id, ids),
        eq(casesTable.deletedAt, sql`NULL`),
        or(
          eq(casesTable.approvalStatus, "pending_approval"),
          eq(casesTable.approvalStatus, "needs_correction"),
        ),
        or(
          isNull(casesTable.submittedAt),
          lt(casesTable.submittedAt, approvalStaleCutoff),
        ),
      ));
    for (const c of approvalWaitingRows) {
      const caseId = Number(c.id);
      const existsOpen = await db
        .select({ id: caseBottleneckSnapshotsTable.id })
        .from(caseBottleneckSnapshotsTable)
        .where(and(
          eq(caseBottleneckSnapshotsTable.firmId, firmId),
          eq(caseBottleneckSnapshotsTable.caseId, caseId),
          eq(caseBottleneckSnapshotsTable.monitorKind, "approval_waiting"),
          isNull(caseBottleneckSnapshotsTable.resolvedAt),
        ))
        .limit(1);
      if (existsOpen[0]) continue;
      const anchor = c.submittedAt ? new Date(String(c.submittedAt)) : new Date(now.getTime() - CASE_APPROVAL_STALE_HOURS * 60 * 60 * 1000);
      const hours = Math.max(CASE_APPROVAL_STALE_HOURS, Math.floor(Math.max(0, now.getTime() - anchor.getTime()) / (60 * 60 * 1000)));
      const daysStuck = Math.max(1, Math.floor(hours / 24));
      const severity: "attention" | "urgent" | "critical" = hours >= 72 ? "critical" : hours >= 48 ? "urgent" : "attention";
      const responsibleLawyerUserId = lawyerIdByCase.get(caseId) ?? null;
      const responsibleManagerUserId = managerIdByCase.get(caseId) ?? null;
      if (opts.dryRun) continue;
      const title = c.referenceNo ? `Case ${c.referenceNo}` : `Case #${caseId}`;
      const detail = `Approval waiting status=${c.approvalStatus ?? "pending_approval"} for ${hours}h.`;
      const ins = await db.insert(caseBottleneckSnapshotsTable).values({
        firmId,
        caseId,
        monitorKind: "approval_waiting",
        severity,
        daysStuck,
        responsibleLawyerUserId,
        responsibleManagerUserId,
        title,
        detail,
        metadata: { approvalStatus: c.approvalStatus ?? null, waitingHours: hours, submittedAt: anchor.toISOString() },
      }).returning({ id: caseBottleneckSnapshotsTable.id });
      if (ins[0]) {
        const sid = ins[0].id;
        createdSnapshots.push(sid);
        if (meetsEscalationThreshold(escalationConfig, severity, "approval_waiting")) {
          await escalateSnapshot(firmId, sid, null, `Auto-escalated (threshold=${escalationConfig.escalateToPartnerAtSeverity}): ${detail}`);
          escalatedSnapshots.push(sid);
        }
      }
    }
    }

  const staleNoMovement = await db
    .select({ id: caseBottleneckSnapshotsTable.id, caseId: caseBottleneckSnapshotsTable.caseId })
    .from(caseBottleneckSnapshotsTable)
    .leftJoin(caseWorkflowStepsTable, and(
      eq(caseWorkflowStepsTable.caseId, caseBottleneckSnapshotsTable.caseId),
      gt(caseWorkflowStepsTable.updatedAt, sql`COALESCE(${caseBottleneckSnapshotsTable.createdAt}, '1970-01-01')::timestamptz`),
    ))
    .where(and(
      eq(caseBottleneckSnapshotsTable.firmId, firmId),
      eq(caseBottleneckSnapshotsTable.monitorKind, "case_no_movement"),
      isNull(caseBottleneckSnapshotsTable.resolvedAt),
      ne(caseWorkflowStepsTable.id, sql`NULL`),
    ));
  for (const s of staleNoMovement) {
    if (opts.dryRun) continue;
    await db.update(caseBottleneckSnapshotsTable)
      .set({ resolvedAt: now, resolvedNote: "Auto-resolved: new workflow progress detected", updatedAt: now })
      .where(eq(caseBottleneckSnapshotsTable.id, s.id));
    await db.insert(caseMonitorLogsTable).values({
      firmId, snapshotId: s.id, caseId: s.caseId ?? null, action: "resolve", notes: "Auto-resolved: new workflow progress detected", metadata: { auto: true },
    });
    resolvedSnapshots.push(s.id);
  }

  const stalePvDelay = await db
    .select({ id: caseBottleneckSnapshotsTable.id, paymentVoucherId: caseBottleneckSnapshotsTable.paymentVoucherId })
    .from(caseBottleneckSnapshotsTable)
    .leftJoin(paymentVouchersTable, eq(paymentVouchersTable.id, caseBottleneckSnapshotsTable.paymentVoucherId))
    .where(and(
      eq(caseBottleneckSnapshotsTable.firmId, firmId),
      eq(caseBottleneckSnapshotsTable.monitorKind, "pv_delay"),
      isNull(caseBottleneckSnapshotsTable.resolvedAt),
      or(
        eq(paymentVouchersTable.status, "completed"),
        gte(paymentVouchersTable.paymentDueAt, pvDueCutoff),
      ),
    ));
  for (const s of stalePvDelay) {
    if (opts.dryRun) continue;
    await db.update(caseBottleneckSnapshotsTable)
      .set({ resolvedAt: now, resolvedNote: "Auto-resolved: PV no longer overdue or completed", updatedAt: now })
      .where(eq(caseBottleneckSnapshotsTable.id, s.id));
    await db.insert(caseMonitorLogsTable).values({
      firmId, snapshotId: s.id, caseId: null, action: "resolve", notes: "Auto-resolved: PV no longer overdue or completed", metadata: { auto: true },
    });
    resolvedSnapshots.push(s.id);
  }

  const staleWaitingOnHold = await db
    .select({
      id: caseBottleneckSnapshotsTable.id,
      caseId: caseBottleneckSnapshotsTable.caseId,
      monitorKind: caseBottleneckSnapshotsTable.monitorKind,
      createdAt: caseBottleneckSnapshotsTable.createdAt,
    })
    .from(caseBottleneckSnapshotsTable)
    .leftJoin(casesTable, eq(casesTable.id, caseBottleneckSnapshotsTable.caseId))
    .where(and(
      eq(caseBottleneckSnapshotsTable.firmId, firmId),
      or(
        eq(caseBottleneckSnapshotsTable.monitorKind, "case_waiting"),
        eq(caseBottleneckSnapshotsTable.monitorKind, "case_on_hold"),
      ),
      isNull(caseBottleneckSnapshotsTable.resolvedAt),
      or(
        isNull(casesTable.id),
        eq(casesTable.deletedAt, sql`NULL`),
        gt(casesTable.lawyerStatusUpdatedAt, sql`COALESCE(${caseBottleneckSnapshotsTable.createdAt}, '1970-01-01')::timestamptz`),
        gt(casesTable.developerStatusUpdatedAt, sql`COALESCE(${caseBottleneckSnapshotsTable.createdAt}, '1970-01-01')::timestamptz`),
      ),
    ));
  for (const s of staleWaitingOnHold) {
    if (opts.dryRun) continue;
    await db.update(caseBottleneckSnapshotsTable)
      .set({ resolvedAt: now, resolvedNote: `Auto-resolved: ${s.monitorKind} status progressed`, updatedAt: now })
      .where(eq(caseBottleneckSnapshotsTable.id, s.id));
    await db.insert(caseMonitorLogsTable).values({
      firmId, snapshotId: s.id, caseId: s.caseId ?? null, action: "resolve", notes: `Auto-resolved: ${s.monitorKind} status progressed`, metadata: { auto: true },
    });
    resolvedSnapshots.push(s.id);
  }

  const staleApprovalWaiting = await db
    .select({
      id: caseBottleneckSnapshotsTable.id,
      caseId: caseBottleneckSnapshotsTable.caseId,
    })
    .from(caseBottleneckSnapshotsTable)
    .leftJoin(casesTable, eq(casesTable.id, caseBottleneckSnapshotsTable.caseId))
    .where(and(
      eq(caseBottleneckSnapshotsTable.firmId, firmId),
      eq(caseBottleneckSnapshotsTable.monitorKind, "approval_waiting"),
      isNull(caseBottleneckSnapshotsTable.resolvedAt),
      or(
        eq(casesTable.approvalStatus, "approved"),
        eq(casesTable.approvalStatus, "rejected"),
        isNull(casesTable.id),
      ),
    ));
  for (const s of staleApprovalWaiting) {
    if (opts.dryRun) continue;
    await db.update(caseBottleneckSnapshotsTable)
      .set({ resolvedAt: now, resolvedNote: "Auto-resolved: case approval status resolved", updatedAt: now })
      .where(eq(caseBottleneckSnapshotsTable.id, s.id));
    await db.insert(caseMonitorLogsTable).values({
      firmId, snapshotId: s.id, caseId: s.caseId ?? null, action: "resolve", notes: "Auto-resolved: case approval status resolved", metadata: { auto: true },
    });
    resolvedSnapshots.push(s.id);
  }

  return { createdSnapshots, resolvedSnapshots, escalatedSnapshots, scannedAt: now, escalationConfig };
}

async function escalateSnapshot(
  firmId: number,
  snapshotId: number,
  targetPartnerUserId: number | null,
  reason: string,
): Promise<void> {
  try {
    await db.update(caseBottleneckSnapshotsTable)
      .set({ escalatedToPartner: true, escalatedAt: new Date(), updatedAt: new Date() })
      .where(eq(caseBottleneckSnapshotsTable.id, snapshotId));
    await db.insert(caseMonitorLogsTable).values({
      firmId,
      snapshotId,
      actorUserId: null,
      action: "escalate",
      notes: reason ?? "Auto-escalated by job",
      metadata: { auto: true, targetPartnerUserId: targetPartnerUserId ?? null },
    });
    try {
      await writeAuditLog({
        firmId: firmId > 0 ? firmId : 0,
        actorId: 0,
        entityType: "case_bottleneck_snapshot",
        entityId: snapshotId,
        action: "escalate",
        detail: reason ?? "Auto-escalated by job",
      });
    } catch { /* audit non-fatal */ }
  } catch (err) {
    logger.error({ err, firmId, snapshotId }, "case-bottleneck-monitor: escalateSnapshot failed");
  }
}

export async function tickAllFirms() {
  const gotLock = await tryAcquireLock();
  if (!gotLock) return { skipped: true };
  let created = 0;
  let resolved = 0;
  let escalated = 0;
  try {
    const firms = await db.select({ id: firmsTable.id }).from(firmsTable).where(eq(firmsTable.status, "active"));
    for (const f of firms) {
      try {
        const result = await scanBottlenecksForFirm(f.id);
        created += result.createdSnapshots.length;
        resolved += result.resolvedSnapshots.length;
        escalated += result.escalatedSnapshots.length;
      } catch (err) {
        logger.error({ err, firmId: f.id }, "case-bottleneck-monitor: per-firm tick failed");
      }
    }
    if (created || resolved || escalated) {
      try {
        await writeAuditLog({
          firmId: 0,
          actorId: 0,
          entityType: "case_monitor", entityId: 0,
          action: "tick",
          detail: `Created ${created}, resolved ${resolved}, escalated ${escalated} snapshots.`,
        });
      } catch { /* ignore audit failure */ }
      logger.info({ created, resolved, escalated }, "case-bottleneck-monitor tick complete");
    }
  } finally {
    await releaseLock();
  }
  return { created, resolved, skipped: false };
}

export function startCaseBottleneckMonitor() {
  if (timer || running) return;
  running = true;
  logger.info("Starting case bottleneck monitor job");
  const loop = async () => {
    try { await tickAllFirms(); } catch (err) { logger.error({ err }, "case-bottleneck-monitor loop error"); }
  };
  loop().catch(() => {});
  timer = setInterval(loop, SCAN_INTERVAL_MS);
}

export function stopCaseBottleneckMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
