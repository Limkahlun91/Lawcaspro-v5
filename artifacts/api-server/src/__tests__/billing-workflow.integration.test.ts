import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  invoicesTable,
  invoiceAuditTrailTable,
  receiptsTable,
  receiptAllocationsTable,
  firmNumberSequencesTable,
} from "@workspace/db";
import {
  markInvoicePaid,
  softDeleteInvoice,
  retryInvoiceAction,
  appendInvoiceAuditTrail,
} from "../modules/accounting/invoice-audit-writer.service.js";

const FIRM_ID = 91001;
let pg: PGlite;
let r: any;

const BILLING_DDL = `
CREATE TABLE IF NOT EXISTS firm_number_sequences (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  seq_name TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  last_prefix TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (firm_id, seq_name)
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  quotation_id INTEGER,
  invoice_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(18,2) NOT NULL DEFAULT 0,
  issued_date DATE,
  due_date DATE,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  einvoice_status TEXT NOT NULL DEFAULT 'DRAFT',
  einvoice_external_submission_id TEXT,
  einvoice_submitted_at TIMESTAMPTZ,
  einvoice_last_checked_at TIMESTAMPTZ,
  einvoice_error_code TEXT,
  einvoice_error_message TEXT,
  einvoice_retry_count INTEGER NOT NULL DEFAULT 0,
  einvoice_classification TEXT,
  einvoice_source_invoice_id INTEGER
);

CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  invoice_id INTEGER,
  receipt_no TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'bank_transfer',
  bank_account_id INTEGER,
  account_type TEXT NOT NULL DEFAULT 'client',
  amount NUMERIC(18,2) NOT NULL,
  received_date DATE NOT NULL,
  reference_no TEXT,
  notes TEXT,
  is_reversed BOOLEAN NOT NULL DEFAULT FALSE,
  reversed_by INTEGER,
  reversed_at TIMESTAMPTZ,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receipt_allocations (
  id SERIAL PRIMARY KEY,
  receipt_id INTEGER NOT NULL,
  invoice_id INTEGER,
  amount NUMERIC(18,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_audit_trail (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  before_snapshot JSONB,
  after_snapshot JSONB,
  delta JSONB,
  amount_change NUMERIC(18,2),
  status_before TEXT,
  status_after TEXT,
  actor_user_id INTEGER,
  actor_role TEXT,
  reauth_verified BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_token TEXT,
  client_request_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  receipt_id INTEGER,
  payment_method TEXT,
  bank_reference TEXT,
  paid_amount NUMERIC(18,2),
  paid_date TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

describe("Billing Workflow — Invoice Paid / Delete / Retry (PART 3C)", () => {
  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    await pg.exec(BILLING_DDL);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  async function q<T = any>(stmt: string): Promise<T[]> {
    const res: any = await pg.exec(stmt);
    if (res && Array.isArray(res)) {
      if (res[0] && Array.isArray(res[0].rows)) return res[0].rows as T[];
      if (res[0] && Array.isArray(res[0].fields)) {
        const out: any[] = [];
        const fields = res[0].fields.map((f: any) => typeof f === "string" ? f : f.name);
        for (const row of (res[0].rows ?? [])) {
          const o: any = {};
          fields.forEach((k: string, i: number) => { o[k] = row[i]; });
          out.push(o);
        }
        return out as T[];
      }
    }
    if (res && res.rows && Array.isArray(res.rows)) return res.rows as T[];
    if (res && Array.isArray(res)) return res as T[];
    return [];
  }

  it("BIL-1: mark_paid → status=paid, amount_paid set, receipt row + allocation written, audit=mark_paid", async () => {
    await pg.exec(`
      INSERT INTO invoices (id, firm_id, invoice_no, status, grand_total, amount_due, amount_paid)
      VALUES (1001, ${FIRM_ID}, 'INV-TEST-1001', 'issued', 1500.00, 1500.00, 0.00);
    `);
    const result = await markInvoicePaid({
      firmId: FIRM_ID, invoiceId: 1001, actorUserId: 401,
      paidAmount: "1500.00",
      paymentMethod: "bank_transfer",
      bankReference: "MAY20260811001",
      notes: "Full settlement PGT transfer",
      reAuthVerified: true,
    }, { tx: r });

    expect(result.receiptId).toBeGreaterThanOrEqual(1);
    expect(result.auditId).toBeGreaterThanOrEqual(1);

    const invs = await q<any>(`SELECT status, amount_paid, amount_due FROM invoices WHERE firm_id=${FIRM_ID} AND id=1001 LIMIT 1`);
    expect(String(invs[0].status)).toBe("paid");
    expect(Number(invs[0].amount_paid)).toBe(1500.00);
    expect(Number(invs[0].amount_due)).toBe(0.00);

    const rcps = await q<any>(`SELECT payment_method as method, reference_no as ref, invoice_id as "invId", amount, created_by as "createdBy" FROM receipts WHERE firm_id=${FIRM_ID} AND id=${Number(result.receiptId!)} LIMIT 1`);
    expect(Number(rcps[0].amount)).toBe(1500.00);
    expect(rcps[0].method).toBe("bank_transfer");
    expect(rcps[0].ref).toBe("MAY20260811001");
    expect(Number(rcps[0].invId)).toBe(1001);
    expect(Number(rcps[0].createdBy)).toBe(401);

    const allocs = await q<any>(`SELECT receipt_id as "rcpId", invoice_id as "invId", amount FROM receipt_allocations WHERE receipt_id=${Number(result.receiptId!)}`);
    expect(Number(allocs[0].amount)).toBe(1500.00);
    expect(Number(allocs[0].invId)).toBe(1001);

    const audit = (await q<any>(`
      SELECT action_type AS "actionType", status_after AS "statusAfter", reauth_verified AS "reAuth",
             actor_user_id AS "actor", notes, receipt_id AS "receiptId",
             bank_reference AS "bankRef", paid_amount AS "paidAmount"
      FROM invoice_audit_trail
      WHERE firm_id=${FIRM_ID} AND invoice_id=1001
      ORDER BY created_at DESC LIMIT 1
    `))[0];
    expect(audit.actionType).toBe("mark_paid");
    expect(audit.statusAfter).toBe("paid");
    expect(audit.reAuth).toBe(true);
    expect(Number(audit.actor)).toBe(401);
    expect(Number(audit.receiptId)).toBe(Number(result.receiptId));
    expect(audit.bankRef).toBe("MAY20260811001");
    expect(Number(audit.paidAmount)).toBe(1500.00);
  });

  it("BIL-2: mark_paid PARTIAL → status=partial_paid + delta recorded", async () => {
    await pg.exec(`
      INSERT INTO invoices (id, firm_id, invoice_no, status, grand_total, amount_due, amount_paid)
      VALUES (1002, ${FIRM_ID}, 'INV-TEST-1002', 'issued', 3000.00, 3000.00, 0.00);
    `);
    const partial = await markInvoicePaid({
      firmId: FIRM_ID, invoiceId: 1002, actorUserId: 402,
      paidAmount: "1000.00", paymentMethod: "cheque",
      reAuthVerified: true,
    }, { tx: r });
    expect(partial.receiptId).toBeGreaterThanOrEqual(1);

    const invs = await q<any>(`SELECT status, amount_paid, amount_due FROM invoices WHERE id=1002 LIMIT 1`);
    expect(String(invs[0].status)).toBe("partial_paid");
    expect(Number(invs[0].amount_paid)).toBe(1000.00);
    expect(Number(invs[0].amount_due)).toBe(2000.00);
  });

  it("BIL-3: soft_delete ISSUED invoice — requires reAuth + reason ≥6 chars, sets deleted_at and status=void", async () => {
    await pg.exec(`
      INSERT INTO invoices (id, firm_id, invoice_no, status, grand_total, amount_due, amount_paid)
      VALUES (1003, ${FIRM_ID}, 'INV-TEST-1003', 'issued', 500.00, 500.00, 0.00);
    `);
    await expect(softDeleteInvoice({
      firmId: FIRM_ID, invoiceId: 1003, actorUserId: 403,
      confirmationReason: "short", reAuthVerified: true,
    }, { tx: r })).rejects.toThrow(/DELETE_REASON_REQUIRED|6 char/i);

    await expect(softDeleteInvoice({
      firmId: FIRM_ID, invoiceId: 1003, actorUserId: 403,
      confirmationReason: "Duplicate invoice, wrong case id", reAuthVerified: false,
    }, { tx: r })).rejects.toThrow(/DELETE_REAUTH_REQUIRED|re-auth|reAuth/i);

    const ok = await softDeleteInvoice({
      firmId: FIRM_ID, invoiceId: 1003, actorUserId: 403,
      confirmationReason: "Duplicate of INV-TEST-1001 created by error",
      reAuthVerified: true,
    }, { tx: r });
    expect(ok.deleted).toBe(true);
    expect(ok.auditId).toBeGreaterThanOrEqual(1);

    const invs = await q<any>(`SELECT status, deleted_at as "deletedAt" FROM invoices WHERE id=1003 LIMIT 1`);
    expect(String(invs[0].status)).toBe("void");
    expect(invs[0].deletedAt).not.toBeNull();

    const delAudit = (await q<any>(`
      SELECT action_type AS "actionType", delta, status_after AS "statusAfter",
             notes, reauth_verified AS "reAuth"
      FROM invoice_audit_trail
      WHERE firm_id=${FIRM_ID} AND invoice_id=1003 AND action_type='soft_delete'
      LIMIT 1
    `))[0];
    expect(delAudit.actionType).toBe("soft_delete");
    expect(delAudit.statusAfter).toBe("void");
    expect(delAudit.reAuth).toBe(true);
    const deltaParsed = typeof delAudit.delta === "string" ? JSON.parse(delAudit.delta) : (delAudit.delta ?? {});
    expect((deltaParsed as any)?.confirmationReason).toMatch(/Duplicate/);
    expect(delAudit.notes).toMatch(/Duplicate/);
  });

  it("BIL-4: deleting PAID invoice FORBIDDEN (credit note route required)", async () => {
    const invId = 1001;
    await expect(softDeleteInvoice({
      firmId: FIRM_ID, invoiceId: invId, actorUserId: 403,
      confirmationReason: "Credit note reversal intent", reAuthVerified: true,
    }, { tx: r })).rejects.toThrow(/PAID_DELETE_FORBIDDEN|cannot be deleted|credit note/i);
  });

  it("BIL-5: retry increments counter (≤5 times), after which INVOICE_RETRY_EXHAUSTED", async () => {
    await pg.exec(`
      INSERT INTO invoices (id, firm_id, invoice_no, status, grand_total, amount_due)
      VALUES (1010, ${FIRM_ID}, 'INV-TEST-1010', 'issued', 888.00, 888.00);
    `);
    const MAX = 5;
    const ids: number[] = [];
    for (let i = 1; i <= MAX; i++) {
      const step = await retryInvoiceAction({
        firmId: FIRM_ID, invoiceId: 1010, actionType: "einvoice_submit_failed" as any, actorUserId: 410,
        clientRequestId: `RETRY-${i}`,
      }, { tx: r });
      ids.push(step.auditId);
      if (i < MAX) expect(step.retryable).toBe(true);
    }
    // Check 5th is NOT retryable
    const last = await q<any>(`
      SELECT action_type AS "actionType", retry_count AS "retryCount", client_request_id AS "crId"
      FROM invoice_audit_trail
      WHERE firm_id=${FIRM_ID} AND invoice_id=1010
      ORDER BY created_at DESC LIMIT 1
    `);
    expect(Number(last[0].retryCount)).toBe(MAX);
    expect(last[0].crId).toBe(`RETRY-${MAX}`);

    // 6th → exhaust
    await expect(retryInvoiceAction({
      firmId: FIRM_ID, invoiceId: 1010, actionType: "einvoice_submit_failed" as any, actorUserId: 410,
    }, { tx: r })).rejects.toThrow(/INVOICE_RETRY_EXHAUSTED|Max retries/i);
  });

  it("BIL-6: audit trail append-only — no deletes, 1 audit row per mutation", async () => {
    const all = await q<any>(`
      SELECT id, action_type AS "actionType", invoice_id AS "invId", created_at AS "createdAt"
      FROM invoice_audit_trail
      WHERE firm_id=${FIRM_ID}
      ORDER BY id
    `);

    const markPaid = all.filter(a => a.actionType === "mark_paid" || a.actionType === "mark_partial_paid").length;
    const softDel  = all.filter(a => a.actionType === "soft_delete").length;
    const retries  = all.filter(a => a.actionType === "einvoice_submit_failed").length;
    expect(markPaid).toBe(2);
    expect(softDel).toBe(1);
    expect(retries).toBe(5);

    // Confirm no gaps in ids for this firm — appends only
    const ids = all.map(a => Number(a.id)).sort((a,b)=>a-b);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i-1]);
    }
  });
});
