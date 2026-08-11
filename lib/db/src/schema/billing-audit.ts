import { pgTable, serial, text, integer, numeric, timestamp, index, jsonb, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const invoiceAuditTrailTable = pgTable("invoice_audit_trail", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  invoiceId: integer("invoice_id").notNull(),
  actionType: text("action_type").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot"),
  delta: jsonb("delta"),
  amountChange: numeric("amount_change", { precision: 18, scale: 2 }),
  statusBefore: text("status_before"),
  statusAfter: text("status_after"),
  actorUserId: integer("actor_user_id"),
  actorRole: text("actor_role"),
  reAuthVerified: boolean("reauth_verified").notNull().default(false),
  confirmationToken: text("confirmation_token"),
  clientRequestId: text("client_request_id"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  receiptId: integer("receipt_id"),
  paymentMethod: text("payment_method"),
  bankReference: text("bank_reference"),
  paidAmount: numeric("paid_amount", { precision: 18, scale: 2 }),
  paidDate: timestamp("paid_date", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIdx: index("idx_invoice_audit_firm").on(t.firmId),
  firmInvoiceIdx: index("idx_invoice_audit_firm_invoice").on(t.firmId, t.invoiceId),
  firmActionIdx: index("idx_invoice_audit_firm_action").on(t.firmId, t.actionType, t.createdAt),
  firmActorIdx: index("idx_invoice_audit_firm_actor").on(t.firmId, t.actorUserId, t.createdAt),
  clientRequestIdx: index("idx_invoice_audit_client_request").on(t.firmId, t.clientRequestId).where(sql`client_request_id IS NOT NULL`),
  createdAtIdx: index("idx_invoice_audit_created_at").on(t.createdAt),
}));

export type InvoiceAuditActionType =
  | "create"
  | "update_items"
  | "issue"
  | "mark_paid"
  | "mark_partial_paid"
  | "unmark_paid"
  | "void"
  | "soft_delete"
  | "restore"
  | "allocate_receipt"
  | "unallocate_receipt"
  | "edit_notes"
  | "change_due_date"
  | "retry_einvoice"
  | "einvoice_submit_initiated"
  | "einvoice_submit_success"
  | "einvoice_submit_failed"
  | "manual_adjustment"
  | "external_sync";
