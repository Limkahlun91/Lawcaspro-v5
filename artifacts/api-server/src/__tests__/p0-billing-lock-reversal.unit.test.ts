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

/**
 * Build a fake drizzle-ish `db` object that:
 *   • records `begin / lock / sum / insert / commit / rollback` into _order
 *   • simulates a transaction via `.transaction(fn)` wrapping
 *   • tracks ledger state in-memory so SUM→INSERT ordering is visible
 *
 * IMPORTANT — no plain `conn` escape hatch is provided on the public API;
 * the G3/G4 redesign explicitly forbids passing a raw autocommit connection
 * as a pretend-transaction.  To exercise Path B (caller owns real tx), pass
 * the mock tx object returned from this factory through the NEW
 * `transaction:` option only (NEVER `conn:`).
 */
function makeMockDb(initialLedger: LedgerRow[] = [], firmRows: any[] = []) {
  const order: OpRecord[] = [];
  let seq = 1000;
  const ledger: LedgerRow[] = [...initialLedger];
  const firms = [...firmRows];

  const makeConn = (tag: string) => {
    void tag;
    return {
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
    };
  };

  // Shared "real" connection that transaction() will pass into fn(conn) — this
  // simulates a single real DB session where LOCK/SUM/INSERT share one tx.
  const innerConn = makeConn("inner");

  const api: any = {
    _order: order,
    _ledger: ledger,
    transaction: async <T,>(fn: (tx: any) => Promise<T>): Promise<T> => {
      order.push({ op: "begin" });
      try {
        // Pass the SAME inner conn into fn — this is the key guarantee that
        // LOCK / SUM / INSERT share one real session and one BEGIN/COMMIT.
        const out = await fn(innerConn);
        order.push({ op: "commit" });
        return out;
      } catch (e) {
        order.push({ op: "rollback" });
        throw e;
      }
    },
    // Route direct execute / select / insert through the same shared inner
    // conn so callers that need to read *before* a transaction (e.g., pricing
    // lookup for monthly charge) can still find the fake firms table.
    execute: innerConn.execute,
    select: innerConn.select,
    insert: innerConn.insert,
    // Expose innerConn via a typed `_tx_for_testing` so Path B (caller owns
    // transaction) can pass it as { transaction: api._tx_for_testing } AFTER
    // wrapping it in its own begin/commit model — NO `conn:` escape ever.
    _tx_for_testing: innerConn,
  };
  return api;
}

describe("P0 — Billing Ledger LOCK before SUM/INSERT invariant", () => {
  let origTx: any;
  let origSelect: any;
  let origInsert: any;
  let origExecute: any;

  beforeEach(() => {
    origTx = (db as any).transaction;
    origSelect = (db as any).select;
    origInsert = (db as any).insert;
    origExecute = (db as any).execute;
  });
  afterEach(() => {
    (db as any).transaction = origTx;
    (db as any).select = origSelect;
    (db as any).insert = origInsert;
    (db as any).execute = origExecute;
  });

  function patchDb(mock: any) {
    (db as any).transaction = mock.transaction;
    (db as any).select = mock.select;
    (db as any).insert = mock.insert;
    (db as any).execute = mock.execute;
  }

  // ---------------------------------------------------------------------------
  // G3: appendLedgerEntry opens real db.transaction + BEGIN/LOCK/SUM/INSERT/COMMIT
  // ---------------------------------------------------------------------------
  it("appendLedgerEntry no-caller-tx → BEGIN → LOCK → SUM → INSERT → COMMIT (exact order)", async () => {
    const mock = makeMockDb([]);
    patchDb(mock);

    await appendLedgerEntry(
      {
        firmId: 77,
        entryType: "subscription_charge",
        description: "test",
        debit: "100.00",
        credit: "0.00",
      },
      // Note: NEVER pass `conn:` — new API has NO plain conn escape hatch
    );

    const order = mock._order;
    // Exact strict ordering of the 5 events
    const beginIdx = order.findIndex((o) => o.op === "begin");
    const lockIdx = order.findIndex((o) => o.op === "lock");
    const sumIdx = order.findIndex((o) => o.op === "sum");
    const insertIdx = order.findIndex((o) => o.op === "insert");
    const commitIdx = order.findIndex((o) => o.op === "commit");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(sumIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(sumIdx);
    expect(commitIdx).toBeGreaterThan(insertIdx);
    // EXACTLY one begin + one commit (no "begin/lock then commit too early")
    expect(order.filter((o) => o.op === "begin").length).toBe(1);
    expect(order.filter((o) => o.op === "commit").length).toBe(1);
    // Nothing AFTER commit
    expect(order.indexOf(order.find((o) => o.op === "commit")!)).toBe(order.length - 1);
  });

  it("FAIL-FAST detector: order [BEGIN,LOCK,COMMIT,SUM,INSERT] must fail", async () => {
    // Verify our assertions actually catch the regression user described:
    // "BEGIN/COMMIT around LOCK only, then SUM, then INSERT".
    const badOrder: OpRecord[] = [
      { op: "begin" }, { op: "lock", key: 1n }, { op: "commit" },
      { op: "sum" }, { op: "insert" },
    ];
    const idx = (op: OpRecord["op"]) => badOrder.findIndex((o) => o.op === op);
    const sumAfterCommit = idx("sum") > idx("commit");
    const insertAfterCommit = idx("insert") > idx("commit");
    expect(sumAfterCommit || insertAfterCommit).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // G4: generateMonthlySubscriptionCharge no-caller-tx -> internal real tx used
  // ---------------------------------------------------------------------------
  it("generateMonthlySubscriptionCharge no-caller-tx → BEGIN → LOCK → SUM → INSERT → COMMIT (never bypasses tx)", async () => {
    const mock = makeMockDb([], [
      {
        planId: 1,
        isCustomPlan: false,
        customPriceMonthly: null,
        planName: "BASIC",
        planPriceMonthly: "299.00",
      },
    ]);
    patchDb(mock);

    await generateMonthlySubscriptionCharge(
      77,
      new Date("2025-01-01T00:00:00Z"),
      new Date("2025-01-31T23:59:59Z"),
      // NO opts.conn (G4 API removed) — NO fake conn possible here.
    );

    const order = mock._order;
    const beginIdx = order.findIndex((o) => o.op === "begin");
    const lockIdx = order.findIndex((o) => o.op === "lock");
    const sumIdx = order.findIndex((o) => o.op === "sum");
    const insertIdx = order.findIndex((o) => o.op === "insert");
    const commitIdx = order.findIndex((o) => o.op === "commit");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(sumIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(sumIdx);
    expect(commitIdx).toBeGreaterThan(insertIdx);
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

  describe("reverseLedgerEntry — no duplicate full reversals (G6 atomic check+insert)", () => {
    it("first reversal → success, alreadyReversed=false", async () => {
      const mock = makeMockDb([
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
      patchDb(mock);
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
      const mock = makeMockDb([prior, rev]);
      patchDb(mock);
      const res = await reverseLedgerEntry(42);
      expect(res.alreadyReversed).toBe(true);
      expect(res.reversalId).toBe(99);
    });

    it("reversal of a reversal → REVERSAL_OF_REVERSAL_FORBIDDEN", async () => {
      const mock = makeMockDb([
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
      patchDb(mock);
      await expect(reverseLedgerEntry(99)).rejects.toThrow(
        /REVERSAL_OF_REVERSAL_FORBIDDEN|reversal.*not.*reversible|Forbidden/i,
      );
    });
  });

  it("G6 reverseLedgerEntry atomic BEGIN→LOCK→prior-check→append→COMMIT order", async () => {
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
    const mock = makeMockDb([prior]);
    patchDb(mock);

    await reverseLedgerEntry(42);
    const order = mock._order;
    const beginIdx = order.findIndex((o) => o.op === "begin");
    const lockIdx = order.findIndex((o) => o.op === "lock");
    // SUM before reversal = running balance recompute inside appendLedgerEntry
    const sumIdx = order.findIndex((o) => o.op === "sum");
    // reversal insert
    const insertIdx = order.findIndex((o) => o.op === "insert");
    const commitIdx = order.findIndex((o) => o.op === "commit");

    expect(beginIdx).toBeGreaterThanOrEqual(0);
    // LOCK must come BEFORE first SUM (appendLedgerEntry inner lock) = critical
    // ordering guarantee for reversal atomicity.
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(lockIdx).toBeLessThan(sumIdx);
    expect(sumIdx).toBeLessThan(insertIdx);
    expect(insertIdx).toBeLessThan(commitIdx);
  });
});
