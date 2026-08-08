import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, boolean, jsonb, date } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Approval Process Definitions
// ---------------------------------------------------------------------------
export const hrApprovalProcessDefinitionsTable = pgTable(
  "hr_approval_process_definitions",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    processCode: text("process_code").notNull(),
    processName: text("process_name").notNull(),
    processModule: text("process_module").notNull(),
    processVersion: integer("process_version").notNull().default(1),
    approvalMode: text("approval_mode").notNull().default("sequential"),
    stepsConfig: jsonb("steps_config").$type<Record<string, unknown>[]>().notNull().default([]),
    defaultFinalApproverUserId: integer("default_final_approver_user_id"),
    allowDelegation: boolean("allow_delegation").notNull().default(true),
    allowReassignment: boolean("allow_reassignment").notNull().default(true),
    allowWithdrawal: boolean("allow_withdrawal").notNull().default(true),
    allowResubmission: boolean("allow_resubmission").notNull().default(true),
    maxResubmissions: integer("max_resubmissions").notNull().default(5),
    overdueAfterHours: integer("overdue_after_hours"),
    escalationAfterHours: integer("escalation_after_hours"),
    reminderFrequencyHours: integer("reminder_frequency_hours"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmCodeVersionUq: uniqueIndex("uq_hr_approval_proc_firm_code_version").on(t.firmId, t.processCode, t.processVersion),
    firmActiveIdx: index("idx_hr_approval_proc_active").on(t.firmId, t.processModule, t.isActive),
  }),
);

export const insertHrApprovalProcessDefinitionSchema = createInsertSchema(hrApprovalProcessDefinitionsTable);
export const selectHrApprovalProcessDefinitionSchema = createSelectSchema(hrApprovalProcessDefinitionsTable);
export type HrApprovalProcessDefinition = z.infer<typeof selectHrApprovalProcessDefinitionSchema>;
export type InsertHrApprovalProcessDefinition = z.infer<typeof insertHrApprovalProcessDefinitionSchema>;

// ---------------------------------------------------------------------------
// Approval Requests
// ---------------------------------------------------------------------------
export const hrApprovalRequestsTable = pgTable(
  "hr_approval_requests",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    requestNo: text("request_no").notNull(),
    processDefinitionId: integer("process_definition_id").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    submissionPayload: jsonb("submission_payload").$type<Record<string, unknown>>().notNull().default({}),
    overallStatus: text("overall_status").notNull().default("draft"),
    submittedByUserId: integer("submitted_by_user_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    currentStepNumber: integer("current_step_number").notNull().default(1),
    totalSteps: integer("total_steps").notNull().default(1),
    withdrawnByUserId: integer("withdrawn_by_user_id"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    finalDecision: text("final_decision"),
    finalDecidedByUserId: integer("final_decided_by_user_id"),
    finalDecidedAt: timestamp("final_decided_at", { withTimezone: true }),
    clientRequestId: text("client_request_id"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    escalationLevel: integer("escalation_level").notNull().default(0),
    lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),
    lastEscalatedAt: timestamp("last_escalated_at", { withTimezone: true }),
    resubmissionCount: integer("resubmission_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmRequestNoUq: uniqueIndex("uq_hr_approval_requests_firm_no").on(t.firmId, t.requestNo),
    firmAggregateUq: uniqueIndex("uq_hr_approval_requests_aggregate").on(t.firmId, t.aggregateType, t.aggregateId),
    firmStatusIdx: index("idx_hr_approval_requests_status").on(t.firmId, t.overallStatus),
    firmSubmitterIdx: index("idx_hr_approval_requests_submitter").on(t.firmId, t.submittedByUserId),
    firmProcessIdx: index("idx_hr_approval_requests_process").on(t.firmId, t.processDefinitionId),
    firmDueIdx: index("idx_hr_approval_requests_overdue").on(t.firmId, t.dueAt),
  }),
);

export const insertHrApprovalRequestSchema = createInsertSchema(hrApprovalRequestsTable);
export const selectHrApprovalRequestSchema = createSelectSchema(hrApprovalRequestsTable);
export type HrApprovalRequest = z.infer<typeof selectHrApprovalRequestSchema>;
export type InsertHrApprovalRequest = z.infer<typeof insertHrApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Approval Request Steps
// ---------------------------------------------------------------------------
export const hrApprovalRequestStepsTable = pgTable(
  "hr_approval_request_steps",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    approvalRequestId: integer("approval_request_id").notNull(),
    stepNumber: integer("step_number").notNull(),
    stepLabel: text("step_label"),
    stepMode: text("step_mode").notNull().default("any_one"),
    requiredApproverCount: integer("required_approver_count").notNull().default(1),
    approverRoleRequirements: jsonb("approver_role_requirements").$type<Record<string, unknown>[]>().default([]),
    status: text("status").notNull().default("pending"),
    assignedApproverUserIds: jsonb("assigned_approver_user_ids").$type<number[]>().notNull().default([]),
    respondedApproverUserIds: jsonb("responded_approver_user_ids").$type<number[]>().notNull().default([]),
    delegatedApproverUserIds: jsonb("delegated_approver_user_ids").$type<number[]>().notNull().default([]),
    delegatedFromUserId: integer("delegated_from_user_id"),
    delegationUsedId: integer("delegation_used_id"),
    reassignedFromUserId: integer("reassigned_from_user_id"),
    reassignedByUserId: integer("reassigned_by_user_id"),
    reassignedAt: timestamp("reassigned_at", { withTimezone: true }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    decision: text("decision"),
    decisionNote: text("decision_note"),
    decisionActorUserId: integer("decision_actor_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmRequestStepUq: uniqueIndex("uq_hr_approval_steps_req_step").on(t.firmId, t.approvalRequestId, t.stepNumber),
    firmStatusIdx: index("idx_hr_approval_steps_status").on(t.firmId, t.status),
  }),
);

export const insertHrApprovalRequestStepSchema = createInsertSchema(hrApprovalRequestStepsTable);
export const selectHrApprovalRequestStepSchema = createSelectSchema(hrApprovalRequestStepsTable);
export type HrApprovalRequestStep = z.infer<typeof selectHrApprovalRequestStepSchema>;
export type InsertHrApprovalRequestStep = z.infer<typeof insertHrApprovalRequestStepSchema>;

// ---------------------------------------------------------------------------
// Approval Delegations
// ---------------------------------------------------------------------------
export const hrApprovalDelegationsTable = pgTable(
  "hr_approval_delegations",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    delegatorUserId: integer("delegator_user_id").notNull(),
    delegateUserId: integer("delegate_user_id").notNull(),
    scopeModule: text("scope_module"),
    scopeProcessCode: text("scope_process_code"),
    scopeScope: text("scope_scope").notNull().default("all_hr_approvals"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    reason: text("reason"),
    delegationStatus: text("delegation_status").notNull().default("active"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    revokedByUserId: integer("revoked_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmDelegatorIdx: index("idx_hr_approval_delegator").on(t.firmId, t.delegatorUserId, t.validFrom),
    firmDelegateIdx: index("idx_hr_approval_delegate").on(t.firmId, t.delegateUserId, t.validFrom),
    firmStatusIdx: index("idx_hr_approval_delegation_status").on(t.firmId, t.delegationStatus),
  }),
);

export const insertHrApprovalDelegationSchema = createInsertSchema(hrApprovalDelegationsTable);
export const selectHrApprovalDelegationSchema = createSelectSchema(hrApprovalDelegationsTable);
export type HrApprovalDelegation = z.infer<typeof selectHrApprovalDelegationSchema>;
export type InsertHrApprovalDelegation = z.infer<typeof insertHrApprovalDelegationSchema>;

// ---------------------------------------------------------------------------
// Approval Action Logs (immutable audit)
// ---------------------------------------------------------------------------
export const hrApprovalActionLogsTable = pgTable(
  "hr_approval_action_logs",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    approvalRequestId: integer("approval_request_id"),
    approvalStepId: integer("approval_step_id"),
    actorUserId: integer("actor_user_id"),
    actingForUserId: integer("acting_for_user_id"),
    delegationUsedId: integer("delegation_used_id"),
    actionType: text("action_type").notNull(),
    actionNote: text("action_note"),
    actionPayload: jsonb("action_payload").$type<Record<string, unknown>>().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmRequestIdx: index("idx_hr_approval_action_req").on(t.firmId, t.approvalRequestId),
    firmActorIdx: index("idx_hr_approval_action_actor").on(t.firmId, t.actorUserId),
  }),
);

export const insertHrApprovalActionLogSchema = createInsertSchema(hrApprovalActionLogsTable);
export const selectHrApprovalActionLogSchema = createSelectSchema(hrApprovalActionLogsTable);
export type HrApprovalActionLog = z.infer<typeof selectHrApprovalActionLogSchema>;
export type InsertHrApprovalActionLog = z.infer<typeof insertHrApprovalActionLogSchema>;
