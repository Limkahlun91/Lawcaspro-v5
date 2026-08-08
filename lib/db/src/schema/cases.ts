import { pgTable, serial, text, integer, numeric, timestamp, index, uniqueIndex, date, boolean, jsonb, uuid, bigserial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type CaseBorrower = {
  name: string;
  ic?: string | null;
  tin?: string | null;
  hp?: string | null;
  phone?: string | null;
  email?: string | null;
  address: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  addressLine4?: string | null;
  addressLine5?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
};

export type CasePropertyDetails = {
  propertyAddress?: string;
  titleCategory?: "Master" | "Strata" | "Individual";
  lotNo?: string;
  hakmilikNo?: string;
  bangunanNo?: string;
  tingkatNo?: string;
  petakNo?: string;
  accessoryPetakNo?: string;
  carparkNo?: string;
  carparkLevel?: string;
  landArea?: string;
  accessoryArea?: string;
  bandarMukim?: string;
  daerah?: string;
  negeri?: string;
  parcelNo?: string;
  floorNo?: string;
  propertyType?: string;
  areaSqm?: string | number;
  buildingNo?: string;
  carParkNo?: string;
  purchasePrice?: string | number;
  progressPayment?: string | number;
  devDiscount?: string | number;
  bumiDiscount?: string | number;
  approvedPurchasePrice?: string | number;
  [k: string]: unknown;
};

export type CaseLoanBorrower = {
  name: string;
  ic?: string | null;
  tin?: string | null;
  hp?: string;
  email?: string;
  address?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressLine3?: string | null;
  addressLine4?: string | null;
  addressLine5?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
};
export type CaseLoanDetails = {
  loanPartyType?: "1st Party" | "3rd Party" | "1st_party" | "3rd_party";
  borrowers?: CaseLoanBorrower[];
  endFinancierBank?: string;
  bankRef?: string;
  branchAddressLine1?: string;
  branchAddressLine2?: string;
  branchAddressLine3?: string;
  branchAddressLine4?: string;
  branchAddressLine5?: string;
  propertyFinancingSum?: string | number;
  othersSum?: string | number;
  end_financier?: string;
  endFinancier?: string;
  financier?: string;
  bank?: string;
  loanAmountNum?: string | number;
  loanAmount?: string | number;
  [k: string]: unknown;
};

export const CasePropertyDetailsSchema = z.object({
  propertyAddress: z.string().optional(),
  titleCategory: z.enum(["Master", "Strata", "Individual"]).optional(),
  lotNo: z.string().optional(),
  hakmilikNo: z.string().optional(),
  bangunanNo: z.string().optional(),
  tingkatNo: z.string().optional(),
  petakNo: z.string().optional(),
  accessoryPetakNo: z.string().optional(),
  carparkNo: z.string().optional(),
  carparkLevel: z.string().optional(),
  landArea: z.string().optional(),
  accessoryArea: z.string().optional(),
  bandarMukim: z.string().optional(),
  daerah: z.string().optional(),
  negeri: z.string().optional(),
  parcelNo: z.string().optional(),
  floorNo: z.string().optional(),
  propertyType: z.string().optional(),
  areaSqm: z.union([z.string(), z.number()]).optional(),
  buildingNo: z.string().optional(),
  carParkNo: z.string().optional(),
  purchasePrice: z.union([z.string(), z.number()]).optional(),
  progressPayment: z.union([z.string(), z.number()]).optional(),
  devDiscount: z.union([z.string(), z.number()]).optional(),
  bumiDiscount: z.union([z.string(), z.number()]).optional(),
  approvedPurchasePrice: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const CaseLoanBorrowerSchema = z.object({
  name: z.string(),
  ic: z.string().nullish(),
  tin: z.string().nullish(),
  hp: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  addressLine1: z.string().nullish(),
  addressLine2: z.string().nullish(),
  addressLine3: z.string().nullish(),
  addressLine4: z.string().nullish(),
  addressLine5: z.string().nullish(),
  postcode: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
}).passthrough();

export const CaseLoanDetailsSchema = z.object({
  loanPartyType: z.enum(["1st Party", "3rd Party", "1st_party", "3rd_party"]).optional(),
  borrowers: z.array(CaseLoanBorrowerSchema).optional(),
  endFinancierBank: z.string().optional(),
  bankRef: z.string().optional(),
  branchAddressLine1: z.string().optional(),
  branchAddressLine2: z.string().optional(),
  branchAddressLine3: z.string().optional(),
  branchAddressLine4: z.string().optional(),
  branchAddressLine5: z.string().optional(),
  propertyFinancingSum: z.union([z.string(), z.number()]).optional(),
  othersSum: z.union([z.string(), z.number()]).optional(),
  end_financier: z.string().optional(),
  endFinancier: z.string().optional(),
  financier: z.string().optional(),
  bank: z.string().optional(),
  loanAmountNum: z.union([z.string(), z.number()]).optional(),
  loanAmount: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const casesTable = pgTable("cases", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  projectId: integer("project_id"),
  developerId: integer("developer_id"),
  referenceNo: text("reference_no"),
  proposedReferenceNo: text("proposed_reference_no"),
  referenceNoChangedBy: integer("reference_no_changed_by"),
  referenceNoChangedAt: timestamp("reference_no_changed_at", { withTimezone: true }),
  referenceNoChangeReason: text("reference_no_change_reason"),
  purchaseMode: text("purchase_mode").notNull().default("cash"),
  titleType: text("title_type").notNull().default("master"),
  isEncumbered: boolean("is_encumbered").notNull().default(false),
  tenure: text("tenure").notNull().default("freehold"),
  trackingToken: uuid("tracking_token").notNull().defaultRandom(),
  spaPrice: numeric("spa_price", { precision: 15, scale: 2 }),
  apdlPrice: numeric("apdl_price", { precision: 15, scale: 2 }),
  developerDiscount: numeric("developer_discount", { precision: 15, scale: 2 }),
  bumiputraDiscount: numeric("bumiputra_discount", { precision: 15, scale: 2 }),
  amountPaid: numeric("amount_paid", { precision: 18, scale: 2 }).notNull().default("0"),
  outstandingBalance: numeric("outstanding_balance", { precision: 18, scale: 2 }).notNull().default("0"),
  status: text("status").notNull().default("File Opened / SPA Pending Signing"),
  lawyerStatus: text("lawyer_status"),
  lawyerStatusUpdatedAt: timestamp("lawyer_status_updated_at", { withTimezone: true }),
  developerStatus: text("developer_status"),
  developerStatusUpdatedAt: timestamp("developer_status_updated_at", { withTimezone: true }),
  caseType: text("case_type").notNull().default("developer_sales"),
  approvalStatus: text("approval_status").notNull().default("pending_approval"),
  submittedBy: integer("submitted_by"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvalNote: text("approval_note"),
  encumbrances: text("encumbrances"),
  actingFor: text("acting_for"),
  perfectionType: text("perfection_type"),
  parcelNo: text("parcel_no"),
  spaDetails: text("spa_details"),
  propertyDetails: jsonb("property_details").$type<CasePropertyDetails>(),
  loanDetails: jsonb("loan_details").$type<CaseLoanDetails>(),
  borrowers: jsonb("borrowers").notNull().default([]).$type<CaseBorrower[]>(),
  loanPartyType: text("loan_party_type").notNull().default("1st_party"),
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
  trackingTokenUnique: uniqueIndex("cases_tracking_token_key").on(t.trackingToken),
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
  userActiveCaseIdx: index("idx_case_assignments_user_active_case").on(t.userId, t.unassignedAt, t.caseId),
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
  stepStatusCaseIdx: index("idx_case_workflow_steps_step_status_case").on(t.stepKey, t.status, t.caseId),
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

export const caseMessagesTable = pgTable("case_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  channel: text("channel").notNull().default("client"),
  senderType: text("sender_type").notNull(),
  senderId: integer("sender_id"),
  messageText: text("message_text").notNull(),
  attachments: jsonb("attachments").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmCaseCreatedAtIdx: index("idx_case_messages_firm_case_created_at").on(t.firmId, t.caseId, t.createdAt),
  caseCreatedAtIdx: index("idx_case_messages_case_created_at").on(t.caseId, t.createdAt),
}));

export const caseMessageReadStatusTable = pgTable("case_message_read_status", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  userId: integer("user_id").notNull(),
  channel: text("channel").notNull().default("client"),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmCaseUserUnique: uniqueIndex("case_message_read_status_firm_case_user_key").on(t.firmId, t.caseId, t.userId, t.channel),
  firmUserIdx: index("idx_case_message_read_status_firm_user").on(t.firmId, t.userId),
  firmCaseIdx: index("idx_case_message_read_status_firm_case").on(t.firmId, t.caseId),
}));

export const caseKeyDatesTable = pgTable("case_key_dates", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),

  spaSignedDate: date("spa_signed_date"),
  spaForwardToDeveloperExecutionOn: date("spa_forward_to_developer_execution_on"),
  spaReceivedDevReturnSpaOn: date("spa_received_dev_return_spa_on"),
  spaDate: date("spa_date"),
  spaStampedDate: date("spa_stamped_date"),
  stampedSpaSendToDeveloperOn: date("stamped_spa_send_to_developer_on"),
  stampedSpaReceivedFromDeveloperOn: date("stamped_spa_received_from_developer_on"),
  stampedSpaSentToPurchaserOn: date("stamped_spa_sent_to_purchaser_on"),

  liDate: date("li_date"),
  liReceivedOn: date("li_received_on"),
  letterOfOfferDate: date("letter_of_offer_date"),
  letterOfOfferStampedDate: date("letter_of_offer_stamped_date"),
  suppLoDate: date("supp_lo_date"),

  loanDocsPendingDate: date("loan_docs_pending_date"),
  loanDocsSignedDate: date("loan_docs_signed_date"),
  actingLetterIssuedDate: date("acting_letter_issued_date"),
  developerConfirmationReceivedOn: date("developer_confirmation_received_on"),
  developerConfirmationDate: date("developer_confirmation_date"),
  loanSentBankExecutionDate: date("loan_sent_bank_execution_date"),
  loanBankExecutedDate: date("loan_bank_executed_date"),
  differentialSumRm: numeric("differential_sum_rm", { precision: 15, scale: 2 }),
  differentialSumSettledOn: date("differential_sum_settled_on"),
  bankLuDated: date("bank_lu_dated"),
  bankLuReceivedDate: date("bank_lu_received_date"),
  bankLuForwardToDeveloperOn: date("bank_lu_forward_to_developer_on"),
  developerLuReceivedOn: date("developer_lu_received_on"),
  developerLuDated: date("developer_lu_dated"),
  masterLuExempted: boolean("master_lu_exempted").notNull().default(false),
  encumbranceFreeExempted: boolean("encumbrance_free_exempted").notNull().default(false),
  letterDisclaimerReceivedOn: date("letter_disclaimer_received_on"),
  letterDisclaimerDated: date("letter_disclaimer_dated"),
  letterDisclaimerReferenceNos: text("letter_disclaimer_reference_nos"),
  redemptionSum: numeric("redemption_sum", { precision: 15, scale: 2 }),
  balanceSumLessLast5Rm: numeric("balance_sum_less_last_5_rm", { precision: 15, scale: 2 }),
  bankruptcySearchDated: date("bankruptcy_search_dated"),
  loanAgreementDated: date("loan_agreement_dated"),
  loanAgreementSubmittedStampingDate: date("loan_agreement_submitted_stamping_date"),
  loanAgreementStampedDate: date("loan_agreement_stamped_date"),
  receivedExecutedDocumentOn1: date("received_executed_document_on_1"),
  receivedUnexecutedDocumentOn: date("received_unexecuted_document_on"),
  resentBankExecutionDated: date("resent_bank_execution_dated"),
  receivedExecutedDocumentOn2: date("received_executed_document_on_2"),
  statutoryDeclarationDated: date("statutory_declaration_dated"),
  statutoryDeclarationStampedOn: date("statutory_declaration_stamped_on"),
  faDate: date("fa_date"),
  faAdjudicationNumber: text("fa_adjudication_number"),
  faStampOn: date("fa_stamp_on"),
  doaDate: date("doa_date"),
  doaStampOn: date("doa_stamp_on"),
  poaDate: date("poa_date"),
  poaStampOn: date("poa_stamp_on"),
  noaDated: date("noa_dated"),
  registerPaOn: date("register_pa_on"),
  paNo: text("pa_no"),
  registerPoaOn: date("register_poa_on"),
  registeredPoaRegistrationNumber: text("registered_poa_registration_number"),
  noaServedOn: date("noa_served_on"),
  adviceToBankDate: date("advice_to_bank_date"),
  bank1stReleaseOn: date("bank_1st_release_on"),
  firstReleaseAmountRm: numeric("first_release_amount_rm", { precision: 15, scale: 2 }),

  completionSlaActivatedAt: timestamp("completion_sla_activated_at", { withTimezone: true }),
  completionSlaNotified48hAt: timestamp("completion_sla_notified_48h_at", { withTimezone: true }),

  dischargeDate: date("discharge_date"),
  dischargeTitleReceivedOn: date("discharge_title_received_on"),
  requestLetterNoObjection: date("request_letter_no_objection"),
  receivedLetterNoObjectionOn: date("received_letter_no_objection_on"),
  blanketConsentTransferReq: date("blanket_consent_transfer_req"),
  blanketConsentTransferApproval: date("blanket_consent_transfer_approval"),
  consentToChargeReq: date("consent_to_charge_req"),
  consentToChargeApproval: date("consent_to_charge_approval"),
  consentToTransferDate: date("consent_to_transfer_date"),
  consentToChargeDate: date("consent_to_charge_date"),
  caveatLodgedDate: date("caveat_lodged_date"),
  firstAdviceDate: date("first_advice_date"),
  devInformedRedemptionDate: date("dev_informed_redemption_date"),
  requestDischargeDate: date("request_discharge_date"),
  chargeDate: date("charge_date"),
  chargeSubmitStamping: date("charge_submit_stamping"),
  chargeStamped: date("charge_stamped"),
  presentationDate: date("presentation_date"),
  secondAdviceDate: date("second_advice_date"),

  motReceivedDate: date("mot_received_date"),
  motSignedDate: date("mot_signed_date"),
  motSubmitStamping: date("mot_submit_stamping"),
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

export const caseListSavedViewsTable = pgTable("case_list_saved_views", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  userId: integer("user_id").notNull(),
  routeKey: text("route_key").notNull().default("cases"),
  name: text("name").notNull(),
  params: jsonb("params").notNull().default({}),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmUserIdx: index("idx_case_list_saved_views_firm_user").on(t.firmId, t.userId),
  uniqueIdx: uniqueIndex("idx_case_list_saved_views_unique").on(t.firmId, t.userId, t.routeKey, t.name),
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

export const caseNotificationsTable = pgTable("case_notifications", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  recipientUserId: integer("recipient_user_id").notNull(),
  actorUserId: integer("actor_user_id"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => ({
  firmRecipientCreatedAtIdx: index("idx_case_notifications_firm_recipient_created_at").on(t.firmId, t.recipientUserId, t.createdAt),
  firmRecipientUnreadIdx: index("idx_case_notifications_firm_recipient_unread").on(t.firmId, t.recipientUserId, t.isRead, t.createdAt),
  firmRecipientTypeUnreadIdx: index("idx_case_notifications_firm_recipient_type_unread").on(t.firmId, t.recipientUserId, t.type, t.isRead),
  firmCaseIdx: index("idx_case_notifications_firm_case").on(t.firmId, t.caseId),
}));

export const caseReferenceHistoryTable = pgTable("case_reference_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  previousReferenceNo: text("previous_reference_no"),
  newReferenceNo: text("new_reference_no").notNull(),
  changeType: text("change_type").notNull(),
  actorUserId: integer("actor_user_id"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  reason: text("reason"),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  idempotencyKey: text("idempotency_key").unique(),
}, (t) => ({
  caseCreatedIdx: index("idx_case_reference_history_case_created").on(t.caseId, t.createdAt),
  firmIdx: index("idx_case_reference_history_firm").on(t.firmId),
  actorIdx: index("idx_case_reference_history_actor").on(t.actorUserId),
}));

export type CaseReferenceHistoryChangeType =
  | "PROPOSED_TO_FINAL"
  | "MANUAL_CHANGE"
  | "REAPPROVAL_CHANGE"
  | "SYSTEM_ASSIGNMENT"
  | "BACKFILLED_FROM_CASE_SNAPSHOT";

export type CaseReferenceHistorySource =
  | "APPROVAL"
  | "CASE_EDIT"
  | "SYSTEM"
  | "BACKFILL";

export const insertCaseSchema = createInsertSchema(casesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCase = z.infer<typeof insertCaseSchema>;
export type Case = typeof casesTable.$inferSelect;
