/**
 * Billing Ledger Service — APPEND-ONLY ledger for platform billing per firm.
 *
 * Rules:
 *   - Never UPDATE or DELETE rows in billing_ledger.
 *   - Every correction is a NEW row with entry_type reversal/credit_note/debit_note/adjustment.
 *   - running_balance is computed on-the-fly via window function when reading,
 *     and also stored on each INSERT for fast lookups (via trigger/function on server side is ideal;
 *     in application code we compute running balance before insert).
 *
 * Entry types:
 *   - subscription_charge: Monthly base plan charge
 *   - usage_charge: Overage on usage-based limits (e.g. OCR pages over limit)
 *   - addon_charge: Paid add-on (e.g. HR module, extra storage tier)
 *   - adjustment: Manual +/- adjustment (discount, rounding, goodwill)
 *   - reversal: Cancel previous charge (same abs value, opposite sign)
 *   - credit_note: Reduce amount owed
 *   - debit_note: Increase amount owed
 *   - payment: Incoming payment (credit side)
 *   - refund: Outgoing refund (debit side)
 *   - write_off: Cancel uncollectable balance
 *   - rounding: FX / rounding delta
 *   - complimentary: Founder-entered comp / zero-dollar charge for addon (audit trail)
 */

import { and, eq, gte, desc, sql, asc } from "drizzle-orm";
import {
  db,
  firmsTable,
  billingLedgerTable,
  firmInvoicesTable,
  subscriptionPlansTable,
  type InsertBillingLedgerEntry,
  type AppDb,
  type RlsDb,
} from "@workspace/db";
import { ApiError } from "../lib/api-response.js";
import { logger } from "../lib/logger.js";

export type BillingEntryType =
  | "subscription_charge"
  | "usage_charge"
  | "addon_charge"
  | "adjustment"
  | "reversal"
  | "credit_note"
  | "debit_note"
  | "payment"
  | "refund"
  | "write_off"
  | "rounding"
  | "complimentary";

export interface NewLedgerEntry {
  firmId: number;
  subscriptionId?: number | null;
  invoiceId?: number | null;
  idempotencyKey?: string | null;
  entryType: BillingEntryType;
  description: string;
  billingPeriodStart?: string | Date | null;
  billingPeriodEnd?: string | Date | null;
  debit?: number | string | null;
  credit?: number | string | null;
  currency?: string;
  referenceNo?: string | null;
  correlationId?: string | null;
  sourceType?: string | null;
  sourceId?: number | null;
  dueDate?: string | Date | null;
  paidDate?: string | Date | null;
  status?: "pending" | "posted" | "voided";
  paymentReference?: string | null;
  paymentMethod?: string | null;
  createdBy?: number | null;
}

const toNum = (v: number | string | null | undefined): string => {
  if (v === null || v === undefined) return "0.00";
  if (typeof v === "number") return v.toFixed(2);
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
};

function toDateStringOrNull(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

export const BILLING_LEDGER_FIRM_LOCK_NAMESPACE = 0x4C43424Cn; // "LCBL" ascii for LawCaseBillingLedger

// Stable numeric hash for advisory lock key (firm_id -> bigint).
// We use a simple 32-bit mix (Postgres advisory xact lock accepts bigint via pg_catalog.int8).
export function firmAdvisoryLockKey(firmId: number): bigint {
  const FIRM_LOCK_NAMESPACE = BILLING_LEDGER_FIRM_LOCK_NAMESPACE;
  return FIRM_LOCK_NAMESPACE * 0x100000000n + BigInt(Math.abs(Math.floor(firmId)) & 0xffffffff);
}

/**
 * Pure helper: deterministic idempotency key per firm + billing period month.
 * Used by generateMonthlySubscriptionCharge() and tests to guarantee no
 * double-bill of the same firm/month window.
 *
 * @param firmId Firm identifier (positive integer)
 * @param year   4-digit calendar year (Gregorian)
 * @param month0 0-indexed month (0 = Jan, 11 = Dec) — matches Date.getUTCMonth()
 */
export function buildMonthlySubscriptionIdempotencyKey(firmId: number, year: number, month0: number): string {
  const mm = String(month0 + 1).padStart(2, "0");
  return `SUB-MONTHLY-${firmId}-${year}${mm}`;
}

/**
 * Append exactly one ledger entry. This is the ONLY API surface for writing.
 * Any attempt to update/delete must produce new rows (reversal/credit).
 *
 * CONCURRENCY SAFETY (Phase 4 — critical invariant):
 *   We acquire a per-firm scoped TRANSACTION-LEVEL advisory lock
 *   (pg_advisory_xact_lock) BEFORE reading current balance + computing + writing.
 *   The lock is automatically released at COMMIT/ROLLBACK. This serializes
 *   concurrent charge/payment/reversal writes for the same firm so running_balance
 *   never has races. Cross-firm writes never contend.
 *
 *   The lock is acquired unconditionally (regardless of `alreadyInTx`). If the
 *   caller provided an open RLS connection inside their own transaction, the
 *   advisory lock is acquired inside THAT transaction (correct scope).
 *
 *   NOTE: We never interpret a generic "conn was passed" as "lock already held".
 *   See `lockAlreadyHeld` flag below for the ONLY safe short-circuit.
 *
 * IDEMPOTENCY (Phase 4):
 *   If entry.idempotencyKey is provided, uq_billing_ledger_idempotency unique index
 *   (firm_id, idempotency_key) WHERE idempotency_key IS NOT NULL rejects duplicates
 *   with a UNIQUE violation. We catch that and return the existing row instead.
 *
 * BALANCE CORRECTNESS (Phase 4, option B + A hybrid):
 *   We store running_balance on the row for fast reads. We also derive balance via
 *   SUM(debit - credit) as a cross-check inside the locked tx. The result stored
 *   is the recomputed SUM (never stale SELECT + manual add without lock).
 */
export async function appendLedgerEntry(
  entry: NewLedgerEntry,
  opts: {
    /**
     * Verified open DB transaction owned by the caller.
     * If provided, LOCK + SUM + INSERT run inside this single existing
     * transaction (caller owns COMMIT/ROLLBACK).
     *
     * If omitted, appendLedgerEntry opens its own `db.transaction(...)` so
     * the three statements are guaranteed to share one real PostgreSQL
     * transaction (the pg_advisory_xact_lock lives until COMMIT).
     *
     * There is intentionally no plain-`conn` escape hatch. Passing a raw
     * auto-commit PoolClient/RlsDb/db object would release the xact advisory
     * lock immediately after the LOCK statement and is therefore forbidden.
     */
    transaction?: AppDb | RlsDb;
    forceRunningBalance?: string;
    /**
     * Callers that have ALREADY acquired firmAdvisoryLockKey(entry.firmId)
     * on the current transaction may pass true to avoid re-acquiring.
     * Default = false → LOCK ALWAYS.
     */
    lockAlreadyHeld?: boolean;
  } = {},
): Promise<{ id: number; runningBalance: string }> {
  const debit = toNum(entry.debit ?? 0);
  const credit = toNum(entry.credit ?? 0);

  if (entry.entryType === "reversal" && Number(debit) === 0 && Number(credit) === 0) {
    throw new ApiError({ status: 400, code: "INVALID_REVERSAL", message: "Reversal must carry non-zero debit or credit", retryable: false });
  }

  const lockAlreadyHeld = Boolean(opts.lockAlreadyHeld);

  /**
   * Core append logic.  The caller guarantees `conn` lives inside a real
   * BEGIN/COMMIT PostgreSQL transaction — either one we opened just below
   * (Path B) or one the caller explicitly passed in as `transaction`
   * (Path A).
   */
  const run = async (conn: AppDb | RlsDb, opts2: { lockAlreadyHeld: boolean }) => {
    if (!opts2.lockAlreadyHeld) {
      const lockKey = firmAdvisoryLockKey(entry.firmId);
      await conn.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
    }

    let runningBalance: string;
    if (opts.forceRunningBalance !== undefined && opts.forceRunningBalance !== null) {
      runningBalance = String(opts.forceRunningBalance);
    } else {
      const rows = await conn
        .select({
          running: sql<string | number>`COALESCE(SUM(${billingLedgerTable.debit} - ${billingLedgerTable.credit}), 0)`,
        })
        .from(billingLedgerTable)
        .where(eq(billingLedgerTable.firmId, entry.firmId));
      const raw = rows[0]?.running;
      const existing = typeof raw === "bigint" ? Number(raw) : Number(raw ?? 0);
      const next = existing + Number(debit) - Number(credit);
      runningBalance = next.toFixed(2);
    }

    try {
      const payload: InsertBillingLedgerEntry = {
        firmId: entry.firmId,
        subscriptionId: entry.subscriptionId ?? null,
        invoiceId: entry.invoiceId ?? null,
        idempotencyKey: entry.idempotencyKey ?? null,
        entryType: entry.entryType,
        description: entry.description,
        billingPeriodStart: toDateStringOrNull(entry.billingPeriodStart),
        billingPeriodEnd: toDateStringOrNull(entry.billingPeriodEnd),
        debit: debit as unknown as any,
        credit: credit as unknown as any,
        currency: entry.currency ?? "MYR",
        referenceNo: entry.referenceNo ?? null,
        correlationId: entry.correlationId ?? null,
        sourceType: entry.sourceType ?? null,
        sourceId: entry.sourceId ?? null,
        dueDate: toDateStringOrNull(entry.dueDate),
        paidDate: toDateStringOrNull(entry.paidDate),
        status: entry.status ?? "posted",
        paymentReference: entry.paymentReference ?? null,
        paymentMethod: entry.paymentMethod ?? null,
        runningBalance: runningBalance as unknown as any,
        createdBy: entry.createdBy ?? null,
      };
      const rows = await conn
        .insert(billingLedgerTable)
        .values(payload)
        .returning({ id: billingLedgerTable.id, runningBalance: billingLedgerTable.runningBalance });
      const row = rows[0];
      if (!row) throw new ApiError({ status: 500, code: "LEDGER_APPEND_FAILED", message: "Ledger insert produced no returning row", retryable: false });
      return { id: Number(row.id), runningBalance: String(row.runningBalance) };
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      if (/APPEND-ONLY|billing_ledger_append_only/i.test(msg)) {
        logger.error({ firmId: entry.firmId, entryType: entry.entryType, err }, "billing_ledger.append_blocked_by_trigger");
        throw new ApiError({ status: 409, code: "LEDGER_APPEND_ONLY", message: "Ledger is append-only; use reversal/credit_note instead of update/delete", retryable: false });
      }
      if (/uq_billing_ledger_idempotency|duplicate.*key.*idempotency/i.test(msg) || (String(err?.code) === "23505" && /idempotency/.test(msg))) {
        const prior = await conn
          .select({ id: billingLedgerTable.id, runningBalance: billingLedgerTable.runningBalance })
          .from(billingLedgerTable)
          .where(and(
            eq(billingLedgerTable.firmId, entry.firmId),
            eq(billingLedgerTable.idempotencyKey, String(entry.idempotencyKey ?? "")),
          ))
          .limit(1);
        if (prior[0]) {
          return { id: Number(prior[0].id), runningBalance: String(prior[0].runningBalance) };
        }
      }
      throw err;
    }
  };

  // ── Path A: caller provided a real transaction-scoped connection ───────
  //         → run LOCK/SUM/INSERT inside their transaction.
  if (opts.transaction) {
    return await run(opts.transaction, { lockAlreadyHeld });
  }
  // ── Path B: no caller transaction → open our own REAL db.transaction ───
  //         → LOCK + SUM + INSERT all inside one BEGIN/COMMIT block.
  return await db.transaction(async (tx) =>
    run(tx as unknown as AppDb, { lockAlreadyHeld }),
  );
}

export function buildBillingReversalIdempotencyKey(firmId: number, originalEntryId: number): string {
  return `billing-reversal:${firmId}:${originalEntryId}`;
}

export async function reverseLedgerEntry(
  entryId: number,
  params: { actorId?: number | null; reason?: string; referenceNo?: string } = {},
  opts: { transaction?: AppDb | RlsDb; lockAlreadyHeld?: boolean } = {},
): Promise<{ reversalId: number; runningBalance: string; alreadyReversed: boolean }> {
  const runInternal = async (conn: AppDb | RlsDb, runOpts: { lockAlreadyHeld: boolean }) => {
    // ── LOCK first: we must serialize the whole CHECK-then-INSERT with the
    //    firm-level xact advisory lock BEFORE any reads, so two concurrent
    //    reversals of the same original entry never both observe "no prior
    //    reversal exists" and race past the pre-flight.
    let firmIdFromLock: number | undefined;
    if (!runOpts.lockAlreadyHeld) {
      // Peek firmId first so we know which lock key to acquire.  This is a
      // single-row PK read (safe without our lock) — the critical ordering
      // guarantee is that we acquire the firm lock BEFORE the "any prior
      // reversal exists?" check below.  If we get a stale read here the
      // worst case is the idempotency UNIQUE index fires correctly.
      const peek = (await conn
        .select({ firmId: billingLedgerTable.firmId })
        .from(billingLedgerTable)
        .where(eq(billingLedgerTable.id, entryId))
        .limit(1))[0];
      if (!peek) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Ledger entry not found", retryable: false });
      firmIdFromLock = Number(peek.firmId);
      await conn.execute(sql`SELECT pg_advisory_xact_lock(${firmAdvisoryLockKey(firmIdFromLock)})`);
    }

    const prior = (await conn
      .select()
      .from(billingLedgerTable)
      .where(eq(billingLedgerTable.id, entryId))
      .limit(1))[0];
    if (!prior) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Ledger entry not found", retryable: false });
    if (prior.status === "voided") {
      throw new ApiError({ status: 409, code: "ALREADY_VOIDED", message: "Ledger entry already voided", retryable: false });
    }
    const firmId = Number(prior.firmId);
    if (firmIdFromLock !== undefined && firmIdFromLock !== firmId) {
      // Edge case: PK changed between peek and read — defensively re-lock
      // the real firm before continuing.
      await conn.execute(sql`SELECT pg_advisory_xact_lock(${firmAdvisoryLockKey(firmId)})`);
    }

    const existingReversal = (await conn
      .select({ id: billingLedgerTable.id, runningBalance: billingLedgerTable.runningBalance })
      .from(billingLedgerTable)
      .where(and(
        eq(billingLedgerTable.firmId, firmId),
        eq(billingLedgerTable.sourceType, "billing_ledger_reversal"),
        eq(billingLedgerTable.sourceId, Number(prior.id)),
      ))
      .limit(1))[0];
    if (existingReversal) {
      return {
        reversalId: Number(existingReversal.id),
        runningBalance: String(existingReversal.runningBalance),
        alreadyReversed: true,
      };
    }

    if (prior.entryType === "reversal") {
      throw new ApiError({ status: 409, code: "REVERSAL_OF_REVERSAL_FORBIDDEN", message: "Reversals are themselves not reversible; issue a credit note instead", retryable: false });
    }

    const idempotencyKey = buildBillingReversalIdempotencyKey(firmId, Number(prior.id));
    const reversedDesc = `REVERSAL #${prior.id}${params.reason ? ` — ${params.reason}` : ""}`;
    const res = await appendLedgerEntry(
      {
        firmId,
        subscriptionId: prior.subscriptionId ?? null,
        invoiceId: prior.invoiceId ?? null,
        idempotencyKey,
        entryType: "reversal",
        description: reversedDesc,
        billingPeriodStart: prior.billingPeriodStart ?? null,
        billingPeriodEnd: prior.billingPeriodEnd ?? null,
        debit: String(prior.credit),
        credit: String(prior.debit),
        currency: String(prior.currency ?? "MYR"),
        referenceNo: params.referenceNo ?? prior.referenceNo ?? null,
        sourceType: "billing_ledger_reversal",
        sourceId: Number(prior.id),
        createdBy: params.actorId ?? null,
      },
      { transaction: conn, lockAlreadyHeld: true },
    );
    return { reversalId: res.id, runningBalance: res.runningBalance, alreadyReversed: false };
  };

  if (opts.transaction) {
    return runInternal(opts.transaction, { lockAlreadyHeld: Boolean(opts.lockAlreadyHeld) });
  }
  return await db.transaction(async (tx) =>
    runInternal(tx as unknown as AppDb, { lockAlreadyHeld: Boolean(opts.lockAlreadyHeld) }),
  );
}

export async function generateMonthlySubscriptionCharge(
  firmId: number,
  periodStart: Date,
  periodEnd: Date,
  opts: { transaction?: AppDb | RlsDb; actorId?: number | null } = {},
): Promise<{ chargeId: number; amount: string; runningBalance: string }> {
  // Firm+plan lookup is a READ — it may run on autocommit; there is no
  // correctness risk if pricing races because the idempotency + append-
  // inside-its-own-transaction below guarantees the real serialized part.
  const readConn = opts.transaction ?? db;
  const [firm] = await readConn
    .select({
      planId: firmsTable.subscriptionPlanId,
      isCustomPlan: firmsTable.isCustomPlan,
      customPriceMonthly: firmsTable.customPriceMonthly,
      planName: subscriptionPlansTable.name,
      planPriceMonthly: subscriptionPlansTable.priceMonthly,
    })
    .from(firmsTable)
    .leftJoin(subscriptionPlansTable, eq(firmsTable.subscriptionPlanId, subscriptionPlansTable.id))
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  if (!firm) throw new ApiError({ status: 404, code: "FIRM_NOT_FOUND", message: "", retryable: false });

  const amountStr =
    firm.isCustomPlan && firm.customPriceMonthly !== null && firm.customPriceMonthly !== undefined
      ? toNum(firm.customPriceMonthly)
      : toNum(firm.planPriceMonthly ?? 0);

  const yyyymm = `${periodStart.getUTCFullYear()}${String(periodStart.getUTCMonth() + 1).padStart(2, "0")}`;
  const description = `Subscription ${firm.planName ?? "plan"} — ${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}`;
  const idempotencyKey = buildMonthlySubscriptionIdempotencyKey(firmId, periodStart.getUTCFullYear(), periodStart.getUTCMonth());

  // Critical: when the caller does NOT own a transaction, pass NO options
  // here so appendLedgerEntry opens its OWN real db.transaction() and
  // performs LOCK → SUM → INSERT inside one PostgreSQL transaction.
  // A plain PoolClient/RlsDb in autocommit mode is NEVER passed in.
  const res = await appendLedgerEntry(
    {
      firmId,
      entryType: "subscription_charge",
      idempotencyKey,
      description,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      debit: amountStr,
      credit: "0.00",
      currency: "MYR",
      referenceNo: `SUB-${yyyymm}-${firmId}`,
      sourceType: "subscription_monthly",
      createdBy: opts.actorId ?? null,
    },
    opts.transaction ? { transaction: opts.transaction } : {},
  );
  return { chargeId: res.id, amount: amountStr, runningBalance: res.runningBalance };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export interface LedgerPage {
  items: Array<typeof billingLedgerTable.$inferSelect>;
  balanceAtStart: string;
  balanceAtEnd: string;
  totalDebit: string;
  totalCredit: string;
}

export async function getFirmLedger(
  firmId: number,
  opts: {
    conn?: AppDb | RlsDb;
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
    offset?: number;
  } = {},
): Promise<LedgerPage> {
  const conn = opts.conn ?? db;
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  let where = eq(billingLedgerTable.firmId, firmId);
  if (opts.fromDate) where = and(where, gteCreated(billingLedgerTable.createdAt, opts.fromDate));
  if (opts.toDate) where = and(where, lteCreated(billingLedgerTable.createdAt, opts.toDate));

  const items = (await conn
    .select()
    .from(billingLedgerTable)
    .where(where)
    .orderBy(asc(billingLedgerTable.createdAt), asc(billingLedgerTable.id))
    .limit(limit)
    .offset(offset)) as unknown as Array<typeof billingLedgerTable.$inferSelect>;

  // totals + balance
  const [tot] = await conn
    .select({
      debit: sql<string | number>`COALESCE(SUM(${billingLedgerTable.debit}),0)`,
      credit: sql<string | number>`COALESCE(SUM(${billingLedgerTable.credit}),0)`,
    })
    .from(billingLedgerTable)
    .where(where);
  const totalDebit = String(tot?.debit ?? 0);
  const totalCredit = String(tot?.credit ?? 0);

  const [balRow] = await conn
    .select({ balance: billingLedgerTable.runningBalance })
    .from(billingLedgerTable)
    .where(eq(billingLedgerTable.firmId, firmId))
    .orderBy(desc(billingLedgerTable.id))
    .limit(1);
  const balanceAtEnd = String(balRow?.balance ?? "0.00");
  const balanceAtStart = (Number(balanceAtEnd) - Number(totalDebit) + Number(totalCredit)).toFixed(2);

  return { items, balanceAtStart, balanceAtEnd, totalDebit, totalCredit };
}

function gteCreated(col: any, d: Date) {
  return gte(col, d);
}
function lteCreated(col: any, d: Date) {
  return sql`${col} <= ${d}`;
}

export async function getFirmOutstandingBalance(
  firmId: number,
  opts: { conn?: AppDb | RlsDb } = {},
): Promise<string> {
  const conn = opts.conn ?? db;
  const [row] = await conn
    .select({ bal: billingLedgerTable.runningBalance })
    .from(billingLedgerTable)
    .where(eq(billingLedgerTable.firmId, firmId))
    .orderBy(desc(billingLedgerTable.id))
    .limit(1);
  return String(row?.bal ?? "0.00");
}
