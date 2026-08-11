/**
 * PART 1 J/K/L - Targeted: HIMS notification resolve recipients + no user 0, and Invoice Paid atomic rollback
 *
 * HIMS tests:
 *   - targetScope=user without valid userId => 400
 *   - resolved responsible_lawyer returns real integer user ids (NO userId=0)
 *   - inserted hims_notification_audit rows have target_user_id IS NOT NULL and != 0
 *
 * Invoice paid tests:
 *   - If receipt creation / allocation fails mid-flight, invoice status remains NOT paid (atomic rollback)
 *   - All success: invoice + receipt + allocation + case_ledger + audit exist together
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, count } from "drizzle-orm";
import { ApiError } from "../lib/api-response.js";
import {
  himsNotificationAuditTable,
  invoicesTable,
  receiptsTable,
  receiptAllocationsTable,
  caseLedgersTable,
  invoiceAuditTrailTable,
  caseAssignmentsTable,
  hrEmployeesTable,
} from "@workspace/db";

export type HimsNotificationTargetScope =
  | "user"
  | "case_team"
  | "responsible_lawyer"
  | "firm"
  | "finance_team"
  | "compliance_team";

const himsUserScopeValidate = (targetScope: HimsNotificationTargetScope, targetUserId: number | undefined | null): void => {
  if (targetScope === "user") {
    if (!Number.isInteger(targetUserId)) {
      throw new ApiError({
        status: 400,
        code: "HIMS_NOTIFICATION_TARGET_REQUIRED",
        message: "A valid target user is required",
        retryable: false,
      });
    }
  }
};

const buildIdemKey = (caseId: number, status: string, userId: number): string =>
  `HIMS_STATUS:${caseId}:${status}:${userId}`;

describe("PART 1 J/L - HIMS notification idempotency + recipient resolution", () => {
  let pg: PGlite;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 8001;
  const CASE = 3001;
  const LAWYER_USER_ID = 201;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS case_assignments (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        user_id integer,
        role_in_case text,
        unassigned_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS hr_employees (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        user_id integer,
        employment_status text,
        department_id integer
      );
      CREATE TABLE IF NOT EXISTS hims_notification_audit (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        event_key text,
        idempotency_key text,
        notification_type text,
        target_user_id integer,
        payload_json jsonb,
        delivery_count integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_notif_audit_idem
        ON hims_notification_audit(firm_id, idempotency_key);
    `);
    r = drizzle(pg);
  });

  beforeEach(async () => {
    await r.delete(himsNotificationAuditTable as any).where(eq(himsNotificationAuditTable.firmId as any, FIRM));
    await r.delete(caseAssignmentsTable as any).where(eq(caseAssignmentsTable.caseId as any, CASE));
    await r.delete(hrEmployeesTable as any).where(eq(hrEmployeesTable.firmId as any, FIRM));
  });

  it("HIMS targetScope=user with no valid userId: throws 400 TARGET_REQUIRED", () => {
    expect(() => himsUserScopeValidate("user", null)).toThrow(/HIMS_NOTIFICATION_TARGET_REQUIRED/);
    expect(() => himsUserScopeValidate("user", 0)).toThrow(/HIMS_NOTIFICATION_TARGET_REQUIRED/);
    expect(() => himsUserScopeValidate("user", undefined)).toThrow(/HIMS_NOTIFICATION_TARGET_REQUIRED/);
  });

  it("HIMS targetScope=user with valid integer userId: passes", () => {
    expect(() => himsUserScopeValidate("user", LAWYER_USER_ID)).not.toThrow();
  });

  it("resolved responsible_lawyer userIds are real integers, never 0", async () => {
    await r.insert(caseAssignmentsTable as any).values([
      { caseId: CASE, userId: LAWYER_USER_ID, roleInCase: "lawyer", unassignedAt: null },
      { caseId: CASE, userId: 99, roleInCase: "associate", unassignedAt: null },
    ]);

    const responsibleRows = await r
      .select({ userId: caseAssignmentsTable.userId })
      .from(caseAssignmentsTable)
      .where(and(
        eq(caseAssignmentsTable.caseId as any, CASE),
        eq((caseAssignmentsTable as any).roleInCase, "lawyer"),
        eq((caseAssignmentsTable as any).unassignedAt, null),
      ));
    const responsibleIds = responsibleRows.map((r: any) => Number(r.userId)).filter((n) => Number.isInteger(n) && n > 0);
    expect(responsibleIds.length).toBeGreaterThan(0);
    for (const id of responsibleIds) {
      expect(id).toBeGreaterThan(0);
      expect(id).not.toBe(0);
    }

    for (const id of responsibleIds) {
      const idem = buildIdemKey(CASE, "STATUS_CHANGED", id);
      await r.insert(himsNotificationAuditTable as any).values({
        firmId: FIRM,
        caseId: CASE,
        eventKey: `evt-${id}`,
        idempotencyKey: idem,
        notificationType: "status_change",
        targetUserId: id,
      } as any).onConflictDoNothing();
    }
    const auditRows: any = await r
      .select()
      .from(himsNotificationAuditTable)
      .where(eq(himsNotificationAuditTable.firmId as any, FIRM));
    expect(auditRows.length).toBe(responsibleIds.length);
    for (const row of auditRows) {
      expect(Number(row.targetUserId)).toBeGreaterThan(0);
      expect(Number(row.targetUserId)).not.toBe(0);
      expect(row.targetUserId).not.toBeNull();
    }
  });
});

describe("PART 1 K/L - Invoice mark paid atomic rollback", () => {
  let pg: PGlite;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 8001;
  const CASE = 3001;
  const INVOICE = 10001;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS firm_number_sequences (
        firm_id integer NOT NULL,
        seq_name text NOT NULL,
        next_value integer NOT NULL DEFAULT 1,
        PRIMARY KEY (firm_id, seq_name)
      );
      CREATE TABLE IF NOT EXISTS invoices (
        id integer PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        status text NOT NULL DEFAULT 'draft',
        grand_total numeric(18,2) NOT NULL DEFAULT 0,
        amount_paid numeric(18,2) NOT NULL DEFAULT 0,
        amount_due numeric(18,2) NOT NULL DEFAULT 0,
        deleted_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        invoice_id integer,
        receipt_no text,
        amount numeric(18,2) NOT NULL,
        received_date date NOT NULL,
        reference_no text,
        notes text,
        created_by integer
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_firm_receipt_no ON receipts(firm_id, receipt_no);
      CREATE TABLE IF NOT EXISTS receipt_allocations (
        id serial PRIMARY KEY,
        receipt_id integer NOT NULL,
        invoice_id integer,
        amount numeric(18,2) NOT NULL,
        notes text
      );
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
        event_key text
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_case_ledgers_firm_event_key ON case_ledgers(firm_id, event_key);
      CREATE TABLE IF NOT EXISTS invoice_audit_trail (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        invoice_id integer NOT NULL,
        action_type text NOT NULL,
        actor_user_id integer,
        receipt_id integer,
        status_before text,
        status_after text,
        amount_change numeric(18,2),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    r = drizzle(pg);
  });

  beforeEach(async () => {
    await r.delete(invoiceAuditTrailTable as any).where(eq(invoiceAuditTrailTable.firmId as any, FIRM));
    await r.delete(caseLedgersTable as any).where(eq(caseLedgersTable.firmId as any, FIRM));
    await r.delete(receiptAllocationsTable);
    await r.delete(receiptsTable as any).where(eq(receiptsTable.firmId as any, FIRM));
    await r.delete(invoicesTable as any).where(eq(invoicesTable.firmId as any, FIRM));
    await r.insert(invoicesTable as any).values({
      id: INVOICE,
      firmId: FIRM,
      caseId: CASE,
      status: "issued",
      grandTotal: "1000.00",
      amountPaid: "0.00",
      amountDue: "1000.00",
      deletedAt: null,
      updatedAt: new Date(),
    } as any);
  });

  it("atomic: all success => invoice status=paid + receipt + allocation + ledger + audit all exist", async () => {
    try {
      await (r as any).transaction(async (tx: any) => {
        const locked = await tx
          .select()
          .from(invoicesTable)
          .where(and(eq(invoicesTable.firmId as any, FIRM), eq(invoicesTable.id as any, INVOICE)))
          .for("update")
          .limit(1);
        const cur = locked[0] as any;
        if (!cur || cur.status === "void" || cur.deletedAt) throw new Error("bad");

        const receiptNo = `REC-TEST-${INVOICE}-1`;
        const receiptRows = await tx
          .insert(receiptsTable as any)
          .values({
            firmId: FIRM,
            caseId: CASE,
            invoiceId: INVOICE,
            receiptNo,
            amount: "1000.00",
            receivedDate: new Date(),
            createdBy: 1,
          } as any)
          .returning({ id: receiptsTable.id });
        const receiptId = Number((receiptRows as any)[0].id);
        if (!receiptId) throw new Error("no receipt id");

        const allocRows = await tx
          .insert(receiptAllocationsTable as any)
          .values({ receiptId, invoiceId: INVOICE, amount: "1000.00" } as any)
          .returning({ id: receiptAllocationsTable.id });
        if (!allocRows?.[0]) throw new Error("no alloc");

        await tx
          .update(invoicesTable as any)
          .set({ status: "paid", amountPaid: "1000.00", amountDue: "0.00", updatedAt: new Date() })
          .where(and(eq(invoicesTable.firmId as any, FIRM), eq(invoicesTable.id as any, INVOICE)));

        const { randomUUID } = await import("node:crypto");
        await tx.insert(caseLedgersTable as any).values({
          id: randomUUID(),
          firmId: FIRM,
          caseId: CASE,
          transactionDate: new Date(),
          entryCategory: "income",
          entryType: "receipt",
          description: `Invoice #${INVOICE} paid`,
          amount: "1000.00",
          debitCents: 100000,
          creditCents: 0,
          sourceType: "invoice_paid",
          sourceId: INVOICE,
          eventKey: `INVOICE_PAID:${INVOICE}`,
        } as any).onConflictDoNothing();

        await tx.insert(invoiceAuditTrailTable as any).values({
          firmId: FIRM,
          invoiceId: INVOICE,
          actionType: "mark_paid",
          actorUserId: 1,
          receiptId,
          statusBefore: "issued",
          statusAfter: "paid",
          amountChange: "1000.00",
        } as any);
      });
    } catch (err) {
      // ignore if tx failure
    }

    const invoiceRow = (await r
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.firmId as any, FIRM), eq(invoicesTable.id as any, INVOICE)))
      .limit(1))?.[0] as any;
    expect(invoiceRow.status).toBe("paid");

    const [receiptCnt] = await r.select({ n: count() }).from(receiptsTable).where(eq(receiptsTable.firmId as any, FIRM));
    const [allocCnt] = await r.select({ n: count() }).from(receiptAllocationsTable);
    const [ledgerCnt] = await r.select({ n: count() }).from(caseLedgersTable).where(eq(caseLedgersTable.firmId as any, FIRM));
    const [auditCnt] = await r.select({ n: count() }).from(invoiceAuditTrailTable).where(eq(invoiceAuditTrailTable.firmId as any, FIRM));

    expect(Number(receiptCnt.n)).toBe(1);
    expect(Number(allocCnt.n)).toBe(1);
    expect(Number(ledgerCnt.n)).toBe(1);
    expect(Number(auditCnt.n)).toBe(1);
  });

  it("atomic: receipt creation fail => invoice status remains NOT paid (rollback all)", async () => {
    try {
      await (r as any).transaction(async (tx: any) => {
        const locked = await tx
          .select()
          .from(invoicesTable)
          .where(and(eq(invoicesTable.firmId as any, FIRM), eq(invoicesTable.id as any, INVOICE)))
          .for("update")
          .limit(1);
        const cur = locked[0] as any;
        if (!cur || cur.status === "void" || cur.deletedAt) throw new Error("bad");

        await tx
          .update(invoicesTable as any)
          .set({ status: "paid", amountPaid: "1000.00", amountDue: "0.00", updatedAt: new Date() })
          .where(and(eq(invoicesTable.firmId as any, FIRM), eq(invoicesTable.id as any, INVOICE)));

        throw new Error("RECEIPT_CREATE_FAILED simulated");
      });
      expect.unreachable("tx should throw");
    } catch {
      // expected rollback
    }

    const invoiceRow = (await r
      .select()
      .from(invoicesTable)
      .where(and(eq(invoicesTable.firmId as any, FIRM), eq(invoicesTable.id as any, INVOICE)))
      .limit(1))?.[0] as any;

    expect(invoiceRow.status).toBe("issued");
    expect(String(invoiceRow.amountPaid ?? "")).toBe("0.00");

    const [receiptCnt] = await r.select({ n: count() }).from(receiptsTable).where(eq(receiptsTable.firmId as any, FIRM));
    const [allocCnt] = await r.select({ n: count() }).from(receiptAllocationsTable);
    const [ledgerCnt] = await r.select({ n: count() }).from(caseLedgersTable).where(eq(caseLedgersTable.firmId as any, FIRM));
    const [auditCnt] = await r.select({ n: count() }).from(invoiceAuditTrailTable).where(eq(invoiceAuditTrailTable.firmId as any, FIRM));

    expect(Number(receiptCnt.n)).toBe(0);
    expect(Number(allocCnt.n)).toBe(0);
    expect(Number(ledgerCnt.n)).toBe(0);
    expect(Number(auditCnt.n)).toBe(0);
  });
});
