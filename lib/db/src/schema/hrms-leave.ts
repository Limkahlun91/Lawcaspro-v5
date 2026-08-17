import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, date, boolean, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const hrLeaveTypesTable = pgTable(
  "hr_leave_types",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    leaveTypeCode: text("leave_type_code").notNull(),
    leaveTypeName: text("leave_type_name").notNull(),
    defaultEntitledDays: numeric("default_entitled_days", { precision: 10, scale: 2 }).notNull().default("0"),
    carryForwardAllowed: boolean("carry_forward_allowed").notNull().default(false),
    maxCarryForwardDays: numeric("max_carry_forward_days", { precision: 10, scale: 2 }),
    isActive: boolean("is_active").notNull().default(true),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmCodeUq: uniqueIndex("uq_hr_leave_types_firm_code").on(t.firmId, t.leaveTypeCode),
    firmIdx: index("idx_hr_leave_types_firm").on(t.firmId),
    activeIdx: index("idx_hr_leave_types_active").on(t.firmId, t.isActive),
  }),
);

export const insertHrLeaveTypeSchema = createInsertSchema(hrLeaveTypesTable);
export const selectHrLeaveTypeSchema = createSelectSchema(hrLeaveTypesTable);
export type HrLeaveType = z.infer<typeof selectHrLeaveTypeSchema>;
export type InsertHrLeaveType = z.infer<typeof insertHrLeaveTypeSchema>;

export const hrLeaveRequestsTable = pgTable(
  "hr_leave_requests",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    leaveTypeCode: text("leave_type_code").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    days: numeric("days", { precision: 10, scale: 2 }).notNull().default("0"),
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedByUserId: integer("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    finalApproverUserId: integer("final_approver_user_id"),
    rejectionReason: text("rejection_reason"),
    balanceDeducted: boolean("balance_deducted").notNull().default(false),
    attachedDocumentRef: text("attached_document_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmIdx: index("idx_hr_leave_req_firm").on(t.firmId),
    firmEmployeeIdx: index("idx_hr_leave_req_emp").on(t.firmId, t.employeeId),
    firmStatusIdx: index("idx_hr_leave_req_status").on(t.firmId, t.status),
    firmDateRangeIdx: index("idx_hr_leave_req_dates").on(t.firmId, t.startDate, t.endDate),
    firmTypeIdx: index("idx_hr_leave_req_type").on(t.firmId, t.leaveTypeCode),
    idempotencyUq: uniqueIndex("uq_hr_leave_req_idem").on(t.firmId, t.idempotencyKey),
    firmCreatedIdx: index("idx_hr_leave_req_created").on(t.firmId, t.createdAt),
  }),
);

export const insertHrLeaveRequestSchema = createInsertSchema(hrLeaveRequestsTable);
export const selectHrLeaveRequestSchema = createSelectSchema(hrLeaveRequestsTable);
export type HrLeaveRequest = z.infer<typeof selectHrLeaveRequestSchema>;
export type InsertHrLeaveRequest = z.infer<typeof insertHrLeaveRequestSchema>;

void jsonb;
