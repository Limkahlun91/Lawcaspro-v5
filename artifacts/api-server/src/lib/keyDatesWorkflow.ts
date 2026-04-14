export const KEY_DATE_WORKFLOW_MAPPINGS = [
  { keyDateField: "spa_signed_date", stepKey: "file_opened" },
  { keyDateField: "spa_stamped_date", stepKey: "spa_stamped" },
  { keyDateField: "letter_of_offer_stamped_date", stepKey: "lof_stamped" },
  { keyDateField: "loan_docs_pending_date", stepKey: "loan_docs_pending" },
  { keyDateField: "loan_docs_signed_date", stepKey: "loan_docs_signed" },
  { keyDateField: "acting_letter_issued_date", stepKey: "acting_letter_issued" },
  { keyDateField: "loan_sent_bank_execution_date", stepKey: "loan_sent_bank_exec" },
  { keyDateField: "loan_bank_executed_date", stepKey: "loan_bank_executed" },
  { keyDateField: "bank_lu_received_date", stepKey: "blu_received" },
  { keyDateField: "noa_served_on", stepKey: "noa_served" },
  { keyDateField: "register_poa_on", stepKey: "pa_registered" },
  { keyDateField: "letter_disclaimer_dated", stepKey: "letter_disclaimer" },
] as const;

export type KeyDateField = (typeof KEY_DATE_WORKFLOW_MAPPINGS)[number]["keyDateField"];
export type WorkflowStepKey = (typeof KEY_DATE_WORKFLOW_MAPPINGS)[number]["stepKey"];

export const KEY_DATE_FIELD_TO_STEP_KEY: Record<KeyDateField, WorkflowStepKey> = KEY_DATE_WORKFLOW_MAPPINGS.reduce(
  (acc, m) => {
    acc[m.keyDateField] = m.stepKey;
    return acc;
  },
  {} as Record<KeyDateField, WorkflowStepKey>
);

export const WORKFLOW_STEP_KEY_TO_KEY_DATE_FIELD: Partial<Record<string, KeyDateField>> = KEY_DATE_WORKFLOW_MAPPINGS.reduce(
  (acc, m) => {
    acc[m.stepKey] = m.keyDateField;
    return acc;
  },
  {} as Partial<Record<string, KeyDateField>>
);

