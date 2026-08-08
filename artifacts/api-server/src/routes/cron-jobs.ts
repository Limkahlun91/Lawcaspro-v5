import express, { type Response, type Router as ExpressRouter } from "express";
import { db } from "@workspace/db";
import { paymentVouchersTable, paymentVoucherActionsTable, userNotificationsTable, accountingSettingsTable, caseAssignmentsTable, permissionsTable, rolesTable, usersTable } from "@workspace/db";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { writeAuditLog } from "../lib/auth.js";
import {
  AccountingSettingsLoaderError,
  normalizeAccountingSettings,
  safeLoadAccountingSettingsOrDefault,
  type AccountingSettingsRecord,
} from "../modules/accounting/accounting-settings.js";

type RouterInternalLike = {
  post: (path: string, ...handlers: unknown[]) => unknown;
  get: (path: string, ...handlers: unknown[]) => unknown;
};

const ACTIVE_STATUSES = ["unread", "read", "acknowledged", "escalated"] as const;
const ESCALATION_DEFAULT_GRACE_HOURS = 1;
const ESCALATION_DEFAULT_REPEAT_HOURS = 2;
const RULE_CODE_PV_STAGE1 = "PV_OVERDUE_STAGE1_RESPONSIBLE";
const RULE_CODE_PV_STAGE2 = "PV_OVERDUE_PARTNER_ESCALATION";

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

async function tryAcquireLock(): Promise<boolean> {
  const r = await db.execute(sql`SELECT pg_try_advisory_lock(hashtext('payment_voucher_sla_monitor_http')) as ok`);
  const rows = Array.isArray(r) ? r : ("rows" in (r as any) ? (r as any).rows : []);
  const ok = rows?.[0]?.ok;
  return ok === true || ok === "t" || ok === 1;
}

async function releaseLock(): Promise<void> {
  try { await db.execute(sql`SELECT pg_advisory_unlock(hashtext('payment_voucher_sla_monitor_http'))`); } catch { /* ignore */ }
}

function uniqIds(ids: Array<number | null | undefined>): number[] {
  return Array.from(new Set(ids.filter((id): id is number => Number.isFinite(id) && Number(id) > 0)));
}

const one = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (typeof v === "string") return v || undefined;
  if (Array.isArray(v)) {
    const first = (v as unknown[])[0];
    return typeof first === "string" ? first || undefined : undefined;
  }
  if (typeof v === "number") return String(v);
  return undefined;
};

function getCronSecret(): string | undefined {
  const canonical = process.env.CRON_SECRET;
  if (canonical) return canonical;
  const legacy = process.env.CRON_SHARED_SECRET || process.env.INTERNAL_CRON_TOKEN;
  if (legacy) {
    logger.warn({ event: "cron.auth.using_legacy_env" }, "CRON_SECRET is recommended; legacy CRON_SHARED_SECRET / INTERNAL_CRON_TOKEN detected");
    return legacy;
  }
  return undefined;
}

function getCronVercelSecret(): string | undefined {
  return process.env.CRON_VERCEL_SECRET;
}

function requireCronAuth(req: express.Request, res: Response): boolean {
  const providedBearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length)
    : undefined;
  const providedHeader = one(req.headers["x-cron-token"]);
  const vercelCronSig = one(req.headers["x-vercel-cron-secret"]);
  const expected = getCronSecret();
  const vercelExpected = getCronVercelSecret();
  const canonicalMatch = !!(expected && (providedBearer === expected || providedHeader === expected));
  const vercelMatch = !!(vercelCronSig && vercelExpected && vercelCronSig === vercelExpected);
  const match = canonicalMatch || vercelMatch;
  if (!match) {
    res.status(401).json({ error: "cron_auth_required" });
    return false;
  }
  return true;
}

type TickCtx = {
  settingsCache: Map<number, AccountingSettingsRecord>;
  accountManagerCache: Map<number, number[]>;
  escalationCache: Map<number, number[]>;
  caseOwnerCache: Map<number, number[]>;
  managerCache: Map<number, number[]>;
  partnerRoleCache: Map<number, number[]>;
};

function buildCtx(): TickCtx {
  return {
    settingsCache: new Map(),
    accountManagerCache: new Map(),
    escalationCache: new Map(),
    caseOwnerCache: new Map(),
    managerCache: new Map(),
    partnerRoleCache: new Map(),
  };
}

const getSettings = async (firmId: number, ctx: TickCtx): Promise<AccountingSettingsRecord> => {
  const cached = ctx.settingsCache.get(firmId);
  if (cached) return cached;
  try {
    const normalized = await safeLoadAccountingSettingsOrDefault({
      firmId,
      db: db as any,
      accountingSettingsTable,
      sql,
      eq,
    });
    ctx.settingsCache.set(firmId, normalized);
    return normalized;
  } catch (err) {
    if (err instanceof AccountingSettingsLoaderError) {
      const def = normalizeAccountingSettings(firmId, undefined);
      ctx.settingsCache.set(firmId, def);
      return def;
    }
    const def = normalizeAccountingSettings(firmId, undefined);
    ctx.settingsCache.set(firmId, def);
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

const getAccountManagerRecipients = async (firmId: number, ctx: TickCtx): Promise<number[]> => {
  const cached = ctx.accountManagerCache.get(firmId);
  if (cached) return cached;
  const settings = await getSettings(firmId, ctx);
  const ids = await getActiveUsersByRoleIds(firmId, settings.accountManagerRoleIds);
  ctx.accountManagerCache.set(firmId, ids);
  return ids;
};

const getAllPartnerRoleIds = async (firmId: number, ctx: TickCtx): Promise<number[]> => {
  if (ctx.partnerRoleCache.has(firmId)) return ctx.partnerRoleCache.get(firmId)!;
  const rows = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.firmId, firmId), sql`LOWER(${rolesTable.name}) = 'partner'`));
  const ids = uniqIds(rows.map(r => r.id));
  ctx.partnerRoleCache.set(firmId, ids);
  return ids;
};

const getEscalationRecipients = async (firmId: number, ctx: TickCtx): Promise<number[]> => {
  const cached = ctx.escalationCache.get(firmId);
  if (cached) return cached;
  const partnerRoleIds = await getAllPartnerRoleIds(firmId, ctx);
  let ids: number[] = [];
  if (partnerRoleIds.length > 0) ids = await getActiveUsersByRoleIds(firmId, partnerRoleIds);
  if (ids.length === 0) {
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
    ids = uniqIds(rows.map((row) => row.id));
  }
  ctx.escalationCache.set(firmId, ids);
  return ids;
};

const getManagerRoleIds = async (firmId: number, ctx: TickCtx): Promise<number[]> => {
  if (ctx.managerCache.has(firmId)) return ctx.managerCache.get(firmId)!;
  const rows = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.firmId, firmId), sql`LOWER(${rolesTable.name}) = 'manager'`));
  const ids = uniqIds(rows.map(r => r.id));
  ctx.managerCache.set(firmId, ids);
  return ids;
};

async function createOrBumpNotification(args: {
  firmId: number;
  userId: number;
  sourceType: string;
  sourceId: number;
  caseId?: number | null;
  notificationType: string;
  title: string;
  message: string;
  meta?: Record<string, unknown>;
  status?: "unread" | "escalated";
  dismissible?: boolean;
  severity?: "normal" | "high" | "urgent";
  targetScope?: "user" | "lawyer" | "manager" | "selected_partner" | "all_partners";
  ruleCode?: string;
  resolutionMode?: "MANUAL_ALLOWED" | "AUTO_ONLY";
  correlationId?: string;
  entityType?: string;
  entityId?: number;
  repeatHours?: number;
}): Promise<{ created: boolean; updated: boolean; id?: number }> {
  const now = new Date();
  const repeatHours = args.repeatHours ?? ESCALATION_DEFAULT_REPEAT_HOURS;
  const isDedupe = !!(args.ruleCode && args.entityType && args.entityId);
  if (isDedupe) {
    const [existing] = await db
      .select()
      .from(userNotificationsTable)
      .where(and(
        eq(userNotificationsTable.firmId, args.firmId),
        eq(userNotificationsTable.userId, args.userId),
        eq(userNotificationsTable.ruleCode, args.ruleCode!),
        eq(userNotificationsTable.entityType, args.entityType!),
        eq(userNotificationsTable.entityId, args.entityId!),
        inArray(userNotificationsTable.status, ACTIVE_STATUSES as unknown as string[]),
      ))
      .limit(1);
    if (existing) {
      const newCount = (Number(existing.deliveryCount) || 0) + 1;
      await db.update(userNotificationsTable).set({
        title: args.title,
        message: args.message,
        meta: args.meta ?? existing.meta ?? null,
        deliveryCount: newCount,
        lastNotifiedAt: now,
        nextNotifyAt: new Date(now.getTime() + repeatHours * 3600_000),
      } as any).where(eq(userNotificationsTable.id, Number(existing.id)));
      return { created: false, updated: true, id: Number(existing.id) };
    }
  } else {
    const [existing] = await db.select({ id: userNotificationsTable.id }).from(userNotificationsTable).where(and(
      eq(userNotificationsTable.firmId, args.firmId),
      eq(userNotificationsTable.userId, args.userId),
      eq(userNotificationsTable.sourceType, args.sourceType),
      eq(userNotificationsTable.sourceId, args.sourceId),
      eq(userNotificationsTable.notificationType, args.notificationType),
    )).limit(1);
    if (existing) return { created: false, updated: false, id: Number(existing.id) };
  }
  const [inserted] = await db.insert(userNotificationsTable).values({
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
    status: args.status ?? "unread",
    dismissible: args.dismissible ?? true,
    severity: args.severity ?? "normal",
    targetScope: args.targetScope ?? "user",
    resolutionMode: args.resolutionMode ?? "MANUAL_ALLOWED",
    ruleCode: args.ruleCode ?? null,
    correlationId: args.correlationId ?? null,
    entityType: args.entityType ?? null,
    entityId: args.entityId ?? null,
    lastNotifiedAt: now,
    nextNotifyAt: new Date(now.getTime() + repeatHours * 3600_000),
    deliveryCount: 1,
    eventEscalatedAt: args.status === "escalated" ? now : null,
  } as any).returning({ id: userNotificationsTable.id });
  return { created: true, updated: false, id: inserted?.id ? Number(inserted.id) : undefined };
}

async function autoResolveCompletedEscalations(): Promise<{ resolvedCount: number; processedPvs: number }> {
  const now = new Date();
  let processedPvs = 0;
  let resolvedCount = 0;
  const terminalStatuses = ["completed", "paid_pending_collection", "rejected", "cancelled"];
  const completedPVs = await db
    .select({ id: paymentVouchersTable.id, firmId: paymentVouchersTable.firmId, status: paymentVouchersTable.status })
    .from(paymentVouchersTable)
    .where(and(
      inArray(paymentVouchersTable.status, terminalStatuses as unknown as string[]),
      sql`${paymentVouchersTable.escalationResolvedAt} IS NULL`,
      or(sql`${paymentVouchersTable.overdueNotifiedAt} IS NOT NULL`, sql`${paymentVouchersTable.lastEscalationNotifiedAt} IS NOT NULL`),
    ));
  for (const pv of completedPVs) {
    try {
      processedPvs++;
      const activeNotificationExists = await db
        .select({ id: userNotificationsTable.id })
        .from(userNotificationsTable)
        .where(and(
          eq(userNotificationsTable.firmId, pv.firmId),
          eq(userNotificationsTable.sourceType, "payment_voucher"),
          eq(userNotificationsTable.sourceId, pv.id),
          inArray(userNotificationsTable.status, ACTIVE_STATUSES as unknown as string[]),
        ))
        .limit(1);
      if (!activeNotificationExists[0]) {
        await db
          .update(paymentVouchersTable)
          .set({ escalationResolvedAt: now, escalationResolvedBy: null, updatedAt: now })
          .where(and(eq(paymentVouchersTable.id, pv.id), eq(paymentVouchersTable.firmId, pv.firmId), sql`${paymentVouchersTable.escalationResolvedAt} IS NULL`));
        continue;
      }
      const resolved = await db
        .update(userNotificationsTable)
        .set({
          status: "auto_resolved",
          autoResolvedAt: now,
          resolvedAt: now,
          resolvedReason: `Payment voucher #${pv.id} transitioned to ${pv.status}. Auto-resolved.`,
          statusSetAt: now,
          eventResolvedAt: now,
          eventAutoResolvedAt: now,
          updatedAt: now,
        } as any)
        .where(and(
          eq(userNotificationsTable.firmId, pv.firmId),
          eq(userNotificationsTable.sourceType, "payment_voucher"),
          eq(userNotificationsTable.sourceId, pv.id),
          inArray(userNotificationsTable.status, ACTIVE_STATUSES as unknown as string[]),
        ))
        .returning({ id: userNotificationsTable.id });
      await db
        .update(paymentVouchersTable)
        .set({ escalationResolvedAt: now, escalationResolvedBy: null, updatedAt: now })
        .where(and(eq(paymentVouchersTable.id, pv.id), eq(paymentVouchersTable.firmId, pv.firmId)));
      resolvedCount += resolved.length;
      if (resolved.length > 0) {
        await writeAuditLog({
          firmId: pv.firmId,
          actorId: null,
          actorType: "system",
          action: "payment_voucher.escalation_auto_resolved",
          entityType: "payment_voucher",
          entityId: pv.id,
          detail: `count=${resolved.length} status=${pv.status} channel=cron_http`,
        });
      }
    } catch (err) {
      logger.error({ err, paymentVoucherId: pv.id, firmId: pv.firmId }, "cron.pv_sla.auto_resolve_failed");
    }
  }
  return { resolvedCount, processedPvs };
}

function buildCorrelationId(ruleCode: string, firmId: number, pvId: number, now: Date, repeatHours: number): string {
  const waveBucket = Math.floor(now.getTime() / (repeatHours * 3600_000));
  return `pv|${firmId}|${pvId}|${ruleCode}|${waveBucket}`;
}

export type PvSlaTickResult = {
  vouchersProcessed: number;
  actionsProcessed: number;
  stage1Notifications: number;
  stage2Notifications: number;
  autoResolvedCount: number;
  autoResolvePvs: number;
  at: string;
  channel: string;
};

export async function tickPaymentVoucherSla(args?: { channel?: string }): Promise<PvSlaTickResult> {
  const channel = args?.channel ?? "cron_http";
  const start = new Date();
  const result: PvSlaTickResult = {
    vouchersProcessed: 0,
    actionsProcessed: 0,
    stage1Notifications: 0,
    stage2Notifications: 0,
    autoResolvedCount: 0,
    autoResolvePvs: 0,
    at: start.toISOString(),
    channel,
  };
  const ctx = buildCtx();
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
      approvingPartnerId: paymentVouchersTable.approvingPartnerId,
      responsibleLawyerId: paymentVouchersTable.responsibleLawyerId,
      lastEscalationNotifiedAt: paymentVouchersTable.lastEscalationNotifiedAt,
      escalationRepeatCount: paymentVouchersTable.escalationRepeatCount,
      escalationResolvedAt: paymentVouchersTable.escalationResolvedAt,
      status: paymentVouchersTable.status,
      amount: paymentVouchersTable.amount,
      receivedAt: paymentVouchersTable.receivedAt,
    })
    .from(paymentVouchersTable)
    .where(and(
      inArray(paymentVouchersTable.status, ["pending_account", "paid_pending_collection"] as unknown as string[]),
      sql`${paymentVouchersTable.paymentDueAt} IS NOT NULL`,
    ))
    .orderBy(paymentVouchersTable.paymentDueAt);

  for (const row of vouchers) {
    try {
      result.vouchersProcessed++;
      if (row.status === "pending_account" && !row.receivedAt) continue;
      const settings = await getSettings(row.firmId, ctx);
      const dueAt = row.paymentDueAt ? new Date(row.paymentDueAt) : null;
      if (!dueAt || Number.isNaN(dueAt.getTime())) continue;
      const graceHours = Number.isFinite(Number(settings.paymentVoucherSla.escalationGraceHours))
        ? Number(settings.paymentVoucherSla.escalationGraceHours)
        : ESCALATION_DEFAULT_GRACE_HOURS;
      const repeatHours = Number.isFinite(Number(settings.paymentVoucherSla.escalationRepeatHours))
        ? Number(settings.paymentVoucherSla.escalationRepeatHours)
        : ESCALATION_DEFAULT_REPEAT_HOURS;

      if (row.status === "pending_account") {
        if (!row.overdueNotifiedAt && dueAt.getTime() <= now.getTime()) {
          await db.update(paymentVouchersTable).set({
            overdueNotifiedAt: now,
            breachedAt: sql`COALESCE(${paymentVouchersTable.breachedAt}, NOW())`,
            updatedAt: now,
          }).where(and(eq(paymentVouchersTable.id, row.id), eq(paymentVouchersTable.firmId, row.firmId), sql`${paymentVouchersTable.overdueNotifiedAt} IS NULL`));
          row.overdueNotifiedAt = now;
          await writeAuditLog({
            firmId: row.firmId,
            actorId: null,
            actorType: "system",
            action: "payment_voucher.sla_breached",
            entityType: "payment_voucher",
            entityId: row.id,
            detail: `voucherNo=${row.voucherNo} channel=${channel}`,
          });
        }
        const dueSoonMinutes = Number.isFinite(Number(settings.paymentVoucherSla.dueSoonMinutes))
          ? Number(settings.paymentVoucherSla.dueSoonMinutes)
          : 30;
        if (!row.dueSoonNotifiedAt) {
          const dueSoonAt = dueAt.getTime() - dueSoonMinutes * 60_000;
          if (dueSoonAt <= now.getTime() && dueAt.getTime() > now.getTime() && settings.paymentVoucherSla.notifyAssignedAccountUser) {
            const dueSoonRecipients = uniqIds([
              settings.paymentVoucherSla.notifyAssignedAccountUser ? row.assignedAccountUserId : null,
              ...(settings.paymentVoucherSla.notifyAccountManager ? await getAccountManagerRecipients(row.firmId, ctx) : []),
            ]);
            for (const userId of dueSoonRecipients) {
              await createOrBumpNotification({
                firmId: row.firmId,
                userId,
                sourceType: "payment_voucher",
                sourceId: row.id,
                caseId: row.caseId,
                notificationType: "payment_voucher.sla_due_soon",
                title: `Voucher due soon: ${row.voucherNo}`,
                message: `Payment voucher ${row.voucherNo} is due by ${dueAt.toLocaleString("en-MY")}.`,
                meta: { voucherNo: row.voucherNo, paymentDueAt: dueAt.toISOString() },
                severity: "high",
                dismissible: true,
                targetScope: "manager",
              });
            }
            await db.update(paymentVouchersTable).set({ dueSoonNotifiedAt: now, updatedAt: now }).where(and(
              eq(paymentVouchersTable.id, row.id),
              eq(paymentVouchersTable.firmId, row.firmId),
              sql`${paymentVouchersTable.dueSoonNotifiedAt} IS NULL`,
            ));
            row.dueSoonNotifiedAt = now;
            await writeAuditLog({
              firmId: row.firmId,
              actorId: null,
              actorType: "system",
              action: "payment_voucher.sla_due_soon",
              entityType: "payment_voucher",
              entityId: row.id,
              detail: `voucherNo=${row.voucherNo} channel=${channel}`,
            });
          }
        }
      }

      if (row.overdueNotifiedAt) {
        if (row.escalationResolvedAt) continue;
        const overdueAt = new Date(row.overdueNotifiedAt);
        const stage2EligibleAt = new Date(overdueAt.getTime() + graceHours * 3600_000);
        const isStage2Eligible = now.getTime() >= stage2EligibleAt.getTime();
        if (row.lastEscalationNotifiedAt) {
          const last = new Date(row.lastEscalationNotifiedAt);
          const nextRepeatAt = new Date(last.getTime() + repeatHours * 3600_000);
          if (now.getTime() < nextRepeatAt.getTime()) continue;
        }

        const amountStr = row.amount != null ? String(row.amount) : "";
        const repeatCount = (Number(row.escalationRepeatCount ?? 0) || 0);
        const newRepeatCount = repeatCount + 1;
        const approvalPartnerIds = uniqIds([row.approvingPartnerId]);
        const overdueHours = dueAt
          ? Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / 3600_000))
          : 0;

        const managerRoleIds = await getManagerRoleIds(row.firmId, ctx);
        const managers = await getActiveUsersByRoleIds(row.firmId, managerRoleIds);
        const accountManagers = await getAccountManagerRecipients(row.firmId, ctx);
        const stage1Recipients = uniqIds([row.responsibleLawyerId, ...accountManagers, ...managers]);
        const stage1CorrelationId = buildCorrelationId(RULE_CODE_PV_STAGE1, row.firmId, row.id, now, repeatHours);
        const stage1Title = newRepeatCount === 1
          ? `OVERDUE: Voucher ${row.voucherNo}`
          : `REMINDER ${newRepeatCount}: Overdue Voucher ${row.voucherNo}`;
        const stage1Message =
          `Payment voucher ${row.voucherNo}${amountStr ? ` (MYR ${amountStr})` : ""} has been overdue for ${overdueHours}h.` +
          (newRepeatCount > 1 ? ` Reminder ${newRepeatCount - 1}. ` : "") +
          " Immediate payment or progress update required.";
        for (const userId of stage1Recipients) {
          const r = await createOrBumpNotification({
            firmId: row.firmId,
            userId,
            sourceType: "payment_voucher",
            sourceId: row.id,
            caseId: row.caseId,
            notificationType: "payment_voucher.sla_breached_stage1",
            title: stage1Title,
            message: stage1Message,
            meta: {
              voucherNo: row.voucherNo,
              escalationCount: newRepeatCount,
              overdueHours,
              escalationStage: 1,
            },
            status: "escalated",
            severity: "urgent",
            dismissible: false,
            targetScope: "lawyer",
            ruleCode: RULE_CODE_PV_STAGE1,
            resolutionMode: "MANUAL_ALLOWED",
            correlationId: stage1CorrelationId,
            entityType: "payment_voucher",
            entityId: row.id,
            repeatHours,
          });
          if (r.created || r.updated) result.stage1Notifications++;
        }

        if (isStage2Eligible) {
          const allPartners = await getEscalationRecipients(row.firmId, ctx);
          const stage2CorrelationId = buildCorrelationId(RULE_CODE_PV_STAGE2, row.firmId, row.id, now, repeatHours);
          const stage2Recipients = uniqIds([...allPartners, ...approvalPartnerIds]);
          const stage2Title = newRepeatCount === 1
            ? `ESCALATED: PV overdue ${row.voucherNo}`
            : `REMINDER ${newRepeatCount - 1}: PV still overdue ${row.voucherNo}`;
          const stage2Message =
            `Payment voucher ${row.voucherNo}${amountStr ? ` (MYR ${amountStr})` : ""} has been overdue for ${overdueHours}h.` +
            (newRepeatCount > 1 ? ` Escalation repeated ${newRepeatCount - 1} time(s). ` : "") +
            (dueAt ? ` Original due: ${dueAt.toLocaleString("en-MY")}. ` : "") +
            " Immediate Partner review required.";
          for (const userId of stage2Recipients) {
            const isApprovingPartner = approvalPartnerIds.includes(userId);
            const r = await createOrBumpNotification({
              firmId: row.firmId,
              userId,
              sourceType: "payment_voucher",
              sourceId: row.id,
              caseId: row.caseId,
              notificationType: "payment_voucher.sla_escalated",
              title: stage2Title,
              message: stage2Message,
              meta: {
                voucherNo: row.voucherNo,
                escalationCount: newRepeatCount,
                overdueHours,
                approvingPartnerId: row.approvingPartnerId,
                isApprovingPartner,
                escalationStage: 2,
              },
              status: "escalated",
              severity: "urgent",
              dismissible: false,
              targetScope: isApprovingPartner ? "selected_partner" : "all_partners",
              ruleCode: RULE_CODE_PV_STAGE2,
              resolutionMode: "AUTO_ONLY",
              correlationId: stage2CorrelationId,
              entityType: "payment_voucher",
              entityId: row.id,
              repeatHours,
            });
            if (r.created || r.updated) result.stage2Notifications++;
          }
        }

        await db.update(paymentVouchersTable).set({
          lastEscalationNotifiedAt: now,
          escalationRepeatCount: newRepeatCount,
          updatedAt: now,
        }).where(and(eq(paymentVouchersTable.id, row.id), eq(paymentVouchersTable.firmId, row.firmId)));

        await writeAuditLog({
          firmId: row.firmId,
          actorId: null,
          actorType: "system",
          action: "payment_voucher.escalated",
          entityType: "payment_voucher",
          entityId: row.id,
          detail: `voucherNo=${row.voucherNo} escalationRepeatCount=${newRepeatCount} stage2=${isStage2Eligible} channel=${channel}`,
        });
      }
    } catch (err) {
      logger.error({ err, paymentVoucherId: row.id, firmId: row.firmId }, "cron.pv_sla.voucher_failed");
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
    .where(inArray(paymentVoucherActionsTable.status, ["assigned", "acknowledged"] as unknown as string[]));

  for (const row of actions) {
    try {
      result.actionsProcessed++;
      const settings = await getSettings(row.firmId, ctx);
      const isAckStage = row.status === "assigned";
      const dueAtRaw = isAckStage ? row.acknowledgeDueAt : row.completionDueAt;
      const dueAt = dueAtRaw ? new Date(dueAtRaw) : null;
      if (!dueAt || Number.isNaN(dueAt.getTime())) continue;
      const overdue = dueAt.getTime() <= now.getTime();
      const dueSoonMinutes = Number.isFinite(Number(settings.clerkActionSla.dueSoonMinutes))
        ? Number(settings.clerkActionSla.dueSoonMinutes)
        : 15;
      const dueSoonAt = dueAt.getTime() - dueSoonMinutes * 60_000;
      if (!overdue && dueSoonAt > now.getTime()) continue;
      const kind = overdue
        ? (isAckStage ? "payment_voucher.action_acknowledge_overdue" : "payment_voucher.action_complete_overdue")
        : (isAckStage ? "payment_voucher.action_acknowledge_due_soon" : "payment_voucher.action_complete_due_soon");
      const title = overdue
        ? `Clerk action overdue: PV #${row.paymentVoucherId}`
        : `Clerk action due soon: PV #${row.paymentVoucherId}`;
      const actionLabel = row.customAction || row.actionType;
      const caseOwners: number[] = [];
      if (settings.clerkActionSla.notifyCaseOwner && row.caseId && row.caseId > 0) {
        const ownerRows = await db
          .select({ userId: caseAssignmentsTable.userId })
          .from(caseAssignmentsTable)
          .innerJoin(usersTable, and(
            eq(usersTable.id, caseAssignmentsTable.userId),
            eq(usersTable.firmId, row.firmId),
            eq(usersTable.status, "active"),
          ))
          .where(and(
            eq(caseAssignmentsTable.caseId, row.caseId),
            eq(caseAssignmentsTable.roleInCase, "lawyer"),
            sql`${caseAssignmentsTable.unassignedAt} IS NULL`,
          ));
        caseOwners.push(...uniqIds(ownerRows.map(r => r.userId)));
      }
      const escalationPartners: number[] = overdue && settings.clerkActionSla.notifyPartnerOnOverdue
        ? await getEscalationRecipients(row.firmId, ctx)
        : [];
      const recipients = uniqIds([row.assignedUserId, ...caseOwners, ...escalationPartners]);
      const isAllPartnerEscalation = overdue && settings.clerkActionSla.notifyPartnerOnOverdue;
      for (const userId of recipients) {
        await createOrBumpNotification({
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
            stage: isAckStage ? "acknowledge" : "complete",
          },
          severity: overdue ? "urgent" : "high",
          dismissible: isAllPartnerEscalation ? false : true,
          targetScope: isAllPartnerEscalation ? "all_partners" : (overdue ? "manager" : "user"),
        });
      }
      if (overdue) {
        await db.update(paymentVoucherActionsTable).set({
          breachedAt: sql`COALESCE(${paymentVoucherActionsTable.breachedAt}, NOW())`,
          updatedAt: now,
        }).where(and(eq(paymentVoucherActionsTable.id, row.id), eq(paymentVoucherActionsTable.firmId, row.firmId)));
        await writeAuditLog({
          firmId: row.firmId,
          actorId: null,
          actorType: "system",
          action: "payment_voucher.action_overdue",
          entityType: "payment_voucher_action",
          entityId: row.id,
          detail: `paymentVoucherId=${row.paymentVoucherId} channel=${channel}`,
        });
      }
    } catch (err) {
      logger.error({ err, paymentVoucherActionId: row.id, firmId: row.firmId }, "cron.pv_sla.action_failed");
    }
  }

  const auto = await autoResolveCompletedEscalations();
  result.autoResolvedCount = auto.resolvedCount;
  result.autoResolvePvs = auto.processedPvs;
  return result;
}

export async function runPaymentVoucherSlaOnce(): Promise<PvSlaTickResult & { lockAcquired: boolean }> {
  const lockAcquired = await tryAcquireLock();
  try {
    if (!lockAcquired) {
      return {
        lockAcquired,
        vouchersProcessed: 0,
        actionsProcessed: 0,
        stage1Notifications: 0,
        stage2Notifications: 0,
        autoResolvedCount: 0,
        autoResolvePvs: 0,
        at: new Date().toISOString(),
        channel: "cron_http",
      };
    }
    const result = await tickPaymentVoucherSla({ channel: "cron_http" });
    return { lockAcquired, ...result };
  } finally {
    if (lockAcquired) {
      await releaseLock();
    }
  }
}

router.post("/cron/payment-voucher-sla", async (req: express.Request, res: Response): Promise<void> => {
  try {
    if (!requireCronAuth(req, res)) return;
    const result = await runPaymentVoucherSlaOnce();
    res.json(result);
  } catch (e) {
    logger.error({ err: e }, "cron.pv_sla.http_failed");
    res.status(500).json({ error: "cron_failed", detail: (e as Error).message });
  }
});

router.get("/cron/payment-voucher-sla", async (req: express.Request, res: Response): Promise<void> => {
  try {
    if (!requireCronAuth(req, res)) return;
    const result = await runPaymentVoucherSlaOnce();
    res.json(result);
  } catch (e) {
    logger.error({ err: e }, "cron.pv_sla.http_failed");
    res.status(500).json({ error: "cron_failed", detail: (e as Error).message });
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
