import { casesTable, caseKeyDatesTable, caseWorkflowStepsTable, sql, type SQL } from "@workspace/db";

export type MilestonePresence = "filled" | "missing";

export type CaseMilestoneKey =
  | "spa_date"
  | "spa_stamped_date"
  | "letter_of_offer_date"
  | "loan_docs_pending_date"
  | "loan_docs_signed_date"
  | "acting_letter_issued_date"
  | "developer_confirmation_received_on"
  | "loan_sent_bank_execution_date"
  | "loan_bank_executed_date"
  | "bank_lu_received_date"
  | "advice_to_bank_date"
  | "bank_lu_forward_to_developer_on"
  | "developer_lu_received_on"
  | "developer_lu_dated"
  | "register_poa_on"
  | "letter_disclaimer_dated"
  | "mot_received_date"
  | "mot_signed_date"
  | "mot_stamped_date"
  | "mot_registered_date"
  | "noa_served_on"
  | "completion_date";

export function spaStatusSql(): SQL<string> {
  return sql<string>`COALESCE((
    SELECT ${caseWorkflowStepsTable.stepName}
    FROM ${caseWorkflowStepsTable}
    WHERE ${caseWorkflowStepsTable.caseId} = ${casesTable.id}
      AND ${caseWorkflowStepsTable.pathType} = 'common'
      AND ${caseWorkflowStepsTable.status} = 'completed'
    ORDER BY ${caseWorkflowStepsTable.stepOrder} DESC
    LIMIT 1
  ), 'Pending')`;
}

export function loanStatusSql(): SQL<string | null> {
  return sql<string | null>`CASE
    WHEN ${casesTable.purchaseMode} = 'loan' THEN COALESCE((
      SELECT ${caseWorkflowStepsTable.stepName}
      FROM ${caseWorkflowStepsTable}
      WHERE ${caseWorkflowStepsTable.caseId} = ${casesTable.id}
        AND ${caseWorkflowStepsTable.pathType} = 'loan'
        AND ${caseWorkflowStepsTable.status} = 'completed'
      ORDER BY ${caseWorkflowStepsTable.stepOrder} DESC
      LIMIT 1
    ), 'Pending')
    ELSE NULL
  END`;
}

function workflowCompletedDateSql(stepKey: string): SQL<Date | null> {
  return sql<Date | null>`(
    SELECT (${caseWorkflowStepsTable.completedAt}::date)
    FROM ${caseWorkflowStepsTable}
    WHERE ${caseWorkflowStepsTable.caseId} = ${casesTable.id}
      AND ${caseWorkflowStepsTable.stepKey} = ${stepKey}
      AND ${caseWorkflowStepsTable.status} = 'completed'
    ORDER BY ${caseWorkflowStepsTable.stepOrder} DESC
    LIMIT 1
  )`;
}

export function milestoneDateSql(milestone: CaseMilestoneKey): SQL<Date | null> {
  switch (milestone) {
    case "spa_date":
      return sql<Date | null>`(${caseKeyDatesTable.spaDate})`;
    case "spa_stamped_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.spaStampedDate}, ${workflowCompletedDateSql("spa_stamped")})`;
    case "letter_of_offer_date":
      return sql<Date | null>`(${caseKeyDatesTable.letterOfOfferDate})`;
    case "loan_docs_pending_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.loanDocsPendingDate}, ${workflowCompletedDateSql("loan_docs_pending")})`;
    case "loan_docs_signed_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.loanDocsSignedDate}, ${workflowCompletedDateSql("loan_docs_signed")})`;
    case "acting_letter_issued_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.actingLetterIssuedDate}, ${workflowCompletedDateSql("acting_letter_issued")})`;
    case "developer_confirmation_received_on":
      return sql<Date | null>`(${caseKeyDatesTable.developerConfirmationReceivedOn})`;
    case "loan_sent_bank_execution_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.loanSentBankExecutionDate}, ${workflowCompletedDateSql("loan_sent_bank_exec")})`;
    case "loan_bank_executed_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.loanBankExecutedDate}, ${workflowCompletedDateSql("loan_bank_executed")})`;
    case "bank_lu_received_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.bankLuReceivedDate}, ${workflowCompletedDateSql("blu_received")})`;
    case "advice_to_bank_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.adviceToBankDate}, ${workflowCompletedDateSql("advised")})`;
    case "bank_lu_forward_to_developer_on":
      return sql<Date | null>`(${caseKeyDatesTable.bankLuForwardToDeveloperOn})`;
    case "developer_lu_received_on":
      return sql<Date | null>`(${caseKeyDatesTable.developerLuReceivedOn})`;
    case "developer_lu_dated":
      return sql<Date | null>`(${caseKeyDatesTable.developerLuDated})`;
    case "register_poa_on":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.registerPoaOn}, ${workflowCompletedDateSql("pa_registered")})`;
    case "letter_disclaimer_dated":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.letterDisclaimerDated}, ${workflowCompletedDateSql("letter_disclaimer")})`;
    case "mot_received_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.motReceivedDate}, ${workflowCompletedDateSql("mot_received")})`;
    case "mot_signed_date":
      return sql<Date | null>`(${caseKeyDatesTable.motSignedDate})`;
    case "mot_stamped_date":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.motStampedDate}, ${workflowCompletedDateSql("mot_stamp")})`;
    case "mot_registered_date":
      return sql<Date | null>`(${caseKeyDatesTable.motRegisteredDate})`;
    case "noa_served_on":
      return sql<Date | null>`COALESCE(${caseKeyDatesTable.noaServedOn}, ${workflowCompletedDateSql("noa_served")})`;
    case "completion_date":
      return sql<Date | null>`(${caseKeyDatesTable.completionDate})`;
    default:
      return sql<Date | null>`NULL`;
  }
}

export function milestoneDateYmdSql(milestone: CaseMilestoneKey): SQL<string | null> {
  const d = milestoneDateSql(milestone);
  return sql<string | null>`(${d}::text)`;
}

export function milestonePresenceWhereSql(milestone: CaseMilestoneKey, presence: MilestonePresence): SQL<unknown> {
  const expr = milestoneDateSql(milestone);
  if (presence === "filled") return sql`${expr} IS NOT NULL`;
  return sql`${expr} IS NULL`;
}
