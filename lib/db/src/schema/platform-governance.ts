import { pgTable, serial, text, integer, boolean, timestamp, jsonb, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";

export const platformFounderRolesTable = pgTable("platform_founder_roles", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  level: text("level").notNull(),
  isSystem: boolean("is_system").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  codeUq: uniqueIndex("uq_platform_founder_roles_code").on(t.code),
  levelIdx: index("idx_platform_founder_roles_level").on(t.level),
}));

export const platformFounderRolePermissionsTable = pgTable("platform_founder_role_permissions", {
  id: serial("id").primaryKey(),
  roleId: uuid("role_id").notNull(),
  permissionCode: text("permission_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  roleIdx: index("idx_platform_founder_role_permissions_role").on(t.roleId),
  permIdx: index("idx_platform_founder_role_permissions_perm").on(t.permissionCode),
  uq: uniqueIndex("uq_platform_founder_role_permissions_role_perm").on(t.roleId, t.permissionCode),
}));

export const platformFounderUserRolesTable = pgTable("platform_founder_user_roles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  roleId: uuid("role_id").notNull(),
  assignedByUserId: integer("assigned_by_user_id"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("idx_platform_founder_user_roles_user").on(t.userId),
  roleIdx: index("idx_platform_founder_user_roles_role").on(t.roleId),
  uq: uniqueIndex("uq_platform_founder_user_roles_user_role").on(t.userId, t.roleId),
}));

export const platformApprovalRequestsTable = pgTable("platform_approval_requests", {
  id: uuid("id").primaryKey(),
  requestCode: text("request_code").notNull(),
  firmId: integer("firm_id").notNull(),

  actionCode: text("action_code").notNull(),
  riskLevel: text("risk_level").notNull(),
  scopeType: text("scope_type").notNull(),
  moduleCode: text("module_code"),
  targetEntityType: text("target_entity_type"),
  targetEntityId: text("target_entity_id"),
  targetLabel: text("target_label"),

  snapshotId: uuid("snapshot_id"),
  operationType: text("operation_type").notNull(),
  operationId: uuid("operation_id").notNull(),

  requestedByUserId: integer("requested_by_user_id").notNull(),
  requestedByEmail: text("requested_by_email"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  reason: text("reason").notNull(),
  detailedNote: text("detailed_note"),

  status: text("status").notNull().default("requested"),
  approvalPolicyCode: text("approval_policy_code").notNull(),
  requiredApprovals: integer("required_approvals").notNull().default(1),
  currentApprovals: integer("current_approvals").notNull().default(0),
  selfApprovalAllowed: boolean("self_approval_allowed").notNull().default(false),

  expiresAt: timestamp("expires_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),

  emergencyFlag: boolean("emergency_flag").notNull().default(false),
  impersonationFlag: boolean("impersonation_flag").notNull().default(false),
  policyResultJson: jsonb("policy_result_json"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  codeUq: uniqueIndex("uq_platform_approval_requests_code").on(t.requestCode),
  firmCreatedIdx: index("idx_platform_approval_requests_firm_created_at").on(t.firmId, t.createdAt),
  statusCreatedIdx: index("idx_platform_approval_requests_status_created_at").on(t.status, t.createdAt),
  opIdx: index("idx_platform_approval_requests_operation").on(t.operationType, t.operationId),
  actionIdx: index("idx_platform_approval_requests_action").on(t.actionCode, t.createdAt),
}));

export const platformApprovalEventsTable = pgTable("platform_approval_events", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id").notNull(),
  actorUserId: integer("actor_user_id").notNull(),
  action: text("action").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  requestIdx: index("idx_platform_approval_events_request").on(t.requestId),
  actorIdx: index("idx_platform_approval_events_actor").on(t.actorUserId, t.createdAt),
}));

export const platformStepUpChallengesTable = pgTable("platform_step_up_challenges", {
  id: uuid("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  actionCode: text("action_code").notNull(),
  riskLevel: text("risk_level").notNull(),
  scopeType: text("scope_type").notNull(),
  moduleCode: text("module_code"),
  targetEntityType: text("target_entity_type"),
  targetEntityId: text("target_entity_id"),
  issuedToUserId: integer("issued_to_user_id").notNull(),
  issuedToEmail: text("issued_to_email"),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  notBeforeAt: timestamp("not_before_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedByUserId: integer("consumed_by_user_id"),
  requiredPhrase: text("required_phrase").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIssuedIdx: index("idx_platform_step_up_challenges_firm_issued_at").on(t.firmId, t.issuedAt),
  userIssuedIdx: index("idx_platform_step_up_challenges_user_issued_at").on(t.issuedToUserId, t.issuedAt),
  expiresIdx: index("idx_platform_step_up_challenges_expires_at").on(t.expiresAt),
}));

