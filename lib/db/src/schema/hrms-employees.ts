import { pgTable, serial, text, integer, numeric, timestamp, index, uniqueIndex, date, boolean, jsonb, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Employees Core Table (non-sensitive)
// ---------------------------------------------------------------------------
export const hrEmployeesTable = pgTable(
  "hr_employees",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeNo: text("employee_no").notNull(),
    linkedUserId: integer("linked_user_id"),
    preferredName: text("preferred_name"),
    legalFullName: text("legal_full_name").notNull(),
    commonEmail: text("common_email"),
    commonMobile: text("common_mobile"),
    employmentStatus: text("employment_status").notNull().default("draft"),
    icPassportNoMasked: text("ic_passport_no_masked"),
    nationality: text("nationality"),
    gender: text("gender"),
    maritalStatus: text("marital_status"),
    dateOfBirth: date("date_of_birth"),
    address1: text("address_1"),
    address2: text("address_2"),
    city: text("city"),
    state: text("state"),
    postcode: text("postcode"),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactRelation: text("emergency_contact_relation"),
    emergencyContactPhone: text("emergency_contact_phone"),
    joinDate: date("join_date"),
    confirmationDate: date("confirmation_date"),
    noticeStartDate: date("notice_start_date"),
    terminationDate: date("termination_date"),
    lastWorkingDate: date("last_working_date"),
    rehireOriginalJoinDate: date("rehire_original_join_date"),
    branchId: integer("branch_id"),
    departmentId: integer("department_id"),
    positionId: integer("position_id"),
    workLocation: text("work_location"),
    employmentType: text("employment_type"),
    reportingManagerEmployeeId: integer("reporting_manager_employee_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    lastStatusChangeAt: timestamp("last_status_change_at", { withTimezone: true }),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmEmployeeNoUq: uniqueIndex("uq_hr_employees_firm_employee_no").on(t.firmId, t.employeeNo),
    firmUserIdUq: uniqueIndex("uq_hr_employees_firm_user_id").on(t.firmId, t.linkedUserId),
    firmStatusIdx: index("idx_hr_employees_firm_status").on(t.firmId, t.employmentStatus),
    firmDeptIdx: index("idx_hr_employees_dept").on(t.firmId, t.departmentId),
    firmPosIdx: index("idx_hr_employees_position").on(t.firmId, t.positionId),
    firmBranchIdx: index("idx_hr_employees_branch").on(t.firmId, t.branchId),
    firmManagerIdx: index("idx_hr_employees_manager").on(t.firmId, t.reportingManagerEmployeeId),
    firmJoinIdx: index("idx_hr_employees_join_date").on(t.firmId, t.joinDate),
    firmNameIdx: index("idx_hr_employees_name").on(t.firmId, t.legalFullName),
    firmCreatedIdx: index("idx_hr_employees_created").on(t.firmId, t.createdAt),
  }),
);

export const insertHrEmployeeSchema = createInsertSchema(hrEmployeesTable);
export const selectHrEmployeeSchema = createSelectSchema(hrEmployeesTable);
export type HrEmployee = z.infer<typeof selectHrEmployeeSchema>;
export type InsertHrEmployee = z.infer<typeof insertHrEmployeeSchema>;

// ---------------------------------------------------------------------------
// Employee Salaries (hr_employee_salaries) — Sensitive
// ---------------------------------------------------------------------------
export const hrEmployeeSalariesTable = pgTable(
  "hr_employee_salaries",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    salaryType: text("salary_type").notNull().default("basic"),
    currency: text("currency").notNull().default("MYR"),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    payslipVisibility: text("payslip_visibility").notNull().default("visible"),
    isCurrent: boolean("is_current").notNull().default(true),
    reviewNextDate: date("review_next_date"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empUq: uniqueIndex("uq_hr_salaries_emp_type_from").on(t.firmId, t.employeeId, t.salaryType, t.effectiveFrom),
    empIdx: index("idx_hr_salaries_emp").on(t.firmId, t.employeeId),
  }),
);

export const insertHrEmployeeSalarySchema = createInsertSchema(hrEmployeeSalariesTable);
export const selectHrEmployeeSalarySchema = createSelectSchema(hrEmployeeSalariesTable);
export type HrEmployeeSalary = z.infer<typeof selectHrEmployeeSalarySchema>;
export type InsertHrEmployeeSalary = z.infer<typeof insertHrEmployeeSalarySchema>;

// ---------------------------------------------------------------------------
// Employee Bank Accounts — Sensitive
// ---------------------------------------------------------------------------
export const hrEmployeeBankAccountsTable = pgTable(
  "hr_employee_bank_accounts",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    bankName: text("bank_name").notNull(),
    bankBranch: text("bank_branch"),
    bankCode: text("bank_code"),
    swiftCode: text("swift_code"),
    accountNumber: text("account_number").notNull(),
    accountHolderName: text("account_holder_name").notNull(),
    currency: text("currency").notNull().default("MYR"),
    isPrimary: boolean("is_primary").notNull().default(true),
    isVerified: boolean("is_verified").notNull().default(false),
    verifiedByUserId: integer("verified_by_user_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    attachmentDocumentRef: text("attachment_document_ref"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empIdx: index("idx_hr_bank_emp").on(t.firmId, t.employeeId),
  }),
);

export const insertHrEmployeeBankAccountSchema = createInsertSchema(hrEmployeeBankAccountsTable);
export const selectHrEmployeeBankAccountSchema = createSelectSchema(hrEmployeeBankAccountsTable);
export type HrEmployeeBankAccount = z.infer<typeof selectHrEmployeeBankAccountSchema>;
export type InsertHrEmployeeBankAccount = z.infer<typeof insertHrEmployeeBankAccountSchema>;

// ---------------------------------------------------------------------------
// Employee Identity Records — Sensitive (NRIC / Passport)
// ---------------------------------------------------------------------------
export const hrEmployeeIdentityRecordsTable = pgTable(
  "hr_employee_identity_records",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    identityType: text("identity_type").notNull(),
    identityNumber: text("identity_number").notNull(),
    issuedCountry: text("issued_country").notNull().default("Malaysia"),
    issuedBy: text("issued_by"),
    issuedDate: date("issued_date"),
    expiryDate: date("expiry_date"),
    isVerified: boolean("is_verified").notNull().default(false),
    verifiedByUserId: integer("verified_by_user_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    fullNameOnDocument: text("full_name_on_document"),
    attachmentDocumentRef: text("attachment_document_ref"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empUq: uniqueIndex("uq_hr_identity_emp_type_no").on(t.firmId, t.employeeId, t.identityType, t.identityNumber),
    empExpiryIdx: index("idx_hr_identity_expiry").on(t.firmId, t.expiryDate),
  }),
);

export const insertHrEmployeeIdentityRecordSchema = createInsertSchema(hrEmployeeIdentityRecordsTable);
export const selectHrEmployeeIdentityRecordSchema = createSelectSchema(hrEmployeeIdentityRecordsTable);
export type HrEmployeeIdentityRecord = z.infer<typeof selectHrEmployeeIdentityRecordSchema>;
export type InsertHrEmployeeIdentityRecord = z.infer<typeof insertHrEmployeeIdentityRecordSchema>;

// ---------------------------------------------------------------------------
// Employee Medical Records — Sensitive (DENIED to Partner by default)
// ---------------------------------------------------------------------------
export const hrEmployeeMedicalRecordsTable = pgTable(
  "hr_employee_medical_records",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    recordType: text("record_type").notNull(),
    recordDate: date("record_date").notNull(),
    providerName: text("provider_name"),
    bloodGroup: text("blood_group"),
    allergies: text("allergies"),
    chronicConditions: text("chronic_conditions"),
    medication: text("medication"),
    summary: text("summary"),
    documentRef: text("document_ref"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empIdx: index("idx_hr_medical_emp").on(t.firmId, t.employeeId),
  }),
);

export const insertHrEmployeeMedicalRecordSchema = createInsertSchema(hrEmployeeMedicalRecordsTable);
export const selectHrEmployeeMedicalRecordSchema = createSelectSchema(hrEmployeeMedicalRecordsTable);
export type HrEmployeeMedicalRecord = z.infer<typeof selectHrEmployeeMedicalRecordSchema>;
export type InsertHrEmployeeMedicalRecord = z.infer<typeof insertHrEmployeeMedicalRecordSchema>;

// ---------------------------------------------------------------------------
// Employee Disciplinary Records — Sensitive (Partner default deny)
// ---------------------------------------------------------------------------
export const hrEmployeeDisciplinaryRecordsTable = pgTable(
  "hr_employee_disciplinary_records",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    caseNo: text("case_no").notNull(),
    incidentDate: date("incident_date").notNull(),
    reportDate: date("report_date").notNull(),
    severityLevel: text("severity_level").notNull(),
    caseType: text("case_type").notNull(),
    description: text("description").notNull(),
    findings: text("findings"),
    disciplinaryAction: text("disciplinary_action").notNull(),
    effectiveDate: date("effective_date"),
    endDate: date("end_date"),
    isActive: boolean("is_active").notNull().default(true),
    closedByUserId: integer("closed_by_user_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    hearingRef: text("hearing_ref"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmCaseUq: uniqueIndex("uq_hr_disciplinary_firm_case").on(t.firmId, t.caseNo),
    empIdx: index("idx_hr_disciplinary_emp").on(t.firmId, t.employeeId),
  }),
);

export const insertHrEmployeeDisciplinaryRecordSchema = createInsertSchema(hrEmployeeDisciplinaryRecordsTable);
export const selectHrEmployeeDisciplinaryRecordSchema = createSelectSchema(hrEmployeeDisciplinaryRecordsTable);
export type HrEmployeeDisciplinaryRecord = z.infer<typeof selectHrEmployeeDisciplinaryRecordSchema>;
export type InsertHrEmployeeDisciplinaryRecord = z.infer<typeof insertHrEmployeeDisciplinaryRecordSchema>;

// ---------------------------------------------------------------------------
// Employee Leave Balances — Sensitive (adjust permission only)
// ---------------------------------------------------------------------------
export const hrEmployeeLeaveBalancesTable = pgTable(
  "hr_employee_leave_balances",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    leaveTypeCode: text("leave_type_code").notNull(),
    leaveYear: integer("leave_year").notNull(),
    entitledDays: numeric("entitled_days", { precision: 10, scale: 2 }).notNull().default("0"),
    carriedForwardDays: numeric("carried_forward_days", { precision: 10, scale: 2 }).notNull().default("0"),
    adjustedDays: numeric("adjusted_days", { precision: 10, scale: 2 }).notNull().default("0"),
    takenDays: numeric("taken_days", { precision: 10, scale: 2 }).notNull().default("0"),
    pendingApprovalDays: numeric("pending_approval_days", { precision: 10, scale: 2 }).notNull().default("0"),
    balanceCarriedForwardOverride: numeric("balance_carried_forward_override", { precision: 10, scale: 2 }),
    expiryDate: date("expiry_date"),
    lastCalculationRef: text("last_calculation_ref"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    empTypeYearUq: uniqueIndex("uq_hr_leave_balance_emp_type_year").on(t.firmId, t.employeeId, t.leaveTypeCode, t.leaveYear),
  }),
);

export const insertHrEmployeeLeaveBalanceSchema = createInsertSchema(hrEmployeeLeaveBalancesTable);
export const selectHrEmployeeLeaveBalanceSchema = createSelectSchema(hrEmployeeLeaveBalancesTable);
export type HrEmployeeLeaveBalance = z.infer<typeof selectHrEmployeeLeaveBalanceSchema>;
export type InsertHrEmployeeLeaveBalance = z.infer<typeof insertHrEmployeeLeaveBalanceSchema>;

void bigint;
void jsonb;
