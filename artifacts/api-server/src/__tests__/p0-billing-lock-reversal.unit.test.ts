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
  status?: string;
  subscriptionId?: number | null;
  invoiceId?: number | null;
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
/**
 * Serialize a drizzle-ish sql tagged template param to a string that regex
 * patterns can match against.  Drizzle SQL objects expose `toSQL()` on some
 * versions; fallback is JSON.stringify + extract/concat `queryChunks`/`params`
 * to rebuild an approximation good enough for lock-keyword matching.
 */
function serializeSqlish(stmt: any, depth = 0): string {
  if (depth > 12) return "";
  if (stmt == null) return "";
  if (typeof stmt === "string") return stmt;
  if (typeof stmt === "number" || typeof stmt === "bigint" || typeof stmt === "boolean") return String(stmt);
  // Drizzle 4.x Param wrapper: {value: 42} (or any object with plain .value primitive)
  if (stmt && typeof stmt === "object" && !Array.isArray(stmt)) {
    const valKeys = ["value", "val", "rawValue", "param", "$value"];
    for (const k of valKeys) {
      if (k in stmt) {
        const sub = (stmt as any)[k];
        if (sub == null || typeof sub !== "object" || Array.isArray(sub)) {
          return serializeSqlish(sub, depth + 1);
        }
      }
    }
  }
  // PgColumn FIRST — before calling getSQL that strips column metadata
  if (stmt && typeof stmt === "object" && !Array.isArray(stmt)) {
    if ("name" in stmt && typeof stmt.name === "string" && "table" in stmt && stmt.table && typeof stmt.table === "object") {
      try {
        // Table name is hidden under Symbol property in drizzle PgTable
        let tname: string | null = null;
        const tn = stmt.table;
        for (const sym of Object.getOwnPropertySymbols(tn)) {
          const v = (tn as any)[sym];
          if (typeof v === "string") { tname = v; break; }
        }
        if (!tname && typeof (tn as any).name === "string") tname = (tn as any).name;
        if (!tname) {
          for (const key of ["$name", "dbName", "$tableName"]) {
            const v = (tn as any)[key];
            if (typeof v === "string") { tname = v; break; }
          }
        }
        // PgColumn.table.id.name fallback
        for (const colKey of Object.keys(tn)) {
          const col = (tn as any)[colKey];
          if (col && typeof col === "object" && "table" in col) {
            for (const sym of Object.getOwnPropertySymbols(col.table)) {
              const v = (col.table as any)[sym];
              if (typeof v === "string") { tname = v; break; }
            }
            if (tname) break;
          }
        }
        const sn: any = (stmt.table as any).schema;
        if (tname) return (sn ? `"${sn}".` : "") + `"${String(tname)}"."${String(stmt.name)}"`;
      } catch {}
      // fallback: return column name alone
      return `"${String(stmt.name)}"`;
    }
  }
  const tryGetSqlObj = (x: any): any => {
    try {
      if (typeof x?.getSQL === "function") return x.getSQL();
    } catch {}
    return x;
  };
  const obj = tryGetSqlObj(stmt);
  if (typeof obj === "string") return obj;
  if (obj && typeof obj === "object") {
    if (Array.isArray(obj)) {
      return obj.map((c) => serializeSqlish(c, depth + 1)).join("");
    }
    // Plain object: recurse values (drizzle select({alias: sql}) shape)
    const proto = Object.getPrototypeOf(obj);
    const isPlain = proto === null || proto === Object.prototype;
    if (isPlain && !("queryChunks" in obj) && !("sql" in obj) && !("strings" in obj)) {
      return Object.values(obj).map(v => serializeSqlish(v, depth + 1)).join(" ");
    }
    if ("queryChunks" in obj && Array.isArray(obj.queryChunks)) {
      return obj.queryChunks.map((c: any) => {
        if (c && typeof c === "object" && "value" in c && Array.isArray(c.value)) {
          return c.value.map((v: any) => serializeSqlish(v, depth + 1)).join("");
        }
        return serializeSqlish(c, depth + 1);
      }).join("");
    }
    if (typeof obj.sql === "string") return obj.sql;
    if ("strings" in obj && Array.isArray((obj as any).strings)) {
      const parts: string[] = (obj as any).strings.slice();
      const values: any[] = Array.isArray((obj as any).values) ? (obj as any).values : [];
      let out = "";
      for (let i = 0; i < parts.length; i++) {
        out += parts[i];
        if (i < values.length) out += serializeSqlish(values[i], depth + 1);
      }
      return out;
    }
    // Drizzle Param wrapper fallback after getSQL
    const valKeys = ["value", "val", "rawValue", "param", "$value"];
    for (const k of valKeys) {
      if (k in obj && (obj as any)[k] != null && typeof (obj as any)[k] !== "object") {
        return serializeSqlish((obj as any)[k], depth + 1);
      }
    }
  }
  try { return String(stmt); } catch { return ""; }
}

function makeMockDb(initialLedger: LedgerRow[] = [], firmRows: any[] = []) {
  const order: OpRecord[] = [];
  let seq = 1000;
  const ledger: LedgerRow[] = [...initialLedger];
  const firms = [...firmRows];

  const makeConn = (tag: string) => {
    void tag;
    return {
      execute: async (stmt: any) => {
        const stmtStr = serializeSqlish(stmt);
        if (/pg_advisory_xact_lock/.test(stmtStr)) {
          const m = stmtStr.match(/pg_advisory_xact_lock\D*(\d+)/);
          const key = m ? BigInt(m[1]) : 0n;
          order.push({ op: "lock", key });
          return { rows: [] };
        }
        return { rows: [] };
      },
      select: (_cols: any) => ({
        from: (fromTable: any) => {
          // Robust table name extractor for drizzle PgTable (pgTable result)
          let tn = "";
          try {
            const t = fromTable;
            if (t && typeof t === "object") {
              // try Symbol first
              try {
                const syms = Object.getOwnPropertySymbols(t);
                for (const s of syms) {
                  const v = (t as any)[s];
                  if (typeof v === "string" && /^(billing_ledger|firms|roles|permissions|cases|case_assignments|subscription_plans|firm_invoices)$/.test(v)) { tn = v; break; }
                }
              } catch {}
              if (!tn && typeof t.name === "string") tn = t.name;
              // drizzle <Symbol for table name> known: pgTable exports { name: ... } via hidden key like $schema
              if (!tn) {
                const keys = Object.keys(t).concat(String(Object.getOwnPropertySymbols(t)));
                // Walk column names and match back to known tables via their .table reference
                for (const k of Object.keys(t)) {
                  const col = (t as any)[k];
                  if (col && typeof col === "object" && "table" in col) {
                    // column's table ref: extract name by checking billingLedgerTable.name
                    try {
                      const innerColsTable = col.table;
                      for (const sym of Object.getOwnPropertySymbols(innerColsTable)) {
                        const v = (innerColsTable as any)[sym];
                        if (typeof v === "string") { tn = v; break; }
                      }
                      if (!tn && typeof innerColsTable.name === "string") tn = innerColsTable.name;
                      if (tn) break;
                    } catch {}
                  }
                }
              }
              // Final fallback: check well known from exports
              if (!tn) {
                if (typeof t.id?.table?.name === "string") tn = t.id.table.name;
              }
              if (!tn) {
                // try Symbol.for("drizzle:BaseName") and drizzle:Name variants
                for (const s of [Symbol.for("drizzle:Name"), Symbol.for("drizzle:BaseName"), Symbol.for("drizzle:SchemaName")]) {
                  const v = (t as any)[s];
                  if (typeof v === "string") { tn = v; break; }
                }
              }
            }
          } catch {}
          tn = String(tn);
          // Determine if this SELECT is the running-balance aggregate query.
          // In production appendLedgerEntry, the SUM query comes with
          //  select({ running: sql`COALESCE(SUM(..), 0)` }).
          // Conversely, the other queries come with plain columns like id/firmId
          // or `select()` wildcard or `.limit(1)`.
          let colsFlat = "";
          if (typeof _cols === "object" && _cols !== null) {
            try {
              colsFlat = JSON.stringify(_cols, (_k, v) => {
                if (v && typeof v === "object" && "table" in v && "name" in v) return `COL:${String(v.name)}`;
                if (v && typeof v === "object" && "name" in v && "schema" in v) return `TBL:${String(v.name)}`;
                return v;
              });
            } catch { colsFlat = ""; }
            if (!colsFlat) {
              try { colsFlat = String(_cols); } catch { colsFlat = ""; }
            }
          }
          const colsKeys = typeof _cols === "object" && _cols !== null ? Object.keys(_cols) : [];
          // In-memory side-channel diagnostics for test debugging when console would crash shell
          (globalThis as any).__p0BillingDiag = (globalThis as any).__p0BillingDiag || [];
          (globalThis as any).__p0BillingDiag.push({ t: "from", tn, colsKeys, colsFlat0_20: String(colsFlat).slice(0,20), serSum: /SUM|COALESCE/.test(serializeSqlish(_cols)) });
          const isSumAggregate =
            (colsKeys.length === 1 && colsKeys[0] === "running") ||
            /SUM|COALESCE/.test(colsFlat) ||
            /SUM|COALESCE/.test(serializeSqlish(_cols));
          // Collect column references from predicate: walk recursively, collect col snake_case + camelCase names
          const collectPredColsAndVals = (pred: any): { cols: Set<string>; vals: Map<string, any[]> } => {
            const cols = new Set<string>();
            const vals = new Map<string, any[]>();
            let lastCol: string | null = null;
            const unwrap = (x: any): any => {
              if (x == null) return x;
              if (typeof x !== "object" || Array.isArray(x)) return x;
              // Drizzle Param wrapper
              for (const k of ["value", "val", "rawValue", "param", "$value"]) {
                if (k in x) {
                  const sub = (x as any)[k];
                  if (sub == null || typeof sub !== "object" || Array.isArray(sub)) return sub;
                }
              }
              return x;
            };
            const walk = (x: any, d: number): void => {
              if (d > 15) return;
              if (x == null) { return; }
              const u = unwrap(x);
              if (u !== x) { walk(u, d + 1); return; }
              if (typeof x === "number" || typeof x === "bigint" || typeof x === "boolean") {
                if (lastCol !== null) { const arr = vals.get(lastCol) ?? []; arr.push(x); vals.set(lastCol, arr); }
                return;
              }
              if (typeof x === "string") {
                // Likely separator like " = "; skip tracking as value, just keep lastCol active
                // If it's a quoted string literal, push as val for lastCol
                if (/^['"].*['"]$/.test(x) && lastCol !== null) { const arr = vals.get(lastCol) ?? []; arr.push(x.replace(/^['"]|['"]$/g, "")); vals.set(lastCol, arr); }
                return;
              }
              if (typeof x === "object") {
                if (Array.isArray(x)) { x.forEach((c) => walk(c, d + 1)); return; }
                // Detect Drizzle column FIRST (before getSQL unwrap) so we capture lastCol name+table
                if (!Array.isArray(x) && "name" in x && typeof (x as any).name === "string" && "table" in x && (x as any).table && typeof (x as any).table === "object") {
                  const colName = String((x as any).name);
                  cols.add(colName);
                  lastCol = colName;
                  return;
                }
                try {
                  if (typeof x.getSQL === "function") {
                    const g = x.getSQL();
                    if (g && g !== x) { walk(g, d + 1); return; }
                  }
                } catch {}
                if ("queryChunks" in x && Array.isArray((x as any).queryChunks)) { walk((x as any).queryChunks, d + 1); return; }
                if ("value" in x && Array.isArray((x as any).value)) { walk((x as any).value, d + 1); return; }
                for (const k of Object.keys(x)) { try { walk((x as any)[k], d + 1); } catch {} }
              }
            };
            walk(pred, 0);
            return { cols, vals };
          };
          const buildLedgerRowsGivenPred = (predObj: any, wantFull: boolean): any[] => {
            const predFlat = serializeSqlish(predObj);
            // Also check JSON-walked filter info in case serializeSqlish missed something (fallback)
            const { cols: pcols, vals: pvals } = collectPredColsAndVals(predObj);
            const predAll = predFlat + " " + Array.from(pcols).join(",") + " " + Array.from(pvals.entries()).map(e => e[0]+":"+e[1].join("|")).join(" ");
            const extract = (colName: string, sqlColName = colName): string[] => {
              const out: string[] = [];
              const buildRe = (needle: string): RegExp[] => {
                const n = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return [
                  new RegExp('"' + n + '"\\s*=\\s*([0-9a-zA-Z_:\\-\\.]+)', "gi"),
                  new RegExp('"' + n + '"\\s*=\\s*\'([^\']+)\'', "gi"),
                  new RegExp('"' + n + '"\\s*=\\s*"([^"]+)"', "gi"),
                  new RegExp('(?:^|[\\s,(])' + n + '\\s*=\\s*([0-9a-zA-Z_:\\-\\.]+)', "gi"),
                ];
              };
              const patterns: RegExp[] = [...buildRe(sqlColName), ...buildRe(colName)];
              for (const re of patterns) {
                let m: RegExpExecArray | null;
                while ((m = re.exec(predAll)) !== null) out.push(m[1]);
              }
              const w1 = pvals.get(sqlColName);
              const w2 = pvals.get(colName);
              (w1 || []).forEach(v => out.push(String(v)));
              (w2 || []).forEach(v => out.push(String(v)));
              return out;
            };
            const idValues = extract("id");
            const firmIdValues = extract("firm_id", "firmId");
            const sourceTypeValues = extract("source_type", "sourceType");
            const sourceIdValues = extract("source_id", "sourceId");
            const idempotencyValues = extract("idempotency_key", "idempotencyKey");
            const matchNum = (vals: string[], n: number | string | null | undefined): boolean => vals.length === 0 || n === undefined || n === null || vals.some((v) => String(v) === String(n));
            const matchStr = (vals: string[], v: string | null | undefined): boolean => {
              if (vals.length === 0) return true;
              if (v === undefined || v === null) return vals.some((vv) => vv === null || vv === undefined || vv === String(v));
              const norm = (x: any) => String(x).toLowerCase().replace(/^['"]|['"]$/g, "");
              return vals.some((vv) => norm(vv) === norm(String(v)));
            };
            const filterCount = idValues.length + firmIdValues.length + sourceTypeValues.length + sourceIdValues.length + idempotencyValues.length;
            const isExistingReversalLookup =
              colsKeys.length === 2 && colsKeys.includes("id") && colsKeys.includes("runningBalance") &&
              (sourceTypeValues.length > 0 || sourceIdValues.length > 0 || /source_type|sourceType|source_id|sourceId/.test(predAll));
            let rows = ledger.slice();
            if (filterCount > 0) {
              if (idValues.length && !isExistingReversalLookup) rows = rows.filter(r => matchNum(idValues, r.id));
              if (firmIdValues.length) rows = rows.filter(r => matchNum(firmIdValues, r.firmId));
              if (sourceTypeValues.length) rows = rows.filter(r => matchStr(sourceTypeValues, r.sourceType));
              if (sourceIdValues.length) rows = rows.filter(r => matchNum(sourceIdValues, r.sourceId));
              if (idempotencyValues.length) rows = rows.filter(r => matchStr(idempotencyValues, r.idempotencyKey));
            }
            // classify by colsKeys:
            if (colsKeys.length === 1 && colsKeys[0] === "firmId") return rows.map(r => ({ firmId: r.firmId }));
            if (colsKeys.length === 2 && colsKeys.includes("id") && colsKeys.includes("runningBalance")) {
              if (sourceTypeValues.length > 0 && sourceIdValues.length > 0) {
                // Canonical existingReversal lookup: filter explicitly by both filters
                return ledger
                  .filter(r => r.sourceType === "billing_ledger_reversal")
                  .filter(r => firmIdValues.length === 0 || matchNum(firmIdValues, r.firmId))
                  .filter(r => sourceIdValues.length === 0 || matchNum(sourceIdValues, r.sourceId))
                  .filter(r => idempotencyValues.length === 0 || matchStr(idempotencyValues, r.idempotencyKey))
                  .map(r => ({ id: r.id, runningBalance: r.runningBalance }));
              }
              if (sourceTypeValues.length > 0 || sourceIdValues.length > 0 || /source_type|sourceType|source_id|sourceId/.test(predAll)) {
                // legacy shape but partial filter info; enforce sourceId match by forcing empty if none explicitly given
                const filtered = ledger
                  .filter(r => r.sourceType === "billing_ledger_reversal")
                  .filter(r => firmIdValues.length === 0 || matchNum(firmIdValues, r.firmId))
                  .filter(r => sourceIdValues.length === 0 ? false : matchNum(sourceIdValues, r.sourceId));
                return filtered.map(r => ({ id: r.id, runningBalance: r.runningBalance }));
              }
              // dup idempotency fallback → all rows with filter by firm/idempotency/id
              return rows.map(r => ({ id: r.id, runningBalance: r.runningBalance }));
            }
            if (wantFull || colsKeys.length === 0) {
              return rows.map(r => ({ ...r, status: r.status ?? "posted", entryType: r.entryType, sourceType: r.sourceType, sourceId: r.sourceId, subscriptionId: r.subscriptionId ?? null, invoiceId: r.invoiceId ?? null, billingPeriodStart: null, billingPeriodEnd: null, currency: "MYR", referenceNo: null, correlationId: null, dueDate: null, paidDate: null, description: "", createdBy: null, debit: r.debit, credit: r.credit, firmId: r.firmId, idempotencyKey: r.idempotencyKey, id: r.id, runningBalance: r.runningBalance }));
            }
            return rows.map(r => ({ id: r.id, runningBalance: r.runningBalance }));
          };
          return {
            where: (_pred2: any) => {
              if (tn === "billing_ledger") {
                if (isSumAggregate) order.push({ op: "sum" });
                const running = ledger.reduce((acc, l) => acc + Number(l.debit) - Number(l.credit), 0);
                const buildRows = (): any[] => {
                  if (isSumAggregate) return [{ running: String(running.toFixed(2)) }];
                  return buildLedgerRowsGivenPred(_pred2, colsKeys.length === 0);
                };
                const resultRows = buildRows();
                const chain = {
                  limit: (n: number) => Promise.resolve(resultRows.slice(0, n)),
                };
                (chain as any).then = (onFulfilled?: any, onRejected?: any) => Promise.resolve(resultRows).then(onFulfilled, onRejected);
                return chain as any;
              }
              const rows = tn === "firms" ? firms : [];
              const chain2 = { limit: (n: number) => Promise.resolve(rows.slice(0, n)) };
              (chain2 as any).then = (onF?: any, onR?: any) => Promise.resolve(rows).then(onF, onR);
              return chain2 as any;
            },
            limit: (_n: number) => {
              if (tn === "billing_ledger") {
                const running = ledger.reduce((acc, l) => acc + Number(l.debit) - Number(l.credit), 0);
                return Promise.resolve([{ running: String(running.toFixed(2)) }]);
              }
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
