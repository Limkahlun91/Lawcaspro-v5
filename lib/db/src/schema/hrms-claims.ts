import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, date, boolean, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const hrClaimsTable = pgTable(
  "hr_claims",
  {
    id: serial("id").primaryKey(),
    firmId: integer("firm_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    claimTypeCode: text("claim_type_code").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull().default("0"),
    currency: text("currency").notNull().default("MYR"),
    description: text("description"),
    claimDate: date("claim_date").notNull(),
    receiptDocumentRef: text("receipt_document_ref"),
    status: text("status").notNull().default("draft"),
    idempotencyKey: text("idempotency_key"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedByUserId: integer("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    accountingCreated: boolean("accounting_created").notNull().default(false),
    accountingPayableId: integer("accounting_payable_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: integer("created_by_user_id"),
    updatedByUserId: integer("updated_by_user_id"),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    firmIdx: index("idx_hr_claims_firm").on(t.firmId),
    firmEmployeeIdx: index("idx_hr_claims_emp").on(t.firmId, t.employeeId),
    firmStatusIdx: index("idx_hr_claims_status").on(t.firmId, t.status),
    firmTypeIdx: index("idx_hr_claims_type").on(t.firmId, t.claimTypeCode),
    firmDateIdx: index("idx_hr_claims_date").on(t.firmId, t.claimDate),
    idempotencyUq: uniqueIndex("uq_hr_claims_idem").on(t.firmId, t.idempotencyKey),
    firmCreatedIdx: index("idx_hr_claims_created").on(t.firmId, t.createdAt),
  }),
);

export const insertHrClaimSchema = createInsertSchema(hrClaimsTable);
export const selectHrClaimSchema = createSelectSchema(hrClaimsTable);
export type HrClaim = z.infer<typeof selectHrClaimSchema>;
export type InsertHrClaim = z.infer<typeof insertHrClaimSchema>;

void jsonb;
