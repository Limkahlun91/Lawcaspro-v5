import { pgTable, serial, text, integer, numeric, timestamp, index, uniqueIndex, date, boolean, jsonb, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Reporting Lines (historical, supports primary + secondary reporting)
// ---------------------------------------------------------------------------
export const hrReportingLinesTable = pgTable(
  "hr_reporting_lines",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    reportingManagerEmployeeId: integer("reporting_manager_employee_id").notNull(),
    reportingType: text("reporting_type").notNull().default("primary"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isPrimary: boolean("is_primary").notNull().default(true),
    changeReason: text("change_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empIdx: index("idx_hr_reporting_emp").on(t.firmId, t.employeeId),
    mgrIdx: index("idx_hr_reporting_manager").on(t.firmId, t.reportingManagerEmployeeId),
    primaryUq: uniqueIndex("uq_hr_reporting_primary").on(t.firmId, t.employeeId, t.effectiveFrom),
  }),
);

export const insertHrReportingLineSchema = createInsertSchema(hrReportingLinesTable);
export const selectHrReportingLineSchema = createSelectSchema(hrReportingLinesTable);
export type HrReportingLine = z.infer<typeof selectHrReportingLineSchema>;
export type InsertHrReportingLine = z.infer<typeof insertHrReportingLineSchema>;

// ---------------------------------------------------------------------------
// Employment Records (job change history)
// ---------------------------------------------------------------------------
export const hrEmploymentRecordsTable = pgTable(
  "hr_employment_records",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    recordType: text("record_type").notNull(),
    recordNo: text("record_no"),
    effectiveDate: date("effective_date").notNull(),
    endDate: date("end_date"),
    oldBranchId: integer("old_branch_id"),
    oldDepartmentId: integer("old_department_id"),
    oldPositionId: integer("old_position_id"),
    oldReportingManagerEmployeeId: integer("old_reporting_manager_employee_id"),
    oldEmploymentType: text("old_employment_type"),
    oldWorkLocation: text("old_work_location"),
    newBranchId: integer("new_branch_id"),
    newDepartmentId: integer("new_department_id"),
    newPositionId: integer("new_position_id"),
    newReportingManagerEmployeeId: integer("new_reporting_manager_employee_id"),
    newEmploymentType: text("new_employment_type"),
    newWorkLocation: text("new_work_location"),
    salaryAmountOld: numeric("salary_amount_old", { precision: 19, scale: 4 }),
    salaryAmountNew: numeric("salary_amount_new", { precision: 19, scale: 4 }),
    salaryCurrency: text("salary_currency").default("MYR"),
    salaryChangeReason: text("salary_change_reason"),
    approvalStatus: text("approval_status").default("draft"),
    approvedByUserId: integer("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empIdx: index("idx_hr_emp_records_emp").on(t.firmId, t.employeeId),
    statusIdx: index("idx_hr_emp_records_status").on(t.firmId, t.approvalStatus),
  }),
);

export const insertHrEmploymentRecordSchema = createInsertSchema(hrEmploymentRecordsTable);
export const selectHrEmploymentRecordSchema = createSelectSchema(hrEmploymentRecordsTable);
export type HrEmploymentRecord = z.infer<typeof selectHrEmploymentRecordSchema>;
export type InsertHrEmploymentRecord = z.infer<typeof insertHrEmploymentRecordSchema>;

// ---------------------------------------------------------------------------
// HR Documents (metadata + storage refs)
// ---------------------------------------------------------------------------
export const hrDocumentsTable = pgTable(
  "hr_documents",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id"),
    documentType: text("document_type").notNull(),
    documentCategory: text("document_category").notNull().default("general"),
    documentName: text("document_name").notNull(),
    description: text("description"),
    storagePath: text("storage_path").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    fileName: text("file_name").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    fileContentType: text("file_content_type"),
    fileSha256: text("file_sha256"),
    isSigned: boolean("is_signed").notNull().default(false),
    signedSignatoryUserId: integer("signed_signatory_user_id"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    effectiveDate: date("effective_date"),
    expiryDate: date("expiry_date"),
    expiryNotificationSent: boolean("expiry_notification_sent").notNull().default(false),
    viewPermissionRoleCodes: jsonb("view_permission_role_codes").$type<string[]>().notNull().default([]),
    viewPermissionUserIds: jsonb("view_permission_user_ids").$type<number[]>().notNull().default([]),
    partnerViewAllowed: boolean("partner_view_allowed").notNull().default(false),
    selfViewAllowed: boolean("self_view_allowed").notNull().default(true),
    archiveStatus: text("archive_status").notNull().default("active"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: integer("archived_by_user_id"),
    uploadByUserId: integer("upload_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empIdx: index("idx_hr_documents_emp").on(t.firmId, t.employeeId),
    catIdx: index("idx_hr_documents_category").on(t.firmId, t.documentCategory),
    expiryIdx: index("idx_hr_documents_expiry").on(t.firmId, t.expiryDate),
    typeIdx: index("idx_hr_documents_type").on(t.firmId, t.documentType),
  }),
);

export const insertHrDocumentSchema = createInsertSchema(hrDocumentsTable);
export const selectHrDocumentSchema = createSelectSchema(hrDocumentsTable);
export type HrDocument = z.infer<typeof selectHrDocumentSchema>;
export type InsertHrDocument = z.infer<typeof insertHrDocumentSchema>;

// ---------------------------------------------------------------------------
// User ↔ Employee Memberships
// ---------------------------------------------------------------------------
export const hrUserEmployeeMembershipsTable = pgTable(
  "hr_user_employee_memberships",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    userId: integer("user_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    membershipType: text("membership_type").notNull().default("employee"),
    linkedByUserId: integer("linked_by_user_id"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    unlinkedByUserId: integer("unlinked_by_user_id"),
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
    linkNote: text("link_note"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmUserUq: uniqueIndex("uq_hr_membership_firm_user").on(t.firmId, t.userId),
    firmEmployeeUq: uniqueIndex("uq_hr_membership_firm_employee").on(t.firmId, t.employeeId),
    userIdIdx: index("idx_hr_membership_user").on(t.userId, t.isActive),
    statusIdx: index("idx_hr_membership_status").on(t.firmId, t.isActive),
  }),
);

export const insertHrUserEmployeeMembershipSchema = createInsertSchema(hrUserEmployeeMembershipsTable);
export const selectHrUserEmployeeMembershipSchema = createSelectSchema(hrUserEmployeeMembershipsTable);
export type HrUserEmployeeMembership = z.infer<typeof selectHrUserEmployeeMembershipSchema>;
export type InsertHrUserEmployeeMembership = z.infer<typeof insertHrUserEmployeeMembershipSchema>;

// ---------------------------------------------------------------------------
// Firm-level HR Feature Flags
// ---------------------------------------------------------------------------
export const hrFirmFeatureFlagsTable = pgTable(
  "hr_firm_feature_flags",
  {
    firmId: integer("firm_id").primaryKey(),
    hrEnabled: boolean("hr_enabled").notNull().default(false),
    hrAttendanceEnabled: boolean("hr_attendance_enabled").notNull().default(false),
    hrPayrollEnabled: boolean("hr_payroll_enabled").notNull().default(false),
    hrRecruitmentEnabled: boolean("hr_recruitment_enabled").notNull().default(false),
    hrPerformanceEnabled: boolean("hr_performance_enabled").notNull().default(false),
    hrCaseWorkloadEnabled: boolean("hr_case_workload_enabled").notNull().default(false),
    hrClaimsEnabled: boolean("hr_claims_enabled").notNull().default(true),
    hrLeaveEnabled: boolean("hr_leave_enabled").notNull().default(true),
    hrDocumentsEnabled: boolean("hr_documents_enabled").notNull().default(true),
    hrSelfServiceEnabled: boolean("hr_self_service_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  () => ({}),
);

export const insertHrFirmFeatureFlagsSchema = createInsertSchema(hrFirmFeatureFlagsTable);
export const selectHrFirmFeatureFlagsSchema = createSelectSchema(hrFirmFeatureFlagsTable);
export type HrFirmFeatureFlags = z.infer<typeof selectHrFirmFeatureFlagsSchema>;
export type InsertHrFirmFeatureFlags = z.infer<typeof insertHrFirmFeatureFlagsSchema>;

// ---------------------------------------------------------------------------
// Employee Position Authorizations (per-emp auth scope matrix)
// ---------------------------------------------------------------------------
export const hrEmployeePositionAuthorizationsTable = pgTable(
  "hr_employee_position_authorizations",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    authorizationScope: text("authorization_scope").notNull(),
    authorizationLevel: text("authorization_level").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    grantedByUserId: integer("granted_by_user_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empIdx: index("idx_hr_pos_auth_emp").on(t.firmId, t.employeeId),
  }),
);

export const insertHrEmployeePositionAuthorizationSchema = createInsertSchema(hrEmployeePositionAuthorizationsTable);
export const selectHrEmployeePositionAuthorizationSchema = createSelectSchema(hrEmployeePositionAuthorizationsTable);
export type HrEmployeePositionAuthorization = z.infer<typeof selectHrEmployeePositionAuthorizationSchema>;
export type InsertHrEmployeePositionAuthorization = z.infer<typeof insertHrEmployeePositionAuthorizationSchema>;

void numeric;
