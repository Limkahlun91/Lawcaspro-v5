import { createHRError, HR_ERROR_CODES } from "../errors/hr-error-codes.js";

export interface HRIdempotencyKey {
  sourceModule: "HR" | "ACCOUNTING" | "WORKFLOW" | "NOTIFICATIONS";
  sourceType: string;
  sourceId: string | number;
  actionType: string;
  version: number;
}

export function formatHRIdempotencyKey(key: HRIdempotencyKey): string {
  const safe = (v: unknown): string => String(v ?? "").replace(/[|]/g, "_");
  return [
    safe(key.sourceModule),
    safe(key.sourceType),
    safe(key.sourceId),
    safe(key.actionType),
    safe(key.version),
  ].join("|");
}

export function parseHRIdempotencyKey(raw: string): HRIdempotencyKey {
  const parts = raw.split("|");
  if (parts.length !== 5) throw createHRError(HR_ERROR_CODES.HR_IDEMPOTENCY_CONFLICT, "Malformed idempotency key");
  const [sourceModule, sourceType, sourceId, actionType, version] = parts;
  const m = sourceModule as HRIdempotencyKey["sourceModule"];
  if (!["HR", "ACCOUNTING", "WORKFLOW", "NOTIFICATIONS"].includes(m)) {
    throw createHRError(HR_ERROR_CODES.HR_IDEMPOTENCY_CONFLICT, `Invalid source module: ${sourceModule}`);
  }
  return {
    sourceModule: m,
    sourceType,
    sourceId: /^\d+$/.test(sourceId) ? Number(sourceId) : sourceId,
    actionType,
    version: Number(version) || 1,
  };
}

export function generateHRClientRequestId(prefix = "hr"): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}

export function normalizeClientRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}
