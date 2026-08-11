import { and, eq } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, jsonb, boolean, index, uniqueIndex, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  casesTable,
  caseKeyDatesTable,
  caseWorkflowStepsTable,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

const himsStatusChecksTable = pgTable("hims_status_checks", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  checkType: text("check_type").notNull().default("TRACKING_START"),
  status: text("status").notNull().default("PENDING"),
  idempotencyKey: text("idempotency_key").notNull(),
  triggerSource: text("trigger_source").notNull().default("SPA_STAMPED_DATE"),
  triggerOldValue: text("trigger_old_value"),
  triggerNewValue: text("trigger_new_value"),
  spaStampedDate: date("spa_stamped_date"),
  workflowStatusBefore: text("workflow_status_before"),
  workflowStatusAfter: text("workflow_status_after"),
  scheduledCheckAt: timestamp("scheduled_check_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  himsReferenceNo: text("hims_reference_no"),
  himsStatusResponse: jsonb("hims_status_response"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_hims_status_checks_firm").on(t.firmId),
  firmCaseIdx: index("idx_hims_status_checks_firm_case").on(t.firmId, t.caseId, t.createdAt),
  firmStatusIdx: index("idx_hims_status_checks_status").on(t.firmId, t.status, t.createdAt),
  uqIdem: uniqueIndex("uq_hims_status_checks_idempotency").on(t.firmId, t.idempotencyKey),
}));

export type HimsStatusCheck = typeof himsStatusChecksTable.$inferSelect;

export interface EvaluateCaseHimsTrackingStartInput {
  firmId: number;
  caseId: number;
  spaStampedOld: Date | string | null | undefined;
  spaStampedNew: Date | string | null | undefined;
  actorUserId?: number | null;
  scheduledCheckAt?: Date | null;
}

export interface EvaluateCaseHimsTrackingStartResult {
  triggered: boolean;
  himsCheckId: number | null;
  idempotencyKey: string;
  workflowUpdated: boolean;
  workflowOldStatus: string | null;
  workflowNewStatus: string | null;
  isDuplicate: boolean;
}

function toDateOrNull(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function toDateString(v: Date | null): string | null {
  if (!v) return null;
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, "0");
  const d = String(v.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function evaluateCaseHimsTrackingStart(
  input: EvaluateCaseHimsTrackingStartInput,
  opts: { tx?: unknown } = {},
): Promise<EvaluateCaseHimsTrackingStartResult> {
  const conn = pickDbConn(opts.tx);

  const idempotencyKey = `HIMS_TRACKER_START:${input.caseId}`;

  const oldNull = input.spaStampedOld === null || input.spaStampedOld === undefined;
  const newNotNull = input.spaStampedNew !== null && input.spaStampedNew !== undefined && String(input.spaStampedNew).trim() !== "";

  if (!(oldNull && newNotNull)) {
    return {
      triggered: false,
      himsCheckId: null,
      idempotencyKey,
      workflowUpdated: false,
      workflowOldStatus: null,
      workflowNewStatus: null,
      isDuplicate: false,
    };
  }

  const spaStampedDateObj = toDateOrNull(input.spaStampedNew);
  const spaStampedDateStr = toDateString(spaStampedDateObj);

  let existingCheck: HimsStatusCheck | null = null;
  try {
    existingCheck = (await conn
      .select()
      .from(himsStatusChecksTable as any)
      .where(and(
        eq(himsStatusChecksTable.firmId, input.firmId),
        eq(himsStatusChecksTable.idempotencyKey, idempotencyKey),
      ))
      .limit(1))?.[0] as any;
  } catch {
    existingCheck = null;
  }

  const now = new Date();
  let himsCheckId: number | null = null;
  let isDuplicate = false;

  if (existingCheck) {
    himsCheckId = Number((existingCheck as any).id);
    isDuplicate = true;
  } else {
    try {
      const rows = await conn
        .insert(himsStatusChecksTable as any)
        .values({
          firmId: input.firmId,
          caseId: input.caseId,
          checkType: "TRACKING_START",
          status: "HIMS_CHECK_PENDING",
          idempotencyKey,
          triggerSource: "SPA_STAMPED_DATE",
          triggerOldValue: null,
          triggerNewValue: spaStampedDateStr,
          spaStampedDate: spaStampedDateObj,
          workflowStatusBefore: null,
          workflowStatusAfter: "HIMS_CHECK_PENDING",
          scheduledCheckAt: input.scheduledCheckAt instanceof Date ? input.scheduledCheckAt : now,
          lastCheckedAt: null,
          himsReferenceNo: null,
          himsStatusResponse: null,
          errorCode: null,
          errorMessage: null,
          retryCount: 0,
          createdByUserId: typeof input.actorUserId === "number" ? input.actorUserId : null,
          createdAt: now,
          updatedAt: now,
        } as any)
        .returning({ id: himsStatusChecksTable.id });
      himsCheckId = rows?.[0] ? Number((rows[0] as any).id) : null;
    } catch (err: any) {
      const msg = String(err?.message ?? err?.code ?? "");
      const isUniqueViolation = /unique|uq_|23505|duplicate.*key/i.test(msg);
      if (isUniqueViolation) {
        try {
          const fallback = (await conn
            .select({ id: himsStatusChecksTable.id })
            .from(himsStatusChecksTable as any)
            .where(and(
              eq(himsStatusChecksTable.firmId, input.firmId),
              eq(himsStatusChecksTable.idempotencyKey, idempotencyKey),
            ))
            .limit(1))?.[0] as any;
          himsCheckId = fallback ? Number(fallback.id) : null;
          isDuplicate = true;
        } catch {
          throw new ApiError({
            status: 500,
            code: "HIMS_CHECK_INSERT_FAILED",
            message: "Failed to create HIMS status check after UNIQUE conflict",
            retryable: true,
          });
        }
      } else {
        throw err;
      }
    }
  }

  let workflowUpdated = false;
  let workflowOldStatus: string | null = null;
  let workflowNewStatus: string | null = null;

  try {
    const caseCols: any = { id: (casesTable as any).id, status: (casesTable as any).status };
    if ((casesTable as any).workflowStatus) {
      caseCols.workflowStatus = (casesTable as any).workflowStatus;
    }
    if ((casesTable as any).himsWorkflowStatus) {
      caseCols.himsWorkflowStatus = (casesTable as any).himsWorkflowStatus;
    }
    if ((casesTable as any).lawyerStatus) {
      caseCols.lawyerStatus = (casesTable as any).lawyerStatus;
    }

    const caseRow = (await conn
      .select(caseCols)
      .from(casesTable as any)
      .where(and(
        eq((casesTable as any).firmId, input.firmId),
        eq((casesTable as any).id, input.caseId),
      ))
      .limit(1))?.[0] as any;

    if (caseRow) {
      const targetStatus = "HIMS_CHECK_PENDING";

      const workflowColCandidates = [
        "workflowStatus",
        "himsWorkflowStatus",
        "status",
      ];

      let updateCol: string | null = null;
      for (const col of workflowColCandidates) {
        if ((casesTable as any)[col] !== undefined && typeof caseRow[col] === "string") {
          updateCol = col;
          break;
        }
      }

      if (updateCol) {
        workflowOldStatus = caseRow[updateCol] ?? null;
        if (workflowOldStatus !== targetStatus) {
          const patch: any = { updatedAt: new Date() };
          patch[updateCol] = targetStatus;
          await conn
            .update(casesTable as any)
            .set(patch)
            .where(and(
              eq((casesTable as any).firmId, input.firmId),
              eq((casesTable as any).id, input.caseId),
            ));
          workflowNewStatus = targetStatus;
          workflowUpdated = true;
        } else {
          workflowNewStatus = workflowOldStatus;
        }
      }

      if (himsCheckId != null && (workflowOldStatus || workflowNewStatus)) {
        const patch: any = { updatedAt: new Date() };
        if (workflowOldStatus) patch.workflowStatusBefore = workflowOldStatus;
        if (workflowNewStatus) patch.workflowStatusAfter = workflowNewStatus;
        try {
          await conn
            .update(himsStatusChecksTable as any)
            .set(patch)
            .where(and(
              eq(himsStatusChecksTable.firmId, input.firmId),
              eq(himsStatusChecksTable.id, himsCheckId),
            ));
        } catch {
          // non-fatal
        }
      }
    }
  } catch (err) {
    // Workflow update is best-effort; do not fail the whole trigger
  }

  return {
    triggered: true,
    himsCheckId,
    idempotencyKey,
    workflowUpdated,
    workflowOldStatus,
    workflowNewStatus,
    isDuplicate,
  };
}
