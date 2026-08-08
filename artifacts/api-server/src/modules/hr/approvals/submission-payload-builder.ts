import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import { logger } from "../../../lib/logger.js";

export const ALLOWED_SUBMISSION_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "title",
  "summary",
  "aggregateId",
  "aggregateType",
  "linkRef",
  "note",
  "approverNotes",
  "approvalReason",
  "amount",
  "currency",
  "claimType",
  "claimReason",
  "leaveType",
  "leaveStartDate",
  "leaveEndDate",
  "leaveDays",
  "attachmentRefs",
  "tags",
  "clientRequestId",
  "customFields",
  "escalationLevel",
  "requiresFinalApprover",
]);

const FORBIDDEN_HARD_REJECT_KEYS: readonly RegExp[] = Object.freeze([
  /(^|[_-])nric([_-]|$)/i,
  /(^|[_-])(ic_passport_no|ic_passport_number|ic_number|passport_no|passport_number|ic)([_-]|$)/i,
  /(^|[_-])(passport|passport_id|passportno|passportnumber)([_-]|$)/i,
  /(^|[_-])(bank_account|bank_account_number|bank_account_no|bank_account_id|bank_acct|bankacct|bankaccount)([_-]|$)/i,
  /(^|[_-])(account_number|account_no|accountnumber)([_-]|$)/i,
  /(^|[_-])(salary|salary_amount|salary_figures|salary_value|salary_history|salary_record|salaryamount|salaryfigures)([_-]|$)/i,
  /(^|[_-])(pay_amount|pay_grade|pay_rate|payamount|paygrade|payrate)([_-]|$)/i,
  /(^|[_-])(home_address|personal_address|homeaddress|personaladdress)([_-]|$)/i,
]);

export type AuditKeyLogLevel = "warn" | "info";

export interface PayloadBuilderResult {
  payload: Record<string, unknown>;
  droppedKeys: string[];
  rejectedKeys: string[];
  malformedLogged: boolean;
}

function logMalformedKey(
  key: string,
  context: { firmId?: number; actorUserId?: number; aggregateId?: string; aggregateType?: string },
  level: AuditKeyLogLevel = "warn",
) {
  logger[level]({ key, context }, "[hrApprovalPayloadBuilder] malformed/unknown key in approval submission_payload");
}

function isForbiddenHardKey(key: string): boolean {
  return FORBIDDEN_HARD_REJECT_KEYS.some((re) => re.test(key));
}

export function buildSubmissionPayload(
  raw: Record<string, unknown>,
  allowList: readonly string[] = ALLOWED_SUBMISSION_PAYLOAD_KEYS,
  context: { firmId?: number; actorUserId?: number; aggregateId?: string; aggregateType?: string } = {},
): PayloadBuilderResult {
  if (!raw || typeof raw !== "object") {
    return { payload: {}, droppedKeys: [], rejectedKeys: [], malformedLogged: false };
  }
  const allowedLower = new Set(allowList.map((k) => k.toLowerCase()));
  const payload: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  const rejectedKeys: string[] = [];
  let malformedLogged = false;
  for (const key of Object.keys(raw)) {
    if (!key || typeof key !== "string") continue;
    if (isForbiddenHardKey(key)) {
      rejectedKeys.push(key);
      logger.error(
        { key, context, actor: context.actorUserId },
        "[hrApprovalPayloadBuilder] FORBIDDEN PII/salary/bank key present in approval payload — rejected",
      );
      continue;
    }
    if (!allowedLower.has(key.toLowerCase())) {
      droppedKeys.push(key);
      logMalformedKey(key, context, "warn");
      malformedLogged = true;
      continue;
    }
    const val = raw[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = buildSubmissionPayload(val as Record<string, unknown>, allowList, context);
      payload[key] = nested.payload;
      for (const d of nested.droppedKeys) droppedKeys.push(`${key}.${d}`);
      for (const r of nested.rejectedKeys) rejectedKeys.push(`${key}.${r}`);
      if (nested.malformedLogged) malformedLogged = true;
    } else {
      payload[key] = val;
    }
  }
  if (rejectedKeys.length > 0) {
    throw createHRError(
      HR_ERROR_CODES.HR_PERMISSION_DENIED,
      "Approval submission payload contained forbidden PII keys (NRIC/bank/salary). Submission rejected.",
      { details: { rejectedKeys } },
    );
  }
  return { payload, droppedKeys, rejectedKeys, malformedLogged };
}

export const hrApprovalSubmissionPayloadBuilder = {
  buildSubmissionPayload,
  ALLOWED_SUBMISSION_PAYLOAD_KEYS,
};

export default hrApprovalSubmissionPayloadBuilder;
