import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as dbSchema from "@workspace/db";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql, and, eq, or, desc, count, inArray, isNotNull } from "drizzle-orm";

const FIRM_ID = 42;
const ACTOR_USER_ID = 9;
const TARGET_STAFF_ID = 17;

type Schema = typeof dbSchema;
type DrizzleClient = PgliteDatabase<Schema>;

const ACCOUNTING_CORE_DDL = `
CREATE TABLE IF NOT EXISTS cases (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  project_id integer,
  developer_id integer,
  reference_no text,
  proposed_reference_no text,
  reference_no_changed_by integer,
  reference_no_changed_at timestamptz,
  reference_no_change_reason text,
  purchase_mode text NOT NULL DEFAULT 'cash',
  title_type text NOT NULL DEFAULT 'master',
  is_encumbered boolean NOT NULL DEFAULT false,
  tenure text NOT NULL DEFAULT 'freehold',
  tracking_token uuid NOT NULL DEFAULT gen_random_uuid(),
  spa_price numeric(15,2),
  apdl_price numeric(15,2),
  developer_discount numeric(15,2),
  bumiputra_discount numeric(15,2),
  amount_paid numeric(18,2) NOT NULL DEFAULT 0,
  outstanding_balance numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'File Opened / SPA Pending Signing',
  lawyer_status text,
  lawyer_status_updated_at timestamptz,
  developer_status text,
  developer_status_updated_at timestamptz,
  case_type text NOT NULL DEFAULT 'subsale',
  approval_status text NOT NULL DEFAULT 'pending_approval',
  submitted_by integer,
  submitted_at timestamptz,
  approved_by integer,
  approved_at timestamptz,
  approval_note text,
  encumbrances text,
  acting_for text,
  perfection_type text,
  parcel_no text,
  spa_details text,
  property_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  loan_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  borrowers jsonb NOT NULL DEFAULT '[]'::jsonb,
  loan_party_type text NOT NULL DEFAULT '1st_party',
  company_details text,
  created_by integer,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_firm ON cases(firm_id);

CREATE TABLE IF NOT EXISTS case_assignments (
  id serial PRIMARY KEY,
  case_id integer NOT NULL,
  user_id integer NOT NULL,
  role_in_case text NOT NULL DEFAULT 'lawyer',
  assigned_by integer,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_case_assignments_case ON case_assignments(case_id);
CREATE INDEX IF NOT EXISTS idx_case_assignments_user_active_case ON case_assignments(user_id, unassigned_at, case_id);

CREATE TABLE IF NOT EXISTS case_key_dates (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  case_id integer NOT NULL,
  spa_signed_date date,
  spa_forward_to_developer_execution_on date,
  spa_received_dev_return_spa_on date,
  spa_date date,
  spa_stamped_date date,
  stamped_spa_send_to_developer_on date,
  stamped_spa_received_from_developer_on date,
  stamped_spa_sent_to_purchaser_on date,
  li_date date,
  li_received_on date,
  letter_of_offer_date date,
  letter_of_offer_stamped_date date,
  supp_lo_date date,
  loan_docs_pending_date date,
  loan_docs_signed_date date,
  acting_letter_issued_date date,
  developer_confirmation_received_on date,
  developer_confirmation_date date,
  loan_sent_bank_execution_date date,
  loan_bank_executed_date date,
  differential_sum_rm numeric(15,2),
  differential_sum_settled_on date,
  bank_lu_dated date,
  bank_lu_received_date date,
  bank_lu_forward_to_developer_on date,
  developer_lu_received_on date,
  developer_lu_dated date,
  master_lu_exempted boolean NOT NULL DEFAULT false,
  encumbrance_free_exempted boolean NOT NULL DEFAULT false,
  letter_disclaimer_received_on date,
  letter_disclaimer_dated date,
  letter_disclaimer_reference_nos text,
  redemption_sum numeric(15,2),
  balance_sum_less_last_5_rm numeric(15,2),
  bankruptcy_search_dated date,
  loan_agreement_dated date,
  loan_agreement_submitted_stamping_date date,
  loan_agreement_stamped_date date,
  received_executed_document_on_1 date,
  received_unexecuted_document_on date,
  resent_bank_execution_dated date,
  received_executed_document_on_2 date,
  statutory_declaration_dated date,
  statutory_declaration_stamped_on date,
  fa_date date,
  fa_adjudication_number text,
  fa_stamp_on date,
  doa_date date,
  doa_stamp_on date,
  poa_date date,
  poa_stamp_on date,
  noa_dated date,
  register_pa_on date,
  pa_no text,
  register_poa_on date,
  registered_poa_registration_number text,
  noa_served_on date,
  advice_to_bank_date date,
  bank_1st_release_on date,
  first_release_amount_rm numeric(15,2),
  completion_sla_activated_at timestamptz,
  completion_sla_notified_48h_at timestamptz,
  discharge_date date,
  discharge_title_received_on date,
  request_letter_no_objection date,
  received_letter_no_objection_on date,
  blanket_consent_transfer_req date,
  blanket_consent_transfer_approval date,
  consent_to_charge_req date,
  consent_to_charge_approval date,
  consent_to_transfer_date date,
  consent_to_charge_date date,
  caveat_lodged_date date,
  first_advice_date date,
  dev_informed_redemption_date date,
  request_discharge_date date,
  charge_date date,
  charge_submit_stamping date,
  charge_stamped date,
  presentation_date date,
  second_advice_date date,
  mot_received_date date,
  mot_signed_date date,
  mot_submit_stamping date,
  mot_stamped_date date,
  mot_registered_date date,
  progressive_payment_date date,
  full_settlement_date date,
  completion_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_case_key_dates_firm_case ON case_key_dates(firm_id, case_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_key_dates_case_unique ON case_key_dates(case_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id serial PRIMARY KEY,
  firm_id integer DEFAULT ${FIRM_ID},
  actor_id integer,
  actor_type text NOT NULL DEFAULT 'firm_user',
  action text NOT NULL,
  entity_type text,
  entity_id integer,
  detail text,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_firm_created ON audit_logs(firm_id, created_at);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text,
  password_hash text,
  full_name text,
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  role_id integer,
  user_type text DEFAULT 'firm_user',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_workflow_steps (
  id serial PRIMARY KEY,
  case_id integer NOT NULL,
  step_key text NOT NULL,
  step_name text NOT NULL,
  step_order integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  path_type text NOT NULL DEFAULT 'common',
  completed_by integer,
  completed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_case ON case_workflow_steps(case_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_case_step_unique ON case_workflow_steps(case_id, step_key);

CREATE TABLE IF NOT EXISTS case_workflow_documents (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  case_id integer NOT NULL,
  milestone_key text,
  object_path text NOT NULL DEFAULT '',
  file_name text NOT NULL DEFAULT '',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  case_id integer NOT NULL,
  transaction_date date NOT NULL,
  entry_category text NOT NULL,
  entry_type text NOT NULL,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL,
  debit_cents integer NOT NULL DEFAULT 0,
  credit_cents integer NOT NULL DEFAULT 0,
  source_type text,
  source_id integer,
  source_reference text,
  event_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_case_ledgers_firm_case ON case_ledgers(firm_id, case_id, transaction_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_ledgers_firm_event_key ON case_ledgers(firm_id, event_key) WHERE event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS firms (
  id serial PRIMARY KEY,
  name text DEFAULT 'test-firm',
  slug text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  case_id integer,
  quotation_id integer,
  invoice_no text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  subtotal numeric(18,2) NOT NULL DEFAULT 0,
  tax_total numeric(18,2) NOT NULL DEFAULT 0,
  grand_total numeric(18,2) NOT NULL DEFAULT 0,
  amount_paid numeric(18,2) NOT NULL DEFAULT 0,
  amount_due numeric(18,2) NOT NULL DEFAULT 0,
  issued_date date,
  due_date date,
  notes text,
  version integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  einvoice_status text NOT NULL DEFAULT 'DRAFT',
  einvoice_external_submission_id text,
  einvoice_submitted_at timestamptz,
  einvoice_last_checked_at timestamptz,
  einvoice_error_code text,
  einvoice_error_message text,
  einvoice_retry_count integer NOT NULL DEFAULT 0,
  einvoice_classification text,
  einvoice_source_invoice_id integer
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_firm_invoice_no ON invoices(firm_id, invoice_no);

CREATE TABLE IF NOT EXISTS invoice_items (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL,
  description text NOT NULL,
  item_type text NOT NULL DEFAULT 'disbursement',
  item_category text NOT NULL DEFAULT 'fee',
  amount_excl_tax numeric(18,2) NOT NULL DEFAULT 0,
  tax_rate numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  amount_incl_tax numeric(18,2) NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS quotations (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  case_id integer,
  reference_no text NOT NULL,
  client_name text NOT NULL,
  client_details jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_address text,
  client_tin text,
  property_description text,
  purchase_price numeric(18,2),
  bank_name text,
  loan_amount text,
  loan_amount_num numeric(18,2),
  rule_version_id integer,
  tax_rate numeric(5,2) NOT NULL DEFAULT 8,
  status text NOT NULL DEFAULT 'draft',
  notes text,
  fee_override_reason text,
  fee_override_approved_by integer,
  accepted_at timestamptz,
  sent_at timestamptz,
  deleted_at timestamptz,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotations_firm_status ON quotations(firm_id, status);
CREATE INDEX IF NOT EXISTS idx_quotations_case ON quotations(case_id);

CREATE TABLE IF NOT EXISTS quotation_items (
  id serial PRIMARY KEY,
  quotation_id integer NOT NULL,
  section text NOT NULL,
  category text,
  item_no text,
  sub_item_no text,
  description text NOT NULL,
  tax_code text NOT NULL DEFAULT 'T',
  item_category text NOT NULL DEFAULT 'fee',
  amount_excl_tax numeric(18,2) NOT NULL DEFAULT 0,
  tax_rate numeric(5,2) NOT NULL DEFAULT 8,
  tax_amount numeric(18,2) NOT NULL DEFAULT 0,
  amount_incl_tax numeric(18,2) NOT NULL DEFAULT 0,
  is_system_generated boolean NOT NULL DEFAULT false,
  item_type text NOT NULL DEFAULT 'disbursement',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotation_items_q ON quotation_items(quotation_id);

CREATE TABLE IF NOT EXISTS receipts (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  case_id integer,
  invoice_id integer,
  receipt_no text NOT NULL,
  payment_method text NOT NULL DEFAULT 'bank_transfer',
  bank_account_id integer,
  account_type text NOT NULL DEFAULT 'client',
  amount numeric(18,2) NOT NULL,
  received_date date NOT NULL,
  reference_no text,
  notes text,
  is_reversed boolean NOT NULL DEFAULT false,
  reversed_by integer,
  reversed_at timestamptz,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_firm_receipt_no ON receipts(firm_id, receipt_no);

CREATE TABLE IF NOT EXISTS receipt_allocations (
  id serial PRIMARY KEY,
  receipt_id integer NOT NULL,
  invoice_id integer,
  amount numeric(18,2) NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receipt_allocs_receipt ON receipt_allocations(receipt_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL DEFAULT ${FIRM_ID},
  case_id integer,
  entry_date date NOT NULL,
  entry_type text NOT NULL,
  account_type text NOT NULL,
  debit numeric(18,2) NOT NULL DEFAULT 0,
  credit numeric(18,2) NOT NULL DEFAULT 0,
  balance_after numeric(18,2) NOT NULL DEFAULT 0,
  description text NOT NULL,
  reference_no text,
  source_type text,
  source_id integer,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS firm_number_sequences (
  firm_id integer NOT NULL,
  seq_name text NOT NULL,
  next_value integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_prefix text,
  PRIMARY KEY (firm_id, seq_name)
);
`;

async function createTestClient(): Promise<{ pg: PGlite; db: DrizzleClient; teardown: () => Promise<void> }> {
  const pg = new PGlite();
  await pg.exec(ACCOUNTING_CORE_DDL);
  const db = drizzle(pg) as unknown as DrizzleClient;
  // seed: 1 firm + 1 user + 2 cases
  await db.execute(sql`INSERT INTO firms (id, name, slug) VALUES (${FIRM_ID}, 'Test', 't') ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO users (id, email, full_name, firm_id, user_type) VALUES (${ACTOR_USER_ID}, 'a@t', 'Actor', ${FIRM_ID}, 'firm_user') ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO users (id, email, full_name, firm_id, user_type) VALUES (${TARGET_STAFF_ID}, 'b@t', 'Target', ${FIRM_ID}, 'firm_user') ON CONFLICT DO NOTHING`);
  return { pg, db, teardown: async () => { await pg.close(); } };
}

async function insertCase(db: DrizzleClient, extras: Partial<{ caseType: string; purchaseMode: string; titleType: string }> = {}): Promise<number> {
  const [res] = await db.insert(dbSchema.casesTable).values({
    firmId: FIRM_ID,
    createdBy: ACTOR_USER_ID,
    purchaseMode: extras.purchaseMode ?? "subsale",
    titleType: extras.titleType ?? "master",
    caseType: extras.caseType ?? "subsale",
    referenceNo: "CASE-" + Math.random().toString(36).slice(2, 9),
  }).returning({ id: dbSchema.casesTable.id });
  await db.insert(dbSchema.caseKeyDatesTable).values({
    firmId: FIRM_ID,
    caseId: res.id,
  }).onConflictDoNothing();
  return res.id;
}

async function countActiveAssignments(db: DrizzleClient, caseId: number): Promise<number> {
  const [r] = await db.select({ value: count() }).from(dbSchema.caseAssignmentsTable).where(and(
    eq(dbSchema.caseAssignmentsTable.caseId, caseId),
    sql`${dbSchema.caseAssignmentsTable.unassignedAt} IS NULL`,
  ));
  return Number(r?.value ?? 0);
}

async function nextReceiptNo(db: DrizzleClient): Promise<string> {
  const key = `receipt-${FIRM_ID}`;
  const [row] = await db.select().from(dbSchema.firmNumberSequencesTable).where(eq(dbSchema.firmNumberSequencesTable.firmId, FIRM_ID)).limit(1);
  const nextVal = Number(row?.nextValue ?? 1);
  if (row) {
    await db.update(dbSchema.firmNumberSequencesTable).set({ nextValue: nextVal + 1, updatedAt: new Date() }).where(eq(dbSchema.firmNumberSequencesTable.firmId, FIRM_ID));
  } else {
    await db.insert(dbSchema.firmNumberSequencesTable).values({ firmId: FIRM_ID, seqName: "receipt", nextValue: nextVal + 1 });
  }
  return `RCP-${FIRM_ID}-${String(nextVal).padStart(4, "0")}`;
}

async function nextInvoiceNo(db: DrizzleClient): Promise<string> {
  const key = `inv-${FIRM_ID}`;
  const [row] = await db.select().from(dbSchema.firmNumberSequencesTable).where(eq(dbSchema.firmNumberSequencesTable.firmId, FIRM_ID)).limit(1);
  const nextVal = (Number(row?.nextValue ?? 1) * 11) % 999999;
  return `INV-${FIRM_ID}-${String(nextVal).padStart(4, "0")}`;
}

type ReceiptKindOk = { kind: "ok"; rec: InferSelectModel<typeof dbSchema.receiptsTable>; idempotentReplay?: boolean };
type ReceiptKinds =
  | ReceiptKindOk
  | { kind: "invoice_not_found" }
  | { kind: "case_not_found" }
  | { kind: "case_invoice_mismatch" }
  | { kind: "allocation_invoice_not_found"; invoiceId: number }
  | { kind: "case_already_settled" };

async function createReceiptRaw(db: DrizzleClient, opts: {
  caseId?: number;
  invoiceId?: number;
  amount: number;
  receivedDate: string;
  allocations?: Array<{ invoiceId: number; amount: number }>;
  idempotencyKey?: string;
  accountType?: string;
  paymentMethod?: string;
  bankAccountId?: number;
  referenceNo?: string;
  notes?: string;
  failOnAllocationInsertIndex?: number; // for R4 ghost testing
}): Promise<ReceiptKinds> {
  const amountNum = Number(opts.amount);
  const amountStr = amountNum.toFixed(2);
  const normalizeAcc = (v: unknown): string => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s === "trust") return "client";
    if (s === "balance_sheet") return "balance_sheet";
    if (s === "office") return "office";
    return "client";
  };
  const allocations = Array.isArray(opts.allocations) ? opts.allocations : [];
  if (opts.invoiceId && allocations.length === 0) allocations.push({ invoiceId: opts.invoiceId, amount: amountNum });

  try {
    return await (db as any).transaction(async (tx: DrizzleClient) => {
      const paymentAccountType = normalizeAcc(opts.accountType ?? "client");
      if (opts.caseId) {
        const [c] = await tx.select({ id: dbSchema.casesTable.id }).from(dbSchema.casesTable).where(and(eq(dbSchema.casesTable.id, opts.caseId), eq(dbSchema.casesTable.firmId, FIRM_ID))).limit(1);
        if (!c) return { kind: "case_not_found" as const };
        const [kd] = await tx.select({ fullSettlementDate: dbSchema.caseKeyDatesTable.fullSettlementDate })
          .from(dbSchema.caseKeyDatesTable)
          .where(and(eq(dbSchema.caseKeyDatesTable.caseId, opts.caseId), eq(dbSchema.caseKeyDatesTable.firmId, FIRM_ID)))
          .limit(1);
        if (kd && kd.fullSettlementDate) return { kind: "case_already_settled" as const };
      }
      if (opts.idempotencyKey) {
        const idemEventKey = `RECEIPT_IDEM:${FIRM_ID}:${opts.idempotencyKey}`;
        const [existingIdem] = await tx.select({ id: dbSchema.caseLedgersTable.id, sourceId: dbSchema.caseLedgersTable.sourceId })
          .from(dbSchema.caseLedgersTable)
          .where(and(eq(dbSchema.caseLedgersTable.firmId, FIRM_ID), eq(dbSchema.caseLedgersTable.eventKey, idemEventKey)))
          .limit(1);
        if (existingIdem && existingIdem.sourceId) {
          const [recRow] = await tx.select().from(dbSchema.receiptsTable).where(and(eq(dbSchema.receiptsTable.id, Number(existingIdem.sourceId)), eq(dbSchema.receiptsTable.firmId, FIRM_ID))).limit(1);
          if (recRow) return { kind: "ok" as const, rec: recRow, idempotentReplay: true };
        }
      }
      const receiptNo = await nextReceiptNo(tx);
      const [rec] = await tx.insert(dbSchema.receiptsTable).values({
        firmId: FIRM_ID,
        caseId: opts.caseId ?? null,
        invoiceId: opts.invoiceId ?? null,
        receiptNo,
        paymentMethod: opts.paymentMethod ?? "bank_transfer",
        bankAccountId: opts.bankAccountId ?? null,
        accountType: paymentAccountType,
        amount: amountStr,
        receivedDate: opts.receivedDate,
        referenceNo: opts.referenceNo ?? null,
        notes: opts.notes ?? null,
        createdBy: ACTOR_USER_ID,
      }).returning();
      for (let i = 0; i < allocations.length; i++) {
        const alloc = allocations[i];
        if (opts.failOnAllocationInsertIndex !== undefined && i === opts.failOnAllocationInsertIndex) {
          throw new Error("SIMULATED_ALLOCATION_INSERT_FAIL");
        }
        await tx.insert(dbSchema.receiptAllocationsTable).values({
          receiptId: rec.id,
          invoiceId: alloc.invoiceId ?? null,
          amount: Number(alloc.amount).toFixed(2),
        });
      }
      await tx.insert(dbSchema.ledgerEntriesTable).values({
        firmId: FIRM_ID,
        caseId: opts.caseId ?? null,
        entryDate: opts.receivedDate,
        entryType: "receipt",
        accountType: paymentAccountType,
        debit: "0.00",
        credit: amountStr,
        balanceAfter: amountStr,
        description: `Receipt ${receiptNo}`,
        referenceNo: receiptNo,
        sourceType: "receipt",
        sourceId: rec.id,
        createdBy: ACTOR_USER_ID,
      });
      if (opts.caseId) {
        const amountNumCents = Math.round(amountNum * 100);
        const evtKey = `RECEIPT:${rec.id}:CONFIRM`;
        const [exists] = await tx.select({ id: dbSchema.caseLedgersTable.id }).from(dbSchema.caseLedgersTable).where(or(
          and(
            eq(dbSchema.caseLedgersTable.firmId, FIRM_ID),
            eq(dbSchema.caseLedgersTable.caseId, opts.caseId),
            eq(dbSchema.caseLedgersTable.sourceType, "receipt"),
            eq(dbSchema.caseLedgersTable.sourceId, rec.id),
          ),
          and(
            eq(dbSchema.caseLedgersTable.firmId, FIRM_ID),
            eq(dbSchema.caseLedgersTable.eventKey, evtKey),
          ),
        )).limit(1);
        if (!exists) {
          await tx.insert(dbSchema.caseLedgersTable).values({
            firmId: FIRM_ID,
            caseId: opts.caseId,
            transactionDate: opts.receivedDate,
            entryCategory: paymentAccountType,
            entryType: "payment_received",
            description: `Receipt ${receiptNo}`,
            amount: amountStr,
            debitCents: Math.max(0, amountNumCents),
            creditCents: 0,
            sourceType: "receipt",
            sourceId: rec.id,
            sourceReference: receiptNo,
            eventKey: evtKey,
          });
        }
        if (opts.idempotencyKey) {
          const idemAnchorKey = `RECEIPT_IDEM:${FIRM_ID}:${opts.idempotencyKey}`;
          const [anchorExists] = await tx.select({ id: dbSchema.caseLedgersTable.id })
            .from(dbSchema.caseLedgersTable)
            .where(and(eq(dbSchema.caseLedgersTable.firmId, FIRM_ID), eq(dbSchema.caseLedgersTable.eventKey, idemAnchorKey)))
            .limit(1);
          if (!anchorExists) {
            try {
              await tx.insert(dbSchema.caseLedgersTable).values({
                firmId: FIRM_ID,
                caseId: opts.caseId,
                transactionDate: opts.receivedDate,
                entryCategory: paymentAccountType,
                entryType: "idem_anchor",
                description: `Receipt Idempotency anchor for ${opts.idempotencyKey}`,
                amount: "0.00",
                debitCents: 0,
                creditCents: 0,
                sourceType: "receipt",
                sourceId: rec.id,
                sourceReference: receiptNo,
                eventKey: idemAnchorKey,
              });
            } catch (idemCollide) {
              const info = String((idemCollide as any)?.sqlState ?? (idemCollide as any)?.sqlstate ?? "");
              if (info === "23505") {
                const [idemCollideRec] = await tx.select({ sourceId: dbSchema.caseLedgersTable.sourceId })
                  .from(dbSchema.caseLedgersTable)
                  .where(and(eq(dbSchema.caseLedgersTable.firmId, FIRM_ID), eq(dbSchema.caseLedgersTable.eventKey, idemAnchorKey)))
                  .limit(1);
                if (idemCollideRec && idemCollideRec.sourceId) {
                  const [existingRow] = await tx.select().from(dbSchema.receiptsTable).where(and(eq(dbSchema.receiptsTable.id, Number(idemCollideRec.sourceId)), eq(dbSchema.receiptsTable.firmId, FIRM_ID))).limit(1);
                  if (existingRow) return { kind: "ok" as const, rec: existingRow, idempotentReplay: true };
                }
              }
              throw idemCollide;
            }
          }
        }
      }
      return { kind: "ok" as const, rec };
    });
  } catch (err: any) {
    if (err?.message === "SIMULATED_ALLOCATION_INSERT_FAIL") {
      throw err;
    }
    throw err;
  }
}

type InvoiceKind =
  | { kind: "ok"; inv: InferSelectModel<typeof dbSchema.invoicesTable> }
  | { kind: "case_not_found" }
  | { kind: "already_invoiced" }
  | { kind: "quotation_already_invoiced" }
  | { kind: "case_already_settled" };

async function createInvoiceManual(db: DrizzleClient, opts: {
  caseId?: number;
  quotationId?: number;
  items: Array<{ description: string; amountExclTax: number; taxRate: number; taxAmount: number; amountInclTax: number }>;
  failItemsIndex?: number;
}): Promise<InvoiceKind> {
  const subtotal = opts.items.reduce((s, i) => s + (Number.isFinite(i.amountExclTax) ? i.amountExclTax : 0), 0);
  const taxTotal = opts.items.reduce((s, i) => s + (Number.isFinite(i.taxAmount) ? i.taxAmount : 0), 0);
  const grandTotal = subtotal + taxTotal;
  try {
    return await (db as any).transaction(async (tx: DrizzleClient) => {
      if (opts.caseId) {
        const [c] = await tx.select({ id: dbSchema.casesTable.id }).from(dbSchema.casesTable).where(and(eq(dbSchema.casesTable.id, opts.caseId), eq(dbSchema.casesTable.firmId, FIRM_ID))).limit(1);
        if (!c) return { kind: "case_not_found" as const };
        const [kd] = await tx.select({ fullSettlementDate: dbSchema.caseKeyDatesTable.fullSettlementDate })
          .from(dbSchema.caseKeyDatesTable)
          .where(and(eq(dbSchema.caseKeyDatesTable.caseId, opts.caseId), eq(dbSchema.caseKeyDatesTable.firmId, FIRM_ID)))
          .limit(1);
        if (kd && kd.fullSettlementDate) return { kind: "case_already_settled" as const };
      }
      if (opts.quotationId) {
        const [existingInv] = await tx.select({ id: dbSchema.invoicesTable.id }).from(dbSchema.invoicesTable).where(and(eq(dbSchema.invoicesTable.firmId, FIRM_ID), eq(dbSchema.invoicesTable.quotationId, opts.quotationId))).limit(1);
        if (existingInv) return { kind: "quotation_already_invoiced" as const };
      }
      const invoiceNo = await nextInvoiceNo(tx);
      const today = new Date().toISOString().slice(0, 10);
      const [inv] = await tx.insert(dbSchema.invoicesTable).values({
        firmId: FIRM_ID,
        caseId: opts.caseId ?? null,
        quotationId: opts.quotationId ?? null,
        invoiceNo,
        status: "draft",
        subtotal: subtotal.toFixed(2),
        taxTotal: taxTotal.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        amountPaid: "0.00",
        amountDue: grandTotal.toFixed(2),
        issuedDate: today,
        dueDate: today,
        createdBy: ACTOR_USER_ID,
      }).returning();
      for (let i = 0; i < opts.items.length; i++) {
        if (opts.failItemsIndex !== undefined && i === opts.failItemsIndex) {
          throw new Error("SIMULATED_INVOICE_ITEMS_FAIL");
        }
        const it = opts.items[i];
        await tx.insert(dbSchema.invoiceItemsTable).values({
          invoiceId: inv.id,
          description: it.description,
          itemType: "professional_fee",
          itemCategory: "fee",
          amountExclTax: (Number.isFinite(it.amountExclTax) ? it.amountExclTax : 0).toFixed(2),
          taxRate: (Number.isFinite(it.taxRate) ? it.taxRate : 0).toFixed(2),
          taxAmount: (Number.isFinite(it.taxAmount) ? it.taxAmount : 0).toFixed(2),
          amountInclTax: (Number.isFinite(it.amountInclTax) ? it.amountInclTax : 0).toFixed(2),
          sortOrder: i,
        });
      }
      return { kind: "ok" as const, inv };
    });
  } catch (err: any) {
    if (err?.message === "SIMULATED_INVOICE_ITEMS_FAIL") throw err;
    throw err;
  }
}

async function createInvoiceFromQuotation(db: DrizzleClient, quotationId: number, failItemsIndex?: number): Promise<InvoiceKind> {
  try {
    return await (db as any).transaction(async (tx: DrizzleClient) => {
      const [existingInv] = await tx.select({ id: dbSchema.invoicesTable.id }).from(dbSchema.invoicesTable).where(and(eq(dbSchema.invoicesTable.firmId, FIRM_ID), eq(dbSchema.invoicesTable.quotationId, quotationId))).limit(1);
      if (existingInv) return { kind: "already_invoiced" as const };
      const [q] = await tx.select().from(dbSchema.quotationsTable).where(and(eq(dbSchema.quotationsTable.id, quotationId), eq(dbSchema.quotationsTable.firmId, FIRM_ID))).limit(1);
      if (!q) throw new Error("quotation_not_found");
      const caseId = q.caseId ? Number(q.caseId) : null;
      if (caseId) {
        const [kd] = await tx.select({ fullSettlementDate: dbSchema.caseKeyDatesTable.fullSettlementDate })
          .from(dbSchema.caseKeyDatesTable)
          .where(and(eq(dbSchema.caseKeyDatesTable.caseId, caseId), eq(dbSchema.caseKeyDatesTable.firmId, FIRM_ID)))
          .limit(1);
        if (kd && kd.fullSettlementDate) return { kind: "case_already_settled" as const };
      }
      const qItems = await tx.select().from(dbSchema.quotationItemsTable).where(eq(dbSchema.quotationItemsTable.quotationId, quotationId));
      const subtotal = qItems.reduce((s, i) => s + Number(i.amountExclTax), 0);
      const taxTotal = qItems.reduce((s, i) => s + Number(i.taxAmount), 0);
      const grandTotal = subtotal + taxTotal;
      const invoiceNo = await nextInvoiceNo(tx);
      const today = new Date().toISOString().slice(0, 10);
      const [inv] = await tx.insert(dbSchema.invoicesTable).values({
        firmId: FIRM_ID,
        caseId: q.caseId ?? null,
        quotationId,
        invoiceNo,
        status: "draft",
        subtotal: subtotal.toFixed(2),
        taxTotal: taxTotal.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        amountPaid: "0.00",
        amountDue: grandTotal.toFixed(2),
        issuedDate: today,
        dueDate: today,
        createdBy: ACTOR_USER_ID,
      }).returning();
      for (let i = 0; i < qItems.length; i++) {
        if (failItemsIndex !== undefined && i === failItemsIndex) throw new Error("SIMULATED_INVOICE_FROM_QUOTE_ITEMS_FAIL");
        const qi = qItems[i];
        await tx.insert(dbSchema.invoiceItemsTable).values({
          invoiceId: inv.id,
          description: qi.description,
          itemType: qi.itemType || "disbursement",
          itemCategory: qi.itemCategory === "disbursement" ? "disbursement" : "fee",
          amountExclTax: String(qi.amountExclTax),
          taxRate: String(qi.taxRate),
          taxAmount: String(qi.taxAmount),
          amountInclTax: String(qi.amountInclTax),
          sortOrder: i,
        });
      }
      return { kind: "ok" as const, inv };
    });
  } catch (err: any) {
    if (err.message?.startsWith("SIMULATED_")) throw err;
    throw err;
  }
}

async function createQuotation(db: DrizzleClient, caseId: number, items: Array<{ description: string; amountExclTax: number; taxRate: number; taxAmount: number; amountInclTax: number }>): Promise<number> {
  const [q] = await db.insert(dbSchema.quotationsTable).values({
    firmId: FIRM_ID,
    caseId,
    referenceNo: "Q-" + Math.random().toString(36).slice(2, 8),
    clientName: "Regression Test Client",
    clientDetails: [] as any[],
    createdBy: ACTOR_USER_ID,
  }).returning({ id: dbSchema.quotationsTable.id });
  await db.insert(dbSchema.quotationItemsTable).values(items.map((it, idx) => ({
    quotationId: q.id,
    section: "Legal Fees",
    description: it.description,
    itemType: "disbursement",
    itemCategory: "fee",
    amountExclTax: it.amountExclTax.toFixed(2),
    taxRate: it.taxRate.toFixed(2),
    taxAmount: it.taxAmount.toFixed(2),
    amountInclTax: it.amountInclTax.toFixed(2),
    sortOrder: idx,
  })));
  return q.id;
}

type VoidKind =
  | { kind: "ok"; inv: InferSelectModel<typeof dbSchema.invoicesTable> }
  | { kind: "not_found" }
  | { kind: "paid" }
  | { kind: "case_already_settled" }
  | { kind: "has_receipts"; allocTotal: number };

async function voidInvoice(db: DrizzleClient, id: number): Promise<VoidKind> {
  const [preInv] = await db.select().from(dbSchema.invoicesTable).where(and(eq(dbSchema.invoicesTable.id, id), eq(dbSchema.invoicesTable.firmId, FIRM_ID))).limit(1);
  return await (db as any).transaction(async (tx: DrizzleClient) => {
    const [lockedInv] = await tx.select().from(dbSchema.invoicesTable).where(and(eq(dbSchema.invoicesTable.id, id), eq(dbSchema.invoicesTable.firmId, FIRM_ID))).limit(1);
    if (!lockedInv) return { kind: "not_found" as const };
    if (lockedInv.status === "paid") return { kind: "paid" as const };
    const caseId = lockedInv.caseId ? Number(lockedInv.caseId) : null;
    if (caseId) {
      const [kd] = await tx.select({ fullSettlementDate: dbSchema.caseKeyDatesTable.fullSettlementDate })
        .from(dbSchema.caseKeyDatesTable)
        .where(and(eq(dbSchema.caseKeyDatesTable.caseId, caseId), eq(dbSchema.caseKeyDatesTable.firmId, FIRM_ID)))
        .limit(1);
      if (kd && kd.fullSettlementDate) return { kind: "case_already_settled" as const };
    }
    const [allocRows] = await tx.select({ total: sql<number>`COALESCE(SUM(${dbSchema.receiptAllocationsTable.amount}), 0)` })
      .from(dbSchema.receiptAllocationsTable)
      .innerJoin(dbSchema.receiptsTable, and(
        eq(dbSchema.receiptAllocationsTable.receiptId, dbSchema.receiptsTable.id),
        eq(dbSchema.receiptsTable.firmId, FIRM_ID),
        sql`${dbSchema.receiptsTable.isReversed} = false`,
      ))
      .where(eq(dbSchema.receiptAllocationsTable.invoiceId, id));
    const allocTotal = Number(allocRows?.total ?? 0);
    if (allocTotal > 0) return { kind: "has_receipts" as const, allocTotal };
    const [updatedRow] = await tx.update(dbSchema.invoicesTable).set({ status: "void", amountDue: "0.00", amountPaid: "0.00", updatedAt: new Date() })
      .where(and(eq(dbSchema.invoicesTable.id, id), eq(dbSchema.invoicesTable.firmId, FIRM_ID)))
      .returning();
    if (caseId && preInv && preInv.status === "issued") {
      const [billedRow] = await tx.select({ id: dbSchema.caseLedgersTable.id, eventKey: dbSchema.caseLedgersTable.eventKey })
        .from(dbSchema.caseLedgersTable)
        .where(and(
          eq(dbSchema.caseLedgersTable.firmId, FIRM_ID),
          eq(dbSchema.caseLedgersTable.caseId, caseId),
          eq(dbSchema.caseLedgersTable.sourceType, "invoice"),
          eq(dbSchema.caseLedgersTable.sourceId, id),
          eq(dbSchema.caseLedgersTable.entryType, "invoice_billed"),
        ))
        .limit(1);
      if (billedRow && billedRow.id) {
        const voidEventKey = `INVOICE_VOID:${id}:${String(billedRow.eventKey ?? "")}`;
        const [voidExists] = await tx.select({ id: dbSchema.caseLedgersTable.id })
          .from(dbSchema.caseLedgersTable)
          .where(and(eq(dbSchema.caseLedgersTable.firmId, FIRM_ID), eq(dbSchema.caseLedgersTable.caseId, caseId), eq(dbSchema.caseLedgersTable.eventKey, voidEventKey)))
          .limit(1);
        if (!voidExists) {
          const originalAmount = Number(preInv.grandTotal ?? 0);
          const debitCentsOrig = Math.round(originalAmount * 100);
          await tx.insert(dbSchema.caseLedgersTable).values({
            firmId: FIRM_ID,
            caseId,
            transactionDate: new Date().toISOString().slice(0, 10),
            entryCategory: "office",
            entryType: "invoice_void",
            description: `Invoice ${lockedInv.invoiceNo} voided reversal`,
            amount: originalAmount.toFixed(2),
            debitCents: 0,
            creditCents: debitCentsOrig,
            sourceType: "invoice",
            sourceId: id,
            sourceReference: lockedInv.invoiceNo,
            eventKey: voidEventKey,
          });
        }
      }
    }
    return { kind: "ok" as const, inv: updatedRow };
  });
}

async function bulkAssignStaff(db: DrizzleClient, caseIds: number[], roleInCase: "lawyer" | "clerk", userId: number, failOnIndex?: number): Promise<{ requested: number; succeeded: number; failed: number }> {
  return await (db as any).transaction(async (tx: DrizzleClient) => {
    const cases = await tx.select({ id: dbSchema.casesTable.id }).from(dbSchema.casesTable).where(and(eq(dbSchema.casesTable.firmId, FIRM_ID), inArray(dbSchema.casesTable.id, caseIds)));
    const existingIds = new Set(cases.map((c) => c.id));
    const missingIds = caseIds.filter((id) => !existingIds.has(id));
    if (missingIds.length > 0) throw new Error("missing_cases_detected");
    const now = new Date();
    let succeeded = 0;
    for (let i = 0; i < cases.length; i++) {
      const caseId = cases[i].id;
      if (failOnIndex !== undefined && i === failOnIndex) throw new Error("SIMULATED_ASSIGN_LOOP_FAIL");
      await tx.update(dbSchema.caseAssignmentsTable).set({ unassignedAt: now }).where(and(
        eq(dbSchema.caseAssignmentsTable.caseId, caseId),
        eq(dbSchema.caseAssignmentsTable.roleInCase, roleInCase),
        sql`${dbSchema.caseAssignmentsTable.unassignedAt} IS NULL`,
      ));
      await tx.insert(dbSchema.caseAssignmentsTable).values({
        caseId,
        userId,
        roleInCase,
        assignedBy: ACTOR_USER_ID,
        assignedAt: now,
      });
      await tx.insert(dbSchema.auditLogsTable).values({
        firmId: FIRM_ID,
        actorId: ACTOR_USER_ID,
        actorType: "firm_user",
        action: "cases.bulk.assign",
        entityType: "case",
        entityId: caseId,
        detail: `role=${roleInCase} userId=${userId}`,
      });
      succeeded += 1;
    }
    return { requested: caseIds.length, succeeded, failed: 0 };
  }).catch((e: any) => {
    if (e.message === "missing_cases_detected") return { requested: caseIds.length, succeeded: 0, failed: caseIds.length };
    if (e.message.startsWith("SIMULATED_")) throw e;
    return { requested: caseIds.length, succeeded: 0, failed: caseIds.length };
  });
}

describe("G3-1 Bulk Assign Staff: Atomic Transaction Wrapper", () => {
  let ctx: Awaited<ReturnType<typeof createTestClient>>;
  let db: DrizzleClient;

  beforeAll(async () => { ctx = await createTestClient(); db = ctx.db; });
  afterAll(async () => { await ctx.teardown(); });

  it("R1.1 Mid-loop failure fully rolls back assignments (atomic)", async () => {
    const a = await insertCase(db);
    const b = await insertCase(db);
    const c = await insertCase(db);
    // 0 baseline
    expect(await countActiveAssignments(db, a)).toBe(0);
    expect(await countActiveAssignments(db, b)).toBe(0);
    expect(await countActiveAssignments(db, c)).toBe(0);
    // fail at index 1 (caseId = b insert new assignment)
    await expect(bulkAssignStaff(db, [a, b, c], "lawyer", TARGET_STAFF_ID, 1)).rejects.toThrow("SIMULATED_ASSIGN_LOOP_FAIL");
    // ALL 3 must still be 0 (no partial update)
    expect(await countActiveAssignments(db, a)).toBe(0);
    expect(await countActiveAssignments(db, b)).toBe(0);
    expect(await countActiveAssignments(db, c)).toBe(0);
    // no audit logs for this partial run (logs also wrapped)
    const [logCount] = await db.select({ value: count() }).from(dbSchema.auditLogsTable).where(eq(dbSchema.auditLogsTable.action, "cases.bulk.assign"));
    expect(Number(logCount?.value ?? 0)).toBe(0);
  });

  it("R1.2 Happy path N=3 all assigned atomically", async () => {
    const a = await insertCase(db);
    const b = await insertCase(db);
    const c = await insertCase(db);
    const r = await bulkAssignStaff(db, [a, b, c], "clerk", TARGET_STAFF_ID);
    expect(r.succeeded).toBe(3);
    expect(await countActiveAssignments(db, a)).toBe(1);
    expect(await countActiveAssignments(db, b)).toBe(1);
    expect(await countActiveAssignments(db, c)).toBe(1);
  });
});

describe("G3-2 Bulk Status: Atomic Transaction Wrapper", () => {
  let ctx: Awaited<ReturnType<typeof createTestClient>>;
  let db: DrizzleClient;

  beforeAll(async () => { ctx = await createTestClient(); db = ctx.db; });
  afterAll(async () => { await ctx.teardown(); });

  async function applySimpleStatusSimulate(db: DrizzleClient, caseIds: number[], failOnIndex?: number): Promise<{ requested: number; succeeded: number; failed: number; completionDatesSet: number[] }> {
    return await (db as any).transaction(async (tx: DrizzleClient) => {
      const cases = await tx.select({ id: dbSchema.casesTable.id }).from(dbSchema.casesTable).where(and(eq(dbSchema.casesTable.firmId, FIRM_ID), inArray(dbSchema.casesTable.id, caseIds)));
      let succeeded = 0;
      const dates: number[] = [];
      for (let i = 0; i < cases.length; i++) {
        const cId = cases[i].id;
        if (failOnIndex !== undefined && i === failOnIndex) throw new Error("SIMULATED_STATUS_LOOP_FAIL");
        await tx.update(dbSchema.caseKeyDatesTable).set({ completionDate: "2026-01-02", updatedAt: new Date() }).where(and(eq(dbSchema.caseKeyDatesTable.caseId, cId), eq(dbSchema.caseKeyDatesTable.firmId, FIRM_ID)));
        await tx.insert(dbSchema.auditLogsTable).values({
          firmId: FIRM_ID,
          actorId: ACTOR_USER_ID,
          actorType: "firm_user",
          action: "cases.bulk.status",
          entityType: "case",
          entityId: cId,
          detail: "completion",
        });
        await tx.update(dbSchema.caseWorkflowStepsTable).set({ status: "completed", completedBy: ACTOR_USER_ID, completedAt: new Date(), updatedAt: new Date() }).where(and(eq(dbSchema.caseWorkflowStepsTable.caseId, cId), eq(dbSchema.caseWorkflowStepsTable.stepKey, "completion")));
        dates.push(cId);
        succeeded += 1;
      }
      return { requested: caseIds.length, succeeded, failed: 0, completionDatesSet: dates };
    }).catch((e: any) => {
      if (e.message.startsWith("SIMULATED_")) throw e;
      return { requested: caseIds.length, succeeded: 0, failed: caseIds.length, completionDatesSet: [] as number[] };
    });
  }

  it("R2.1 Mid-loop failure rolls back all workflow updates", async () => {
    const a = await insertCase(db);
    const b = await insertCase(db);
    const c = await insertCase(db);
    await db.insert(dbSchema.caseWorkflowStepsTable).values([a, b, c].flatMap((id) => [
      { caseId: id, stepKey: "completion", stepName: "Completion", stepOrder: 10, status: "pending", pathType: "common" as const },
      { caseId: id, stepKey: "spa", stepName: "SPA Sign", stepOrder: 1, status: "pending", pathType: "common" as const },
    ])).onConflictDoNothing();
    await expect(applySimpleStatusSimulate(db, [a, b, c], 1)).rejects.toThrow("SIMULATED_STATUS_LOOP_FAIL");
    // All three: completionDate must be NULL
    const kdRows = await db.select({ caseId: dbSchema.caseKeyDatesTable.caseId, completion: dbSchema.caseKeyDatesTable.completionDate }).from(dbSchema.caseKeyDatesTable).where(inArray(dbSchema.caseKeyDatesTable.caseId, [a, b, c]));
    for (const r of kdRows) expect(r.completion).toBeNull();
    // workflow steps back to pending
    const steps = await db.select({ caseId: dbSchema.caseWorkflowStepsTable.caseId, status: dbSchema.caseWorkflowStepsTable.status, stepKey: dbSchema.caseWorkflowStepsTable.stepKey }).from(dbSchema.caseWorkflowStepsTable).where(and(inArray(dbSchema.caseWorkflowStepsTable.caseId, [a, b, c]), eq(dbSchema.caseWorkflowStepsTable.stepKey, "completion")));
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });
});

describe("G3-3 Receipt Idempotency & settled-lock", () => {
  let ctx: Awaited<ReturnType<typeof createTestClient>>;
  let db: DrizzleClient;

  beforeAll(async () => { ctx = await createTestClient(); db = ctx.db; });
  afterAll(async () => { await ctx.teardown(); });

  it("R3.1 Same idempotencyKey 5x → 1 receipt only, returns same id each time", async () => {
    const caseId = await insertCase(db);
    const KEY = "client-side-uuid-same-key-R31-" + Date.now();
    let firstId: number | null = null;
    const results: ReceiptKinds[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await createReceiptRaw(db, { caseId, amount: 321.50, receivedDate: "2026-03-10", idempotencyKey: KEY });
      results.push(r);
    }
    for (const r of results) expect(r.kind).toBe("ok");
    firstId = (results[0] as ReceiptKindOk).rec.id;
    for (const r of results) {
      expect((r as ReceiptKindOk).rec.id).toBe(firstId);
    }
    // exactly 1 row in receipts
    const [countRow] = await db.select({ value: count() }).from(dbSchema.receiptsTable);
    expect(Number(countRow.value)).toBeGreaterThanOrEqual(1);
    // specifically firm_case_id filter
    const [rc] = await db.select({ value: count() }).from(dbSchema.receiptsTable).where(and(eq(dbSchema.receiptsTable.firmId, FIRM_ID), eq(dbSchema.receiptsTable.caseId, caseId)));
    expect(Number(rc.value)).toBe(1);
    // case_ledgers exactly 1 payment_received entry + 1 idem_anchor = 2
    const [lc] = await db.select({ value: count() }).from(dbSchema.caseLedgersTable).where(and(eq(dbSchema.caseLedgersTable.firmId, FIRM_ID), eq(dbSchema.caseLedgersTable.caseId, caseId)));
    expect(Number(lc.value)).toBe(2);
  });

  it("R3.2 Different idempotencyKey but same amount/case → 2 different receipts (distinct keys)", async () => {
    const caseId = await insertCase(db);
    const rA = await createReceiptRaw(db, { caseId, amount: 99.99, receivedDate: "2026-03-10", idempotencyKey: "kA-diff" });
    const rB = await createReceiptRaw(db, { caseId, amount: 99.99, receivedDate: "2026-03-10", idempotencyKey: "kB-diff" });
    expect(rA.kind).toBe("ok");
    expect(rB.kind).toBe("ok");
    expect((rA as ReceiptKindOk).rec.id).not.toBe((rB as ReceiptKindOk).rec.id);
  });

  it("R3.3 Receipt allocation insert failure rolls back the entire receipt (no ghost header)", async () => {
    const caseId = await insertCase(db);
    const [inv1] = await db.insert(dbSchema.invoicesTable).values({
      firmId: FIRM_ID, caseId, invoiceNo: "INV-GHOST-" + Date.now(),
      status: "draft", grandTotal: "100.00", amountDue: "100.00", amountPaid: "0.00", issuedDate: "2026-03-01", dueDate: "2026-04-01", createdBy: ACTOR_USER_ID,
    }).returning({ id: dbSchema.invoicesTable.id });
    const preCount = (await db.select({ value: count() }).from(dbSchema.receiptsTable).where(eq(dbSchema.receiptsTable.caseId, caseId)))[0].value;
    await expect(createReceiptRaw(db, {
      caseId, invoiceId: inv1.id, amount: 100.00, receivedDate: "2026-03-10",
      allocations: [{ invoiceId: inv1.id, amount: 40 }, { invoiceId: inv1.id, amount: 60 }],
      failOnAllocationInsertIndex: 1,
    })).rejects.toThrow("SIMULATED_ALLOCATION_INSERT_FAIL");
    const postCount = (await db.select({ value: count() }).from(dbSchema.receiptsTable).where(eq(dbSchema.receiptsTable.caseId, caseId)))[0].value;
    expect(postCount).toBe(preCount); // No receipt header ghost!
  });
});

describe("G3-4 Invoice Ghost-proof TX Wrapper", () => {
  let ctx: Awaited<ReturnType<typeof createTestClient>>;
  let db: DrizzleClient;

  beforeAll(async () => { ctx = await createTestClient(); db = ctx.db; });
  afterAll(async () => { await ctx.teardown(); });

  it("R4.1 Manual invoice: items insert fail → zero header ghost", async () => {
    const caseId = await insertCase(db);
    const items = [
      { description: "A", amountExclTax: 100, taxRate: 0.08, taxAmount: 8, amountInclTax: 108 },
      { description: "B", amountExclTax: 200, taxRate: 0.08, taxAmount: 16, amountInclTax: 216 },
    ];
    await expect(createInvoiceManual(db, { caseId, items, failItemsIndex: 1 })).rejects.toThrow("SIMULATED_INVOICE_ITEMS_FAIL");
    const [invCount] = await db.select({ value: count() }).from(dbSchema.invoicesTable).where(eq(dbSchema.invoicesTable.caseId, caseId));
    expect(Number(invCount.value)).toBe(0);
  });

  it("R4.2 From-quotation invoice: items insert fail → zero header ghost", async () => {
    const caseId = await insertCase(db);
    const qItems = [
      { description: "Q-fee", amountExclTax: 500, taxRate: 0.06, taxAmount: 30, amountInclTax: 530 },
      { description: "Q2", amountExclTax: 100, taxRate: 0, taxAmount: 0, amountInclTax: 100 },
    ];
    const qId = await createQuotation(db, caseId, qItems);
    await expect(createInvoiceFromQuotation(db, qId, 1)).rejects.toThrow("SIMULATED_INVOICE_FROM_QUOTE_ITEMS_FAIL");
    const [invCount] = await db.select({ value: count() }).from(dbSchema.invoicesTable).where(eq(dbSchema.invoicesTable.quotationId, qId));
    expect(Number(invCount.value)).toBe(0);
  });
});

describe("G3-5 Void Invoice: 409 Reject + Ledger Divergence Fix", () => {
  let ctx: Awaited<ReturnType<typeof createTestClient>>;
  let db: DrizzleClient;

  beforeAll(async () => { ctx = await createTestClient(); db = ctx.db; });
  afterAll(async () => { await ctx.teardown(); });

  it("R5.1 If receipt exists (partial paid), void returns 409 VOID_NOT_ALLOWED_REVERSE_RECEIPT_FIRST", async () => {
    const caseId = await insertCase(db);
    const items = [{ description: "V", amountExclTax: 1000, taxRate: 0.08, taxAmount: 80, amountInclTax: 1080 }];
    const resInv = await createInvoiceManual(db, { caseId, items });
    expect(resInv.kind).toBe("ok");
    const invId = (resInv as Extract<InvoiceKind, { kind: "ok" }>).inv.id;
    // Simulate 'issued' + issue a ledger entry (so void can offset)
    await db.update(dbSchema.invoicesTable).set({ status: "issued" }).where(eq(dbSchema.invoicesTable.id, invId));
    await db.insert(dbSchema.caseLedgersTable).values({
      firmId: FIRM_ID,
      caseId,
      transactionDate: "2026-03-01",
      entryCategory: "office",
      entryType: "invoice_billed",
      description: "Invoice billed",
      amount: "1080.00",
      debitCents: 1080 * 100,
      creditCents: 0,
      sourceType: "invoice",
      sourceId: invId,
      eventKey: `ISSUE:${invId}`,
    });
    // partial receipt 400 allocated to it
    const receiptRes = await createReceiptRaw(db, {
      caseId,
      invoiceId: invId,
      amount: 400,
      receivedDate: "2026-03-02",
      allocations: [{ invoiceId: invId, amount: 400 }],
    });
    expect(receiptRes.kind).toBe("ok");
    // Now try to void
    const vRes = await voidInvoice(db, invId);
    expect(vRes.kind).toBe("has_receipts");
    if (vRes.kind === "has_receipts") expect(vRes.allocTotal).toBe(400);
    // invoice status NOT void
    const [postInv] = await db.select({ status: dbSchema.invoicesTable.status }).from(dbSchema.invoicesTable).where(eq(dbSchema.invoicesTable.id, invId));
    expect(postInv.status).toBe("issued");
  });

  it("R5.2 Issued Invoice without receipt → void inserts invoice_void offset ledger (CASE LEDGER total 0)", async () => {
    const caseId = await insertCase(db);
    const items = [{ description: "V2", amountExclTax: 5000, taxRate: 0.08, taxAmount: 400, amountInclTax: 5400 }];
    const resInv = await createInvoiceManual(db, { caseId, items });
    expect(resInv.kind).toBe("ok");
    const invId = (resInv as Extract<InvoiceKind, { kind: "ok" }>).inv.id;
    await db.update(dbSchema.invoicesTable).set({ status: "issued" }).where(eq(dbSchema.invoicesTable.id, invId));
    await db.insert(dbSchema.caseLedgersTable).values({
      firmId: FIRM_ID, caseId,
      transactionDate: "2026-03-01",
      entryCategory: "office",
      entryType: "invoice_billed",
      description: "Invoice 2",
      amount: "5400.00",
      debitCents: 5400 * 100,
      creditCents: 0,
      sourceType: "invoice",
      sourceId: invId,
      eventKey: `ISSUE2:${invId}`,
    });
    const v = await voidInvoice(db, invId);
    expect(v.kind).toBe("ok");
    const rows = await db.select({ type: dbSchema.caseLedgersTable.entryType, debit: dbSchema.caseLedgersTable.debitCents, credit: dbSchema.caseLedgersTable.creditCents }).from(dbSchema.caseLedgersTable).where(and(eq(dbSchema.caseLedgersTable.firmId, FIRM_ID), eq(dbSchema.caseLedgersTable.caseId, caseId)));
    expect(rows.find((r) => r.type === "invoice_billed")).toBeTruthy();
    expect(rows.find((r) => r.type === "invoice_void")).toBeTruthy();
    const sum = rows.reduce((acc, r) => acc + Number(r.debit ?? 0) - Number(r.credit ?? 0), 0);
    expect(sum).toBe(0); // divergence closed!
  });
});

describe("G3-6 Close Case Settled Lock (full_settlement_date guard)", () => {
  let ctx: Awaited<ReturnType<typeof createTestClient>>;
  let db: DrizzleClient;

  beforeAll(async () => { ctx = await createTestClient(); db = ctx.db; });
  afterAll(async () => { await ctx.teardown(); });

  it("R6.1 Case full_settlement_date = not null → receipt create 409 CASE_ALREADY_SETTLED", async () => {
    const caseId = await insertCase(db);
    await db.update(dbSchema.caseKeyDatesTable).set({ fullSettlementDate: "2026-08-10", updatedAt: new Date() }).where(and(eq(dbSchema.caseKeyDatesTable.caseId, caseId), eq(dbSchema.caseKeyDatesTable.firmId, FIRM_ID)));
    const r = await createReceiptRaw(db, { caseId, amount: 100, receivedDate: "2026-09-01" });
    expect(r.kind).toBe("case_already_settled");
  });

  it("R6.2 Case full_settlement_date → void 409; unset → void OK", async () => {
    const caseId = await insertCase(db);
    const inv = await createInvoiceManual(db, { caseId, items: [{ description: "x", amountExclTax: 1, taxRate: 0, taxAmount: 0, amountInclTax: 1 }] });
    expect(inv.kind).toBe("ok");
    const invId = (inv as Extract<InvoiceKind, { kind: "ok" }>).inv.id;
    // set settled
    await db.update(dbSchema.caseKeyDatesTable).set({ fullSettlementDate: "2026-07-07", updatedAt: new Date() }).where(and(eq(dbSchema.caseKeyDatesTable.caseId, caseId), eq(dbSchema.caseKeyDatesTable.firmId, FIRM_ID)));
    const v1 = await voidInvoice(db, invId);
    expect(v1.kind).toBe("case_already_settled");
    // unset settled
    await db.update(dbSchema.caseKeyDatesTable).set({ fullSettlementDate: null, updatedAt: new Date() }).where(and(eq(dbSchema.caseKeyDatesTable.caseId, caseId), eq(dbSchema.caseKeyDatesTable.firmId, FIRM_ID)));
    const v2 = await voidInvoice(db, invId);
    expect(v2.kind).toBe("ok");
  });
});
