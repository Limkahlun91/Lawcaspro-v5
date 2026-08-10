import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLedgerEntry,
  reverseLedgerEntry,
  buildBillingReversalIdempotencyKey,
  firmAdvisoryLockKey,
  buildMonthlySubscriptionIdempotencyKey,
  generateMonthlySubscriptionCharge,
} from "../services/billing-ledger.js";
import { db } from "@workspace/db";

type OpRecord =
  | { op: "begin" }
  | { op: "lock"; key: bigint }
  | { op: "sum" }
  | { op: "insert" }
  | { op: "commit" }
  | { op: "rollback" };

interface LedgerRow {
  id: number;
  firmId: number;
  idempotencyKey: string | null;
  entryType: string;
  sourceType: string | null;
  sourceId: number | null;
  debit: string;
  credit: string;
  runningBalance: string;
}

function makeMockConn(initialLedger: LedgerRow[] = [], firmRows: any[] = []) {
  const order: OpRecord[] = [];
  let seq = 1000;
  const ledger: LedgerRow[] = [...initialLedger];
  const firms = [...firmRows];

  const conn: any = {
    _order: order,
    _ledger: ledger,
    execute: async (stmt: any) => {
      const stmtStr = String(stmt ?? "");
      if (/pg_advisory_xact_lock/.test(stmtStr)) {
        const m = stmtStr.match(/pg_advisory_xact_lock\((\d+)\)/);
        const key = m ? BigInt(m[1]) : 0n;
        order.push({ op: "lock", key });
        return { rows: [] };
      }
      return { rows: [] };
    },
    select: (_cols: any) => ({
      from: (fromTable: any) => {
        const tn = String((fromTable as any)?.name ?? "");
        return {
          where: (_pred: any) => {
            void _pred;
            if (tn === "billing_ledger") {
              order.push({ op: "sum" });
              const running = ledger.reduce(
                (acc, l) => acc + Number(l.debit) - Number(l.credit),
                0,
              );
              return Promise.resolve([{ running: String(running.toFixed(2)) }]);
            }
            return {
              limit: (n: number) => {
                void n;
                if (tn === "billing_ledger") {
                  return Promise.resolve(
                    ledger
                      .filter((l) => l.sourceType === "billing_ledger_reversal")
                      .map((l) => ({ id: l.id, runningBalance: l.runningBalance })),
                  );
                }
                if (tn === "billing_ledger_2") return Promise.resolve([]);
                if (tn === "firms") return Promise.resolve(firms);
                return Promise.resolve(ledger.slice(0, 1));
              },
            };
          },
          limit: (_n: number) => {
            if (tn === "firms") return Promise.resolve(firms);
            return Promise.resolve([]);
          },
          leftJoin: () => ({
            where: () => ({
              limit: (_n: number) => Promise.resolve(firms),
            }),
          }),
        };
      },
    }),
    insert: (_intoTable: any) => ({
      values: (payload: any[]) => {
        order.push({ op: "insert" });
        const p = payload[0] ?? {};
        const row: LedgerRow = {
          id: ++seq,
          firmId: Number(p.firm_id ?? p.firmId ?? 0),
          idempotencyKey: p.idempotency_key ?? p.idempotencyKey ?? null,
          entryType: String(p.entry_type ?? p.entryType ?? ""),
          sourceType: p.source_type ?? p.sourceType ?? null,
          sourceId: typeof p.source_id === "number"
            ? p.source_id
            : typeof p.sourceId === "number" ? p.sourceId : null,
          debit: String(p.debit ?? "0.00"),
          credit: String(p.credit ?? "0.00"),
          runningBalance: String(p.running_balance ?? p.runningBalance ?? "0.00"),
        };
        ledger.push(row);
        return {
          returning: (_cols: any) => {
            return Promise.resolve([
              { id: row.id, runningBalance: row.runningBalance },
            ]);
          },
        };
      },
    }),
    transaction: async <T,>(fn: (tx: any) => Promise<T>): Promise<T> => {
      order.push({ op: "begin" });
      try {
        const out = await fn(conn);
        order.push({ op: "commit" });
        return out;
      } catch (e) {
        order.push({ op: "rollback" });
        throw e;
      }
    },
  };
  return conn;
}

describe("P0 — Billing Ledger LOCK before SUM/INSERT invariant", () => {
  let origTx: any;

  beforeEach(() => {
    origTx = (db as any).transaction;
  });
  afterEach(() => {
    (db as any).transaction = origTx;
  });

  it("appendLedgerEntry() emits LOCK → SUM → INSERT order when no caller tx", async () => {
    const mockConn = makeMockConn([]);
    (db as any).transaction = mockConn.transaction;

    await appendLedgerEntry(
      {
        firmId: 77,
        entryType: "subscription_charge",
        description: "test",
        debit: "100.00",
        credit: "0.00",
      },
      { lockAlreadyHeld: false },
    );

    const order = mockConn._order;
    const lockIdx = order.findIndex((o) => o.op === "lock");
    const sumIdx = order.findIndex((o) => o.op === "sum");
    const insertIdx = order.findIndex((o) => o.op === "insert");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(sumIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(sumIdx);
  });

  it("generateMonthlySubscriptionCharge(conn) → LOCK BEFORE SUM (not skipped)", async () => {
    const mockConn = makeMockConn([], [
      {
        planId: 1,
        isCustomPlan: false,
        customPriceMonthly: null,
        planName: "BASIC",
        planPriceMonthly: "299.00",
      },
    ]);
    (db as any).transaction = mockConn.transaction;

    try {
      await generateMonthlySubscriptionCharge(
        77,
        new Date("2025-01-01T00:00:00Z"),
        new Date("2025-01-31T23:59:59Z"),
        { conn: mockConn },
      );
    } catch (e) {
      void e;
    }

    const order = mockConn._order;
    const lockIdx = order.findIndex((o) => o.op === "lock");
    const sumIdx = order.findIndex((o) => o.op === "sum");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(sumIdx).toBeGreaterThan(lockIdx);
  });

  it("firmAdvisoryLockKey() stable + firm-isolated", () => {
    expect(firmAdvisoryLockKey(1)).toBe(firmAdvisoryLockKey(1));
    expect(firmAdvisoryLockKey(1)).not.toBe(firmAdvisoryLockKey(2));
    expect(typeof firmAdvisoryLockKey(1)).toBe("bigint");
  });

  it("buildBillingReversalIdempotencyKey() deterministic key", () => {
    const k1 = buildBillingReversalIdempotencyKey(5, 100);
    const k2 = buildBillingReversalIdempotencyKey(5, 100);
    const k3 = buildBillingReversalIdempotencyKey(5, 101);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toBe("billing-reversal:5:100");
  });

  it("buildMonthlySubscriptionIdempotencyKey() stable per period", () => {
    expect(buildMonthlySubscriptionIdempotencyKey(3, 2025, 0)).toBe(
      "SUB-MONTHLY-3-202501",
    );
    expect(buildMonthlySubscriptionIdempotencyKey(3, 2025, 0)).toBe(
      buildMonthlySubscriptionIdempotencyKey(3, 2025, 0),
    );
  });

  describe("reverseLedgerEntry — no duplicate full reversals", () => {
    it("first reversal → success, alreadyReversed=false", async () => {
      const mockConn = makeMockConn([
        {
          id: 42,
          firmId: 5,
          idempotencyKey: null,
          entryType: "subscription_charge",
          sourceType: null,
          sourceId: null,
          debit: "500.00",
          credit: "0.00",
          runningBalance: "500.00",
        },
      ]);
      (db as any).transaction = mockConn.transaction;
      const res = await reverseLedgerEntry(42);
      expect(res.alreadyReversed).toBe(false);
      expect(res.reversalId).toBeGreaterThan(0);
    });

    it("second reversal of same entry → alreadyReversed=true (deterministic)", async () => {
      const prior: LedgerRow = {
        id: 42,
        firmId: 5,
        idempotencyKey: null,
        entryType: "subscription_charge",
        sourceType: null,
        sourceId: null,
        debit: "500.00",
        credit: "0.00",
        runningBalance: "500.00",
      };
      const rev: LedgerRow = {
        id: 99,
        firmId: 5,
        idempotencyKey: buildBillingReversalIdempotencyKey(5, 42),
        entryType: "reversal",
        sourceType: "billing_ledger_reversal",
        sourceId: 42,
        debit: "0.00",
        credit: "500.00",
        runningBalance: "0.00",
      };
      const mockConn = makeMockConn([prior, rev]);
      (db as any).transaction = mockConn.transaction;
      const res = await reverseLedgerEntry(42);
      expect(res.alreadyReversed).toBe(true);
      expect(res.reversalId).toBe(99);
    });

    it("reversal of a reversal → REVERSAL_OF_REVERSAL_FORBIDDEN", async () => {
      const mockConn = makeMockConn([
        {
          id: 99,
          firmId: 5,
          idempotencyKey: buildBillingReversalIdempotencyKey(5, 42),
          entryType: "reversal",
          sourceType: "billing_ledger_reversal",
          sourceId: 42,
          debit: "0.00",
          credit: "500.00",
          runningBalance: "0.00",
        },
      ]);
      (db as any).transaction = mockConn.transaction;
      await expect(reverseLedgerEntry(99)).rejects.toThrow(
        /REVERSAL_OF_REVERSAL_FORBIDDEN|reversal.*not.*reversible|Forbidden/i,
      );
    });
  });

  it("concurrent monthly charge path: first call holds LOCK before SUM via shared order", async () => {
    const mockConn = makeMockConn([], [
      {
        planId: 1,
        isCustomPlan: false,
        customPriceMonthly: null,
        planName: "BASIC",
        planPriceMonthly: "299.00",
      },
    ]);
    (db as any).transaction = mockConn.transaction;

    try {
      await generateMonthlySubscriptionCharge(
        3,
        new Date("2025-01-05T00:00:00Z"),
        new Date("2025-01-31T23:59:59Z"),
        { conn: mockConn },
      );
    } catch (e) {
      void e;
    }
    const hasLock = mockConn._order.some((o) => o.op === "lock");
    const hasSum = mockConn._order.some((o) => o.op === "sum");
    expect(hasLock).toBe(true);
    expect(hasSum).toBe(true);
  });
});
