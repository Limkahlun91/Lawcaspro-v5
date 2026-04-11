import { sql, type SQL } from "drizzle-orm";
import { casesTable, caseKeyDatesTable, caseWorkflowStepsTable } from "@workspace/db";

export type MilestonePresence = "filled" | "missing";

export type CaseMilestoneKey =
  | "spa_date"
  | "spa_stamped_date"
  | "letter_of_offer_date"
  | "loan_docs_signed_date"
  | "acting_letter_issued_date"
  | "loan_sent_bank_execution_date"
  | "loan_bank_executed_date"
  | "bank_lu_received_date"
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

function workflowCompletedDateYmdSql(stepKey: string): SQL<string | null> {
  return sql<string | null>`(
    SELECT ((${caseWorkflowStepsTable.completedAt}::date)::text)
    FROM ${caseWorkflowStepsTable}
    WHERE ${caseWorkflowStepsTable.caseId} = ${casesTable.id}
      AND ${caseWorkflowStepsTable.stepKey} = ${stepKey}
      AND ${caseWorkflowStepsTable.status} = 'completed'
    ORDER BY ${caseWorkflowStepsTable.stepOrder} DESC
    LIMIT 1
  )`;
}

export function milestoneDateYmdSql(milestone: CaseMilestoneKey): SQL<string | null> {
  switch (milestone) {
    case "spa_date":
      return sql<string | null>`((${caseKeyDatesTable.spaDate})::text)`;
    case "spa_stamped_date":
      return sql<string | null>`COALESCE(((${caseKeyDatesTable.spaStampedDate})::text), ${workflowCompletedDateYmdSql("spa_stamped")})`;
    case "letter_of_offer_date":
      return sql<string | null>`((${caseKeyDatesTable.letterOfOfferDate})::text)`;
    case "loan_docs_signed_date":
      return sql<string | null>`COALESCE(((${caseKeyDatesTable.loanDocsSignedDate})::text), ${workflowCompletedDateYmdSql("loan_docs_signed")})`;
    case "acting_letter_issued_date":
      return sql<string | null>`COALESCE(((${caseKeyDatesTable.actingLetterIssuedDate})::text), ${workflowCompletedDateYmdSql("acting_letter_issued")})`;
    case "loan_sent_bank_execution_date":
      return sql<string | null>`COALESCE(((${caseKeyDatesTable.loanSentBankExecutionDate})::text), ${workflowCompletedDateYmdSql("loan_sent_bank_exec")})`;
    case "loan_bank_executed_date":
      return sql<string | null>`COALESCE(((${caseKeyDatesTable.loanBankExecutedDate})::text), ${workflowCompletedDateYmdSql("loan_bank_executed")})`;
    case "bank_lu_received_date":
      return sql<string | null>`COALESCE(((${caseKeyDatesTable.bankLuReceivedDate})::text), ${workflowCompletedDateYmdSql("blu_received")})`;
    case "noa_served_on":
      return sql<string | null>`COALESCE(((${caseKeyDatesTable.noaServedOn})::text), ${workflowCompletedDateYmdSql("noa_served")})`;
    case "completion_date":
      return sql<string | null>`((${caseKeyDatesTable.completionDate})::text)`;
    default:
      return sql<string | null>`NULL`;
  }
}

export function milestonePresenceWhereSql(milestone: CaseMilestoneKey, presence: MilestonePresence): SQL<unknown> {
  const expr = milestoneDateYmdSql(milestone);
  if (presence === "filled") return sql`${expr} IS NOT NULL`;
  return sql`${expr} IS NULL`;
}
