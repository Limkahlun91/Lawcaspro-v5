import { logger } from "../../../lib/logger.js";
import { writeScrubbed } from "../../hr/events/business-event-writer.js";

export interface HrAccountingPostingMarker {
  payrollRunId: string | number;
  firmId: number;
  version: number;
  actorUserId?: number;
  grossAmount?: string;
  netAmount?: string;
  periodKey: string;
}

export interface HrClaimAccountingLink {
  claimId: number | string;
  firmId: number;
  amount: string;
  payableApproved: boolean;
  claimantEmployeeId?: number | string;
  claimType?: string;
}

export interface HrOutboxEvent {
  eventType:
    | "payroll_posting_pending"
    | "HR_CLAIM_APPROVED"
    | "hr_claim_approved_for_payroll"
    | "hr_claim_approved_for_accounting"
    | string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export function buildHrAccountingPostingKey(input: HrAccountingPostingMarker): string {
  return `payroll_${input.payrollRunId}_v${input.version}`;
}

export function buildPaymentVoucherLinkageColumns(): {
  marker: "TODO_next_migration_0146_add_source_hr_claim_id";
  nextMigrationPlan: "0146_add_source_hr_claim_id_to_payment_vouchers";
  note: string;
} {
  return {
    marker: "TODO_next_migration_0146_add_source_hr_claim_id",
    nextMigrationPlan: "0146_add_source_hr_claim_id_to_payment_vouchers",
    note:
      "BIDIRECTIONAL REFERENCE MARKERS: F37 linkage column source_hr_claim_id on payment_vouchers is NOT present in current DB schema. " +
      "Service-layer linkage via outbox payload cross-reference only today. DO NOT invent DB write now. " +
      "Next migration #0146 is reserved to ADD payment_vouchers.source_hr_claim_id nullable FK + index. See also F43 (dedupe key in outbox payload only).",
  };
}

export async function emitPayrollPostingPendingOutbox(input: HrAccountingPostingMarker): Promise<{
  dedupeKey: string;
  outboxPayloadRefOnly: boolean;
}> {
  const key = buildHrAccountingPostingKey(input);
  const payload: Record<string, unknown> = {
    hr_accounting_posting_key: key,
    periodKey: input.periodKey,
    payrollRunId: String(input.payrollRunId),
    version: Number(input.version),
    note: "HR_OUTBOX event payroll_posting_pending. Payload contains reference-only markers (no inline NRIC/salary per scrubber).",
  };
  if (input.grossAmount) payload.grossAmount = input.grossAmount;
  if (input.netAmount) payload.netAmount = input.netAmount;
  await writeScrubbed({
    firmId: input.firmId,
    eventType: "payroll_posting_pending",
    aggregateType: "PAYROLL_RUN",
    aggregateId: String(input.payrollRunId),
    payload,
    actorUserId: input.actorUserId,
    idempotencySuffix: key,
  });
  logger.info(
    { firmId: input.firmId, payrollRunId: input.payrollRunId, key },
    "[hrAccountingLink] emitted payroll_posting_pending via HR outbox (reference markers only)",
  );
  return { dedupeKey: key, outboxPayloadRefOnly: true };
}

export async function emitHrClaimApproved(link: HrClaimAccountingLink): Promise<void> {
  if (!link.payableApproved) return;
  await writeScrubbed({
    firmId: link.firmId,
    eventType: "HR_CLAIM_APPROVED",
    aggregateType: "HR_CLAIM",
    aggregateId: String(link.claimId),
    payload: {
      claimId: String(link.claimId),
      amount: String(link.amount),
      claimType: link.claimType ?? "general",
      linkageColumnPlan: buildPaymentVoucherLinkageColumns(),
    },
    actorUserId: (link as any).actorUserId,
  });
  logger.info(
    { firmId: link.firmId, claimId: link.claimId },
    "[hrAccountingLink] emitted HR_CLAIM_APPROVED with linkage next-migration plan marker in payload (no inline salary/NRIC)",
  );
}

export const hrAccountingLinkageService = {
  buildHrAccountingPostingKey,
  emitPayrollPostingPendingOutbox,
  emitHrClaimApproved,
  buildPaymentVoucherLinkageColumns,
};

export default hrAccountingLinkageService;
