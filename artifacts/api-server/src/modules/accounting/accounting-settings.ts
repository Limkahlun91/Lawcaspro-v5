import type { sql as SqlT } from "drizzle-orm";

export type AccountingSettingsLoaderErrorCode =
  | "MIGRATION_MISSING"
  | "DATABASE_PERMISSION_ERROR"
  | "QUERY_TIMEOUT"
  | "LOCK_TIMEOUT"
  | "ACCOUNTING_SETTINGS_UNAVAILABLE"
  | "SETTINGS_NOT_CONFIGURED";

export class AccountingSettingsLoaderError extends Error {
  readonly code: AccountingSettingsLoaderErrorCode;
  readonly sqlstate: string | null;
  constructor(
    code: AccountingSettingsLoaderErrorCode,
    message: string,
    opts?: { cause?: unknown; sqlstate?: string | null },
  ) {
    super(message);
    this.name = "AccountingSettingsLoaderError";
    this.code = code;
    this.sqlstate = opts?.sqlstate ?? null;
    if (opts?.cause && typeof (Error as any).captureStackTrace === "function") {
      try { (Error as any).captureStackTrace(this, AccountingSettingsLoaderError); } catch { /* noop */ }
    }
  }
}

export const ACCOUNTING_SETTINGS_STATEMENT_TIMEOUT_MS = 4500;
export const ACCOUNTING_SETTINGS_LOCK_TIMEOUT_MS = 500;

export type AccountingSettingsLoaderConn = {
  select: (...args: unknown[]) => any;
  execute?: (query: unknown) => Promise<unknown>;
  transaction?: <T>(fn: (tx: AccountingSettingsLoaderConn) => Promise<T>) => Promise<T>;
};

function extractSqlstate(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || seen.has(cur) || typeof cur !== "object") continue;
    seen.add(cur);
    const e = cur as Record<string, unknown>;
    const codeVal = typeof e.code === "string" ? e.code : null;
    const s1 = (e as { sqlstate?: unknown }).sqlstate;
    const s2 = (e as { sqlState?: unknown }).sqlState;
    const raw = codeVal ?? (typeof s1 === "string" && s1 ? s1 : null) ?? (typeof s2 === "string" && s2 ? s2 : null);
    if (typeof raw === "string" && raw) return raw;
    for (const k of ["cause", "original", "parent", "error", "err"]) {
      const next = e[k];
      if (next && typeof next === "object") queue.push(next);
    }
  }
  return null;
}

function sqlstateToLoaderCode(sqlstate: string | null): AccountingSettingsLoaderErrorCode | null {
  if (!sqlstate) return null;
  switch (sqlstate) {
    case "42P01":
    case "42703":
      return "MIGRATION_MISSING";
    case "42501":
      return "DATABASE_PERMISSION_ERROR";
    case "57014":
    case "57P01":
    case "57P02":
      return "QUERY_TIMEOUT";
    case "55P03":
      return "LOCK_TIMEOUT";
    default:
      return null;
  }
}

function makeSetTimeoutSql(sqlBuilder: typeof SqlT, lockMs: number, stmtMs: number) {
  return [
    sqlBuilder.raw(`SET LOCAL lock_timeout = '${lockMs}ms'`),
    sqlBuilder.raw(`SET LOCAL statement_timeout = '${stmtMs}ms'`),
  ];
}

export type EqBuilder = (lhs: unknown, rhs: unknown) => unknown;

export async function safeLoadAccountingSettings(args: {
  firmId: number;
  db: AccountingSettingsLoaderConn;
  accountingSettingsTable: { firmId: any } & Record<string, any>;
  sql: typeof SqlT;
  eq: EqBuilder;
}): Promise<{ settings: AccountingSettingsRecord; rowExisted: boolean }> {
  const { firmId, db, accountingSettingsTable, sql, eq } = args;
  if (!Number.isFinite(firmId) || firmId <= 0) {
    throw new AccountingSettingsLoaderError("ACCOUNTING_SETTINGS_UNAVAILABLE", "Invalid firmId");
  }
  let row: Record<string, unknown> | undefined;
  let sqlstate: string | null = null;
  try {
    const runBounded = async (conn: AccountingSettingsLoaderConn) => {
      if (typeof conn.execute === "function") {
        const [setLock, setStmt] = makeSetTimeoutSql(sql, ACCOUNTING_SETTINGS_LOCK_TIMEOUT_MS, ACCOUNTING_SETTINGS_STATEMENT_TIMEOUT_MS);
        await conn.execute(setLock);
        await conn.execute(setStmt);
      }
      const rows = await conn
        .select()
        .from(accountingSettingsTable)
        .where(eq(accountingSettingsTable.firmId, firmId))
        .limit(1);
      return rows?.[0];
    };
    const useTx = typeof db.transaction === "function" && typeof db.execute !== "function";
    row = (useTx && db.transaction)
      ? await db.transaction(async (tx) => runBounded(tx))
      : await runBounded(db);
  } catch (err) {
    sqlstate = extractSqlstate(err);
    const mapped = sqlstateToLoaderCode(sqlstate);
    if (mapped) {
      throw new AccountingSettingsLoaderError(mapped, `accounting_settings load failed (sqlstate=${sqlstate})`, { cause: err, sqlstate });
    }
    throw new AccountingSettingsLoaderError("ACCOUNTING_SETTINGS_UNAVAILABLE", `accounting_settings load failed (unexpected)`, { cause: err, sqlstate });
  }
  if (!row) {
    return { settings: getDefaultAccountingSettings(firmId), rowExisted: false };
  }
  return { settings: normalizeAccountingSettings(firmId, row as Record<string, unknown>), rowExisted: true };
}

export async function safeLoadAccountingSettingsOrDefault(args: {
  firmId: number;
  db: AccountingSettingsLoaderConn;
  accountingSettingsTable: { firmId: any } & Record<string, any>;
  sql: typeof SqlT;
  eq: EqBuilder;
}): Promise<AccountingSettingsRecord> {
  const r = await safeLoadAccountingSettings(args);
  return r.settings;
}

export function accountingSettingsErrorHttpStatus(code: AccountingSettingsLoaderErrorCode): 503 {
  return 503;
}

export type PermissionTuple = { module: string; action: string; allowed: boolean };

export type AccountingApprovalThresholdRule = {
  minAmount?: number;
  maxAmount?: number;
  requiresPartnerApproval?: boolean;
  managerCanApprove?: boolean;
  adminCanApprove?: boolean;
  hours?: number;
};

export type AccountingApprovalRules = {
  requirePartnerApprovalByDefault: boolean;
  managerCanFinalApprove: boolean;
  adminCanFinalApprove: boolean;
  requireDoubleApproval: boolean;
  managerSoloVoucherTypes: string[];
  thresholds: AccountingApprovalThresholdRule[];
};

export type AccountingPaymentVoucherSla = {
  defaultHours: number;
  urgentHours: number;
  dueSoonMinutes: number;
  voucherTypeHours: Record<string, number>;
  thresholds: Array<{ minAmount?: number; maxAmount?: number; hours: number }>;
  notifyAssignedAccountUser: boolean;
  notifyAccountManager: boolean;
  notifyPartnerOnOverdue: boolean;
  escalationGraceHours: number;
  escalationRepeatHours: number;
};

export type AccountingClerkActionSla = {
  acknowledgeHours: number;
  completionHours: number;
  dueSoonMinutes: number;
  notifyCaseOwner: boolean;
  notifyPartnerOnOverdue: boolean;
};

export type AccountingSettingsRecord = {
  firmId: number;
  accountManagerRoleIds: number[];
  accountAdminRoleIds: number[];
  timezone: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  excludeSaturday: boolean;
  excludeSunday: boolean;
  firmHolidays: Array<{ date: string; label?: string }>;
  approvalRules: AccountingApprovalRules;
  paymentVoucherSla: AccountingPaymentVoucherSla;
  clerkActionSla: AccountingClerkActionSla;
  paymentProofRequired: boolean;
};

export const ACCOUNTING_ACTIONS = [
  "read",
  "write",
  "create",
  "edit",
  "review",
  "approve",
  "mark_received",
  "mark_paid",
  "cancel",
  "reopen",
  "export",
  "view_audit",
  "manage_settings",
  "override_sla",
] as const;

const uniqNumbers = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)));
};

const normalizeHolidayList = (value: unknown): Array<{ date: string; label?: string }> => {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const item = row as Record<string, unknown>;
      const date = typeof item.date === "string" ? item.date.trim() : "";
      if (!date) return null;
      const label = typeof item.label === "string" ? item.label.trim() : undefined;
      return { date, ...(label ? { label } : {}) };
    })
    .filter((row): row is { date: string; label?: string } => Boolean(row));
};

export function getDefaultAccountingSettings(firmId: number): AccountingSettingsRecord {
  return {
    firmId,
    accountManagerRoleIds: [],
    accountAdminRoleIds: [],
    timezone: "Asia/Kuala_Lumpur",
    workingHoursStart: "09:00",
    workingHoursEnd: "18:00",
    excludeSaturday: true,
    excludeSunday: true,
    firmHolidays: [],
    approvalRules: {
      requirePartnerApprovalByDefault: true,
      managerCanFinalApprove: false,
      adminCanFinalApprove: false,
      requireDoubleApproval: false,
      managerSoloVoucherTypes: [],
      thresholds: [],
    },
    paymentVoucherSla: {
      defaultHours: 24,
      urgentHours: 4,
      dueSoonMinutes: 120,
      voucherTypeHours: {
        external_payment: 24,
        file_transfer: 24,
        file_to_file_transfer: 12,
        internal_transfer: 8,
        account_transfer: 8,
      },
      thresholds: [],
      notifyAssignedAccountUser: true,
      notifyAccountManager: true,
      notifyPartnerOnOverdue: true,
      escalationGraceHours: 1,
      escalationRepeatHours: 2,
    },
    clerkActionSla: {
      acknowledgeHours: 4,
      completionHours: 24,
      dueSoonMinutes: 60,
      notifyCaseOwner: true,
      notifyPartnerOnOverdue: true,
    },
    paymentProofRequired: true,
  };
}

export function normalizeAccountingSettings(
  firmId: number,
  raw: Partial<AccountingSettingsRecord> | Record<string, unknown> | null | undefined,
): AccountingSettingsRecord {
  const defaults = getDefaultAccountingSettings(firmId);
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const approvalRulesRaw = source.approvalRules && typeof source.approvalRules === "object" ? source.approvalRules as Record<string, unknown> : {};
  const paymentSlaRaw = source.paymentVoucherSla && typeof source.paymentVoucherSla === "object" ? source.paymentVoucherSla as Record<string, unknown> : {};
  const clerkSlaRaw = source.clerkActionSla && typeof source.clerkActionSla === "object" ? source.clerkActionSla as Record<string, unknown> : {};
  const toNum = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const toBool = (value: unknown, fallback: boolean): boolean => typeof value === "boolean" ? value : fallback;
  return {
    firmId,
    accountManagerRoleIds: uniqNumbers(source.accountManagerRoleIds ?? defaults.accountManagerRoleIds),
    accountAdminRoleIds: uniqNumbers(source.accountAdminRoleIds ?? defaults.accountAdminRoleIds),
    timezone: typeof source.timezone === "string" && source.timezone.trim() ? source.timezone.trim() : defaults.timezone,
    workingHoursStart: typeof source.workingHoursStart === "string" && source.workingHoursStart.trim() ? source.workingHoursStart.trim() : defaults.workingHoursStart,
    workingHoursEnd: typeof source.workingHoursEnd === "string" && source.workingHoursEnd.trim() ? source.workingHoursEnd.trim() : defaults.workingHoursEnd,
    excludeSaturday: toBool(source.excludeSaturday, defaults.excludeSaturday),
    excludeSunday: toBool(source.excludeSunday, defaults.excludeSunday),
    firmHolidays: normalizeHolidayList(source.firmHolidays ?? defaults.firmHolidays),
    approvalRules: {
      requirePartnerApprovalByDefault: toBool(approvalRulesRaw.requirePartnerApprovalByDefault, defaults.approvalRules.requirePartnerApprovalByDefault),
      managerCanFinalApprove: toBool(approvalRulesRaw.managerCanFinalApprove, defaults.approvalRules.managerCanFinalApprove),
      adminCanFinalApprove: toBool(approvalRulesRaw.adminCanFinalApprove, defaults.approvalRules.adminCanFinalApprove),
      requireDoubleApproval: toBool(approvalRulesRaw.requireDoubleApproval, defaults.approvalRules.requireDoubleApproval),
      managerSoloVoucherTypes: Array.isArray(approvalRulesRaw.managerSoloVoucherTypes)
        ? approvalRulesRaw.managerSoloVoucherTypes.map((x) => String(x ?? "").trim()).filter(Boolean)
        : defaults.approvalRules.managerSoloVoucherTypes,
      thresholds: Array.isArray(approvalRulesRaw.thresholds)
        ? approvalRulesRaw.thresholds
          .map((row) => {
            if (!row || typeof row !== "object") return null;
            const item = row as Record<string, unknown>;
            return {
              ...(Number.isFinite(Number(item.minAmount)) ? { minAmount: Number(item.minAmount) } : {}),
              ...(Number.isFinite(Number(item.maxAmount)) ? { maxAmount: Number(item.maxAmount) } : {}),
              ...(typeof item.requiresPartnerApproval === "boolean" ? { requiresPartnerApproval: item.requiresPartnerApproval } : {}),
              ...(typeof item.managerCanApprove === "boolean" ? { managerCanApprove: item.managerCanApprove } : {}),
              ...(typeof item.adminCanApprove === "boolean" ? { adminCanApprove: item.adminCanApprove } : {}),
              ...(Number.isFinite(Number(item.hours)) ? { hours: Number(item.hours) } : {}),
            };
          })
          .filter((row): row is AccountingApprovalThresholdRule => Boolean(row))
        : defaults.approvalRules.thresholds,
    },
    paymentVoucherSla: {
      defaultHours: toNum(paymentSlaRaw.defaultHours, defaults.paymentVoucherSla.defaultHours),
      urgentHours: toNum(paymentSlaRaw.urgentHours, defaults.paymentVoucherSla.urgentHours),
      dueSoonMinutes: toNum(paymentSlaRaw.dueSoonMinutes, defaults.paymentVoucherSla.dueSoonMinutes),
      voucherTypeHours: paymentSlaRaw.voucherTypeHours && typeof paymentSlaRaw.voucherTypeHours === "object"
        ? Object.fromEntries(
          Object.entries(paymentSlaRaw.voucherTypeHours as Record<string, unknown>)
            .map(([key, value]) => [key, toNum(value, defaults.paymentVoucherSla.voucherTypeHours[key] ?? defaults.paymentVoucherSla.defaultHours)]),
        )
        : defaults.paymentVoucherSla.voucherTypeHours,
      thresholds: Array.isArray(paymentSlaRaw.thresholds)
        ? paymentSlaRaw.thresholds
          .map((row) => {
            if (!row || typeof row !== "object") return null;
            const item = row as Record<string, unknown>;
            const hours = Number(item.hours);
            if (!Number.isFinite(hours) || hours <= 0) return null;
            return {
              ...(Number.isFinite(Number(item.minAmount)) ? { minAmount: Number(item.minAmount) } : {}),
              ...(Number.isFinite(Number(item.maxAmount)) ? { maxAmount: Number(item.maxAmount) } : {}),
              hours,
            };
          })
          .filter((row): row is { minAmount?: number; maxAmount?: number; hours: number } => Boolean(row))
        : defaults.paymentVoucherSla.thresholds,
      notifyAssignedAccountUser: toBool(paymentSlaRaw.notifyAssignedAccountUser, defaults.paymentVoucherSla.notifyAssignedAccountUser),
      notifyAccountManager: toBool(paymentSlaRaw.notifyAccountManager, defaults.paymentVoucherSla.notifyAccountManager),
      notifyPartnerOnOverdue: toBool(paymentSlaRaw.notifyPartnerOnOverdue, defaults.paymentVoucherSla.notifyPartnerOnOverdue),
      escalationGraceHours: toNum(paymentSlaRaw.escalationGraceHours, defaults.paymentVoucherSla.escalationGraceHours),
      escalationRepeatHours: toNum(paymentSlaRaw.escalationRepeatHours, defaults.paymentVoucherSla.escalationRepeatHours),
    },
    clerkActionSla: {
      acknowledgeHours: toNum(clerkSlaRaw.acknowledgeHours, defaults.clerkActionSla.acknowledgeHours),
      completionHours: toNum(clerkSlaRaw.completionHours, defaults.clerkActionSla.completionHours),
      dueSoonMinutes: toNum(clerkSlaRaw.dueSoonMinutes, defaults.clerkActionSla.dueSoonMinutes),
      notifyCaseOwner: toBool(clerkSlaRaw.notifyCaseOwner, defaults.clerkActionSla.notifyCaseOwner),
      notifyPartnerOnOverdue: toBool(clerkSlaRaw.notifyPartnerOnOverdue, defaults.clerkActionSla.notifyPartnerOnOverdue),
    },
    paymentProofRequired: toBool(source.paymentProofRequired, defaults.paymentProofRequired),
  };
}

export function getAccountManagerTemplate(): PermissionTuple[] {
  return [
    { module: "accounting", action: "read", allowed: true },
    { module: "accounting", action: "write", allowed: true },
    { module: "accounting", action: "create", allowed: true },
    { module: "accounting", action: "edit", allowed: true },
    { module: "accounting", action: "review", allowed: true },
    { module: "accounting", action: "mark_received", allowed: true },
    { module: "accounting", action: "mark_paid", allowed: true },
    { module: "reports", action: "read", allowed: true },
  ];
}

export function getAccountAdminTemplate(): PermissionTuple[] {
  return [
    { module: "accounting", action: "read", allowed: true },
    { module: "accounting", action: "write", allowed: true },
    { module: "accounting", action: "create", allowed: true },
    { module: "accounting", action: "edit", allowed: true },
    { module: "accounting", action: "review", allowed: true },
    { module: "accounting", action: "mark_received", allowed: true },
  ];
}

export function getPartnerAccountingTemplate(): PermissionTuple[] {
  return [
    ...ACCOUNTING_ACTIONS.map((action) => ({ module: "accounting", action, allowed: true })),
    { module: "reports", action: "read", allowed: true },
    { module: "reports", action: "export", allowed: true },
    { module: "audit", action: "read", allowed: true },
  ];
}

export function buildRoleTemplate(
  kind: "account_manager" | "account_admin",
  settings: AccountingSettingsRecord,
): PermissionTuple[] {
  const base = kind === "account_manager" ? getAccountManagerTemplate() : getAccountAdminTemplate();
  const tuples = new Map<string, PermissionTuple>();
  for (const row of base) tuples.set(`${row.module}:${row.action}`, row);

  if (kind === "account_manager" && settings.approvalRules.managerCanFinalApprove) {
    tuples.set("accounting:approve", { module: "accounting", action: "approve", allowed: true });
  }
  if (kind === "account_admin" && settings.approvalRules.adminCanFinalApprove) {
    tuples.set("accounting:approve", { module: "accounting", action: "approve", allowed: true });
  }
  return Array.from(tuples.values());
}

export function diffPermissions(
  current: Array<{ module: string; action: string; allowed: boolean }>,
  next: PermissionTuple[],
): { additions: PermissionTuple[]; removals: PermissionTuple[] } {
  const currentAllowed = new Set(current.filter((x) => x.allowed).map((x) => `${x.module}:${x.action}`));
  const nextAllowed = new Set(next.filter((x) => x.allowed).map((x) => `${x.module}:${x.action}`));
  const additions = next.filter((x) => x.allowed && !currentAllowed.has(`${x.module}:${x.action}`));
  const removals = current
    .filter((x) => x.allowed && !nextAllowed.has(`${x.module}:${x.action}`))
    .map((x) => ({ module: x.module, action: x.action, allowed: false }));
  return { additions, removals };
}

function getTimeZoneParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayLabel = map.get("weekday") ?? "Mon";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.get("year") ?? 0),
    month: Number(map.get("month") ?? 1),
    day: Number(map.get("day") ?? 1),
    hour: Number(map.get("hour") ?? 0),
    minute: Number(map.get("minute") ?? 0),
    second: Number(map.get("second") ?? 0),
    weekday: weekdayMap[weekdayLabel] ?? 1,
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getTimeZoneParts(date, timeZone);
  const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return utcMs - date.getTime();
}

function zonedDateTimeToUtc(dateParts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): Date {
  const guess = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, dateParts.hour, dateParts.minute, 0));
  const offset = getTimeZoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

function nextLocalDate(parts: { year: number; month: number; day: number }, offsetDays: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays, 0, 0, 0));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function ymd(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseHm(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return { hour: 9, minute: 0 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return { hour: 9, minute: 0 };
  return { hour: Math.max(0, Math.min(23, hour)), minute: Math.max(0, Math.min(59, minute)) };
}

function isWorkingDay(parts: { year: number; month: number; day: number; weekday: number }, settings: AccountingSettingsRecord): boolean {
  const day = parts.weekday;
  if (settings.excludeSaturday && day === 6) return false;
  if (settings.excludeSunday && day === 0) return false;
  const holidaySet = new Set(settings.firmHolidays.map((row) => row.date));
  if (holidaySet.has(ymd(parts))) return false;
  return true;
}

function nextWorkingStart(from: Date, settings: AccountingSettingsRecord): Date {
  const parts = getTimeZoneParts(from, settings.timezone);
  const workStart = parseHm(settings.workingHoursStart);
  const workEnd = parseHm(settings.workingHoursEnd);
  let cursorDate = { year: parts.year, month: parts.month, day: parts.day };
  const currentLocalMinutes = parts.hour * 60 + parts.minute;
  const startMinutes = workStart.hour * 60 + workStart.minute;
  const endMinutes = workEnd.hour * 60 + workEnd.minute;
  if (currentLocalMinutes >= endMinutes || !isWorkingDay(parts, settings)) {
    cursorDate = nextLocalDate(cursorDate, 1);
  }
  while (true) {
    const candidateUtc = zonedDateTimeToUtc({ ...cursorDate, hour: workStart.hour, minute: workStart.minute }, settings.timezone);
    const candidateParts = getTimeZoneParts(candidateUtc, settings.timezone);
    if (isWorkingDay(candidateParts, settings)) {
      if (ymd(candidateParts) === ymd(parts) && currentLocalMinutes > startMinutes && currentLocalMinutes < endMinutes && isWorkingDay(parts, settings)) {
        return from;
      }
      return candidateUtc;
    }
    cursorDate = nextLocalDate(cursorDate, 1);
  }
}

export function addBusinessHours(startAt: Date, hours: number, settings: AccountingSettingsRecord): Date {
  const totalMinutes = Math.max(1, Math.round(hours * 60));
  const workStart = parseHm(settings.workingHoursStart);
  const workEnd = parseHm(settings.workingHoursEnd);
  let current = nextWorkingStart(startAt, settings);
  let remaining = totalMinutes;
  while (remaining > 0) {
    const local = getTimeZoneParts(current, settings.timezone);
    const endUtc = zonedDateTimeToUtc({ year: local.year, month: local.month, day: local.day, hour: workEnd.hour, minute: workEnd.minute }, settings.timezone);
    const availableMinutes = Math.max(0, Math.floor((endUtc.getTime() - current.getTime()) / 60000));
    if (availableMinutes <= 0) {
      const nextDate = nextLocalDate({ year: local.year, month: local.month, day: local.day }, 1);
      const nextDay = zonedDateTimeToUtc({ ...nextDate, hour: workStart.hour, minute: workStart.minute }, settings.timezone);
      current = nextWorkingStart(nextDay, settings);
      continue;
    }
    const consumed = Math.min(remaining, availableMinutes);
    current = new Date(current.getTime() + consumed * 60000);
    remaining -= consumed;
    if (remaining > 0) {
      const localNext = getTimeZoneParts(current, settings.timezone);
      const nextDate = nextLocalDate({ year: localNext.year, month: localNext.month, day: localNext.day }, 1);
      const nextUtc = zonedDateTimeToUtc({ ...nextDate, hour: workStart.hour, minute: workStart.minute }, settings.timezone);
      current = nextWorkingStart(nextUtc, settings);
    }
  }
  const startUtc = zonedDateTimeToUtc({ ...getTimeZoneParts(current, settings.timezone), hour: workStart.hour, minute: workStart.minute }, settings.timezone);
  return current < startUtc ? startUtc : current;
}

export function resolveApprovalRequirement(
  amount: number,
  voucherType: string,
  settings: AccountingSettingsRecord,
): { requiresPartnerApproval: boolean } {
  for (const rule of settings.approvalRules.thresholds) {
    const minOk = rule.minAmount == null || amount >= rule.minAmount;
    const maxOk = rule.maxAmount == null || amount <= rule.maxAmount;
    if (minOk && maxOk && typeof rule.requiresPartnerApproval === "boolean") {
      return { requiresPartnerApproval: rule.requiresPartnerApproval };
    }
  }
  if (settings.approvalRules.managerSoloVoucherTypes.includes(voucherType)) {
    return { requiresPartnerApproval: false };
  }
  return { requiresPartnerApproval: settings.approvalRules.requirePartnerApprovalByDefault };
}

export function resolvePaymentVoucherSlaHours(
  amount: number,
  voucherType: string,
  isUrgent: boolean,
  settings: AccountingSettingsRecord,
): number {
  for (const rule of settings.paymentVoucherSla.thresholds) {
    const minOk = rule.minAmount == null || amount >= rule.minAmount;
    const maxOk = rule.maxAmount == null || amount <= rule.maxAmount;
    if (minOk && maxOk) return rule.hours;
  }
  if (settings.paymentVoucherSla.voucherTypeHours[voucherType]) {
    return settings.paymentVoucherSla.voucherTypeHours[voucherType];
  }
  return isUrgent ? settings.paymentVoucherSla.urgentHours : settings.paymentVoucherSla.defaultHours;
}
