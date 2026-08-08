import { pgTable, serial, bigserial, text, integer, numeric, timestamp, index, uniqueIndex, date, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// HR Branches
// ---------------------------------------------------------------------------
export const hrBranchesTable = pgTable(
  "hr_branches",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    branchCode: text("branch_code").notNull(),
    branchName: text("branch_name").notNull(),
    address1: text("address_1"),
    address2: text("address_2"),
    city: text("city"),
    state: text("state"),
    postcode: text("postcode"),
    country: text("country").default("Malaysia"),
    phone: text("phone"),
    email: text("email"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmActiveIdx: index("idx_hr_branches_firm_active").on(t.firmId, t.isActive),
    firmCodeUq: uniqueIndex("uq_hr_branches_firm_code").on(t.firmId, t.branchCode),
  }),
);

export const insertHrBranchSchema = createInsertSchema(hrBranchesTable);
export const selectHrBranchSchema = createSelectSchema(hrBranchesTable);
export type HrBranch = z.infer<typeof selectHrBranchSchema>;
export type InsertHrBranch = z.infer<typeof insertHrBranchSchema>;

// ---------------------------------------------------------------------------
// HR Departments
// ---------------------------------------------------------------------------
export const hrDepartmentsTable = pgTable(
  "hr_departments",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    branchId: integer("branch_id"),
    departmentCode: text("department_code").notNull(),
    departmentName: text("department_name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    headEmployeeId: integer("head_employee_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmActiveIdx: index("idx_hr_departments_firm_active").on(t.firmId, t.isActive),
    firmBranchIdx: index("idx_hr_departments_branch").on(t.firmId, t.branchId),
    firmCodeUq: uniqueIndex("uq_hr_departments_firm_code").on(t.firmId, t.departmentCode),
  }),
);

export const insertHrDepartmentSchema = createInsertSchema(hrDepartmentsTable);
export const selectHrDepartmentSchema = createSelectSchema(hrDepartmentsTable);
export type HrDepartment = z.infer<typeof selectHrDepartmentSchema>;
export type InsertHrDepartment = z.infer<typeof insertHrDepartmentSchema>;

// ---------------------------------------------------------------------------
// HR Positions
// ---------------------------------------------------------------------------
export const hrPositionsTable = pgTable(
  "hr_positions",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    departmentId: integer("department_id"),
    positionCode: text("position_code").notNull(),
    positionName: text("position_name").notNull(),
    description: text("description"),
    positionLevel: text("position_level"),
    payGrade: text("pay_grade"),
    reportsToPositionId: integer("reports_to_position_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmActiveIdx: index("idx_hr_positions_firm_active").on(t.firmId, t.isActive),
    firmDeptIdx: index("idx_hr_positions_department").on(t.firmId, t.departmentId),
    firmReportsIdx: index("idx_hr_positions_reports_to").on(t.firmId, t.reportsToPositionId),
    firmCodeUq: uniqueIndex("uq_hr_positions_firm_code").on(t.firmId, t.positionCode),
  }),
);

export const insertHrPositionSchema = createInsertSchema(hrPositionsTable);
export const selectHrPositionSchema = createSelectSchema(hrPositionsTable);
export type HrPosition = z.infer<typeof selectHrPositionSchema>;
export type InsertHrPosition = z.infer<typeof insertHrPositionSchema>;

// ---------------------------------------------------------------------------
// HR Organisation Settings (one row per firm, PK = firm_id)
// ---------------------------------------------------------------------------
export const hrOrganisationSettingsTable = pgTable(
  "hr_organisation_settings",
  {
    firmId: integer("firm_id").primaryKey(),
    defaultTimezone: text("default_timezone").notNull().default("Asia/Kuala_Lumpur"),
    defaultCurrency: text("default_currency").notNull().default("MYR"),
    weeklyOffDays: jsonb("weekly_off_days").$type<string[]>().notNull().default(["Saturday", "Sunday"]),
    publicHolidayCalendarCode: text("public_holiday_calendar_code"),
    payDateOffsetDays: integer("pay_date_offset_days").notNull().default(1),
    payrollCutoffDay: integer("payroll_cutoff_day").notNull().default(28),
    leaveBalanceResetDay: integer("leave_balance_reset_day").notNull().default(1),
    leaveBalanceResetMonth: integer("leave_balance_reset_month").notNull().default(1),
    documentStorageBucketPrefix: text("document_storage_bucket_prefix").notNull().default("hr-documents"),
    requireClaimAttachmentOverAmount: numeric("require_claim_attachment_over_amount", { precision: 19, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  () => ({}),
);

export const insertHrOrganisationSettingsSchema = createInsertSchema(hrOrganisationSettingsTable);
export const selectHrOrganisationSettingsSchema = createSelectSchema(hrOrganisationSettingsTable);
export type HrOrganisationSettings = z.infer<typeof selectHrOrganisationSettingsSchema>;
export type InsertHrOrganisationSettings = z.infer<typeof insertHrOrganisationSettingsSchema>;

// ---------------------------------------------------------------------------
// HR Business Events (Transactional Outbox — Migration 0127)
// ---------------------------------------------------------------------------
export const hrBusinessEventsTable = pgTable(
  "hr_business_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: text("event_id").notNull(),
    firmId: integer("firm_id").notNull(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: integer("actor_user_id"),
    correlationId: text("correlation_id"),
    payload: jsonb("payload").notNull().default({}),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("ready"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    failureMessage: jsonb("failure_message"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    sourceModule: text("source_module").notNull().default("HR"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyUq: uniqueIndex("uq_hr_events_idempotency_firm").on(t.firmId, t.idempotencyKey),
    pollIdx: index("idx_hr_events_poll").on(t.firmId, t.status, t.nextRetryAt, t.createdAt),
    occurredIdx: index("idx_hr_events_firm_occurred").on(t.firmId, t.occurredAt),
    aggregateIdx: index("idx_hr_events_aggregate").on(t.firmId, t.aggregateType, t.aggregateId),
  }),
);

export const insertHrBusinessEventSchema = createInsertSchema(hrBusinessEventsTable);
export const selectHrBusinessEventSchema = createSelectSchema(hrBusinessEventsTable);
export type HrBusinessEvent = z.infer<typeof selectHrBusinessEventSchema>;
export type InsertHrBusinessEvent = z.infer<typeof insertHrBusinessEventSchema>;

// ---------------------------------------------------------------------------
// firm_operating_settings — Neutral Shared Table (Migration 0135 Decision A2)
// ---------------------------------------------------------------------------
export const firmOperatingSettingsTable = pgTable(
  "firm_operating_settings",
  {
    firmId: integer("firm_id").primaryKey(),
    timezone: text("timezone").notNull().default("Asia/Kuala_Lumpur"),
    workingDays: jsonb("working_days").$type<string[]>().notNull().default(["Monday","Tuesday","Wednesday","Thursday","Friday"]),
    workingHours: jsonb("working_hours").$type<{ start: string; end: string; break_start: string; break_end: string }>()
      .notNull()
      .default({ start: "09:00", end: "18:00", break_start: "13:00", break_end: "14:00" }),
    publicHolidayRegion: text("public_holiday_region").notNull().default("Malaysia-Peninsular"),
    holidayCalendar: jsonb("holiday_calendar").$type<Array<{ date: string; name: string; type?: string }>>().notNull().default([]),
    weekendRules: jsonb("weekend_rules").$type<{ saturday_off: boolean; sunday_off: boolean; friday_off: boolean }>()
      .notNull()
      .default({ saturday_off: true, sunday_off: true, friday_off: false }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    timezoneIdx: index("idx_firm_operating_settings_timezone").on(t.timezone),
    holidayRegionIdx: index("idx_firm_operating_settings_holiday_region").on(t.publicHolidayRegion),
  }),
);

export const insertFirmOperatingSettingsSchema = createInsertSchema(firmOperatingSettingsTable);
export const selectFirmOperatingSettingsSchema = createSelectSchema(firmOperatingSettingsTable);
export type FirmOperatingSettings = z.infer<typeof selectFirmOperatingSettingsSchema>;
export type InsertFirmOperatingSettings = z.infer<typeof insertFirmOperatingSettingsSchema>;
