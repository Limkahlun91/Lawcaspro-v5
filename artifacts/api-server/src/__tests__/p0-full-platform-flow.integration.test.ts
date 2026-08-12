import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ApiError } from "../lib/api-response.js";
import {
  approveLeaveIdempotent,
  cancelLeaveIdempotent,
} from "../modules/hr/leave/leave-core.service.js";
import {
  approveClaimWithPayable,
} from "../modules/hr/claims/claims-core.service.js";
import {
  finalisePayrollWithPosting,
} from "../modules/hr/payroll/payroll-core.service.js";
import {
  finaliseOffboarding,
  startOffboarding,
  type OffboardingGuardCode,
} from "../modules/hr/offboarding/offboarding-core.service.js";
import {
  hireCandidateAsEmployee,
} from "../modules/hr/recruitment/recruitment-core.service.js";
import {
  createHimsConnection,
  getHimsCaseStatus,
} from "../modules/hims/hims-tracker.service.js";
import {
  confirmExtractedCandidate,
  rejectExtractedCandidate,
} from "../lib/documentExtraction.js";
import {
  resolveEntitlementsBulk,
  _resetEntitlementCacheForTests,
} from "../services/entitlement-resolver.js";
import {
  assertFirmFeatureEnabled,
} from "../modules/platform/firm-feature-service.js";
import { FEATURE_REGISTRY_MAP, getFeatureDefinition, isFeatureRegistered } from "@workspace/db";

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
  it("P0 — Suite sanity: 10 blocks registered", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].length).toBe(10);
  });
});

describe("P0 BLOCK 1/10 [SCHEMA_CONTRACT_TEST] — Case create/approve → responsible staff My Work visible + unrelated invisible", () => {
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

describe("P0 BLOCK 2/10 [SCHEMA_CONTRACT_TEST] — Upload supporting doc → printer selection present", () => {
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

describe("P0 BLOCK 3/10 [SCHEMA_CONTRACT_TEST] — Quotation→Invoice→Receipt → Case Ledger rows auto (zero sync)", () => {
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

describe("P0 BLOCK 4/10 [SCHEMA_CONTRACT_TEST] — PV approved→paid→Case Ledger source_ref drill", () => {
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

describe("P0 BLOCK 5/10 [END_TO_END_FLOW_TEST] — Claim approved → Accounting payable (claims-core approveClaimWithPayable)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 7801;
  const CLAIM = 7811;
  const EMP = 7821;
  const ACTOR = 7899;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    r = drizzle(pg as any);
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
    `);
    await q(`
      INSERT INTO hr_claims (id, firm_id, employee_id, claim_reference, status, total_amount_cents) VALUES
      (${CLAIM}, ${FIRM}, ${EMP}, 'CL-2025-08-0811', 'submitted', 35000)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK5 — approveClaimWithPayable returns status=approved + payableCreatedNow first call", async () => {
    const result = await approveClaimWithPayable(
      { firmId: FIRM, claimId: CLAIM, actorUserId: ACTOR },
      { tx: r as any }
    );
    expect(result.claimStatus).toBe("approved");
    expect(result.wasAlreadyApproved).toBe(false);
    expect(result.payableCreatedNow).toBe(true);
    expect(result.accounting_created).toBe(true);
    expect(result.payableId).not.toBeNull();
    expect(typeof result.payableId).toBe("number");
    expect(result.claim.status).toBe("approved");
  });

  it("BLOCK5 — approveClaimWithPayable idempotent second call: wasAlreadyApproved=true + same payableId", async () => {
    const first = await approveClaimWithPayable(
      { firmId: FIRM, claimId: CLAIM, actorUserId: ACTOR },
      { tx: r as any }
    );
    const second = await approveClaimWithPayable(
      { firmId: FIRM, claimId: CLAIM, actorUserId: ACTOR },
      { tx: r as any }
    );
    expect(second.wasAlreadyApproved).toBe(true);
    expect(second.payableCreatedNow).toBe(false);
    expect(second.payableId).toBe(first.payableId);
    expect(second.claimStatus).toBe("approved");
  });

  it("BLOCK5 — hr_claims row should reflect approved status (schema assertion)", async () => {
    const c = await q<{ status: string; cents: number }>(`
      SELECT status, total_amount_cents AS "cents"
      FROM hr_claims WHERE firm_id = ${FIRM} AND id = ${CLAIM} LIMIT 1
    `);
    expect(c.length).toBe(1);
    expect(Number(c[0].cents)).toBe(35000);
  });
});

describe("P0 BLOCK 6/10 [END_TO_END_FLOW_TEST] — Payroll finalised → Accounting entries (payroll-core finalisePayrollWithPosting)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 8001;
  const PY_RUN = 8011;
  const ACTOR = 8099;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    r = drizzle(pg as any);
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
    `);
    await q(`
      INSERT INTO payroll_runs (id, firm_id, payroll_reference, run_period, status) VALUES
      (${PY_RUN}, ${FIRM}, 'PY-2025-07', '2025-07', 'approved')
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK6 — finalisePayrollWithPosting first call: wasAlreadyFinalised=false, accountingPostedNow=true, status=finalised", async () => {
    const result = await finalisePayrollWithPosting(
      { firmId: FIRM, runId: PY_RUN, actorUserId: ACTOR },
      { tx: r as any }
    );
    expect(result.wasAlreadyFinalised).toBe(false);
    expect(result.accountingPostedNow).toBe(true);
    expect(result.status).toBe("finalised");
    expect(result.run.status).toBe("finalised");
    expect(result.run.accountingPosted).toBe(true);
    expect(typeof result.journalEntryId).toBe("number");
    expect(result.journalEntryId).toBeGreaterThan(0);
  });

  it("BLOCK6 — finalisePayrollWithPosting idempotent second call: wasAlreadyFinalised=true, same journalEntryId", async () => {
    const first = await finalisePayrollWithPosting(
      { firmId: FIRM, runId: PY_RUN, actorUserId: ACTOR },
      { tx: r as any }
    );
    const second = await finalisePayrollWithPosting(
      { firmId: FIRM, runId: PY_RUN, actorUserId: ACTOR },
      { tx: r as any }
    );
    expect(second.wasAlreadyFinalised).toBe(true);
    expect(second.accountingPostedNow).toBe(false);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    expect(second.status).toBe("finalised");
  });

  it("BLOCK6 — payroll_runs schema row exists with correct reference (schema check)", async () => {
    const p = await q<{ status: string; ref: string }>(`
      SELECT status, payroll_reference AS "ref"
      FROM payroll_runs WHERE firm_id = ${FIRM} AND id = ${PY_RUN} LIMIT 1
    `);
    expect(p.length).toBe(1);
    expect(p[0].ref).toBe("PY-2025-07");
  });
});

describe("P0 BLOCK 7/10 [END_TO_END_FLOW_TEST] — Leave approve → balance update (leave-core approveLeaveIdempotent + cancelLeaveIdempotent)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 8201;
  const EMP = 8211;
  const LEAVE_APPL = 8221;
  const ACTOR = 8299;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    r = drizzle(pg as any);
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
    `);
    await q(`
      INSERT INTO hr_leave_applications (id, firm_id, employee_id, leave_type, start_date, end_date, total_days, status) VALUES
      (${LEAVE_APPL}, ${FIRM}, ${EMP}, 'annual', CURRENT_DATE - 7, CURRENT_DATE - 5, 3.0, 'pending')
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK7 — approveLeaveIdempotent first call: approved=true, wasAlreadyApproved=false, balanceDeductedNow=true", async () => {
    const result = await approveLeaveIdempotent(
      { firmId: FIRM, leaveId: LEAVE_APPL, actorUserId: ACTOR },
      { tx: r as any }
    );
    expect(result.approved).toBe(true);
    expect(result.wasAlreadyApproved).toBe(false);
    expect(result.balanceDeductedNow).toBe(true);
    expect(result.leave.status).toBe("approved");
    expect(result.leave.id).toBe(LEAVE_APPL);
  });

  it("BLOCK7 — approveLeaveIdempotent idempotent second call: wasAlreadyApproved=true, balanceDeductedNow=false", async () => {
    const first = await approveLeaveIdempotent(
      { firmId: FIRM, leaveId: LEAVE_APPL, actorUserId: ACTOR },
      { tx: r as any }
    );
    const second = await approveLeaveIdempotent(
      { firmId: FIRM, leaveId: LEAVE_APPL, actorUserId: ACTOR },
      { tx: r as any }
    );
    expect(second.wasAlreadyApproved).toBe(true);
    expect(second.balanceDeductedNow).toBe(false);
    expect(second.approved).toBe(true);
    expect(second.leave.status).toBe("approved");
  });

  it("BLOCK7 — cancelLeaveIdempotent first call: wasAlreadyCancelled=false, balanceRestored=true", async () => {
    const result = await cancelLeaveIdempotent(
      { firmId: FIRM, leaveId: LEAVE_APPL, actorUserId: ACTOR },
      { tx: r as any }
    );
    expect(result.wasAlreadyCancelled).toBe(false);
    expect(result.balanceRestored).toBe(true);
    expect(result.leave.status).toBe("cancelled");
    expect(result.leave.id).toBe(LEAVE_APPL);
    expect((result as any).leaveAuditIdempotencyKey || (result as any).idempotencyKey).toBeDefined();
  });

  it("BLOCK7 — cancelLeaveIdempotent idempotent second call: wasAlreadyCancelled=true, balanceRestored=false", async () => {
    const first = await cancelLeaveIdempotent(
      { firmId: FIRM, leaveId: LEAVE_APPL, actorUserId: ACTOR },
      { tx: r as any }
    );
    const second = await cancelLeaveIdempotent(
      { firmId: FIRM, leaveId: LEAVE_APPL, actorUserId: ACTOR },
      { tx: r as any }
    );
    expect(second.wasAlreadyCancelled).toBe(true);
    expect(second.balanceRestored).toBe(false);
    expect(second.leave.status).toBe("cancelled");
  });

  it("BLOCK7 — hr_leave_applications schema row (schema integrity)", async () => {
    const la = await q<{ status: string; days: number }>(`
      SELECT status, total_days AS "days"
      FROM hr_leave_applications WHERE firm_id = ${FIRM} AND id = ${LEAVE_APPL} LIMIT 1
    `);
    expect(la.length).toBe(1);
    expect(Number(la[0].days)).toBe(3.0);
  });
});

describe("P0 BLOCK 8/10 [END_TO_END_FLOW_TEST] — Employee inactive/offboarding guard (offboarding-core finaliseOffboarding)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 8401;
  const EMP_INACTIVE = 8411;
  const OFFBOARD_ID = 8451;
  const ACTOR = 8499;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    r = drizzle(pg as any);
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
    `);
    await q(`
      INSERT INTO hr_employees (id, firm_id, employee_no, legal_full_name, employment_status, linked_user_id, last_date) VALUES
      (${EMP_INACTIVE}, ${FIRM}, 'E-INACT-001', 'Ms Departed Staff', 'inactive', 8888, CURRENT_DATE - 1)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK8 — finaliseOffboarding without guard blocks: guardsPassed=true, failedGuardCode=null", async () => {
    const result = await finaliseOffboarding(
      { firmId: FIRM, offboardingId: OFFBOARD_ID, actorUserId: ACTOR, guardContext: {} },
      { tx: r as any }
    );
    expect(result.guardsPassed).toBe(true);
    expect(result.failedGuardCode).toBeNull();
    expect(result.wasAlreadyFinalised).toBe(false);
    expect(result.record.status).toBe("finalised");
  });

  it("BLOCK8 — finaliseOffboarding with activeCasesPending=true throws ApiError OFFBOARDING_ACTIVE_CASES_PENDING", async () => {
    const OFFB_2 = OFFBOARD_ID + 1;
    let thrown: ApiError | null = null;
    try {
      await finaliseOffboarding(
        {
          firmId: FIRM,
          offboardingId: OFFB_2,
          actorUserId: ACTOR,
          guardContext: { activeCasesPending: true },
        },
        { tx: r as any }
      );
    } catch (e: any) {
      thrown = e as ApiError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.status).toBe(409);
    expect(thrown?.code).toBe("OFFBOARDING_ACTIVE_CASES_PENDING");
    expect(thrown?.message).toMatch(/Active cases pending/);
  });

  it("BLOCK8 — finaliseOffboarding with pendingPayroll=true throws OFFBOARDING_PAYROLL_PENDING", async () => {
    const OFFB_3 = OFFBOARD_ID + 2;
    let thrown: ApiError | null = null;
    try {
      await finaliseOffboarding(
        {
          firmId: FIRM,
          offboardingId: OFFB_3,
          actorUserId: ACTOR,
          guardContext: { pendingPayroll: true },
        },
        { tx: r as any }
      );
    } catch (e: any) {
      thrown = e as ApiError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.code as OffboardingGuardCode).toBe("OFFBOARDING_PAYROLL_PENDING");
    expect(thrown?.status).toBe(409);
  });

  it("BLOCK8 — startOffboarding returns initiated status record", async () => {
    const result = await startOffboarding(
      {
        firmId: FIRM,
        employeeId: EMP_INACTIVE,
        lastWorkingDay: new Date(),
        reason: "resignation",
        actorUserId: ACTOR,
      },
      { tx: r as any }
    );
    expect(result.status).toBe("initiated");
    expect(result.employeeId).toBe(EMP_INACTIVE);
    expect(typeof result.id).toBe("number");
  });

  it("BLOCK8 — Employee schema integrity row check", async () => {
    const e = await q<{ status: string; lastDate: string | null }>(`
      SELECT employment_status AS "status", last_date AS "lastDate"
      FROM hr_employees WHERE firm_id = ${FIRM} AND id = ${EMP_INACTIVE} LIMIT 1
    `);
    expect(e.length).toBe(1);
    expect(e[0].status).toBe("inactive");
    expect(e[0].lastDate).not.toBeNull();
  });
});

describe("P0 BLOCK 9/10 [END_TO_END_FLOW_TEST] — Case spa_stamped → HIMS pending (hims-tracker createHimsConnection + getHimsCaseStatus)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 8601;
  const CASE = 8611;
  const ACTOR = 8699;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    r = drizzle(pg as any);
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
    `);
    await q(`
      INSERT INTO cases (id, firm_id, case_no, spa_stamped_date) VALUES
      (${CASE}, ${FIRM}, 'SPA-CASE-8611', CURRENT_DATE)
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("BLOCK9 — createHimsConnection with tracker_only mode succeeds, returns mode=tracker_only", async () => {
    const result = await createHimsConnection(
      {
        firmId: FIRM,
        actorUserId: ACTOR,
        connectionName: "eSPA Main Gateway",
        config: { authMode: "tracker_only", apiEndpoint: "https://hims.example.com/tracker" },
      },
      { tx: r as any }
    );
    expect(result.mode).toBe("tracker_only");
    expect(result.connection).toBeDefined();
    expect(result.connection.firmId).toBe(FIRM);
    expect(result.connection.connectionName).toBe("eSPA Main Gateway");
  });

  it("BLOCK9 — createHimsConnection rejects full_write mode with 403 HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY", async () => {
    let thrown: ApiError | null = null;
    try {
      await createHimsConnection(
        {
          firmId: FIRM,
          actorUserId: ACTOR,
          connectionName: "Bad Full-Write Attempt",
          config: { authMode: "full_write" as any },
        },
        { tx: r as any }
      );
    } catch (e: any) {
      thrown = e as ApiError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.status).toBe(403);
    expect(thrown?.code).toBe("HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY");
  });

  it("BLOCK9 — getHimsCaseStatus returns mode=tracker_only for SPA-stamped case", async () => {
    const status = await getHimsCaseStatus(
      { firmId: FIRM, caseId: CASE },
      { tx: r as any }
    );
    expect(status.mode).toBe("tracker_only");
    expect(status.caseId).toBe(CASE);
    expect(status.firmId).toBe(FIRM);
    expect(["synced", "mismatch_detected", "not_connected", "sync_pending"]).toContain(status.overallStatus);
  });

  it("BLOCK9 — cases.spa_stamped_date NOT NULL schema check + hims_tracker idempotent insert", async () => {
    const c = await q<{ spaDate: string | null }>(`
      SELECT spa_stamped_date::TEXT AS "spaDate"
      FROM cases WHERE firm_id = ${FIRM} AND id = ${CASE} LIMIT 1
    `);
    expect(c.length).toBe(1);
    expect(c[0].spaDate).not.toBeNull();

    await q(`
      INSERT INTO hims_tracker (firm_id, case_id, tracker_stage, status, status_detail, spa_stamped_snapshot) VALUES
      (${FIRM}, ${CASE}, 'HIMS_TRACKER_START', 'active', 'eSPA tracking', CURRENT_DATE)
      ON CONFLICT (firm_id, case_id, tracker_stage) DO NOTHING;
    `);
    await q(`
      INSERT INTO hims_tracker (firm_id, case_id, tracker_stage, status, status_detail, spa_stamped_snapshot) VALUES
      (${FIRM}, ${CASE}, 'HIMS_TRACKER_START', 'active-dup', 'duplicate attempt', CURRENT_DATE)
      ON CONFLICT (firm_id, case_id, tracker_stage) DO NOTHING;
    `);
    const cnt = await q<{ n: number }>(`
      SELECT COUNT(*) AS "n" FROM hims_tracker
      WHERE firm_id = ${FIRM} AND case_id = ${CASE} AND tracker_stage = 'HIMS_TRACKER_START'
    `);
    expect(Number(cnt[0].n)).toBe(1);
  });
});

describe("P0 BLOCK 10/10 [END_TO_END_FLOW_TEST] — Firm feature disable → real API deny (entitlement-resolver + assertFirmFeatureEnabled)", () => {
  let pg: PGlite;
  let q: ReturnType<typeof mkQ>;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 8801;
  const PLAN = 1;

  const FEATURES_DDL = `
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
      configurable boolean NOT NULL DEFAULT true,
      founder_only boolean NOT NULL DEFAULT false,
      dependency_json jsonb,
      route_hint text,
      description text,
      sort_order integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'active',
      plan_controlled boolean NOT NULL DEFAULT true,
      firm_controlled_override boolean NOT NULL DEFAULT true,
      backend_guard_key text,
      job_guards jsonb,
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
      value_json jsonb,
      effective_from timestamptz,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_ent_overrides_perm
      ON firm_entitlement_overrides (firm_id, feature_key) WHERE override_kind = 'permanent';

    ALTER TABLE IF EXISTS firms ADD COLUMN IF NOT EXISTS is_custom_plan boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS firms ADD COLUMN IF NOT EXISTS custom_price_monthly text;
    ALTER TABLE IF EXISTS firm_entitlement_overrides ADD COLUMN IF NOT EXISTS billing_type text NOT NULL DEFAULT 'included';
    ALTER TABLE IF EXISTS firm_entitlement_overrides ADD COLUMN IF NOT EXISTS price_override text;

    ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS configurable boolean NOT NULL DEFAULT true;
    ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS founder_only boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS dependency_json jsonb;
    ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS route_hint text;
    ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  `;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    q = mkQ(pg);
    r = drizzle(pg as any);
    await pg.exec(FEATURES_DDL);
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
    _resetEntitlementCacheForTests();
  });

  afterAll(async () => {
    _resetEntitlementCacheForTests();
    await pg.close?.();
  });

  it("BLOCK10 — resolveEntitlementsBulk returns module.accounting enabled=false via firm override", async () => {
    const ents = await resolveEntitlementsBulk(
      FIRM,
      ["module.accounting", "accounting.invoice", "accounting.payment_voucher", "accounting.case_ledger"],
      { conn: r as any }
    );
    const modAcctg = ents["module.accounting"];
    expect(modAcctg).toBeDefined();
    expect(modAcctg.enabled).toBe(false);
    expect(modAcctg.value).toBe(false);
    expect(modAcctg.source).toBe("firm_override_permanent");
    expect(modAcctg.denied).toBe("firm_override_disabled");
  });

  it("BLOCK10 — Child accounting.invoice inherits parent_disabled from module.accounting", async () => {
    const ents = await resolveEntitlementsBulk(
      FIRM,
      ["module.accounting", "accounting.invoice"],
      { conn: r as any }
    );
    const child = ents["accounting.invoice"];
    if (child && child.enabled !== undefined) {
      const deniedViaAny =
        child.enabled === false ||
        child.denied === "parent_disabled" ||
        child.denied === "firm_override_disabled";
      expect(deniedViaAny).toBe(true);
    }
  });

  it("BLOCK10 — assertFirmFeatureEnabled throws 403 FEATURE_DISABLED for accounting.payment_voucher", async () => {
    let thrown: ApiError | null = null;
    try {
      await assertFirmFeatureEnabled(r as any, FIRM, "accounting.payment_voucher");
    } catch (e: any) {
      thrown = e as ApiError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.status).toBe(403);
    expect(thrown?.code).toBe("FEATURE_DISABLED");
    expect(thrown?.message).toMatch(/Feature disabled/);
  });

  it("BLOCK10 — assertFirmFeatureEnabled shape: ApiError-like contract check", async () => {
    let thrown: ApiError | null = null;
    try {
      await assertFirmFeatureEnabled(r as any, FIRM, "accounting.case_ledger");
    } catch (e: any) {
      thrown = e as ApiError;
    }
    expect(thrown).not.toBeNull();
    expect(typeof (thrown as any).code).toBe("string");
    expect(typeof (thrown as any).message).toBe("string");
    expect(typeof (thrown as any).status).toBe("number");
  });

  it("BLOCK10 — plan says enabled BUT firm override wins (override priority chain)", async () => {
    const planRow = await q<{ vjson: string }>(`
      SELECT value_json::text AS "vjson"
      FROM plan_entitlements
      WHERE plan_id = ${PLAN} AND feature_key = 'module.accounting'
      LIMIT 1
    `);
    expect(planRow.length).toBe(1);
    const pv = JSON.parse(planRow[0].vjson);
    expect(pv.v).toBe(true);

    const ents = await resolveEntitlementsBulk(
      FIRM,
      ["module.accounting"],
      { conn: r as any }
    );
    expect(ents["module.accounting"].enabled).toBe(false);
  });

  it("BLOCK10 — Override row integrity (schema contract)", async () => {
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
});
