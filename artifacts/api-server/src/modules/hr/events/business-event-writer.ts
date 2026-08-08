import { db, hrBusinessEventsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import { logger } from "../../../lib/logger.js";

export const FORBIDDEN_PII_KEYS = Object.freeze([
  "nric",
  "icPassportNo",
  "ic_passport_no",
  "icPassportNumber",
  "passportNo",
  "passport_number",
  "passportNumber",
  "bankAccount",
  "bank_account",
  "bankAccountNo",
  "bank_account_no",
  "bankAccountNumber",
  "bank_account_number",
  "accountNumber",
  "account_number",
  "salaryAmount",
  "salary_amount",
  "salaryFigures",
  "salary_figures",
  "salary",
  "homeAddress",
  "home_address",
  "address1",
  "address_1",
  "address2",
  "address_2",
  "identityNumber",
  "identity_number",
]);

type Payload = Record<string, unknown>;

function deepCloneAndScrub(obj: unknown, path = "$"): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item, idx) => deepCloneAndScrub(item, `${path}[${idx}]`));
  }
  const out: Record<string, unknown> = {};
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const lowerKey = key.toLowerCase().replace(/[_-]/g, "");
    const isForbidden = FORBIDDEN_PII_KEYS.some((fk) => {
      const canonFk = fk.toLowerCase().replace(/[_-]/g, "");
      return lowerKey === canonFk || lowerKey.includes(canonFk);
    });
    if (isForbidden) {
      logger.warn({ path: `${path}.${key}` }, "[hrBusinessEventWriter] scrubbed forbidden PII key");
      continue;
    }
    out[key] = deepCloneAndScrub(rec[key], `${path}.${key}`);
  }
  return out;
}

export function scrubPayload(payload: Payload): Payload {
  const scrubbed = deepCloneAndScrub(payload);
  if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
    return scrubbed as Payload;
  }
  return {};
}

export function buildIdempotencyKey(
  firmId: number,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  dedupeSuffix?: string,
): string {
  const parts = [String(firmId), eventType, aggregateType, aggregateId];
  if (dedupeSuffix) parts.push(dedupeSuffix);
  return parts.join("|");
}

export type SourceModule = "HR" | "ACCOUNTING" | "WORKFLOW" | "NOTIFICATIONS";

export interface WriteScrubbedParams {
  firmId: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Payload;
  actorUserId?: number;
  correlationId?: string;
  sourceModule?: SourceModule;
  version?: number;
  idempotencySuffix?: string;
}

export async function writeScrubbed(params: WriteScrubbedParams) {
  if (!params.firmId || !Number.isFinite(params.firmId)) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required for HR business event");
  }
  if (!params.eventType || !params.aggregateType || !params.aggregateId) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "eventType/aggregateType/aggregateId all required");
  }
  const safePayload = scrubPayload(params.payload ?? {});
  const idempotencyKey = buildIdempotencyKey(
    params.firmId,
    params.eventType,
    params.aggregateType,
    params.aggregateId,
    params.idempotencySuffix,
  );
  const eventId = `evt_${params.firmId}_${idempotencyKey.slice(-40)}`;
  const rows = await db
    .insert(hrBusinessEventsTable)
    .values({
      firmId: params.firmId,
      eventId,
      eventType: params.eventType,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      actorUserId: params.actorUserId ?? null,
      correlationId: params.correlationId ?? null,
      payload: safePayload,
      version: params.version ?? 1,
      sourceModule: (params.sourceModule ?? "HR") as "HR",
      status: "ready",
      idempotencyKey,
    } as any)
    .onConflictDoNothing({ target: [hrBusinessEventsTable.firmId, hrBusinessEventsTable.idempotencyKey] })
    .returning();
  if (rows && rows.length > 0) {
    return rows[0];
  }
  const fallback = await db
    .select()
    .from(hrBusinessEventsTable)
    .where(
      and(
        eq(hrBusinessEventsTable.firmId, params.firmId),
        eq(hrBusinessEventsTable.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!fallback || fallback.length === 0) {
    throw createHRError(HR_ERROR_CODES.HR_IDEMPOTENCY_CONFLICT, "Failed to write or locate HR business event row");
  }
  return fallback[0];
}

export const hrBusinessEventWriteService = {
  scrubPayload,
  writeScrubbed,
  buildIdempotencyKey,
};

export default hrBusinessEventWriteService;
