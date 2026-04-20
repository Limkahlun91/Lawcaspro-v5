import { and, desc, eq, inArray } from "drizzle-orm";
import { auditLogsTable, caseKeyDatesTable, caseWorkflowDocumentsTable, caseWorkflowStepsTable, casesTable, sql, type RlsDb } from "@workspace/db";
import { buildWorkflowSteps } from "./workflow";
import { deriveStatusFromRequirement, WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY, type WorkflowDerivedStatus, type WorkflowAutomationInputs } from "./workflowAutomation";
import { normalizeWorkflowDocumentKeyFromDb, type WorkflowDocumentMilestoneKey } from "./caseWorkflowDocuments";

type Actor = {
  firmId: number;
  actorId: number | null | undefined;
  actorType: string | null | undefined;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
};

function normalizeCaseTitleType(raw: string | null | undefined): string {
  const s = (raw || "").trim().toLowerCase();
  if (s === "master title" || s === "master_title") return "master";
  if (s === "strata title" || s === "strata_title") return "strata";
  if (s === "individual title" || s === "individual_title") return "individual";
  return s || "";
}

function ymdToUtcDate(ymd: string): Date {
  const [yyyy, mm, dd] = ymd.split("-").map((x) => Number(x));
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

function toHasFileMap(rows: Array<{ milestoneKey: string; objectPath: string; fileName: string; updatedAt: Date | null }>): Partial<Record<WorkflowDocumentMilestoneKey, { hasFile: boolean }>> {
  const out: Partial<Record<WorkflowDocumentMilestoneKey, { hasFile: boolean }>> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    const normalized = normalizeWorkflowDocumentKeyFromDb(String(r.milestoneKey));
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out[normalized] = { hasFile: Boolean(r.objectPath && r.fileName) };
  }
  return out;
}

export type WorkflowStepSyncChange = {
  stepKey: string;
  fromStatus: string;
  toStatus: string;
  derivedStatus: WorkflowDerivedStatus;
};

export async function ensureCaseWorkflowSteps(r: RlsDb, firmId: number, caseId: number): Promise<void> {
  const [caseRow] = await r
    .select({ purchaseMode: casesTable.purchaseMode, titleType: casesTable.titleType })
    .from(casesTable)
    .where(and(eq(casesTable.id, caseId), eq(casesTable.firmId, firmId)));
  if (!caseRow) return;

  const purchaseMode = String(caseRow.purchaseMode || "").trim().toLowerCase();
  const titleType = normalizeCaseTitleType(caseRow.titleType);
  const defs = buildWorkflowSteps(purchaseMode, titleType);
  const existing = await r
    .select({ stepKey: caseWorkflowStepsTable.stepKey })
    .from(caseWorkflowStepsTable)
    .where(eq(caseWorkflowStepsTable.caseId, caseId));
  const existingKeys = new Set(existing.map((x) => x.stepKey));
  const missing = defs.filter((d) => !existingKeys.has(d.stepKey));
  if (missing.length === 0) return;

  await r.insert(caseWorkflowStepsTable).values(missing.map((d) => ({
    caseId,
    stepKey: d.stepKey,
    stepName: d.stepName,
    stepOrder: d.stepOrder,
    pathType: d.pathType,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  })));
}

export async function syncWorkflowStepsFromCaseState(
  r: RlsDb,
  caseId: number,
  actor: Actor
): Promise<{ changes: WorkflowStepSyncChange[] }> {
  await ensureCaseWorkflowSteps(r, actor.firmId, caseId);

  const [kd] = await r
    .select()
    .from(caseKeyDatesTable)
    .where(and(eq(caseKeyDatesTable.caseId, caseId), eq(caseKeyDatesTable.firmId, actor.firmId)));

  const docs = await r
    .select({
      milestoneKey: caseWorkflowDocumentsTable.milestoneKey,
      objectPath: caseWorkflowDocumentsTable.objectPath,
      fileName: caseWorkflowDocumentsTable.fileName,
      updatedAt: caseWorkflowDocumentsTable.updatedAt,
    })
    .from(caseWorkflowDocumentsTable)
    .where(and(
      eq(caseWorkflowDocumentsTable.firmId, actor.firmId),
      eq(caseWorkflowDocumentsTable.caseId, caseId),
      sql`${caseWorkflowDocumentsTable.deletedAt} IS NULL`,
    ))
    .orderBy(desc(caseWorkflowDocumentsTable.updatedAt));

  const inputs: WorkflowAutomationInputs = {
    keyDates: {
      spa_signed_date: kd?.spaSignedDate ? String(kd.spaSignedDate) : null,
      spa_stamped_date: kd?.spaStampedDate ? String(kd.spaStampedDate) : null,
      letter_of_offer_stamped_date: kd?.letterOfOfferStampedDate ? String(kd.letterOfOfferStampedDate) : null,
      loan_docs_signed_date: kd?.loanDocsSignedDate ? String(kd.loanDocsSignedDate) : null,
      acting_letter_issued_date: kd?.actingLetterIssuedDate ? String(kd.actingLetterIssuedDate) : null,
      loan_sent_bank_execution_date: kd?.loanSentBankExecutionDate ? String(kd.loanSentBankExecutionDate) : null,
      loan_bank_executed_date: kd?.loanBankExecutedDate ? String(kd.loanBankExecutedDate) : null,
      bank_lu_received_date: kd?.bankLuReceivedDate ? String(kd.bankLuReceivedDate) : null,
      noa_served_on: kd?.noaServedOn ? String(kd.noaServedOn) : null,
      register_poa_on: kd?.registerPoaOn ? String(kd.registerPoaOn) : null,
      letter_disclaimer_dated: kd?.letterDisclaimerDated ? String(kd.letterDisclaimerDated) : null,
    },
    workflowDocs: toHasFileMap(docs),
  };

  const steps = await r
    .select({
      id: caseWorkflowStepsTable.id,
      stepKey: caseWorkflowStepsTable.stepKey,
      status: caseWorkflowStepsTable.status,
      completedAt: caseWorkflowStepsTable.completedAt,
    })
    .from(caseWorkflowStepsTable)
    .where(eq(caseWorkflowStepsTable.caseId, caseId));

  const changes: WorkflowStepSyncChange[] = [];
  for (const s of steps) {
    const requirement = WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY[s.stepKey];
    if (!requirement) continue;
    const derived = deriveStatusFromRequirement(requirement, inputs);
    const desiredStatus = derived === "completed" ? "completed" : "pending";
    if (String(s.status) === desiredStatus) continue;

    if (desiredStatus === "completed") {
      const ymd = inputs.keyDates[requirement.keyDateField];
      const completedAt = typeof ymd === "string" ? ymdToUtcDate(ymd) : new Date();
      await r
        .update(caseWorkflowStepsTable)
        .set({
          status: "completed",
          completedBy: actor.actorId ?? null,
          completedAt: s.completedAt ?? completedAt,
          updatedAt: new Date(),
        })
        .where(and(eq(caseWorkflowStepsTable.id, s.id), eq(caseWorkflowStepsTable.caseId, caseId)));
    } else {
      await r
        .update(caseWorkflowStepsTable)
        .set({
          status: "pending",
          completedBy: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(caseWorkflowStepsTable.id, s.id), eq(caseWorkflowStepsTable.caseId, caseId)));
    }

    changes.push({
      stepKey: s.stepKey,
      fromStatus: String(s.status),
      toStatus: desiredStatus,
      derivedStatus: derived,
    });
  }

  if (changes.length) {
    const actorType = actor.actorType ? String(actor.actorType) : "firm_user";
    await r.insert(auditLogsTable).values({
      firmId: actor.firmId,
      actorId: actor.actorId ?? null,
      actorType,
      action: "workflow.auto_sync",
      entityType: "case",
      entityId: caseId,
      detail: JSON.stringify({ changes }),
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  return { changes };
}
