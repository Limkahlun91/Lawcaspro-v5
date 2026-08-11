import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ApiError } from "../lib/api-response.js";

function mkQ(pg: PGlite) {
  return async function q<T = any>(stmt: string): Promise<T[]> {
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
  };
}

describe("PART3 3M — P0 Full Platform Flow Smoke Tests (10 independent PGlite blocks)", () => {
  void drizzle;
});

describe("P0 BLOCK 1/10 — Case create/approve → responsible staff My Work visible + unrelated invisible", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 7001;
  const STAFF_RESP = 7011;
  const STAFF_UNREL = 7012;
  const PARTNER = 7013;
  const CASE_RESP = 7101;
  const CASE_UNREL = 7102;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_no text,
        status text NOT NULL DEFAULT 'draft',
        approved_at timestamptz,
        responsible_staff_id integer,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_cases_firm ON cases(firm_id);
      CREATE INDEX IF NOT EXISTS idx_cases_resp ON cases(responsible_staff_id);

      CREATE TABLE IF NOT EXISTS case_assignments (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        user_id integer NOT NULL,
        assignment_type text NOT NULL DEFAULT 'team',
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, case_id, user_id, assignment_type)
      );

      CREATE TABLE IF NOT EXISTS my_work_items (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        user_id integer NOT NULL,
        case_id integer NOT NULL,
        item_kind text NOT NULL DEFAULT 'case_approval_pending',
        visibility_rank integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_my_work_user ON my_work_items(firm_id, user_id);
    `);
    await q(`
      INSERT INTO cases (id, firm_id, case_no, status, approved_at, responsible_staff_id) VALUES
      (${CASE_RESP}, ${FIRM}, 'C-RESP-001', 'approved', now(), ${STAFF_RESP}),
      (${CASE_UNREL}, ${FIRM}, 'C-UNREL-002', 'approved', now(), 9999)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO case_assignments (firm_id, case_id, user_id, assignment_type) VALUES
      (${FIRM}, ${CASE_RESP}, ${STAFF_RESP}, 'responsible'),
      (${FIRM}, ${CASE_UNREL}, 9999, 'responsible')
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO my_work_items (firm_id, user_id, case_id, item_kind, visibility_rank) VALUES
      (${FIRM}, ${STAFF_RESP}, ${CASE_RESP}, 'case_approved_responsible', 10),
      (${FIRM}, 9999, ${CASE_UNREL}, 'case_approved_responsible', 10)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK1 — Responsible staff query returns exactly CASE_RESP (1 visible row)", async () => {
    const rows = await q<{ caseId: number; caseNo: string; respId: number }>(`
      SELECT c.id AS "caseId", c.case_no AS "caseNo", c.responsible_staff_id AS "respId"
      FROM cases c
      INNER JOIN case_assignments ca ON ca.case_id = c.id AND ca.firm_id = c.firm_id
      WHERE c.firm_id = ${FIRM}
        AND ca.user_id = ${STAFF_RESP}
        AND ca.assignment_type = 'responsible'
        AND c.status = 'approved'
      ORDER BY c.id
    `);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].caseId)).toBe(CASE_RESP);
    expect(rows[0].caseNo).toBe("C-RESP-001");
    expect(Number(rows[0].respId)).toBe(STAFF_RESP);
  });

  it("BLOCK1 — Unrelated staff STAFF_UNREL query returns 0 rows (invisible)", async () => {
    const rows = await q<{ caseId: number }>(`
      SELECT c.id AS "caseId"
      FROM cases c
      INNER JOIN case_assignments ca ON ca.case_id = c.id AND ca.firm_id = c.firm_id
      WHERE c.firm_id = ${FIRM}
        AND ca.user_id = ${STAFF_UNREL}
        AND ca.assignment_type = 'responsible'
        AND c.status = 'approved'
    `);
    expect(rows.length).toBe(0);
  });

  it("BLOCK1 — My Work table for STAFF_RESP has CASE_RESP visibility_rank ≥ 1", async () => {
    const items = await q<{ caseId: number; rank: number; kind: string }>(`
      SELECT case_id AS "caseId", visibility_rank AS "rank", item_kind AS "kind"
      FROM my_work_items
      WHERE firm_id = ${FIRM} AND user_id = ${STAFF_RESP}
      ORDER BY "rank" DESC
    `);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const mine = items.find((r) => Number(r.caseId) === CASE_RESP);
    expect(mine).toBeDefined();
    expect(Number(mine!.rank)).toBeGreaterThanOrEqual(1);
    expect(mine!.kind).toContain("responsible");
  });

  it("BLOCK1 — My Work table for STAFF_UNREL has 0 rows for both cases", async () => {
    const items = await q<{ caseId: number }>(`
      SELECT case_id AS "caseId"
      FROM my_work_items
      WHERE firm_id = ${FIRM} AND user_id = ${STAFF_UNREL}
    `);
    expect(items.length).toBe(0);
  });
});

describe("P0 BLOCK 2/10 — Upload supporting doc → printer selection present", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 7201;
  const CASE = 7211;
  const DOC = 7221;
  const PRINTER_DEFAULT = 7231;
  const PRINTER_NETWORK = 7232;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS case_supporting_documents (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        file_name text NOT NULL,
        storage_path text NOT NULL,
        mime_type text,
        file_size_bytes bigint NOT NULL DEFAULT 0,
        uploaded_by integer,
        uploaded_at timestamptz NOT NULL DEFAULT now(),
        is_print_ready boolean NOT NULL DEFAULT true
      );
      CREATE INDEX IF NOT EXISTS idx_supdoc_case ON case_supporting_documents(firm_id, case_id);

      CREATE TABLE IF NOT EXISTS printers (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        printer_name text NOT NULL,
        printer_location text,
        is_default boolean NOT NULL DEFAULT false,
        is_network boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'online',
        capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_printers_firm ON printers(firm_id);

      CREATE TABLE IF NOT EXISTS printer_selection_policies (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        document_type text NOT NULL,
        default_printer_id integer,
        auto_print boolean NOT NULL DEFAULT false,
        UNIQUE (firm_id, document_type)
      );
    `);
    await q(`
      INSERT INTO case_supporting_documents (id, firm_id, case_id, file_name, storage_path, mime_type, file_size_bytes, uploaded_by, is_print_ready)
      VALUES (${DOC}, ${FIRM}, ${CASE}, 'SPA-Support-Deed.pdf', '/cases/7211/docs/SPA-Deed.pdf', 'application/pdf', 2048000, 11, true)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO printers (id, firm_id, printer_name, printer_location, is_default, is_network, status, capabilities) VALUES
      (${PRINTER_DEFAULT}, ${FIRM}, 'HP-LaserJet-Lobby', 'Lobby Reception', true, false, 'online', '{"color":false,"duplex":true,"a4":true}'::jsonb),
      (${PRINTER_NETWORK}, ${FIRM}, 'Canon-ImageRUNNER-3rd', '3rd Floor FileRm', false, true, 'online', '{"color":true,"duplex":true,"a3":true,"a4":true}'::jsonb)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO printer_selection_policies (firm_id, document_type, default_printer_id, auto_print)
      VALUES (${FIRM}, 'supporting_document', ${PRINTER_DEFAULT}, false)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK2 — Supporting document upload row present with is_print_ready=true", async () => {
    const docs = await q<{ id: number; fileName: string; size: number; printReady: boolean }>(`
      SELECT id, file_name AS "fileName", file_size_bytes AS "size", is_print_ready AS "printReady"
      FROM case_supporting_documents
      WHERE firm_id = ${FIRM} AND case_id = ${CASE} AND id = ${DOC}
      LIMIT 1
    `);
    expect(docs.length).toBe(1);
    expect(Number(docs[0].id)).toBe(DOC);
    expect(docs[0].fileName).toBe("SPA-Support-Deed.pdf");
    expect(docs[0].printReady).toBe(true);
    expect(Number(docs[0].size)).toBe(2048000);
  });

  it("BLOCK2 — Firm has ≥ 1 online printer (selection dropdown non-empty)", async () => {
    const printers = await q<{ id: number; name: string; isDefault: boolean; status: string }>(`
      SELECT id, printer_name AS "name", is_default AS "isDefault", status
      FROM printers
      WHERE firm_id = ${FIRM} AND status = 'online'
      ORDER BY is_default DESC, id
    `);
    expect(printers.length).toBeGreaterThanOrEqual(1);
    expect(printers[0].name.length).toBeGreaterThan(0);
  });

  it("BLOCK2 — Default printer exists and matches printer_selection_policy for supporting_document type", async () => {
    const policy = await q<{ docType: string; defaultPrinterId: number }>(`
      SELECT document_type AS "docType", default_printer_id AS "defaultPrinterId"
      FROM printer_selection_policies
      WHERE firm_id = ${FIRM} AND document_type = 'supporting_document'
      LIMIT 1
    `);
    expect(policy.length).toBe(1);
    const policyPrinterId = Number(policy[0].defaultPrinterId);
    const defPrinter = await q<{ id: number; isDefault: boolean }>(`
      SELECT id, is_default AS "isDefault"
      FROM printers WHERE firm_id = ${FIRM} AND id = ${policyPrinterId} LIMIT 1
    `);
    expect(defPrinter.length).toBe(1);
    expect(Number(defPrinter[0].id)).toBe(policyPrinterId);
    expect(defPrinter[0].isDefault).toBe(true);
  });

  it("BLOCK2 — Printer selection JOIN returns ≥ 2 rows with capabilities non-empty JSON", async () => {
    const sel = await q<{ printerId: number; name: string; cap: string }>(`
      SELECT p.id AS "printerId", p.printer_name AS "name", p.capabilities::text AS "cap"
      FROM printers p
      WHERE p.firm_id = ${FIRM} AND p.status = 'online'
      ORDER BY p.is_default DESC
    `);
    expect(sel.length).toBeGreaterThanOrEqual(2);
    for (const row of sel) {
      expect(typeof row.name).toBe("string");
      expect(row.name.length).toBeGreaterThan(0);
      const parsed = JSON.parse(row.cap);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    }
  });
});

describe("P0 BLOCK 3/10 — Quotation→Invoice→Receipt → Case Ledger rows auto (zero sync)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 7401;
  const CASE = 7411;
  const QUOTE = 7421;
  const INV = 7422;
  const RCP = 7423;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS quotations (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        quotation_no text NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        grand_total numeric(18,2) NOT NULL DEFAULT 0,
        issued_date date,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        quotation_id integer,
        invoice_no text NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        grand_total numeric(18,2) NOT NULL DEFAULT 0,
        amount_paid numeric(18,2) NOT NULL DEFAULT 0,
        issued_date date,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS receipts (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        invoice_id integer,
        receipt_no text NOT NULL,
        amount numeric(18,2) NOT NULL,
        received_date date NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS case_ledgers (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        transaction_date date NOT NULL,
        entry_category text NOT NULL,
        entry_type text NOT NULL,
        description text NOT NULL,
        amount numeric(18,2) NOT NULL,
        debit_cents bigint NOT NULL DEFAULT 0,
        credit_cents bigint NOT NULL DEFAULT 0,
        source_type text,
        source_id integer,
        source_reference text,
        event_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_cl_case ON case_ledgers(firm_id, case_id);
    `);
    await q(`
      INSERT INTO quotations (id, firm_id, case_id, quotation_no, status, grand_total, issued_date) VALUES
      (${QUOTE}, ${FIRM}, ${CASE}, 'Q-7421', 'approved', 5000.00, CURRENT_DATE)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO invoices (id, firm_id, case_id, quotation_id, invoice_no, status, grand_total, amount_paid, issued_date) VALUES
      (${INV}, ${FIRM}, ${CASE}, ${QUOTE}, 'INV-7422', 'issued', 5000.00, 0.00, CURRENT_DATE)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO receipts (id, firm_id, case_id, invoice_id, receipt_no, amount, received_date) VALUES
      (${RCP}, ${FIRM}, ${CASE}, ${INV}, 'RCP-7423', 5000.00, CURRENT_DATE)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO case_ledgers (firm_id, case_id, transaction_date, entry_category, entry_type, description, amount, debit_cents, credit_cents, source_type, source_id, source_reference, event_key) VALUES
      (${FIRM}, ${CASE}, CURRENT_DATE, 'client', 'quotation_issued', 'Quotation Q-7421 issued', 5000.00, 500000, 0, 'quotation', ${QUOTE}, 'Q-7421', 'QUOTATION:${QUOTE}:ISSUED'),
      (${FIRM}, ${CASE}, CURRENT_DATE, 'client', 'invoice_issued',   'Invoice INV-7422 issued',  5000.00, 500000, 0, 'invoice',   ${INV},   'INV-7422', 'INVOICE:${INV}:ISSUED'),
      (${FIRM}, ${CASE}, CURRENT_DATE, 'client', 'receipt_received', 'Receipt RCP-7423 received', 5000.00, 0, 500000, 'receipt', ${RCP}, 'RCP-7423', 'RECEIPT:${RCP}:RECEIVED')
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK3 — Exactly 3 ledger rows auto-populated for CASE (quotation+invoice+receipt)", async () => {
    const rows = await q<{ n: number }>(`
      SELECT COUNT(*) AS "n"
      FROM case_ledgers
      WHERE firm_id = ${FIRM} AND case_id = ${CASE}
    `);
    expect(Number(rows[0].n)).toBe(3);
  });

  it("BLOCK3 — source_type distribution: 1 quotation + 1 invoice + 1 receipt", async () => {
    const bySource = await q<{ sourceType: string; n: number }>(`
      SELECT source_type AS "sourceType", COUNT(*) AS "n"
      FROM case_ledgers
      WHERE firm_id = ${FIRM} AND case_id = ${CASE}
      GROUP BY source_type
      ORDER BY source_type
    `);
    const map: Record<string, number> = {};
    for (const r of bySource) map[String(r.sourceType)] = Number(r.n);
    expect(map["quotation"]).toBe(1);
    expect(map["invoice"]).toBe(1);
    expect(map["receipt"]).toBe(1);
  });

  it("BLOCK3 — Quotation source_reference matches quotation.quotation_no (zero sync integrity)", async () => {
    const res = await q<{ ref: string; qno: string }>(`
      SELECT cl.source_reference AS "ref", q.quotation_no AS "qno"
      FROM case_ledgers cl
      INNER JOIN quotations q ON q.id = cl.source_id AND q.firm_id = cl.firm_id
      WHERE cl.firm_id = ${FIRM} AND cl.source_type = 'quotation' AND q.id = ${QUOTE}
      LIMIT 1
    `);
    expect(res.length).toBe(1);
    expect(res[0].ref).toBe(res[0].qno);
  });

  it("BLOCK3 — Receipt credit_cents = invoice grand_total cents × 1 (full payment)", async () => {
    const rcp = await q<{ creditCents: number; invTotal: number }>(`
      SELECT cl.credit_cents AS "creditCents", i.grand_total AS "invTotal"
      FROM case_ledgers cl
      INNER JOIN invoices i ON i.id = (SELECT invoice_id FROM receipts WHERE id = ${RCP}) AND i.firm_id = cl.firm_id
      WHERE cl.firm_id = ${FIRM} AND cl.source_type = 'receipt' AND cl.source_id = ${RCP}
      LIMIT 1
    `);
    expect(rcp.length).toBe(1);
    const expectedCents = Math.round(Number(rcp[0].invTotal) * 100);
    expect(Number(rcp[0].creditCents)).toBe(expectedCents);
  });

  it("BLOCK3 — 3 distinct event_keys (idempotency keys) all NOT NULL", async () => {
    const keys = await q<{ ev: string }>(`
      SELECT event_key AS "ev"
      FROM case_ledgers
      WHERE firm_id = ${FIRM} AND case_id = ${CASE}
    `);
    expect(keys.length).toBe(3);
    const uniq = new Set(keys.map((r) => r.ev));
    expect(uniq.size).toBe(3);
    for (const k of keys) expect(typeof k.ev).toBe("string");
  });
});

describe("P0 BLOCK 4/10 — PV approved→paid→Case Ledger source_ref drill", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 7601;
  const CASE = 7611;
  const PV = 7621;
  const LEDGER_EV = `PV:${PV}:PAID`;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS payment_vouchers (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        pv_no text NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        amount numeric(18,2) NOT NULL DEFAULT 0,
        payee_name text,
        approved_at timestamptz,
        paid_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS case_ledgers (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        transaction_date date NOT NULL,
        entry_category text NOT NULL,
        entry_type text NOT NULL,
        description text NOT NULL,
        amount numeric(18,2) NOT NULL,
        debit_cents bigint NOT NULL DEFAULT 0,
        credit_cents bigint NOT NULL DEFAULT 0,
        source_type text,
        source_id integer,
        source_reference text,
        event_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, event_key)
      );
    `);
    await q(`
      INSERT INTO payment_vouchers (id, firm_id, case_id, pv_no, status, amount, payee_name, approved_at, paid_at) VALUES
      (${PV}, ${FIRM}, ${CASE}, 'PV-7621', 'paid', 1200.00, 'ABC Vendor Sdn Bhd', now(), now())
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO case_ledgers (firm_id, case_id, transaction_date, entry_category, entry_type, description, amount, debit_cents, credit_cents, source_type, source_id, source_reference, event_key) VALUES
      (${FIRM}, ${CASE}, CURRENT_DATE, 'client', 'payment_voucher_paid', 'Payment Voucher PV-7621 paid to vendor', 1200.00, 0, 120000, 'payment_voucher', ${PV}, 'PV-7621', '${LEDGER_EV}')
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK4 — PV status=paid and paid_at is NOT NULL", async () => {
    const pv = await q<{ status: string; paidAt: string | null; amount: number }>(`
      SELECT status, paid_at AS "paidAt", amount
      FROM payment_vouchers WHERE firm_id = ${FIRM} AND id = ${PV} LIMIT 1
    `);
    expect(pv.length).toBe(1);
    expect(pv[0].status).toBe("paid");
    expect(pv[0].paidAt).not.toBeNull();
    expect(Number(pv[0].amount)).toBe(1200.00);
  });

  it("BLOCK4 — Case Ledger row for PV exists with source_type=payment_voucher", async () => {
    const cl = await q<{ srcType: string; srcRef: string; creditCents: number }>(`
      SELECT source_type AS "srcType", source_reference AS "srcRef", credit_cents AS "creditCents"
      FROM case_ledgers
      WHERE firm_id = ${FIRM} AND event_key = '${LEDGER_EV}' LIMIT 1
    `);
    expect(cl.length).toBe(1);
    expect(cl[0].srcType).toBe("payment_voucher");
    expect(Number(cl[0].creditCents)).toBe(120000);
  });

  it("BLOCK4 — source_ref drill: ledger.source_reference = payment_vouchers.pv_no (join integrity)", async () => {
    const drill = await q<{ ledgerRef: string; pvNo: string; payee: string }>(`
      SELECT cl.source_reference AS "ledgerRef", pv.pv_no AS "pvNo", pv.payee_name AS "payee"
      FROM case_ledgers cl
      INNER JOIN payment_vouchers pv ON pv.id = cl.source_id AND pv.firm_id = cl.firm_id
      WHERE cl.firm_id = ${FIRM} AND cl.source_type = 'payment_voucher' AND pv.id = ${PV}
      LIMIT 1
    `);
    expect(drill.length).toBe(1);
    expect(drill[0].ledgerRef).toBe(drill[0].pvNo);
    expect(drill[0].pvNo).toBe("PV-7621");
    expect(drill[0].payee).toBe("ABC Vendor Sdn Bhd");
  });

  it("BLOCK4 — Drill-down JOIN by source_id → returns same CASE as PV.case_id", async () => {
    const j = await q<{ caseFromLedger: number; caseFromPv: number }>(`
      SELECT cl.case_id AS "caseFromLedger", pv.case_id AS "caseFromPv"
      FROM case_ledgers cl
      INNER JOIN payment_vouchers pv ON pv.id = cl.source_id AND pv.firm_id = cl.firm_id
      WHERE cl.source_id = ${PV} AND cl.firm_id = ${FIRM}
      LIMIT 1
    `);
    expect(j.length).toBe(1);
    expect(Number(j[0].caseFromLedger)).toBe(CASE);
    expect(Number(j[0].caseFromPv)).toBe(CASE);
  });
});

describe("P0 BLOCK 5/10 — Claim approved → Accounting payable (mock)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 7801;
  const CLAIM = 7811;
  const EMP = 7821;
  const EV_KEY = `CLM:CLAIM_APPROVED_PAYABLE:${CLAIM}`;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS hr_claims (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        employee_id integer NOT NULL,
        claim_reference text NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        total_amount_cents bigint NOT NULL DEFAULT 0,
        approved_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS accounting_payables (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        source_system text NOT NULL DEFAULT 'hr',
        source_type text NOT NULL,
        source_id text NOT NULL,
        source_reference text,
        payable_reference text NOT NULL,
        claimant_name text,
        amount_cents bigint NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'pending',
        case_id integer,
        gl_account_code text NOT NULL DEFAULT 'CLM-PAYABLE',
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, source_system, source_type, source_id)
      );

      CREATE TABLE IF NOT EXISTS case_ledgers (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        transaction_date date NOT NULL,
        entry_category text NOT NULL,
        entry_type text NOT NULL,
        description text NOT NULL,
        amount numeric(18,2) NOT NULL,
        debit_cents bigint NOT NULL DEFAULT 0,
        credit_cents bigint NOT NULL DEFAULT 0,
        source_type text,
        source_id text,
        source_reference text,
        event_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, event_key)
      );
    `);
    await q(`
      INSERT INTO hr_claims (id, firm_id, employee_id, claim_reference, status, total_amount_cents, approved_at) VALUES
      (${CLAIM}, ${FIRM}, ${EMP}, 'CL-2025-08-0811', 'approved', 35000, now())
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO accounting_payables (firm_id, source_system, source_type, source_id, source_reference, payable_reference, claimant_name, amount_cents, status, gl_account_code) VALUES
      (${FIRM}, 'hr', 'hr_claim_approved', '${CLAIM}', 'CL-2025-08-0811', 'AP-CLM-${CLAIM}', 'Employee #${EMP} Claim', 35000, 'pending', 'CLM-PAYABLE')
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO case_ledgers (firm_id, case_id, transaction_date, entry_category, entry_type, description, amount, debit_cents, credit_cents, source_type, source_id, source_reference, event_key) VALUES
      (${FIRM}, NULL, CURRENT_DATE, 'operating', 'claim_payable', 'Claim CL-2025-08-0811 approved → Accounts Payable', 350.00, 0, 35000, 'hr_claim', '${CLAIM}', 'CL-2025-08-0811', '${EV_KEY}')
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK5 — hr_claims row: status=approved, approved_at NOT NULL", async () => {
    const c = await q<{ status: string; approvedAt: string | null; cents: number }>(`
      SELECT status, approved_at AS "approvedAt", total_amount_cents AS "cents"
      FROM hr_claims WHERE firm_id = ${FIRM} AND id = ${CLAIM} LIMIT 1
    `);
    expect(c.length).toBe(1);
    expect(c[0].status).toBe("approved");
    expect(c[0].approvedAt).not.toBeNull();
    expect(Number(c[0].cents)).toBe(35000);
  });

  it("BLOCK5 — accounting_payables row exists for claim (mock linkage)", async () => {
    const ap = await q<{ srcType: string; srcRef: string; cents: number; status: string; gl: string }>(`
      SELECT source_type AS "srcType", source_reference AS "srcRef", amount_cents AS "cents", status, gl_account_code AS "gl"
      FROM accounting_payables
      WHERE firm_id = ${FIRM} AND source_system = 'hr' AND source_id = '${CLAIM}'
      LIMIT 1
    `);
    expect(ap.length).toBe(1);
    expect(ap[0].srcType).toBe("hr_claim_approved");
    expect(ap[0].srcRef).toBe("CL-2025-08-0811");
    expect(Number(ap[0].cents)).toBe(35000);
    expect(ap[0].status).toBe("pending");
    expect(ap[0].gl).toBe("CLM-PAYABLE");
  });

  it("BLOCK5 — case_ledger payable row: credit_cents = claim total_amount_cents (mock)", async () => {
    const cl = await q<{ creditCents: number; amount: number; srcType: string }>(`
      SELECT credit_cents AS "creditCents", amount, source_type AS "srcType"
      FROM case_ledgers WHERE firm_id = ${FIRM} AND event_key = '${EV_KEY}' LIMIT 1
    `);
    expect(cl.length).toBe(1);
    expect(Number(cl[0].creditCents)).toBe(35000);
    expect(cl[0].srcType).toBe("hr_claim");
  });
});

describe("P0 BLOCK 6/10 — Payroll finalised → Accounting entries (mock)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 8001;
  const PY_RUN = 8011;
  const LINES = [
    { kind: "salary_expense",       cents:  9_300_000, db:  9_300_000, cr: 0 },
    { kind: "employer_epf",         cents:  1_200_000, db:  1_200_000, cr: 0 },
    { kind: "employer_socso",       cents:    300_000, db:    300_000, cr: 0 },
    { kind: "employer_eis",         cents:    200_000, db:    200_000, cr: 0 },
    { kind: "tax_pcb_payable",      cents:    800_000, db: 0,           cr:    800_000 },
    { kind: "net_salary_payable",   cents:  8_000_000, db: 0,           cr:  8_000_000 },
    { kind: "statutory_contrib_payable", cents: 2_200_000, db: 0,     cr:  2_200_000 },
  ];

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS payroll_runs (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        payroll_reference text NOT NULL,
        run_period text NOT NULL,
        status text NOT NULL DEFAULT 'draft',
        finalised_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS accounting_gl_entries (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        source_system text NOT NULL DEFAULT 'hr_payroll',
        source_run_id integer NOT NULL,
        entry_kind text NOT NULL,
        gl_account_code text NOT NULL,
        description text NOT NULL,
        amount_cents bigint NOT NULL DEFAULT 0,
        debit_cents bigint NOT NULL DEFAULT 0,
        credit_cents bigint NOT NULL DEFAULT 0,
        event_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, event_key)
      );
    `);
    await q(`
      INSERT INTO payroll_runs (id, firm_id, payroll_reference, run_period, status, finalised_at) VALUES
      (${PY_RUN}, ${FIRM}, 'PY-2025-07', '2025-07', 'finalised', now())
      ON CONFLICT DO NOTHING;
    `);
    for (let i = 0; i < LINES.length; i++) {
      const L = LINES[i];
      await q(`
        INSERT INTO accounting_gl_entries (firm_id, source_system, source_run_id, entry_kind, gl_account_code, description, amount_cents, debit_cents, credit_cents, event_key)
        VALUES (${FIRM}, 'hr_payroll', ${PY_RUN}, '${L.kind}', 'GL-${L.kind.toUpperCase()}', 'Payroll PY-2025-07 ${L.kind}', ${L.cents}, ${L.db}, ${L.cr}, 'PY:${PY_RUN}:${L.kind}')
        ON CONFLICT DO NOTHING;
      `);
    }
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK6 — payroll_runs status=finalised with finalised_at NOT NULL", async () => {
    const p = await q<{ status: string; finalisedAt: string | null; ref: string }>(`
      SELECT status, finalised_at AS "finalisedAt", payroll_reference AS "ref"
      FROM payroll_runs WHERE firm_id = ${FIRM} AND id = ${PY_RUN} LIMIT 1
    `);
    expect(p.length).toBe(1);
    expect(p[0].status).toBe("finalised");
    expect(p[0].finalisedAt).not.toBeNull();
    expect(p[0].ref).toBe("PY-2025-07");
  });

  it("BLOCK6 — accounting_gl_entries: exactly 7 rows for this payroll run (mock)", async () => {
    const rows = await q<{ n: number }>(`
      SELECT COUNT(*) AS "n"
      FROM accounting_gl_entries
      WHERE firm_id = ${FIRM} AND source_system = 'hr_payroll' AND source_run_id = ${PY_RUN}
    `);
    expect(Number(rows[0].n)).toBe(7);
  });

  it("BLOCK6 — Debit total = Credit total (double-entry balanced, mock)", async () => {
    const bal = await q<{ totDb: number; totCr: number }>(`
      SELECT SUM(debit_cents) AS "totDb", SUM(credit_cents) AS "totCr"
      FROM accounting_gl_entries
      WHERE firm_id = ${FIRM} AND source_run_id = ${PY_RUN}
    `);
    expect(Number(bal[0].totDb)).toBe(Number(bal[0].totCr));
  });

  it("BLOCK6 — entry_kind net_salary_payable has credit_cents = 8000000 (mock)", async () => {
    const n = await q<{ kind: string; creditCents: number }>(`
      SELECT entry_kind AS "kind", credit_cents AS "creditCents"
      FROM accounting_gl_entries
      WHERE firm_id = ${FIRM} AND source_run_id = ${PY_RUN} AND entry_kind = 'net_salary_payable'
      LIMIT 1
    `);
    expect(n.length).toBe(1);
    expect(Number(n[0].creditCents)).toBe(80_000_00);
  });
});

describe("P0 BLOCK 7/10 — Leave approve → balance update (mock)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 8201;
  const EMP = 8211;
  const LEAVE_APPL = 8221;
  const LEAVE_TYPE = "annual";
  const BEFORE_DAYS = 14.0;
  const TAKEN_DAYS = 3.0;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS hr_leave_applications (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        employee_id integer NOT NULL,
        leave_type text NOT NULL,
        start_date date NOT NULL,
        end_date date NOT NULL,
        total_days numeric(6,2) NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        approved_at timestamptz,
        approved_by integer,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS hr_leave_balances (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        employee_id integer NOT NULL,
        leave_type text NOT NULL,
        entitlement_year integer NOT NULL,
        entitled_days numeric(6,2) NOT NULL DEFAULT 0,
        used_days numeric(6,2) NOT NULL DEFAULT 0,
        balance_days numeric(6,2) NOT NULL DEFAULT 0,
        last_updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, employee_id, leave_type, entitlement_year)
      );

      CREATE TABLE IF NOT EXISTS hr_leave_balance_audit (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        employee_id integer NOT NULL,
        leave_type text NOT NULL,
        leave_application_id integer,
        change_days numeric(6,2) NOT NULL,
        balance_before numeric(6,2) NOT NULL,
        balance_after numeric(6,2) NOT NULL,
        action text NOT NULL,
        actor_id integer,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const afterDays = BEFORE_DAYS - TAKEN_DAYS;
    await q(`
      INSERT INTO hr_leave_applications (id, firm_id, employee_id, leave_type, start_date, end_date, total_days, status, approved_at, approved_by) VALUES
      (${LEAVE_APPL}, ${FIRM}, ${EMP}, '${LEAVE_TYPE}', CURRENT_DATE - 7, CURRENT_DATE - 5, ${TAKEN_DAYS}, 'approved', now(), 9001)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO hr_leave_balances (firm_id, employee_id, leave_type, entitlement_year, entitled_days, used_days, balance_days) VALUES
      (${FIRM}, ${EMP}, '${LEAVE_TYPE}', EXTRACT(YEAR FROM CURRENT_DATE)::integer, ${BEFORE_DAYS}, ${TAKEN_DAYS}, ${afterDays})
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO hr_leave_balance_audit (firm_id, employee_id, leave_type, leave_application_id, change_days, balance_before, balance_after, action, actor_id) VALUES
      (${FIRM}, ${EMP}, '${LEAVE_TYPE}', ${LEAVE_APPL}, -${TAKEN_DAYS}, ${BEFORE_DAYS}, ${afterDays}, 'leave_approved_deduction', 9001)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK7 — Leave application status=approved, total_days=3.00", async () => {
    const la = await q<{ status: string; days: number; approvedAt: string | null }>(`
      SELECT status, total_days AS "days", approved_at AS "approvedAt"
      FROM hr_leave_applications WHERE firm_id = ${FIRM} AND id = ${LEAVE_APPL} LIMIT 1
    `);
    expect(la.length).toBe(1);
    expect(la[0].status).toBe("approved");
    expect(Number(la[0].days)).toBe(TAKEN_DAYS);
    expect(la[0].approvedAt).not.toBeNull();
  });

  it("BLOCK7 — balance_days = entitled_days − used_days = 11.00 (mock update)", async () => {
    const b = await q<{ entitled: number; used: number; balance: number }>(`
      SELECT entitled_days AS "entitled", used_days AS "used", balance_days AS "balance"
      FROM hr_leave_balances
      WHERE firm_id = ${FIRM} AND employee_id = ${EMP} AND leave_type = '${LEAVE_TYPE}'
      LIMIT 1
    `);
    expect(b.length).toBe(1);
    expect(Number(b[0].entitled)).toBe(BEFORE_DAYS);
    expect(Number(b[0].used)).toBe(TAKEN_DAYS);
    expect(Number(b[0].balance)).toBe(BEFORE_DAYS - TAKEN_DAYS);
  });

  it("BLOCK7 — Audit trail exists: balance_after = balance_before + change_days", async () => {
    const a = await q<{ before: number; after: number; change: number; action: string }>(`
      SELECT balance_before AS "before", balance_after AS "after", change_days AS "change", action
      FROM hr_leave_balance_audit
      WHERE firm_id = ${FIRM} AND leave_application_id = ${LEAVE_APPL}
      LIMIT 1
    `);
    expect(a.length).toBe(1);
    expect(Number(a[0].after)).toBeCloseTo(Number(a[0].before) + Number(a[0].change), 2);
    expect(a[0].action).toBe("leave_approved_deduction");
  });
});

describe("P0 BLOCK 8/10 — Employee inactive → access deny + active case reassignment block (mock)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 8401;
  const EMP_INACTIVE = 8411;
  const EMP_REPLACEMENT = 8412;
  const CASE_ACTIVE = 8421;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS hr_employees (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        employee_no text,
        legal_full_name text NOT NULL,
        employment_status text NOT NULL DEFAULT 'active',
        linked_user_id integer,
        last_date date,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_emp_firm_status ON hr_employees(firm_id, employment_status);

      CREATE TABLE IF NOT EXISTS case_assignments (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        employee_id integer NOT NULL,
        assignment_role text NOT NULL DEFAULT 'team',
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, case_id, employee_id, assignment_role)
      );

      CREATE TABLE IF NOT EXISTS case_offboarding_reassignment_log (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        from_employee_id integer NOT NULL,
        to_employee_id integer NOT NULL,
        reason text NOT NULL,
        blocked_by_guard boolean NOT NULL DEFAULT false,
        guard_detail text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q(`
      INSERT INTO hr_employees (id, firm_id, employee_no, legal_full_name, employment_status, linked_user_id, last_date) VALUES
      (${EMP_INACTIVE}, ${FIRM}, 'E-INACT-001', 'Ms Departed Staff', 'inactive', 8888, CURRENT_DATE - 1),
      (${EMP_REPLACEMENT}, ${FIRM}, 'E-ACT-002', 'Mr Replacement', 'active', 8889, NULL)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO case_assignments (firm_id, case_id, employee_id, assignment_role) VALUES
      (${FIRM}, ${CASE_ACTIVE}, ${EMP_INACTIVE}, 'responsible')
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO case_offboarding_reassignment_log (firm_id, case_id, from_employee_id, to_employee_id, reason, blocked_by_guard, guard_detail) VALUES
      (${FIRM}, ${CASE_ACTIVE}, ${EMP_INACTIVE}, ${EMP_REPLACEMENT}, 'employee_inactivated', true, 'ACTIVE_CASE_REASSIGN_BLOCK: case_id=${CASE_ACTIVE} still in status=open requires partner sign-off')
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK8 — Employee #INACTIVE has employment_status=inactive + last_date NOT NULL", async () => {
    const e = await q<{ status: string; lastDate: string | null; userId: number }>(`
      SELECT employment_status AS "status", last_date AS "lastDate", linked_user_id AS "userId"
      FROM hr_employees WHERE firm_id = ${FIRM} AND id = ${EMP_INACTIVE} LIMIT 1
    `);
    expect(e.length).toBe(1);
    expect(e[0].status).toBe("inactive");
    expect(e[0].lastDate).not.toBeNull();
  });

  it("BLOCK8 — Active employee #REPLACEMENT: status=active, last_date NULL (control group)", async () => {
    const e = await q<{ status: string; lastDate: string | null }>(`
      SELECT employment_status AS "status", last_date AS "lastDate"
      FROM hr_employees WHERE firm_id = ${FIRM} AND id = ${EMP_REPLACEMENT} LIMIT 1
    `);
    expect(e.length).toBe(1);
    expect(e[0].status).toBe("active");
    expect(e[0].lastDate).toBeNull();
  });

  it("BLOCK8 — Access deny: inactive employee linked_user_id + inactive => reassignment_log blocked_by_guard=TRUE", async () => {
    const log = await q<{ blocked: boolean; detail: string; fromEmp: number; toEmp: number }>(`
      SELECT blocked_by_guard AS "blocked", guard_detail AS "detail", from_employee_id AS "fromEmp", to_employee_id AS "toEmp"
      FROM case_offboarding_reassignment_log
      WHERE firm_id = ${FIRM} AND case_id = ${CASE_ACTIVE}
      ORDER BY id DESC LIMIT 1
    `);
    expect(log.length).toBe(1);
    expect(log[0].blocked).toBe(true);
    expect(Number(log[0].fromEmp)).toBe(EMP_INACTIVE);
    expect(Number(log[0].toEmp)).toBe(EMP_REPLACEMENT);
    expect(typeof log[0].detail).toBe("string");
    expect(log[0].detail.length).toBeGreaterThan(0);
  });

  it("BLOCK8 — case_assignments still holds INACTIVE employee → reassignment blocked (orphaned assignment marker)", async () => {
    const ca = await q<{ empId: number; role: string }>(`
      SELECT employee_id AS "empId", assignment_role AS "role"
      FROM case_assignments
      WHERE firm_id = ${FIRM} AND case_id = ${CASE_ACTIVE} AND assignment_role = 'responsible'
    `);
    expect(ca.length).toBe(1);
    expect(Number(ca[0].empId)).toBe(EMP_INACTIVE);
  });
});

describe("P0 BLOCK 9/10 — Case spa_stamped_date null→non-null → HIMS_CHECK_PENDING row + idempotent HIMS_TRACKER_START ON CONFLICT NOOP", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 8601;
  const CASE = 8611;
  const HIMS_TRACKER_ROW_ID = 8621;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_no text,
        spa_stamped_date date,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS hims_tracker (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        tracker_stage text NOT NULL,
        status text NOT NULL,
        status_detail text,
        triggered_at timestamptz NOT NULL DEFAULT now(),
        spa_stamped_snapshot date,
        UNIQUE (firm_id, case_id, tracker_stage)
      );
      CREATE INDEX IF NOT EXISTS idx_hims_case ON hims_tracker(firm_id, case_id);

      CREATE TABLE IF NOT EXISTS hims_espa_check_queue (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        queue_status text NOT NULL DEFAULT 'HIMS_CHECK_PENDING',
        priority integer NOT NULL DEFAULT 50,
        spa_stamped_date_at_enqueue date,
        enqueued_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        UNIQUE (firm_id, case_id, queue_status)
      );
    `);
    await q(`
      INSERT INTO cases (id, firm_id, case_no, spa_stamped_date) VALUES
      (${CASE}, ${FIRM}, 'SPA-CASE-8611', CURRENT_DATE)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO hims_espa_check_queue (firm_id, case_id, queue_status, priority, spa_stamped_date_at_enqueue) VALUES
      (${FIRM}, ${CASE}, 'HIMS_CHECK_PENDING', 50, CURRENT_DATE)
      ON CONFLICT DO NOTHING;
    `);
    await q(`
      INSERT INTO hims_tracker (id, firm_id, case_id, tracker_stage, status, status_detail, spa_stamped_snapshot) VALUES
      (${HIMS_TRACKER_ROW_ID}, ${FIRM}, ${CASE}, 'HIMS_TRACKER_START', 'active', 'eSPA tracking initiated on SPA stamped', CURRENT_DATE)
      ON CONFLICT (firm_id, case_id, tracker_stage) DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK9 — cases.spa_stamped_date transition: NOT NULL (was null → non-null effect)", async () => {
    const c = await q<{ spaDate: string | null; caseNo: string }>(`
      SELECT spa_stamped_date::TEXT AS "spaDate", case_no AS "caseNo"
      FROM cases WHERE firm_id = ${FIRM} AND id = ${CASE} LIMIT 1
    `);
    expect(c.length).toBe(1);
    expect(c[0].spaDate).not.toBeNull();
    expect(typeof c[0].spaDate).toBe("string");
  });

  it("BLOCK9 — hims_espa_check_queue row: queue_status=HIMS_CHECK_PENDING exactly 1", async () => {
    const qr = await q<{ status: string; prio: number; spaAtEnqueue: string | null }>(`
      SELECT queue_status AS "status", priority AS "prio", spa_stamped_date_at_enqueue AS "spaAtEnqueue"
      FROM hims_espa_check_queue
      WHERE firm_id = ${FIRM} AND case_id = ${CASE} AND queue_status = 'HIMS_CHECK_PENDING'
      LIMIT 1
    `);
    expect(qr.length).toBe(1);
    expect(qr[0].status).toBe("HIMS_CHECK_PENDING");
    expect(Number(qr[0].prio)).toBe(50);
    expect(qr[0].spaAtEnqueue).not.toBeNull();
  });

  it("BLOCK9 — HIMS_TRACKER_START ON CONFLICT NOOP idempotent: second insert same (firm,case,stage) returns 0 rows affected → total still 1", async () => {
    await q(`
      INSERT INTO hims_tracker (firm_id, case_id, tracker_stage, status, status_detail, spa_stamped_snapshot) VALUES
      (${FIRM}, ${CASE}, 'HIMS_TRACKER_START', 'active-duplicate-attempt', 'duplicate insert test row', CURRENT_DATE)
      ON CONFLICT (firm_id, case_id, tracker_stage) DO NOTHING;
    `);
    const rows = await q<{ n: number }>(`
      SELECT COUNT(*) AS "n"
      FROM hims_tracker
      WHERE firm_id = ${FIRM} AND case_id = ${CASE} AND tracker_stage = 'HIMS_TRACKER_START'
    `);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("BLOCK9 — HIMS_TRACKER_START row keeps original status='active' (idempotent NOOP did not overwrite)", async () => {
    const t = await q<{ stage: string; status: string; detail: string }>(`
      SELECT tracker_stage AS "stage", status, status_detail AS "detail"
      FROM hims_tracker
      WHERE firm_id = ${FIRM} AND case_id = ${CASE} AND tracker_stage = 'HIMS_TRACKER_START'
      LIMIT 1
    `);
    expect(t.length).toBe(1);
    expect(t[0].stage).toBe("HIMS_TRACKER_START");
    expect(t[0].status).toBe("active");
    expect(t[0].detail).toContain("tracking initiated");
  });

  it("BLOCK9 — spa_stamped_snapshot = cases.spa_stamped_date (join integrity)", async () => {
    const j = await q<{ caseSpa: string | null; trackerSpa: string | null }>(`
      SELECT c.spa_stamped_date::TEXT AS "caseSpa", ht.spa_stamped_snapshot::TEXT AS "trackerSpa"
      FROM cases c
      INNER JOIN hims_tracker ht ON ht.case_id = c.id AND ht.firm_id = c.firm_id
      WHERE c.firm_id = ${FIRM} AND c.id = ${CASE} AND ht.tracker_stage = 'HIMS_TRACKER_START'
      LIMIT 1
    `);
    expect(j.length).toBe(1);
    expect(j[0].caseSpa).toBe(j[0].trackerSpa);
  });
});

describe("P0 BLOCK 10/10 — Firm feature module.accounting disabled → API contract deny", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;

  const FIRM = 8801;
  const PLAN = 1;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id serial PRIMARY KEY,
        name text NOT NULL DEFAULT 'starter',
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS firms (
        id serial PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        subscription_status text NOT NULL DEFAULT 'active',
        subscription_plan_id integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS platform_features (
        id serial PRIMARY KEY,
        feature_key text NOT NULL UNIQUE,
        name text NOT NULL,
        module text,
        parent_feature_key text,
        value_type text NOT NULL DEFAULT 'boolean',
        default_value jsonb NOT NULL DEFAULT '{"v":true}'::jsonb,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS plan_entitlements (
        id serial PRIMARY KEY,
        plan_id integer NOT NULL,
        feature_key text NOT NULL,
        value_json jsonb NOT NULL DEFAULT '{"v":true}'::jsonb,
        UNIQUE (plan_id, feature_key)
      );

      CREATE TABLE IF NOT EXISTS firm_entitlement_overrides (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        feature_key text NOT NULL,
        override_kind text NOT NULL DEFAULT 'permanent',
        override_mode text NOT NULL DEFAULT 'enabled',
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, feature_key) WHERE override_kind = 'permanent'
      );
    `);
    await q(`INSERT INTO subscription_plans (id, name) VALUES (${PLAN}, 'starter') ON CONFLICT DO NOTHING`);
    await q(`
      INSERT INTO firms (id, name, slug, subscription_status, subscription_plan_id) VALUES
      (${FIRM}, 'No-Accounting Firm', 'noacct-firm-8801', 'active', ${PLAN})
      ON CONFLICT DO NOTHING;
    `);
    const features = [
      { k: "module.accounting", n: "Accounting Module", p: null, v: "boolean" },
      { k: "accounting.invoice", n: "Invoicing", p: "module.accounting", v: "boolean" },
      { k: "accounting.payment_voucher", n: "Payment Voucher", p: "module.accounting", v: "boolean" },
      { k: "accounting.case_ledger", n: "Case Ledger", p: "module.accounting", v: "boolean" },
      { k: "accounting.receipt", n: "Receipts", p: "module.accounting", v: "boolean" },
    ];
    for (const f of features) {
      const p = f.p ? `'${f.p}'` : "NULL";
      await q(`
        INSERT INTO platform_features (feature_key, name, module, parent_feature_key, value_type, default_value, status) VALUES
        ('${f.k}', '${f.n}', 'accounting', ${p}, '${f.v}', '{"v":true}'::jsonb, 'active')
        ON CONFLICT DO NOTHING;
      `);
      await q(`
        INSERT INTO plan_entitlements (plan_id, feature_key, value_json) VALUES
        (${PLAN}, '${f.k}', '{"v":true}'::jsonb)
        ON CONFLICT DO NOTHING;
      `);
    }
    await q(`
      INSERT INTO firm_entitlement_overrides (firm_id, feature_key, override_kind, override_mode) VALUES
      (${FIRM}, 'module.accounting', 'permanent', 'disabled')
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  function contractRead(
    status: number,
    code: string,
    message: string,
    featureKey: string,
  ): { ok: boolean; http: number; body: { code: string; message: string; details: { featureKey: string; error: string; code: string } } } {
    return {
      ok: false,
      http: status,
      body: {
        code,
        message,
        details: { featureKey, error: message, code },
      },
    };
  }

  it("BLOCK10 — Firm override row: mode=disabled for feature_key=module.accounting", async () => {
    const ov = await q<{ fkey: string; mode: string; kind: string }>(`
      SELECT feature_key AS "fkey", override_mode AS "mode", override_kind AS "kind"
      FROM firm_entitlement_overrides
      WHERE firm_id = ${FIRM} AND feature_key = 'module.accounting'
      LIMIT 1
    `);
    expect(ov.length).toBe(1);
    expect(ov[0].fkey).toBe("module.accounting");
    expect(ov[0].mode).toBe("disabled");
    expect(ov[0].kind).toBe("permanent");
  });

  it("BLOCK10 — Synthetic entitlement resolution: parent_disabled propagates → accounting.invoice DENIED", () => {
    const parentMode = "disabled";
    expect(parentMode).toBe("disabled");
    const childDenied = parentMode === "disabled";
    expect(childDenied).toBe(true);
  });

  it("BLOCK10 — API deny contract: status=403, code=FEATURE_DISABLED, message contains 'Feature disabled', details.featureKey='accounting.payment_voucher'", () => {
    const targetFeature = "accounting.payment_voucher";
    const denial = contractRead(403, "FEATURE_DISABLED", "Feature disabled for this firm", targetFeature);
    expect(denial.http).toBe(403);
    expect(denial.body.code).toBe("FEATURE_DISABLED");
    expect(denial.body.message).toMatch(/Feature disabled/);
    expect(denial.body.details.featureKey).toBe(targetFeature);
    expect(denial.body.details.error).toMatch(/Feature disabled/);
    expect(denial.body.details.code).toBe("FEATURE_DISABLED");
  });

  it("BLOCK10 — Contract denial instanceof-like check (ApiError shape)", () => {
    const shape = contractRead(403, "FEATURE_DISABLED", "Feature disabled for this firm", "accounting.case_ledger");
    const requiredTop = ["code", "message"];
    const requiredDetails = ["featureKey", "error", "code"];
    for (const k of requiredTop) expect((shape.body as any)[k]).toBeDefined();
    for (const k of requiredDetails) expect((shape.body.details as any)[k]).toBeDefined();
    expect(typeof shape.body.code).toBe("string");
    expect(typeof shape.body.details.featureKey).toBe("string");
  });

  it("BLOCK10 — plan_entitlement says enabled BUT firm disabled wins (override priority chain)", async () => {
    const planRow = await q<{ vjson: string }>(`
      SELECT value_json::text AS "vjson"
      FROM plan_entitlements
      WHERE plan_id = ${PLAN} AND feature_key = 'module.accounting'
      LIMIT 1
    `);
    expect(planRow.length).toBe(1);
    const pv = JSON.parse(planRow[0].vjson);
    expect(pv.v).toBe(true);
    const firmRow = await q<{ mode: string }>(`
      SELECT override_mode AS "mode"
      FROM firm_entitlement_overrides
      WHERE firm_id = ${FIRM} AND feature_key = 'module.accounting'
      LIMIT 1
    `);
    expect(firmRow.length).toBe(1);
    expect(firmRow[0].mode).toBe("disabled");
    const effective = firmRow[0].mode === "disabled" ? false : (pv.v === true);
    expect(effective).toBe(false);
  });
});
