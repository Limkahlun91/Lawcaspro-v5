import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountingSettingsTable,
  caseAssignmentsTable,
  db,
  paymentVoucherActionsTable,
  paymentVouchersTable,
  permissionsTable,
  userNotificationsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { writeAuditLog } from "../lib/auth.js";
import {
  AccountingSettingsLoaderError,
  normalizeAccountingSettings,
  safeLoadAccountingSettingsOrDefault,
  type AccountingSettingsRecord,
} from "../modules/accounting/accounting-settings.js";

async function tryAcquireLock(): Promise<boolean> {
  const r = await db.execute(sql`SELECT pg_try_advisory_lock(hashtext('payment_voucher_sla_monitor')) as ok`);
  const rows = Array.isArray(r) ? r : ("rows" in (r as any) ? (r as any).rows : []);
  const ok = rows?.[0]?.ok;
  return ok === true || ok === "t" || ok === 1;
}

async function releaseLock(): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('payment_voucher_sla_monitor'))`);
  } catch {
  }
}

function uniqIds(ids: Array<number | null | undefined>): number[] {
  return Array.from(new Set(ids.filter((id): id is number => Number.isFinite(id) && Number(id) > 0)));
}

async function createNotificationIfMissing(args: {
  firmId: number;
  userId: number;
  sourceType: string;
  sourceId: number;
  caseId?: number | null;
  notificationType: string;
  title: string;
  message: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const [existing] = await db
    .select({ id: userNotificationsTable.id })
    .from(userNotificationsTable)
    .where(and(
      eq(userNotificationsTable.firmId, args.firmId),
      eq(userNotificationsTable.userId, args.userId),
      eq(userNotificationsTable.sourceType, args.sourceType),
      eq(userNotificationsTable.sourceId, args.sourceId),
      eq(userNotificationsTable.notificationType, args.notificationType),
    ))
    .limit(1);
  if (existing) return;

  await db.insert(userNotificationsTable).values({
    firmId: args.firmId,
    userId: args.userId,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    caseId: args.caseId ?? null,
    notificationType: args.notificationType,
    title: args.title,
    message: args.message,
    meta: args.meta ?? null,
    isRead: false,
  });
}

export function startPaymentVoucherSlaMonitor(): void {
  const enabled = process.env.ENABLE_PAYMENT_VOUCHER_SLA_MONITOR === "1";
  if (!enabled) return;

  const intervalMs = (() => {
    const raw = process.env.PAYMENT_VOUCHER_SLA_MONITOR_INTERVAL_MS;
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 30_000) return Math.floor(n);
    return 5 * 60 * 1000;
  })();

  const settingsCache = new Map<number, AccountingSettingsRecord>();
  const accountManagerCache = new Map<number, number[]>();
  const escalationCache = new Map<number, number[]>();
  const caseOwnerCache = new Map<number, number[]>();

  const getSettings = async (firmId: number): Promise<AccountingSettingsRecord> => {
    const cached = settingsCache.get(firmId);
    if (cached) return cached;
    try {
      const normalized = await safeLoadAccountingSettingsOrDefault({
        firmId,
        db: db as any,
        accountingSettingsTable,
        sql,
        eq,
      });
      settingsCache.set(firmId, normalized);
      return normalized;
    } catch (err) {
      if (err instanceof AccountingSettingsLoaderError) {
        const def = normalizeAccountingSettings(firmId, undefined);
        settingsCache.set(firmId, def);
        return def;
      }
      const def = normalizeAccountingSettings(firmId, undefined);
      settingsCache.set(firmId, def);
      return def;
    }
  };

  const getActiveUsersByRoleIds = async (firmId: number, roleIds: number[]): Promise<number[]> => {
    if (roleIds.length === 0) return [];
    const rows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(
        eq(usersTable.firmId, firmId),
        eq(usersTable.status, "active"),
        inArray(usersTable.roleId, roleIds),
      ));
    return uniqIds(rows.map((row) => row.id));
  };

  const getAccountManagerRecipients = async (firmId: number): Promise<number[]> => {
    const cached = accountManagerCache.get(firmId);
    if (cached) return cached;
    const settings = await getSettings(firmId);
    const ids = await getActiveUsersByRoleIds(firmId, settings.accountManagerRoleIds);
    accountManagerCache.set(firmId, ids);
    return ids;
  };

  const getEscalationRecipients = async (firmId: number): Promise<number[]> => {
    const cached = escalationCache.get(firmId);
    if (cached) return cached;
    const rows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .innerJoin(permissionsTable, eq(permissionsTable.roleId, usersTable.roleId))
      .where(and(
        eq(usersTable.firmId, firmId),
        eq(usersTable.status, "active"),
        eq(permissionsTable.module, "accounting"),
        eq(permissionsTable.action, "manage_settings"),
        eq(permissionsTable.allowed, true),
      ));
    const ids = uniqIds(rows.map((row) => row.id));
    escalationCache.set(firmId, ids);
    return ids;
  };

  const getCaseOwners = async (firmId: number, caseId: number | null): Promise<number[]> => {
    if (!caseId || caseId <= 0) return [];
    const cacheKey = caseId;
    const cached = caseOwnerCache.get(cacheKey);
    if (cached) return cached;
    const rows = await db
      .select({ userId: caseAssignmentsTable.userId })
      .from(caseAssignmentsTable)
      .innerJoin(usersTable, and(
        eq(usersTable.id, caseAssignmentsTable.userId),
        eq(usersTable.firmId, firmId),
        eq(usersTable.status, "active"),
      ))
      .where(and(
        eq(caseAssignmentsTable.caseId, caseId),
        eq(caseAssignmentsTable.roleInCase, "lawyer"),
        sql`${caseAssignmentsTable.unassignedAt} IS NULL`,
      ));
    const ids = uniqIds(rows.map((row) => row.userId));
    caseOwnerCache.set(cacheKey, ids);
    return ids;
  };

  const notifyVoucherDueSoon = async (row: {
    id: number;
    firmId: number;
    caseId: number | null;
    voucherNo: string;
    assignedAccountUserId: number | null;
    paymentDueAt: Date | string | null;
  }): Promise<void> => {
    const settings = await getSettings(row.firmId);
    const dueAt = row.paymentDueAt ? new Date(row.paymentDueAt) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) return;
    const recipients = uniqIds([
      settings.paymentVoucherSla.notifyAssignedAccountUser ? row.assignedAccountUserId : null,
      ...(settings.paymentVoucherSla.notifyAccountManager ? await getAccountManagerRecipients(row.firmId) : []),
    ]);
    for (const userId of recipients) {
      await createNotificationIfMissing({
        firmId: row.firmId,
        userId,
        sourceType: "payment_voucher",
        sourceId: row.id,
        caseId: row.caseId,
        notificationType: "payment_voucher.sla_due_soon",
        title: `Voucher due soon: ${row.voucherNo}`,
        message: `Payment voucher ${row.voucherNo} is due by ${dueAt.toLocaleString("en-MY")}.`,
        meta: { paymentVoucherId: row.id, voucherNo: row.voucherNo, paymentDueAt: dueAt.toISOString() },
      });
    }
    await db
      .update(paymentVouchersTable)
      .set({ dueSoonNotifiedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(paymentVouchersTable.id, row.id),
        eq(paymentVouchersTable.firmId, row.firmId),
        sql`${paymentVouchersTable.dueSoonNotifiedAt} IS NULL`,
      ));
    await writeAuditLog({
      firmId: row.firmId,
      actorId: null,
      actorType: "system",
      action: "payment_voucher.sla_due_soon",
      entityType: "payment_voucher",
      entityId: row.id,
      detail: `voucherNo=${row.voucherNo}`,
    });
  };

  const notifyVoucherOverdue = async (row: {
    id: number;
    firmId: number;
    caseId: number | null;
    voucherNo: string;
    assignedAccountUserId: number | null;
    paymentDueAt: Date | string | null;
  }): Promise<void> => {
    const settings = await getSettings(row.firmId);
    const dueAt = row.paymentDueAt ? new Date(row.paymentDueAt) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) return;
    const recipients = uniqIds([
      settings.paymentVoucherSla.notifyAssignedAccountUser ? row.assignedAccountUserId : null,
      ...(settings.paymentVoucherSla.notifyAccountManager ? await getAccountManagerRecipients(row.firmId) : []),
      ...(settings.paymentVoucherSla.notifyPartnerOnOverdue ? await getEscalationRecipients(row.firmId) : []),
    ]);
    for (const userId of recipients) {
      await createNotificationIfMissing({
        firmId: row.firmId,
        userId,
        sourceType: "payment_voucher",
        sourceId: row.id,
        caseId: row.caseId,
        notificationType: "payment_voucher.sla_breached",
        title: `Voucher overdue: ${row.voucherNo}`,
        message: `Payment voucher ${row.voucherNo} missed its due time of ${dueAt.toLocaleString("en-MY")}.`,
        meta: { paymentVoucherId: row.id, voucherNo: row.voucherNo, paymentDueAt: dueAt.toISOString() },
      });
    }
    await db
      .update(paymentVouchersTable)
      .set({
        overdueNotifiedAt: new Date(),
        breachedAt: sql`COALESCE(${paymentVouchersTable.breachedAt}, NOW())`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(paymentVouchersTable.id, row.id),
        eq(paymentVouchersTable.firmId, row.firmId),
        sql`${paymentVouchersTable.overdueNotifiedAt} IS NULL`,
      ));
    await writeAuditLog({
      firmId: row.firmId,
      actorId: null,
      actorType: "system",
      action: "payment_voucher.sla_breached",
      entityType: "payment_voucher",
      entityId: row.id,
      detail: `voucherNo=${row.voucherNo}`,
    });
  };

  const notifyAction = async (row: {
    id: number;
    firmId: number;
    paymentVoucherId: number;
    caseId: number | null;
    assignedUserId: number;
    status: string;
    actionType: string;
    customAction: string | null;
    acknowledgeDueAt: Date | string | null;
    completionDueAt: Date | string | null;
  }, overdue: boolean): Promise<void> => {
    const settings = await getSettings(row.firmId);
    const isAcknowledgeStage = row.status === "assigned";
    const dueAtRaw = isAcknowledgeStage ? row.acknowledgeDueAt : row.completionDueAt;
    const dueAt = dueAtRaw ? new Date(dueAtRaw) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) return;
    const kind = overdue
      ? (isAcknowledgeStage ? "payment_voucher.action_acknowledge_overdue" : "payment_voucher.action_complete_overdue")
      : (isAcknowledgeStage ? "payment_voucher.action_acknowledge_due_soon" : "payment_voucher.action_complete_due_soon");
    const title = overdue
      ? `Clerk action overdue: PV #${row.paymentVoucherId}`
      : `Clerk action due soon: PV #${row.paymentVoucherId}`;
    const actionLabel = row.customAction || row.actionType;
    const recipients = uniqIds([
      row.assignedUserId,
      ...(settings.clerkActionSla.notifyCaseOwner ? await getCaseOwners(row.firmId, row.caseId) : []),
      ...(overdue && settings.clerkActionSla.notifyPartnerOnOverdue ? await getEscalationRecipients(row.firmId) : []),
    ]);
    for (const userId of recipients) {
      await createNotificationIfMissing({
        firmId: row.firmId,
        userId,
        sourceType: "payment_voucher_action",
        sourceId: row.id,
        caseId: row.caseId,
        notificationType: kind,
        title,
        message: `${actionLabel} is ${overdue ? "overdue" : "due by"} ${dueAt.toLocaleString("en-MY")}.`,
        meta: {
          paymentVoucherActionId: row.id,
          paymentVoucherId: row.paymentVoucherId,
          dueAt: dueAt.toISOString(),
          stage: isAcknowledgeStage ? "acknowledge" : "complete",
        },
      });
    }

    if (overdue) {
      await db
        .update(paymentVoucherActionsTable)
        .set({
          breachedAt: sql`COALESCE(${paymentVoucherActionsTable.breachedAt}, NOW())`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(paymentVoucherActionsTable.id, row.id),
          eq(paymentVoucherActionsTable.firmId, row.firmId),
        ));
      await writeAuditLog({
        firmId: row.firmId,
        actorId: null,
        actorType: "system",
        action: "payment_voucher.action_overdue",
        entityType: "payment_voucher_action",
        entityId: row.id,
        detail: `paymentVoucherId=${row.paymentVoucherId}`,
      });
    }
  };

  const tick = async (): Promise<void> => {
    const lockOk = await tryAcquireLock();
    if (!lockOk) return;
    settingsCache.clear();
    accountManagerCache.clear();
    escalationCache.clear();
    caseOwnerCache.clear();
    try {
      const now = new Date();
      const vouchers = await db
        .select({
          id: paymentVouchersTable.id,
          firmId: paymentVouchersTable.firmId,
          caseId: paymentVouchersTable.caseId,
          voucherNo: paymentVouchersTable.voucherNo,
          assignedAccountUserId: paymentVouchersTable.assignedAccountUserId,
          paymentDueAt: paymentVouchersTable.paymentDueAt,
          dueSoonNotifiedAt: paymentVouchersTable.dueSoonNotifiedAt,
          overdueNotifiedAt: paymentVouchersTable.overdueNotifiedAt,
        })
        .from(paymentVouchersTable)
        .where(and(
          eq(paymentVouchersTable.status, "pending_account"),
          sql`${paymentVouchersTable.receivedAt} IS NOT NULL`,
          sql`${paymentVouchersTable.paymentDueAt} IS NOT NULL`,
        ))
        .orderBy(paymentVouchersTable.paymentDueAt);

      for (const row of vouchers) {
        try {
          const settings = await getSettings(row.firmId);
          const dueAt = row.paymentDueAt ? new Date(row.paymentDueAt) : null;
          if (!dueAt || Number.isNaN(dueAt.getTime())) continue;
          if (!row.overdueNotifiedAt && dueAt.getTime() <= now.getTime()) {
            await notifyVoucherOverdue(row);
            continue;
          }
          const dueSoonAt = dueAt.getTime() - settings.paymentVoucherSla.dueSoonMinutes * 60_000;
          if (!row.dueSoonNotifiedAt && dueSoonAt <= now.getTime() && dueAt.getTime() > now.getTime()) {
            await notifyVoucherDueSoon(row);
          }
        } catch (err) {
          logger.error({ err, paymentVoucherId: row.id, firmId: row.firmId }, "payment_voucher_sla.monitor.voucher_failed");
        }
      }

      const actions = await db
        .select({
          id: paymentVoucherActionsTable.id,
          firmId: paymentVoucherActionsTable.firmId,
          paymentVoucherId: paymentVoucherActionsTable.paymentVoucherId,
          caseId: paymentVoucherActionsTable.caseId,
          assignedUserId: paymentVoucherActionsTable.assignedUserId,
          status: paymentVoucherActionsTable.status,
          actionType: paymentVoucherActionsTable.actionType,
          customAction: paymentVoucherActionsTable.customAction,
          acknowledgeDueAt: paymentVoucherActionsTable.acknowledgeDueAt,
          completionDueAt: paymentVoucherActionsTable.completionDueAt,
        })
        .from(paymentVoucherActionsTable)
        .where(and(
          eq(paymentVoucherActionsTable.status, "assigned"),
        ));

      const acknowledgedActions = await db
        .select({
          id: paymentVoucherActionsTable.id,
          firmId: paymentVoucherActionsTable.firmId,
          paymentVoucherId: paymentVoucherActionsTable.paymentVoucherId,
          caseId: paymentVoucherActionsTable.caseId,
          assignedUserId: paymentVoucherActionsTable.assignedUserId,
          status: paymentVoucherActionsTable.status,
          actionType: paymentVoucherActionsTable.actionType,
          customAction: paymentVoucherActionsTable.customAction,
          acknowledgeDueAt: paymentVoucherActionsTable.acknowledgeDueAt,
          completionDueAt: paymentVoucherActionsTable.completionDueAt,
        })
        .from(paymentVoucherActionsTable)
        .where(and(
          eq(paymentVoucherActionsTable.status, "acknowledged"),
        ));

      for (const row of [...actions, ...acknowledgedActions]) {
        try {
          const settings = await getSettings(row.firmId);
          const dueAtRaw = row.status === "assigned" ? row.acknowledgeDueAt : row.completionDueAt;
          const dueAt = dueAtRaw ? new Date(dueAtRaw) : null;
          if (!dueAt || Number.isNaN(dueAt.getTime())) continue;
          if (dueAt.getTime() <= now.getTime()) {
            await notifyAction(row, true);
            continue;
          }
          const dueSoonAt = dueAt.getTime() - settings.clerkActionSla.dueSoonMinutes * 60_000;
          if (dueSoonAt <= now.getTime()) {
            await notifyAction(row, false);
          }
        } catch (err) {
          logger.error({ err, paymentVoucherActionId: row.id, firmId: row.firmId }, "payment_voucher_sla.monitor.action_failed");
        }
      }
    } finally {
      await releaseLock();
    }
  };

  setInterval(() => {
    tick().catch((err) => {
      logger.error({ err }, "payment_voucher_sla.monitor.tick_failed");
    });
  }, intervalMs);

  tick().catch((err) => logger.error({ err }, "payment_voucher_sla.monitor.first_tick_failed"));
  logger.info({ intervalMs }, "payment_voucher_sla.monitor.started");
}
