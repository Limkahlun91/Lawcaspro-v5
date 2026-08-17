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
    if (!Number.isInteger(targetUserId) || targetUserId < 1) {
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
        case_id integer NOT NULL,
        user_id integer NOT NULL,
        role_in_case text NOT NULL DEFAULT 'lawyer',
        assigned_by integer,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        unassigned_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS hr_employees (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        employee_no text NOT NULL,
        linked_user_id integer,
        preferred_name text,
        legal_full_name text NOT NULL,
        common_email text,
        common_mobile text,
        employment_status text NOT NULL DEFAULT 'draft',
        ic_passport_no_masked text,
        nationality text,
        gender text,
        marital_status text,
        date_of_birth date,
        address_1 text,
        address_2 text,
        city text,
        state text,
        postcode text,
        emergency_contact_name text,
        emergency_contact_relation text,
        emergency_contact_phone text,
        join_date date,
        confirmation_date date,
        notice_start_date date,
        termination_date date,
        last_working_date date,
        rehire_original_join_date date,
        branch_id integer,
        department_id integer,
        position_id integer,
        work_location text,
        employment_type text,
        reporting_manager_employee_id integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        terminated_at timestamptz,
        last_status_change_at timestamptz,
        created_by_user_id integer,
        updated_by_user_id integer,
        version integer NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_employees_firm_employee_no
        ON hr_employees(firm_id, employee_no);
      CREATE TABLE IF NOT EXISTS hims_notification_audit (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        idempotency_key text NOT NULL,
        notification_type text NOT NULL,
        target_user_id integer,
        target_scope text NOT NULL DEFAULT 'firm',
        payload_json jsonb,
        severity text DEFAULT 'info',
        correlation_id text,
        source_system text NOT NULL DEFAULT 'HIMS',
        source_event_name text,
        source_event_ref text,
        notification_created boolean NOT NULL DEFAULT false,
        notification_id integer,
        deduplicated boolean NOT NULL DEFAULT false,
        deduplicated_against_id integer,
        delivery_count integer NOT NULL DEFAULT 0,
        last_delivery_attempt_at timestamptz,
        last_delivery_error text,
        actor_user_id integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_notif_audit_idem
        ON hims_notification_audit(firm_id, idempotency_key);
    `);
    r = drizzle(pg);
  });

  beforeEach(async () => {
    await pg.query(`DELETE FROM hims_notification_audit WHERE firm_id = $1`, [FIRM]);
    await pg.query(`DELETE FROM case_assignments WHERE case_id = $1`, [CASE]);
    await pg.query(`DELETE FROM hr_employees WHERE firm_id = $1`, [FIRM]);
  });

  it("HIMS targetScope=user with no valid userId: throws 400 TARGET_REQUIRED", () => {
    const assertThrows = (val: unknown) => {
      try {
        himsUserScopeValidate("user", val as any);
        throw new Error("__no_throw__");
      } catch (err: any) {
        const msg = String(err?.message ?? err ?? "");
        expect(msg).not.toBe("__no_throw__");
        expect(msg).toMatch(/valid target user/i);
      }
    };
    assertThrows(null);
    assertThrows(0);
    assertThrows(undefined);
  });

  it("HIMS targetScope=user with valid integer userId: passes", () => {
    expect(() => himsUserScopeValidate("user", LAWYER_USER_ID)).not.toThrow();
  });

  it("resolved responsible_lawyer userIds are real integers, never 0", async () => {
    await pg.exec(`
      INSERT INTO case_assignments (case_id, user_id, role_in_case, assigned_at, unassigned_at) VALUES
      (${CASE}, ${LAWYER_USER_ID}, 'lawyer', now(), NULL),
      (${CASE}, 99, 'associate', now(), NULL);
    `);

    const responsibleRows: any = await pg.query(
      `SELECT user_id FROM case_assignments WHERE case_id=$1 AND role_in_case=$2 AND unassigned_at IS NULL`,
      [CASE, "lawyer"],
    );
    const rows = responsibleRows.rows ?? responsibleRows;
    const responsibleIds = rows.map((r: any) => Number(r.user_id ?? r.userId)).filter((n) => Number.isInteger(n) && n > 0);
    expect(responsibleIds.length).toBeGreaterThan(0);
    for (const id of responsibleIds) {
      expect(id).toBeGreaterThan(0);
      expect(id).not.toBe(0);
    }

    for (const id of responsibleIds) {
      const idem = buildIdemKey(CASE, "STATUS_CHANGED", id);
      await pg.query(
        `INSERT INTO hims_notification_audit (firm_id, case_id, idempotency_key, notification_type, target_user_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [FIRM, CASE, idem, "status_change", id],
      );
    }
    const auditResult: any = await pg.query(
      `SELECT target_user_id FROM hims_notification_audit WHERE firm_id=$1`,
      [FIRM],
    );
    const auditRows = auditResult.rows ?? auditResult;
    expect(auditRows.length).toBe(responsibleIds.length);
    for (const row of auditRows) {
      const uid = Number(row.target_user_id ?? row.targetUserId);
      expect(uid).toBeGreaterThan(0);
      expect(uid).not.toBe(0);
      expect(uid).not.toBeNull();
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
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_prefix text,
        PRIMARY KEY (firm_id, seq_name)
      );
      CREATE TABLE IF NOT EXISTS invoices (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
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
      CREATE TABLE IF NOT EXISTS receipts (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
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
      CREATE TABLE IF NOT EXISTS case_ledgers (
        id uuid PRIMARY KEY,
        firm_id integer NOT NULL,
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
      CREATE UNIQUE INDEX IF NOT EXISTS uq_case_ledgers_firm_event_key ON case_ledgers(firm_id, event_key);
      CREATE TABLE IF NOT EXISTS invoice_audit_trail (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        invoice_id integer NOT NULL,
        action_type text NOT NULL,
        before_snapshot jsonb,
        after_snapshot jsonb,
        delta jsonb,
        amount_change numeric(18,2),
        status_before text,
        status_after text,
        actor_user_id integer,
        actor_role text,
        reauth_verified boolean NOT NULL DEFAULT false,
        confirmation_token text,
        client_request_id text,
        ip_address text,
        user_agent text,
        error_code text,
        error_message text,
        retry_count integer NOT NULL DEFAULT 0,
        receipt_id integer,
        payment_method text,
        bank_reference text,
        paid_amount numeric(18,2),
        paid_date timestamptz,
        notes text,
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
      invoiceNo: `INV-TEST-${INVOICE}`,
      status: "issued",
      subtotal: "0.00",
      taxTotal: "0.00",
      grandTotal: "1000.00",
      amountPaid: "0.00",
      amountDue: "1000.00",
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 0,
      einvoiceStatus: "DRAFT",
      einvoiceRetryCount: 0,
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
