import { writeAuditLog } from "../../lib/auth.js";

export type CaseBatchPrintAuditPayload = {
  firmId: number;
  userId: number;
  userType?: string;
  caseId: number;
  selectedDocumentIds: Array<number | string>;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string | null;
};

const CASE_BATCH_PRINT_ACTION = "case.batch_print_documents";

export async function writeCaseBatchPrintAudit(payload: CaseBatchPrintAuditPayload): Promise<void> {
  const { firmId, userId, userType = "firm_user", caseId, selectedDocumentIds, ipAddress, userAgent, requestId } = payload;
  const count = selectedDocumentIds.length;
  await writeAuditLog({
    firmId,
    actorId: userId,
    actorType: userType,
    action: CASE_BATCH_PRINT_ACTION,
    entityType: "case",
    entityId: caseId,
    detail: `CASE_BATCH_PRINT caseId=${caseId} selectedCount=${count}`,
    ipAddress,
    userAgent,
    requestId: requestId ?? null,
    actingForUserId: null,
    before: { caseId },
    after: { caseId, selectedDocumentIds, selectedCount: count },
  }, { strict: false });
}

export { CASE_BATCH_PRINT_ACTION };
