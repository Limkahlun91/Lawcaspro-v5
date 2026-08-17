import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, date, boolean, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const hrAttendanceRecordsTable = pgTable(
  "hr_attendance_records",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    attendanceDate: date("attendance_date").notNull(),
    shiftStart: timestamp("shift_start", { withTimezone: true }),
    shiftEnd: timestamp("shift_end", { withTimezone: true }),
    clockInAt: timestamp("clock_in_at", { withTimezone: true }),
    clockOutAt: timestamp("clock_out_at", { withTimezone: true }),
    clockInSource: text("clock_in_source"),
    clockOutSource: text("clock_out_source"),
    clockInLocationLat: numeric("clock_in_location_lat", { precision: 10, scale: 7 }),
    clockInLocationLng: numeric("clock_in_location_lng", { precision: 10, scale: 7 }),
    clockOutLocationLat: numeric("clock_out_location_lat", { precision: 10, scale: 7 }),
    clockOutLocationLng: numeric("clock_out_location_lng", { precision: 10, scale: 7 }),
    workStatus: text("work_status").notNull().default("normal"),
    source: text("source").notNull().default("manual"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmEmployeeDateUq: uniqueIndex("uq_hr_attendance_firm_emp_date").on(t.firmId, t.employeeId, t.attendanceDate),
    firmIdx: index("idx_hr_attendance_firm").on(t.firmId),
    firmDateIdx: index("idx_hr_attendance_firm_date").on(t.firmId, t.attendanceDate),
    firmEmployeeIdx: index("idx_hr_attendance_firm_emp").on(t.firmId, t.employeeId),
    firmStatusIdx: index("idx_hr_attendance_firm_status").on(t.firmId, t.workStatus),
    firmCreatedIdx: index("idx_hr_attendance_firm_created").on(t.firmId, t.createdAt),
  }),
);

export const insertHrAttendanceRecordSchema = createInsertSchema(hrAttendanceRecordsTable);
export const selectHrAttendanceRecordSchema = createSelectSchema(hrAttendanceRecordsTable);
export type HrAttendanceRecord = z.infer<typeof selectHrAttendanceRecordSchema>;
export type InsertHrAttendanceRecord = z.infer<typeof insertHrAttendanceRecordSchema>;

export const hrAttendanceCorrectionsTable = pgTable(
  "hr_attendance_corrections",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    attendanceId: integer("attendance_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    requestedClockIn: timestamp("requested_clock_in", { withTimezone: true }),
    requestedClockOut: timestamp("requested_clock_out", { withTimezone: true }),
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    reviewedByUserId: integer("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmIdx: index("idx_hr_att_corr_firm").on(t.firmId),
    firmAttendanceIdx: index("idx_hr_att_corr_attendance").on(t.firmId, t.attendanceId),
    firmEmployeeIdx: index("idx_hr_att_corr_emp").on(t.firmId, t.employeeId),
    firmStatusIdx: index("idx_hr_att_corr_status").on(t.firmId, t.status),
  }),
);

export const insertHrAttendanceCorrectionSchema = createInsertSchema(hrAttendanceCorrectionsTable);
export const selectHrAttendanceCorrectionSchema = createSelectSchema(hrAttendanceCorrectionsTable);
export type HrAttendanceCorrection = z.infer<typeof selectHrAttendanceCorrectionSchema>;
export type InsertHrAttendanceCorrection = z.infer<typeof insertHrAttendanceCorrectionSchema>;

void jsonb;
