import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";

export interface VersionedRecord {
  id: number | string;
  version: number;
}

export function checkOptimisticLock<T extends VersionedRecord>(
  current: T,
  expectedVersion: number,
  recordKind = "HR record",
): void {
  if (!Number.isFinite(expectedVersion) || expectedVersion < 0) {
    throw createHRError(
      HR_ERROR_CODES.HR_RECORD_VERSION_MISMATCH,
      `${recordKind} version must be provided for mutation. Refresh and review the latest information.`,
      { details: { expectedVersion, id: current.id } },
    );
  }
  if (current.version !== expectedVersion) {
    throw createHRError(
      HR_ERROR_CODES.HR_RECORD_CONFLICT,
      `${recordKind} was updated by another user. Refresh and review the latest information.`,
      { details: { expectedVersion, actualVersion: current.version, id: current.id } },
    );
  }
}

export function nextVersion(current: number): number {
  if (!Number.isFinite(current) || current < 0) return 1;
  return current + 1;
}

export interface HRDelegation {
  id: number | string;
  originalApproverUserId: number | string;
  delegateApproverUserId: number | string;
  startAt: Date | string;
  endAt: Date | string;
  status: "active" | "expired" | "revoked" | "draft";
}

export interface EffectiveApprover {
  approverUserId: number | string;
  actingForUserId: number | string | null;
  actingDelegationId: number | string | null;
  isDelegated: boolean;
}

export function resolveEffectiveFinalApprover(
  configuredApproverUserId: number | string | null | undefined,
  activeDelegations: HRDelegation[],
  asOf: Date = new Date(),
): EffectiveApprover {
  if (!configuredApproverUserId) {
    throw createHRError(
      HR_ERROR_CODES.HR_APPROVER_NOT_CONFIGURED,
      "No final approver is configured for this HR approval policy. Contact HR Manager or Firm Partner.",
    );
  }
  const t = asOf.getTime();
  for (const d of activeDelegations) {
    if (String(d.originalApproverUserId) !== String(configuredApproverUserId)) continue;
    if (d.status !== "active") continue;
    const start = new Date(d.startAt).getTime();
    const end = new Date(d.endAt).getTime();
    if (t >= start && t <= end) {
      return {
        approverUserId: d.delegateApproverUserId,
        actingForUserId: d.originalApproverUserId,
        actingDelegationId: d.id,
        isDelegated: true,
      };
    }
  }
  return {
    approverUserId: configuredApproverUserId,
    actingForUserId: null,
    actingDelegationId: null,
    isDelegated: false,
  };
}

export type ColumnMaskPredicate = (fieldName: string) => boolean;

export function applyColumnMask<T extends object>(
  record: T,
  canView: ColumnMaskPredicate,
): Partial<T> {
  if (!record) return record;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (canView(key)) {
      out[key] = (record as Record<string, unknown>)[key];
    } else {
      out[key] = null;
    }
  }
  return out as Partial<T>;
}

export function applyColumnMaskList<T extends object>(
  records: T[],
  canView: ColumnMaskPredicate,
): Partial<T>[] {
  return records.map((r) => applyColumnMask(r, canView));
}

export interface HRAuditActor {
  userId: number | string;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export function buildAuditBeforeAfter<T>(
  before: T | null,
  after: T | null,
  allowedKeys: (keyof T & string)[],
): { before: Partial<T> | null; after: Partial<T> | null } {
  const pick = (r: T | null): Partial<T> | null => {
    if (r === null || r === undefined) return null;
    const out: Record<string, unknown> = {};
    for (const k of allowedKeys) out[k] = (r as Record<string, unknown>)[k];
    return out as Partial<T>;
  };
  return { before: pick(before), after: pick(after) };
}
