import type { WorkflowDocumentMilestoneKey } from "./caseWorkflowDocuments";

export type WorkflowDerivedStatus =
  | "completed"
  | "incomplete"
  | "missing_date"
  | "missing_file";

export type WorkflowStepRequirement =
  | { kind: "keyDate"; keyDateField: string }
  | { kind: "dateAndWorkflowDoc"; keyDateField: string; docKey: WorkflowDocumentMilestoneKey };

export type WorkflowStepAutomationRule = {
  stepKey: string;
  requirement: WorkflowStepRequirement;
};

export const WORKFLOW_STEP_AUTOMATION_RULES: WorkflowStepAutomationRule[] = [
  { stepKey: "file_opened", requirement: { kind: "keyDate", keyDateField: "spa_signed_date" } },
  { stepKey: "spa_stamped", requirement: { kind: "dateAndWorkflowDoc", keyDateField: "spa_stamped_date", docKey: "spa_stamped" } },
  { stepKey: "lof_stamped", requirement: { kind: "dateAndWorkflowDoc", keyDateField: "letter_of_offer_stamped_date", docKey: "lo_stamped" } },
  { stepKey: "loan_docs_signed", requirement: { kind: "keyDate", keyDateField: "loan_docs_signed_date" } },
  { stepKey: "acting_letter_issued", requirement: { kind: "keyDate", keyDateField: "acting_letter_issued_date" } },
  { stepKey: "loan_sent_bank_exec", requirement: { kind: "keyDate", keyDateField: "loan_sent_bank_execution_date" } },
  { stepKey: "loan_bank_executed", requirement: { kind: "keyDate", keyDateField: "loan_bank_executed_date" } },
  { stepKey: "blu_received", requirement: { kind: "keyDate", keyDateField: "bank_lu_received_date" } },
  { stepKey: "noa_served", requirement: { kind: "keyDate", keyDateField: "noa_served_on" } },
  { stepKey: "pa_registered", requirement: { kind: "dateAndWorkflowDoc", keyDateField: "register_poa_on", docKey: "register_poa" } },
  { stepKey: "letter_disclaimer", requirement: { kind: "dateAndWorkflowDoc", keyDateField: "letter_disclaimer_dated", docKey: "letter_disclaimer" } },
];

export const WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY: Record<string, WorkflowStepRequirement> = Object.fromEntries(
  WORKFLOW_STEP_AUTOMATION_RULES.map((r) => [r.stepKey, r.requirement])
);

export type WorkflowAutomationInputs = {
  keyDates: Record<string, string | null | undefined>;
  workflowDocs: Partial<Record<WorkflowDocumentMilestoneKey, { hasFile: boolean }>>;
};

export function deriveStatusFromRequirement(
  requirement: WorkflowStepRequirement,
  inputs: WorkflowAutomationInputs
): WorkflowDerivedStatus {
  if (requirement.kind === "keyDate") {
    const ymd = inputs.keyDates[requirement.keyDateField];
    return ymd ? "completed" : "missing_date";
  }

  const ymd = inputs.keyDates[requirement.keyDateField];
  const hasFile = Boolean(inputs.workflowDocs[requirement.docKey]?.hasFile);
  if (ymd && hasFile) return "completed";
  if (!ymd && !hasFile) return "incomplete";
  if (!ymd && hasFile) return "missing_date";
  return "missing_file";
}

export function requiredKeyDateFieldForStep(stepKey: string): string | null {
  const rule = WORKFLOW_AUTOMATION_RULE_BY_STEP_KEY[stepKey];
  if (!rule) return null;
  return rule.keyDateField;
}

