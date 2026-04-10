import { pgTable, serial, text, integer, numeric, timestamp, index, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const casesTable = pgTable("cases", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  projectId: integer("project_id").notNull(),
  developerId: integer("developer_id").notNull(),
  referenceNo: text("reference_no").notNull(),
  purchaseMode: text("purchase_mode").notNull().default("cash"),
  titleType: text("title_type").notNull().default("master"),
  spaPrice: numeric("spa_price", { precision: 15, scale: 2 }),
  status: text("status").notNull().default("File Opened / SPA Pending Signing"),
  caseType: text("case_type"),
  parcelNo: text("parcel_no"),
  spaDetails: text("spa_details"),
  propertyDetails: text("property_details"),
  loanDetails: text("loan_details"),
  companyDetails: text("company_details"),
  createdBy: integer("created_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdIdx: index("idx_cases_firm").on(t.firmId),
  statusIdx: index("idx_cases_status").on(t.status),
  createdAtIdx: index("idx_cases_created_at").on(t.createdAt),
  firmStatusIdx: index("idx_cases_firm_status").on(t.firmId, t.status),
}));

export const casePurchasersTable = pgTable("case_purchasers", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  clientId: integer("client_id").notNull(),
  role: text("role").notNull().default("main"),
  orderNo: integer("order_no").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseIdIdx: index("idx_case_purchasers_case").on(t.caseId),
}));

export const caseAssignmentsTable = pgTable("case_assignments", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  userId: integer("user_id").notNull(),
  roleInCase: text("role_in_case").notNull().default("lawyer"),
  assignedBy: integer("assigned_by"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
}, (t) => ({
  caseIdIdx: index("idx_case_assignments_case").on(t.caseId),
  userIdIdx: index("idx_case_assignments_user").on(t.userId),
}));

export const caseWorkflowStepsTable = pgTable("case_workflow_steps", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  stepKey: text("step_key").notNull(),
  stepName: text("step_name").notNull(),
  stepOrder: integer("step_order").notNull(),
  status: text("status").notNull().default("pending"),
  pathType: text("path_type").notNull().default("common"),
  completedBy: integer("completed_by"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  caseIdIdx: index("idx_workflow_steps_case").on(t.caseId),
  caseStatusIdx: index("idx_workflow_steps_case_status").on(t.caseId, t.status),
}));

export const caseNotesTable = pgTable("case_notes", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull(),
  authorId: integer("author_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseIdIdx: index("idx_case_notes_case").on(t.caseId),
}));

export const caseKeyDatesTable = pgTable("case_key_dates", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),

  spaSignedDate: date("spa_signed_date"),
  spaForwardToDeveloperExecutionOn: date("spa_forward_to_developer_execution_on"),
  spaDate: date("spa_date"),
  spaStampedDate: date("spa_stamped_date"),
  stampedSpaSendToDeveloperOn: date("stamped_spa_send_to_developer_on"),
  stampedSpaReceivedFromDeveloperOn: date("stamped_spa_received_from_developer_on"),

  letterOfOfferDate: date("letter_of_offer_date"),
  letterOfOfferStampedDate: date("letter_of_offer_stamped_date"),

  loanDocsPendingDate: date("loan_docs_pending_date"),
  loanDocsSignedDate: date("loan_docs_signed_date"),
  actingLetterIssuedDate: date("acting_letter_issued_date"),
  developerConfirmationReceivedOn: date("developer_confirmation_received_on"),
  developerConfirmationDate: date("developer_confirmation_date"),
  loanSentBankExecutionDate: date("loan_sent_bank_execution_date"),
  loanBankExecutedDate: date("loan_bank_executed_date"),
  bankLuReceivedDate: date("bank_lu_received_date"),
  bankLuForwardToDeveloperOn: date("bank_lu_forward_to_developer_on"),
  developerLuReceivedOn: date("developer_lu_received_on"),
  developerLuDated: date("developer_lu_dated"),
  letterDisclaimerReceivedOn: date("letter_disclaimer_received_on"),
  letterDisclaimerDated: date("letter_disclaimer_dated"),
  letterDisclaimerReferenceNos: text("letter_disclaimer_reference_nos"),
  redemptionSum: numeric("redemption_sum", { precision: 15, scale: 2 }),
  loanAgreementDated: date("loan_agreement_dated"),
  loanAgreementSubmittedStampingDate: date("loan_agreement_submitted_stamping_date"),
  loanAgreementStampedDate: date("loan_agreement_stamped_date"),
  registerPoaOn: date("register_poa_on"),
  registeredPoaRegistrationNumber: text("registered_poa_registration_number"),
  noaServedOn: date("noa_served_on"),
  adviceToBankDate: date("advice_to_bank_date"),
  bank1stReleaseOn: date("bank_1st_release_on"),
  firstReleaseAmountRm: numeric("first_release_amount_rm", { precision: 15, scale: 2 }),

  motReceivedDate: date("mot_received_date"),
  motSignedDate: date("mot_signed_date"),
  motStampedDate: date("mot_stamped_date"),
  motRegisteredDate: date("mot_registered_date"),

  progressivePaymentDate: date("progressive_payment_date"),
  fullSettlementDate: date("full_settlement_date"),
  completionDate: date("completion_date"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdIdx: index("idx_case_key_dates_firm").on(t.firmId),
  caseIdIdx: index("idx_case_key_dates_case").on(t.caseId),
  firmCaseIdx: index("idx_case_key_dates_firm_case").on(t.firmId, t.caseId),
}));

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id"),
  actorId: integer("actor_id"),
  actorType: text("actor_type").notNull().default("firm_user"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: integer("entity_id"),
  detail: text("detail"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIdIdx: index("idx_audit_firm").on(t.firmId),
  actorIdx: index("idx_audit_actor").on(t.actorId),
  entityIdx: index("idx_audit_entity").on(t.entityType, t.entityId),
  createdAtIdx: index("idx_audit_created_at").on(t.createdAt),
  actionIdx: index("idx_audit_action").on(t.action),
}));

export const insertCaseSchema = createInsertSchema(casesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCase = z.infer<typeof insertCaseSchema>;
export type Case = typeof casesTable.$inferSelect;
