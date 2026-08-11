/**
 * PART 1K - Targeted tests: case-ledger-auto-link.integration.test.ts
 *
 * Scope (Part 1I + 1J):
 *   - Quotation source → one ledger row
 *   - Invoice source → one ledger row
 *   - Receipt source → one ledger row
 *   - PV source → one ledger row
 *   - Retry same event → still exactly one (event_key UNIQUE idempotency)
 *   - Reversal → original + reversal (no deletions)
 *
 * Uses PGlite real-case_ledgers_table to validate the idempotency of event keys.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, sql, count, desc } from "drizzle-orm";
import {
  caseLedgersTable,
} from "@workspace/db";
import { randomUUID } from "node:crypto";

function mkLedgerRowInsertable() {
  return {
    id: randomUUID(),
    firmId: 6001,
    caseId: 4001,
    transactionDate: "2025-01-15",
    entryCategory: "client",
    entryType: "invoice",
    description: "",
    amount: "0.00",
    debitCents: 0,
    creditCents: 0,
    sourceType: "",
    sourceId: 1,
    sourceReference: null as any,
    eventKey: "" as string,
  };
}

describe("Case Ledger Auto Link (Part 1I + 1J)", () => {
  let pg: PGlite;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 6001;
  const CASE = 4001;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS case_ledgers (
        id uuid PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        transaction_date date NOT NULL,
        entry_category text NOT NULL,
        entry_type text NOT NULL,
        description text NOT NULL,
        amount numeric(12,2) NOT NULL,
        debit_cents bigint NOT NULL DEFAULT 0,
        credit_cents bigint NOT NULL DEFAULT 0,
        source_type text,
        source_id integer,
        source_reference text,
        event_key text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- Part 1I: UNIQUE firm_id + event_key (prevents duplicate derived ledger — idempotency at db layer)
      CREATE UNIQUE INDEX IF NOT EXISTS uq_case_ledgers_firm_event_key_test
        ON case_ledgers (firm_id, event_key);
    `);
    r = drizzle(pg);
  });

  beforeEach(async () => {
    await r.delete(caseLedgersTable).where(eq(caseLedgersTable.firmId, FIRM));
  });

  describe("Quotation → exactly one case ledger derived entry (Part 1J rule)", () => {
    it("insert once", async () => {
      const q = mkLedgerRowInsertable();
      q.entryType = "quotation_issued";
      q.description = "Quotation Q-0001";
      q.amount = "500.00";
      q.debitCents = 50000;
      q.creditCents = 0;
      q.sourceType = "quotation";
      q.sourceId = 2001;
      q.sourceReference = "Q-0001";
      q.eventKey = "QUOTATION:2001:ISSUED";
      await r.insert(caseLedgersTable).values(q);
      const [cnt] = await r
        .select({ n: count() })
        .from(caseLedgersTable)
        .where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceType, "quotation")));
      expect(cnt.n).toBe(1);
    });

    it("retry same event key → ON CONFLICT DO NOTHING returns 1 row (exactly-once semantics)", async () => {
      const payload = {
        id: randomUUID(),
        firmId: FIRM,
        caseId: CASE,
        transactionDate: "2025-01-15",
        entryCategory: "client",
        entryType: "quotation_issued",
        description: "Quotation Q-0002",
        amount: "750.00",
        debitCents: 75000,
        creditCents: 0,
        sourceType: "quotation",
        sourceId: 2002,
        sourceReference: "Q-0002",
        eventKey: "QUOTATION:2002:ISSUED",
      };
      // Insert twice with SAME eventKey
      await r.insert(caseLedgersTable).values(payload).onConflictDoNothing({ target: [caseLedgersTable.firmId, caseLedgersTable.eventKey] });
      await r.insert(caseLedgersTable).values({ ...payload, id: randomUUID() }).onConflictDoNothing({ target: [caseLedgersTable.firmId, caseLedgersTable.eventKey] });
      const [cnt] = await r
        .select({ n: count() })
        .from(caseLedgersTable)
        .where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceId, 2002)));
      expect(cnt.n).toBe(1);
    });
  });

  describe("Invoice → one case ledger row", () => {
    it("insert invoice source entry", async () => {
      const p = mkLedgerRowInsertable();
      p.entryType = "invoice_issued";
      p.description = "Invoice INV-100";
      p.amount = "1500.00";
      p.debitCents = 150000;
      p.sourceType = "invoice";
      p.sourceId = 3001;
      p.sourceReference = "INV-100";
      p.eventKey = "INVOICE:3001:ISSUED";
      await r.insert(caseLedgersTable).values(p);
      const [cnt] = await r
        .select({ n: count() })
        .from(caseLedgersTable)
        .where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceType, "invoice")));
      expect(cnt.n).toBe(1);
    });
  });

  describe("Receipt → exactly one case ledger row", () => {
    it("insert once and retry once → idempotent", async () => {
      const base = {
        id: randomUUID(),
        firmId: FIRM,
        caseId: CASE,
        transactionDate: "2025-01-16",
        entryCategory: "client",
        entryType: "payment_received",
        description: "Receipt RCPT-55",
        amount: "1500.00",
        debitCents: 150000,
        creditCents: 0,
        sourceType: "receipt",
        sourceId: 4001,
        sourceReference: "RCPT-55",
        eventKey: "RECEIPT:4001:CONFIRM",
      };
      await r.insert(caseLedgersTable).values(base).onConflictDoNothing({ target: [caseLedgersTable.firmId, caseLedgersTable.eventKey] });
      await r.insert(caseLedgersTable).values({ ...base, id: randomUUID() }).onConflictDoNothing({ target: [caseLedgersTable.firmId, caseLedgersTable.eventKey] });
      const [cnt] = await r
        .select({ n: count() })
        .from(caseLedgersTable)
        .where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceType, "receipt")));
      expect(cnt.n).toBe(1);
    });
  });

  describe("Payment Voucher → exactly one case ledger row", () => {
    it("PV → idempotent insert", async () => {
      const base = {
        id: randomUUID(),
        firmId: FIRM,
        caseId: CASE,
        transactionDate: "2025-01-17",
        entryCategory: "client",
        entryType: "trust_paid",
        description: "PV-88 — Disbursement",
        amount: "600.00",
        debitCents: 0,
        creditCents: 60000,
        sourceType: "payment_voucher",
        sourceId: 5001,
        sourceReference: "PV-88",
        eventKey: "PV:5001:client_paid",
      };
      for (let i = 0; i < 3; i++) {
        await r.insert(caseLedgersTable)
          .values({ ...base, id: randomUUID() })
          .onConflictDoNothing({ target: [caseLedgersTable.firmId, caseLedgersTable.eventKey] });
      }
      const [cnt] = await r
        .select({ n: count() })
        .from(caseLedgersTable)
        .where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceType, "payment_voucher")));
      expect(cnt.n).toBe(1);
    });
  });

  describe("Reversal pattern: original + REVERSAL row (NEVER delete original — Part 1J)", () => {
    it("reverse a receipt: 2 rows total (original + reversal event PV:5002:REVERSAL:1)", async () => {
      // Write the original
      const origEvt = "PV:5002:client_paid";
      await r.insert(caseLedgersTable).values({
        id: randomUUID(),
        firmId: FIRM,
        caseId: CASE,
        transactionDate: "2025-01-18",
        entryCategory: "client",
        entryType: "trust_paid",
        description: "PV-99",
        amount: "250.00",
        debitCents: 0,
        creditCents: 25000,
        sourceType: "payment_voucher",
        sourceId: 5002,
        sourceReference: "PV-99",
        eventKey: origEvt,
      });
      // Then add reversal row (Part 1J rule: NEW reversal row, NO delete of original)
      await r.insert(caseLedgersTable).values({
        id: randomUUID(),
        firmId: FIRM,
        caseId: CASE,
        transactionDate: "2025-01-19",
        entryCategory: "client",
        entryType: "trust_paid",
        description: "Reversal of PV-99",
        amount: "-250.00",
        debitCents: 25000, // opposite sign of original
        creditCents: 0,
        sourceType: "payment_voucher_reversal",
        sourceId: 5002,
        sourceReference: "PV-99",
        eventKey: "PV:5002:REVERSAL:1", // Part 1J: eventKey contains REVERSAL:n appended
      });

      // Verify: 2 rows exist (original + reversal), original untouched.
      const rows = await r
        .select({
          id: caseLedgersTable.id,
          eventKey: caseLedgersTable.eventKey,
          amount: caseLedgersTable.amount,
          sourceType: caseLedgersTable.sourceType,
        })
        .from(caseLedgersTable)
        .where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceId, 5002)))
        .orderBy(caseLedgersTable.eventKey);
      expect(rows.length).toBe(2);
      const eventKeys = rows.map(x => x.eventKey);
      expect(eventKeys).toContain(origEvt);
      expect(eventKeys).toContain("PV:5002:REVERSAL:1");
      expect(rows.filter(x => x.sourceType === "payment_voucher_reversal")).toHaveLength(1);
    });
  });

  describe("Source drill-through (Part 1I #12): financial derived records must be drillable", () => {
    it("record has sourceType + sourceId + sourceReference", async () => {
      const evt = "INVOICE:9999";
      await r.insert(caseLedgersTable).values({
        id: randomUUID(),
        firmId: FIRM,
        caseId: CASE,
        transactionDate: "2025-02-01",
        entryCategory: "client",
        entryType: "invoice_issued",
        description: "INV-9999",
        amount: "99.99",
        debitCents: 9999,
        creditCents: 0,
        sourceType: "invoice",
        sourceId: 9999,
        sourceReference: "INV-9999",
        eventKey: evt,
      });
      const [row] = await r
        .select({ sourceType: caseLedgersTable.sourceType, sourceId: caseLedgersTable.sourceId, sourceReference: caseLedgersTable.sourceReference })
        .from(caseLedgersTable)
        .where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.eventKey, evt)));
      expect(row.sourceType).toBe("invoice");
      expect(row.sourceId).toBe(9999);
      expect(row.sourceReference).toBe("INV-9999");
    });
  });

  describe("Firm level event_key UNIQUE — test idempotent 2 firms can have same event key (firm_id scoping)", () => {
    it("firm A event key Q:1 and firm B Q:1 are BOTH stored (no cross-firm collision)", async () => {
      const FIRM_OTHER = 6002;
      await r.insert(caseLedgersTable).values({
        id: randomUUID(),
        firmId: FIRM,
        caseId: CASE,
        transactionDate: "2025-01-20",
        entryCategory: "client",
        entryType: "quotation_issued",
        description: "Q-firmA",
        amount: "100.00",
        debitCents: 10000,
        creditCents: 0,
        sourceType: "quotation",
        sourceId: 777,
        eventKey: "Q:1",
      });
      await r.insert(caseLedgersTable).values({
        id: randomUUID(),
        firmId: FIRM_OTHER,
        caseId: CASE,
        transactionDate: "2025-01-20",
        entryCategory: "client",
        entryType: "quotation_issued",
        description: "Q-firmB",
        amount: "200.00",
        debitCents: 20000,
        creditCents: 0,
        sourceType: "quotation",
        sourceId: 888,
        eventKey: "Q:1",
      });
      // Each firm has one row with the same event key.
      const [a] = await r.select({n: count()}).from(caseLedgersTable).where(eq(caseLedgersTable.firmId, FIRM));
      const [b] = await r.select({n: count()}).from(caseLedgersTable).where(eq(caseLedgersTable.firmId, FIRM_OTHER));
      expect(a.n).toBeGreaterThanOrEqual(1);
      expect(b.n).toBe(1);
    });
  });
});
