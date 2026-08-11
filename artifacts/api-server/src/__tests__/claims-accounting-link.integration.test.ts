import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and, count } from "drizzle-orm";
import { caseLedgersTable } from "@workspace/db";
import { upsertClaimApprovedPayableLedger, buildClaimsAccountingEventKey } from "../modules/hr/claims-accounting-link.js";

const pg = new PGlite();
const r = drizzle(pg);
const FIRM = 1;
const FIRM2 = 2;

describe("Claim → Accounting automatic payable link (PART 2J)", () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (id serial);
      CREATE TABLE IF NOT EXISTS case_ledgers (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        transaction_date date,
        entry_category text,
        entry_type text,
        description text,
        amount numeric(18,2),
        debit_cents bigint NOT NULL DEFAULT 0,
        credit_cents bigint NOT NULL DEFAULT 0,
        source_type text,
        source_id text,
        source_reference text,
        event_key text,
        created_by integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (firm_id, event_key)
      )
    `);
  });
  beforeEach(async () => {
    await r.delete(caseLedgersTable).where(eq(caseLedgersTable.firmId, FIRM)).execute();
    await r.delete(caseLedgersTable).where(eq(caseLedgersTable.firmId, FIRM2)).execute();
  });

  it("Claim final approval → exactly one ledger row; retry same event_key → alreadyLinked=true", async () => {
    const eventKey = buildClaimsAccountingEventKey({ kind: "CLAIM_APPROVED_PAYABLE", claimId: 9001 });
    expect(eventKey).toBe("CLM:CLAIM_APPROVED_PAYABLE:9001");
    const res1 = await upsertClaimApprovedPayableLedger(r, {
      firmId: FIRM, caseId: 77, claimId: 9001, claimantEmployeeId: 5, claimReference: "CL-2025-0001",
      amountCents: 350_00, description: "Claim approved payable", entryDate: new Date(), actorId: 19,
    });
    expect(res1.alreadyLinked).toBe(false);
    expect(res1.ledgerId).toBeGreaterThan(0);
    const res2 = await upsertClaimApprovedPayableLedger(r, {
      firmId: FIRM, caseId: 77, claimId: 9001, claimantEmployeeId: 5, claimReference: "CL-2025-0001",
      amountCents: 350_00, description: "Claim approved payable", entryDate: new Date(), actorId: 19,
    });
    expect(res2.alreadyLinked).toBe(true);
    const [{ n }]: any[] = await r
      .select({ n: count() }).from(caseLedgersTable)
      .where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceType, "hr_claim")));
    expect(n).toBe(1);
    const [row] = await r.select().from(caseLedgersTable).where(eq(caseLedgersTable.eventKey, eventKey)).limit(1);
    expect(Number(row.creditCents)).toBe(35000);
    expect(Number(row.debitCents)).toBe(0);
    expect(row.sourceReference).toBe("CL-2025-0001");
    expect(row.sourceType).toBe("hr_claim");
  });

  it("Same claim key across two firms → two rows independently, each event_key unique within firm", async () => {
    await upsertClaimApprovedPayableLedger(r, {
      firmId: FIRM, caseId: null, claimId: 9999, claimantEmployeeId: null, claimReference: "X-F1",
      amountCents: 100_00, description: "", entryDate: new Date(), actorId: 1,
    });
    await upsertClaimApprovedPayableLedger(r, {
      firmId: FIRM2, caseId: null, claimId: 9999, claimantEmployeeId: null, claimReference: "X-F2",
      amountCents: 200_00, description: "", entryDate: new Date(), actorId: 1,
    });
    const [f1row] = await r.select().from(caseLedgersTable).where(and(eq(caseLedgersTable.firmId, FIRM), eq(caseLedgersTable.sourceId as any, "9999"))).limit(1);
    const [f2row] = await r.select().from(caseLedgersTable).where(and(eq(caseLedgersTable.firmId, FIRM2), eq(caseLedgersTable.sourceId as any, "9999"))).limit(1);
    expect(f1row.sourceReference).toBe("X-F1");
    expect(f2row.sourceReference).toBe("X-F2");
    expect(Number(f1row.creditCents)).toBe(10000);
    expect(Number(f2row.creditCents)).toBe(20000);
  });

  it("Reversal event key format has REVERSAL token", () => {
    const k = buildClaimsAccountingEventKey({ kind: "CLAIM_APPROVED_PAYABLE", claimId: 7, reversal: 1 });
    expect(k).toContain("REVERSAL:1");
  });
});
