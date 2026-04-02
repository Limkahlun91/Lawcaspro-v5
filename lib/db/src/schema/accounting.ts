import { pgTable, serial, text, integer, numeric, boolean, date, timestamp, index } from "drizzle-orm/pg-core";

export const caseBillingEntriesTable = pgTable("case_billing_entries", {
  id:          serial("id").primaryKey(),
  caseId:      integer("case_id").notNull(),
  firmId:      integer("firm_id").notNull(),
  category:    text("category").notNull().default("disbursement"),
  description: text("description").notNull(),
  amount:      numeric("amount", { precision: 15, scale: 2 }).notNull(),
  quantity:    integer("quantity").notNull().default(1),
  isPaid:      boolean("is_paid").notNull().default(false),
  paidAt:      timestamp("paid_at", { withTimezone: true }),
  createdBy:   integer("created_by"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmCaseIdx: index("idx_billing_entries_firm_case").on(t.firmId, t.caseId),
  caseIdx:     index("idx_billing_entries_case").on(t.caseId),
}));

export const invoicesTable = pgTable("invoices", {
  id:            serial("id").primaryKey(),
  firmId:        integer("firm_id").notNull(),
  caseId:        integer("case_id"),
  quotationId:   integer("quotation_id"),
  invoiceNo:     text("invoice_no").notNull(),
  status:        text("status").notNull().default("draft"),
  subtotal:      numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0"),
  taxTotal:      numeric("tax_total", { precision: 18, scale: 2 }).notNull().default("0"),
  grandTotal:    numeric("grand_total", { precision: 18, scale: 2 }).notNull().default("0"),
  amountPaid:    numeric("amount_paid", { precision: 18, scale: 2 }).notNull().default("0"),
  amountDue:     numeric("amount_due", { precision: 18, scale: 2 }).notNull().default("0"),
  issuedDate:    date("issued_date"),
  dueDate:       date("due_date"),
  notes:         text("notes"),
  version:       integer("version").notNull().default(0),
  deletedAt:     timestamp("deleted_at", { withTimezone: true }),
  createdBy:     integer("created_by"),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmStatusIdx: index("idx_invoices_firm_status").on(t.firmId, t.status),
  dueDateIdx:    index("idx_invoices_due_date").on(t.dueDate),
  statusIdx:     index("idx_invoices_status").on(t.status),
}));

export const invoiceItemsTable = pgTable("invoice_items", {
  id:           serial("id").primaryKey(),
  invoiceId:    integer("invoice_id").notNull(),
  description:  text("description").notNull(),
  itemType:     text("item_type").notNull().default("disbursement"),
  amountExclTax: numeric("amount_excl_tax", { precision: 18, scale: 2 }).notNull().default("0"),
  taxRate:      numeric("tax_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  taxAmount:    numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  amountInclTax: numeric("amount_incl_tax", { precision: 18, scale: 2 }).notNull().default("0"),
  sortOrder:    integer("sort_order").notNull().default(0),
}, (t) => ({
  invoiceIdIdx: index("idx_invoice_items_invoice").on(t.invoiceId),
}));

export const receiptsTable = pgTable("receipts", {
  id:            serial("id").primaryKey(),
  firmId:        integer("firm_id").notNull(),
  caseId:        integer("case_id"),
  invoiceId:     integer("invoice_id"),
  receiptNo:     text("receipt_no").notNull(),
  paymentMethod: text("payment_method").notNull().default("bank_transfer"),
  bankAccountId: integer("bank_account_id"),
  accountType:   text("account_type").notNull().default("client"),
  amount:        numeric("amount", { precision: 18, scale: 2 }).notNull(),
  receivedDate:  date("received_date").notNull(),
  referenceNo:   text("reference_no"),
  notes:         text("notes"),
  isReversed:    boolean("is_reversed").notNull().default(false),
  reversedBy:    integer("reversed_by"),
  reversedAt:    timestamp("reversed_at", { withTimezone: true }),
  createdBy:     integer("created_by"),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  receivedDateIdx: index("idx_receipts_received_date").on(t.receivedDate),
  accountTypeIdx:  index("idx_receipts_account_type").on(t.firmId, t.accountType),
}));

export const receiptAllocationsTable = pgTable("receipt_allocations", {
  id:          serial("id").primaryKey(),
  receiptId:   integer("receipt_id").notNull(),
  invoiceId:   integer("invoice_id"),
  amount:      numeric("amount", { precision: 18, scale: 2 }).notNull(),
  notes:       text("notes"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  receiptIdx: index("idx_receipt_alloc_receipt").on(t.receiptId),
}));

export const paymentVouchersTable = pgTable("payment_vouchers", {
  id:                 serial("id").primaryKey(),
  firmId:             integer("firm_id").notNull(),
  caseId:             integer("case_id"),
  voucherNo:          text("voucher_no").notNull(),
  status:             text("status").notNull().default("draft"),
  payeeName:          text("payee_name").notNull(),
  payeeBank:          text("payee_bank"),
  payeeAccountNo:     text("payee_account_no"),
  paymentMethod:      text("payment_method").notNull().default("bank_transfer"),
  bankAccountId:      integer("bank_account_id"),
  accountType:        text("account_type").notNull().default("office"),
  amount:             numeric("amount", { precision: 18, scale: 2 }).notNull(),
  purpose:            text("purpose").notNull(),
  preparedBy:         integer("prepared_by"),
  preparedAt:         timestamp("prepared_at", { withTimezone: true }),
  lawyerApprovedBy:   integer("lawyer_approved_by"),
  lawyerApprovedAt:   timestamp("lawyer_approved_at", { withTimezone: true }),
  partnerApprovedBy:  integer("partner_approved_by"),
  partnerApprovedAt:  timestamp("partner_approved_at", { withTimezone: true }),
  paidAt:             timestamp("paid_at", { withTimezone: true }),
  paidBy:             integer("paid_by"),
  notes:              text("notes"),
  version:            integer("version").notNull().default(0),
  isReversed:         boolean("is_reversed").notNull().default(false),
  createdBy:          integer("created_by"),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmStatusIdx: index("idx_pvouchers_firm_status").on(t.firmId, t.status),
}));

export const paymentVoucherItemsTable = pgTable("payment_voucher_items", {
  id:          serial("id").primaryKey(),
  voucherId:   integer("voucher_id").notNull(),
  description: text("description").notNull(),
  itemType:    text("item_type").notNull().default("disbursement"),
  amount:      numeric("amount", { precision: 18, scale: 2 }).notNull(),
  sortOrder:   integer("sort_order").notNull().default(0),
}, (t) => ({
  voucherIdx: index("idx_pv_items_voucher").on(t.voucherId),
}));

export const ledgerEntriesTable = pgTable("ledger_entries", {
  id:           serial("id").primaryKey(),
  firmId:       integer("firm_id").notNull(),
  caseId:       integer("case_id"),
  entryDate:    date("entry_date").notNull(),
  entryType:    text("entry_type").notNull(),
  accountType:  text("account_type").notNull(),
  debit:        numeric("debit", { precision: 18, scale: 2 }).notNull().default("0"),
  credit:       numeric("credit", { precision: 18, scale: 2 }).notNull().default("0"),
  balanceAfter: numeric("balance_after", { precision: 18, scale: 2 }).notNull().default("0"),
  description:  text("description").notNull(),
  referenceNo:  text("reference_no"),
  sourceType:   text("source_type"),
  sourceId:     integer("source_id"),
  createdBy:    integer("created_by"),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entryDateIdx:  index("idx_ledger_entry_date").on(t.firmId, t.entryDate),
  accountTypeIdx: index("idx_ledger_account_type").on(t.firmId, t.accountType),
}));

export const creditNotesTable = pgTable("credit_notes", {
  id:           serial("id").primaryKey(),
  firmId:       integer("firm_id").notNull(),
  caseId:       integer("case_id"),
  invoiceId:    integer("invoice_id"),
  creditNoteNo: text("credit_note_no").notNull(),
  reason:       text("reason").notNull(),
  amount:       numeric("amount", { precision: 18, scale: 2 }).notNull(),
  issuedDate:   date("issued_date").notNull(),
  notes:        text("notes"),
  createdBy:    integer("created_by"),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIdx:    index("idx_credit_notes_firm").on(t.firmId),
  invoiceIdx: index("idx_credit_notes_invoice").on(t.invoiceId),
}));
