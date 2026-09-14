import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authSafeDbModule from "../lib/auth-safe-db.js";
import {
  tickAllFirms,
  scanBottlenecksForFirm,
  enumerateActiveFirmIds,
  tryAcquireLock,
} from "../jobs/case-bottleneck-monitor.js";
import { writeAuditLog } from "../lib/auth.js";
import * as monitorModule from "../jobs/case-bottleneck-monitor.js";

// ============================================================
// Snapshot + full restore process.env around EVERY test.
// ============================================================
let fullEnvSnapshot: NodeJS.ProcessEnv;
beforeEach(() => {
  fullEnvSnapshot = { ...process.env };
  (mockWithAuthSafeDb as any).mockClear?.();
  (mockWithTenantSafeDb as any).mockClear?.();
  (mockWriteAuditLog as any).mockClear?.();
  process.env.NODE_ENV = "test";
});
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k !== "PATH" && k !== "SYSTEMROOT" && k !== "SystemRoot") {
      delete process.env[k];
    }
  }
  Object.assign(process.env, fullEnvSnapshot);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Sentinel — any production code that regresses to direct global db fails.
class DirectGlobalDbAccessSentinel extends Error {
  constructor(ctx: string) {
    super(
      `DIRECT_GLOBAL_DB_ACCESSED(${ctx}) — implementation regressed to direct global @workspace/db client.`,
    );
    this.name = "DirectGlobalDbAccessSentinel";
    Object.setPrototypeOf(this, DirectGlobalDbAccessSentinel.prototype);
  }
}
function throwDirectGlobalSentinel(ctx: string): any {
  throw new DirectGlobalDbAccessSentinel(ctx);
}

// ============================================================
// Module-level mock: auth-safe-db module — both withAuthSafeDb
// and withTenantSafeDb captured. Default scoped db throws sentinel
// unless the test installs a mockImplementation.
// ============================================================
vi.mock("../lib/auth-safe-db.js", async (orig) => {
  const actual = await orig<typeof authSafeDbModule>();
  return {
    ...actual,
    withAuthSafeDb: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => {
      const sentinelDb: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "select" || prop === "delete" || prop === "insert" || prop === "update" || prop === "execute") {
              return () => throwDirectGlobalSentinel(`scoped_authdb.${String(prop)}`);
            }
            return undefined;
          },
        },
      );
      return await fn(sentinelDb);
    }),
    withTenantSafeDb: vi.fn(async (_firmId: number, fn: (db: unknown) => Promise<unknown>) => {
      const sentinelDb: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "select" || prop === "delete" || prop === "insert" || prop === "update" || prop === "execute" || prop === "selectDistinctOn") {
              return () => throwDirectGlobalSentinel(`scoped_tenantdb.${String(prop)}`);
            }
            return undefined;
          },
        },
      );
      return await fn(sentinelDb);
    }),
    isTransientDbConnectionError: vi.fn(() => false),
  };
});

const mockWithAuthSafeDb = authSafeDbModule.withAuthSafeDb as unknown as ReturnType<typeof vi.fn>;
const mockWithTenantSafeDb = (authSafeDbModule as any).withTenantSafeDb as unknown as ReturnType<typeof vi.fn>;

// Sentinel global mock for @workspace/db direct access.
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  const sentinelDb: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (["select", "delete", "insert", "update", "execute", "transaction", "selectDistinctOn"].includes(String(prop))) {
          return (..._args: any[]) => throwDirectGlobalSentinel(`db.${String(prop)}`);
        }
        if (typeof actual?.db?.[prop] !== "undefined") return actual.db[prop];
        return undefined;
      },
    },
  );
  const sentinelPool = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "connect" || prop === "query" || prop === "end") {
          return (..._args: any[]) => throwDirectGlobalSentinel(`pool.${String(prop)}`);
        }
        if (typeof actual?.pool?.[prop] !== "undefined") return actual.pool[prop];
        return undefined;
      },
    },
  );
  return {
    ...actual,
    pool: sentinelPool,
    db: sentinelDb,
    makeRlsDb: (..._args: any[]) => throwDirectGlobalSentinel("makeRlsDb"),
  };
});

// Spy (as module mock override) on writeAuditLog to force scoped db pass.
vi.mock("../lib/auth.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    writeAuditLog: vi.fn(async (params: any, options?: any) => {
      if (!options?.db) {
        throw new DirectGlobalDbAccessSentinel(
          `writeAuditLog called without options.db — would fall back to global direct db. (entityType=${params?.entityType}, action=${params?.action})`,
        );
      }
      try {
        if (typeof actual.writeAuditLog === "function") {
          return await actual.writeAuditLog(params, options);
        }
      } catch {
        /* ignore impl-specific downstream failures */
      }
    }),
  };
});
const mockWriteAuditLog = writeAuditLog as unknown as ReturnType<typeof vi.fn>;

// ============================================================
// Helpers
// ============================================================
function chainable<T extends unknown[]>(rows: T): any {
  const self: any = {
    then: (resolve: (value: T) => any) => Promise.resolve(rows).then(resolve),
    catch: (reject: any) => Promise.resolve(rows).catch(reject),
    finally: (f: any) => Promise.resolve(rows).finally(f),
    limit: (_n?: number) => self,
    where: (_c?: any) => self,
    leftJoin: (_a?: any) => self,
    innerJoin: (_a?: any) => self,
    orderBy: (_a?: any) => self,
    groupBy: (_a?: any) => self,
    returning: (_shape?: any) => Promise.resolve([{ id: 1001 }] as any),
    set: (_values: any) => self,
    values: (_vals: any) => self,
    from: (_t: any) => self,
  };
  return self;
}

function fakeEmptyFirmScopedDb(overrides: Record<string, any> = {}): any {
  const base: any = {
    selectDistinctOn: () => ({ from: () => ({ innerJoin: () => ({ where: () => chainable([]) }) }) }),
    select: () => ({
      from: () => ({
        where: () => chainable([]),
        leftJoin: () => ({ where: () => chainable([]) }),
        innerJoin: () => ({ where: () => chainable([]) }),
        orderBy: () => chainable([]),
        groupBy: () => chainable([]),
        limit: () => chainable([]),
      }),
    }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve<any[]>([]) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve<any>({}) }) }),
  };
  return { ...base, ...overrides };
}

// ============================================================
// Tests
// ============================================================

describe("case-bottleneck-monitor — security architecture", () => {
  // T1
  it("T1 — direct global db/pool/makeRlsDb path throws DirectGlobalDbAccessSentinel", () => {
    // Act on @workspace/db directly via dynamic require → MUST throw sentinel.
    // Doing this inside an async callback to ensure sentinel fires.
    const directDbAccessLambda = async () => {
      const { db, pool, makeRlsDb } = await import("@workspace/db");
      await db.select({ x: 1 } as any);
      throw new Error("Should have thrown sentinel");
    };
    return expect(directDbAccessLambda()).rejects.toBeInstanceOf(DirectGlobalDbAccessSentinel);
  });

  // T2 — enumerateActiveFirmIds uses withAuthSafeDb founder scope.
  it("T2 — enumerateActiveFirmIds runs inside withAuthSafeDb, no allowUnsafe", async () => {
    const callOpts: Array<any> = [];
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      callOpts.push(opts);
      return await fn({
        select: (_shape: any) => ({
          from: (_t: any) => ({
            where: () => Promise.resolve<any[]>([
              { id: 11, status: "active" },
              { id: 12, status: "active" },
              { id: 13, status: "active" },
            ]),
          }),
        }),
      });
    });
    const rows = await enumerateActiveFirmIds();
    expect(rows.map(r => r.id).sort()).toEqual([11, 12, 13]);
    expect(mockWithAuthSafeDb).toHaveBeenCalledTimes(1);
    const o = callOpts[0] ?? {};
    expect(o.allowUnsafe !== true).toBe(true);
    expect(o.retry).toBe(true);
    expect(o.maxRetries).toBe(1);
    expect(o.ctx?.stage).toBe("case_bottleneck_monitor_list_firms");
  });

  // T3 — scanBottlenecksForFirm uses withTenantSafeDb(firmId) scoped.
  it("T3 — scanBottlenecksForFirm runs inside withTenantSafeDb(firmId) context — retry:false / maxRetries:0 (no write replay), no allowUnsafe (structurally absent)", async () => {
    const callArgs: Array<any> = [];
    mockWithTenantSafeDb.mockImplementation(async (firmId: number, fn: any, opts?: any) => {
      callArgs.push({ firmId, opts });
      return await fn(fakeEmptyFirmScopedDb());
    });
    const result = await scanBottlenecksForFirm(42);
    expect(Array.isArray(result.createdSnapshots)).toBe(true);
    expect(mockWithTenantSafeDb).toHaveBeenCalledTimes(1);
    expect(callArgs[0].firmId).toBe(42);
    expect(callArgs[0].opts?.ctx?.stage).toBe("case_bottleneck_monitor_scan");
    expect(callArgs[0].opts?.ctx?.firmId).toBe(42);
    // CORRECTION: monitor write scans MUST NOT be retried — ambiguous
    // COMMIT outcome would duplicate snapshots/logs/audit entries.
    expect(callArgs[0].opts?.retry).toBe(false);
    expect(callArgs[0].opts?.maxRetries).toBe(0);
    // Structural: withTenantSafeDb's opts type in auth-safe-db.ts doesn't
    // even have allowUnsafe. If someone added allowUnsafe to opts, this
    // assert would catch regressions.
    expect("allowUnsafe" in (callArgs[0].opts ?? {})).toBe(false);
  });

  // T4a — advisory lock: SQL text + params for BOTH acquire AND unlock on SAME raw client identity (acquired=true case).
  it("T4a — tryAcquireLock(acquired=true) runs pg_try_advisory_lock then pg_advisory_unlock both with ADVISORY_LOCK_KEY param on the EXACT same fake PoolClient", async () => {
    type QueryCall = { sqlText: string; params: any[] };
    const queries: QueryCall[] = [];
    let releaseCallCount = 0;
    let releaseDestroyArg: boolean | undefined = undefined;
    const ONE_AND_ONLY_FAKE_CLIENT_IDENTITY_TAG = Symbol("same_raw_poolclient");
    const rawClient: any = {
      __identity: ONE_AND_ONLY_FAKE_CLIENT_IDENTITY_TAG,
      async query(sqlOrText: any, maybeBindings?: any[]) {
        const sqlText = typeof sqlOrText === "string" ? sqlOrText : sqlOrText?.sql ?? sqlOrText?.query ?? sqlOrText?.text ?? String(sqlOrText);
        const params = Array.isArray(maybeBindings) ? maybeBindings : [];
        queries.push({ sqlText, params });
        if (/pg_try_advisory_lock/.test(sqlText)) return { rows: [{ ok: true }] };
        if (/pg_advisory_unlock/.test(sqlText)) return { rows: [{ ok: true }] };
        return { rows: [] };
      },
      release(d?: boolean) { releaseCallCount++; releaseDestroyArg = d; },
    };
    const handle = await tryAcquireLock(rawClient);
    expect(handle.acquired).toBe(true);

    // First query MUST be the acquire query with correct SQL text.
    expect(queries.length).toBeGreaterThanOrEqual(1);
    const acquireCall = queries[0];
    expect(acquireCall.sqlText).toContain("pg_try_advisory_lock");
    expect(acquireCall.sqlText).toContain("hashtext($1::text)");
    expect(acquireCall.params).toEqual(["case_bottleneck_monitor"]);

    // Before release: NO unlock query yet. Client not released.
    expect(queries.some(q => /pg_advisory_unlock/.test(q.sqlText))).toBe(false);
    expect(releaseCallCount).toBe(0);

    // Call release() — now unlock query must happen on the SAME rawClient.
    await handle.release();
    const unlockCalls = queries.filter(q => /pg_advisory_unlock/.test(q.sqlText));
    expect(unlockCalls.length).toBe(1);
    expect(unlockCalls[0].sqlText).toContain("pg_advisory_unlock");
    expect(unlockCalls[0].sqlText).toContain("hashtext($1::text)");
    expect(unlockCalls[0].params).toEqual(["case_bottleneck_monitor"]);

    // Proof: both acquire + unlock queries ran on rawClient (they were pushed
    // into `queries` which only rawClient.query() appends to).
    expect(queries[0].sqlText).toContain("pg_try_advisory_lock");
    expect(queries.findIndex(q => /pg_advisory_unlock/.test(q.sqlText))).toBeGreaterThan(0);

    // Client release exactly once.
    expect(releaseCallCount).toBe(1);
    expect(releaseDestroyArg).toBe(false);
  });

  // T4b — acquired=false => NO unlock query, client release exactly once immediately inside tryAcquireLock.
  it("T4b — tryAcquireLock(acquired=false): NO pg_advisory_unlock; client released EXACTLY once; release() is idempotent no-op", async () => {
    type QueryCall = { sqlText: string; params: any[] };
    const queries: QueryCall[] = [];
    let releaseCallCount = 0;
    let releaseDestroyArg: boolean | undefined = undefined;
    const rawClient: any = {
      async query(sqlOrText: any, maybeBindings?: any[]) {
        const sqlText = typeof sqlOrText === "string" ? sqlOrText : sqlOrText?.sql ?? sqlOrText?.query ?? sqlOrText?.text ?? String(sqlOrText);
        const params = Array.isArray(maybeBindings) ? maybeBindings : [];
        queries.push({ sqlText, params });
        if (/pg_try_advisory_lock/.test(sqlText)) return { rows: [{ ok: false }] }; // NOT acquired
        return { rows: [] };
      },
      release(d?: boolean) { releaseCallCount++; releaseDestroyArg = d; },
    };
    const handle = await tryAcquireLock(rawClient);
    expect(handle.acquired).toBe(false);

    // Lock query was correct.
    expect(queries.length).toBe(1);
    expect(queries[0].sqlText).toContain("pg_try_advisory_lock");
    expect(queries[0].params).toEqual(["case_bottleneck_monitor"]);

    // CRITICAL: NO unlock query issued (lock was never held).
    expect(queries.some(q => /pg_advisory_unlock/.test(q.sqlText))).toBe(false);
    // Client released EXACTLY once (inside tryAcquireLock's doRelease).
    expect(releaseCallCount).toBe(1);

    // Double-check: calling release() on the handle is a no-op (idempotency).
    await handle.release();
    await handle.release();
    expect(releaseCallCount).toBe(1); // still 1
    expect(queries.some(q => /pg_advisory_unlock/.test(q.sqlText))).toBe(false); // still no unlock
  });

  // T4c — release() is idempotent when acquired=true (unlock + client release exactly one each).
  it("T4c — acquired=true: release() called twice → unlock exactly once + client release exactly once (idempotent)", async () => {
    let unlockCount = 0;
    let clientReleaseCount = 0;
    const rawClient: any = {
      async query(sqlOrText: any) {
        const t = typeof sqlOrText === "string" ? sqlOrText : sqlOrText?.sql ?? sqlOrText?.query ?? sqlOrText?.text ?? String(sqlOrText);
        if (/pg_try_advisory_lock/.test(t)) return { rows: [{ ok: true }] };
        if (/pg_advisory_unlock/.test(t)) { unlockCount++; return { rows: [{ ok: true }] }; }
        return { rows: [] };
      },
      release() { clientReleaseCount++; },
    };
    const handle = await tryAcquireLock(rawClient);
    expect(handle.acquired).toBe(true);
    expect(unlockCount).toBe(0);
    expect(clientReleaseCount).toBe(0);
    await handle.release();
    await handle.release(); // second call — MUST be idempotent no-op
    await handle.release(); // third call — also no-op
    expect(unlockCount).toBe(1);
    expect(clientReleaseCount).toBe(1);
  });

  // T4d — lock acquisition query itself THROWS (not "not acquired").
  //        Cleanup happens once, no unlock, the error propagates so loop
  //        can misclassify as contention (acquired=false) vs DB fault.
  it("T4d — acquire query throws: client released once, never any unlock query, function REJECTS (does NOT return acquired=false)", async () => {
    let clientReleaseCount = 0;
    let releaseDestroyArg: boolean | undefined = undefined;
    let unlockAttempted = false;
    const ERR_CODE = "ETIMEDOUT"; // matches classifyTransient code check
    const ERR_MSG = "connect timeout BOOM acquire query"; // matches message check
    const rawClient: any = {
      async query(sqlOrText: any) {
        const t = typeof sqlOrText === "string" ? sqlOrText : sqlOrText?.sql ?? String(sqlOrText);
        if (/pg_advisory_unlock/.test(t)) { unlockAttempted = true; return { rows: [] }; }
        if (/pg_try_advisory_lock/.test(t)) {
          const err = new Error(ERR_MSG);
          (err as any).code = ERR_CODE;
          throw err;
        }
        return { rows: [] };
      },
      release(d?: boolean) { clientReleaseCount++; releaseDestroyArg = d; },
    };
    // MUST reject / throw — NOT silently return an acquired=false handle.
    await expect(tryAcquireLock(rawClient)).rejects.toThrow(/BOOM acquire query/);
    // Cleanup ran exactly once: client returned to pool.
    expect(clientReleaseCount).toBe(1);
    // Destroy flag: if isTransientDbConnectionError recognizes it, destroy=true;
    // for non-transient errors, destroy=false. Either way, cleanup exactly once.
    expect(typeof releaseDestroyArg).toBe("boolean");
    // No pg_advisory_unlock issued (acquire never completed).
    expect(unlockAttempted).toBe(false);
  });

  // T4e — unlock itself fails: client is still released but destroy=true.
  it("T4e — acquired=true then pg_advisory_unlock fails → client is destroyed/released once safely", async () => {
    let unlockCount = 0;
    let clientReleaseDestroy: boolean | undefined = undefined;
    let clientReleaseCount = 0;
    const rawClient: any = {
      async query(sqlOrText: any) {
        const t = typeof sqlOrText === "string" ? sqlOrText : sqlOrText?.sql ?? String(sqlOrText);
        if (/pg_try_advisory_lock/.test(t)) return { rows: [{ ok: true }] };
        if (/pg_advisory_unlock/.test(t)) {
          unlockCount++;
          throw new Error("UNLOCK_CONN_DROPPED");
        }
        return { rows: [] };
      },
      release(d?: boolean) { clientReleaseCount++; clientReleaseDestroy = d; },
    };
    const handle = await tryAcquireLock(rawClient);
    expect(handle.acquired).toBe(true);
    await handle.release();
    expect(unlockCount).toBe(1);
    expect(clientReleaseCount).toBe(1);
    expect(clientReleaseDestroy).toBe(true); // dirty session must be destroyed
  });

  // T4f — same PoolClient identity for acquire + unlock can be verified by
  //        unique symbol tag on fake client AND raw query count is shared.
  it("T4f — acquire+unlock run on the EXACT same PoolClient instance (proven by unique tag + counter shared across acquire/unlock/release)", async () => {
    const UNIQUE = Symbol.for("bottleneck-monitor-lock-client");
    let queryCallerIdentity: symbol[] = [];
    let releaseCallerIdentity: symbol[] = [];
    let acquireSeen = false;
    let unlockSeen = false;
    function makeFakeClient(tag: symbol) {
      return {
        __tag: tag,
        async query(sqlOrText: any, maybeBindings?: any[]) {
          queryCallerIdentity.push(tag);
          const t = typeof sqlOrText === "string" ? sqlOrText : sqlOrText?.sql ?? String(sqlOrText);
          const p = Array.isArray(maybeBindings) ? maybeBindings : [];
          if (/pg_try_advisory_lock/.test(t)) {
            acquireSeen = true;
            expect(p).toEqual(["case_bottleneck_monitor"]);
            return { rows: [{ ok: true }] };
          }
          if (/pg_advisory_unlock/.test(t)) {
            unlockSeen = true;
            expect(p).toEqual(["case_bottleneck_monitor"]);
            return { rows: [{ ok: true }] };
          }
          return { rows: [] };
        },
        release() {
          releaseCallerIdentity.push(tag);
        },
      };
    }
    const rawClientA = makeFakeClient(UNIQUE);
    const handle = await tryAcquireLock(rawClientA as any);
    await handle.release();
    expect(acquireSeen).toBe(true);
    expect(unlockSeen).toBe(true);
    // Every query AND the release must have gone through rawClientA (the same instance).
    expect(queryCallerIdentity.every(s => s === UNIQUE)).toBe(true);
    expect(releaseCallerIdentity.every(s => s === UNIQUE)).toBe(true);
    expect(queryCallerIdentity.length).toBe(2); // 1 acquire + 1 unlock
    expect(releaseCallerIdentity.length).toBe(1);
  });

  // T5 — per-firm failure does not skip later firms.
  it("T5 — one firm scan throw DOES NOT skip later firms in tickAllFirms", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const fakeHandle = { acquired: true, release } as any;
    const proc: number[] = [];
    let throwOccurred = false;
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      if (opts?.ctx?.stage === "case_bottleneck_monitor_list_firms") {
        return await fn({ select: () => ({ from: () => ({ where: () => Promise.resolve<any[]>([{ id: 201 }, { id: 202 }, { id: 203 }]) }) }) });
      }
      return await fn({ insert: () => ({ values: () => ({}) }) });
    });
    mockWithTenantSafeDb.mockImplementation(async (firmId: number, fn: any) => {
      proc.push(firmId);
      if (firmId === 202 && !throwOccurred) {
        throwOccurred = true;
        throw new Error("FIRM_202_SCAN_THROWN");
      }
      return await fn(fakeEmptyFirmScopedDb());
    });
    const r = await tickAllFirms({ lockHandle: fakeHandle });
    expect(r.skipped).toBe(false);
    expect(throwOccurred).toBe(true);
    expect(proc).toEqual([201, 202, 203]);
    // Lock handle injected by tests: tickAllFirms does NOT release handles it does not own.
    // (That is the semantic of passing in lockHandle.)
    expect(release).not.toHaveBeenCalled();
  });

  // T6 — owned lock cleaned up in finally even when per-firm throws (finality).
  it("T6 — tickAllFirms-owned advisory lock handle.release() called in finally even if every firm scan throws", async () => {
    let unlockObserved = false;
    let rawClientReleased = false;
    const fakeRawClient: any = {
      async query(sqlOrText: any) {
        const t = typeof sqlOrText === "string" ? sqlOrText : sqlOrText?.sql ?? sqlOrText?.query ?? sqlOrText?.text ?? String(sqlOrText);
        if (/pg_try_advisory_lock/.test(t)) return { rows: [{ ok: true }] };
        if (/pg_advisory_unlock/.test(t)) { unlockObserved = true; return { rows: [] }; }
        throw new Error("not allowed");
      },
      release() { rawClientReleased = true; },
    };
    const fakeAcquire = async (): Promise<any> => {
      // Use real tryAcquireLock semantic pattern via production-like closure:
      // acquire on fakeRawClient, then produce handle with release() that
      // unlocks + releases the same fakeRawClient.
      const r = await fakeRawClient.query("SELECT pg_try_advisory_lock(hashtext('case_bottleneck_monitor')) as ok");
      const acquired = r.rows?.[0]?.ok === true;
      let released = false;
      return {
        acquired,
        release: async () => {
          if (released) return;
          released = true;
          if (acquired) {
            try { await fakeRawClient.query("SELECT pg_advisory_unlock(hashtext('case_bottleneck_monitor')) as ok"); } catch { /* ignore */ }
          }
          fakeRawClient.release();
        },
      };
    };
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      if (opts?.ctx?.stage === "case_bottleneck_monitor_list_firms") {
        return await fn({ select: () => ({ from: () => ({ where: () => Promise.resolve<any[]>([{ id: 301 }, { id: 302 }]) }) }) });
      }
      return await fn({ insert: () => ({ values: () => ({}) }) });
    });
    mockWithTenantSafeDb.mockImplementation(async (_firmId: number, fn: any) => {
      throw new Error("PER_FIRM_SCAN_ERROR");
    });
    const result = await tickAllFirms({ acquireLockFn: fakeAcquire });
    expect(result).toBeDefined();
    expect(result.skipped).toBe(false);
    // owned lock: unlock and client release observed via fakeAcquire's custom handle.
    expect(unlockObserved).toBe(true);
    expect(rawClientReleased).toBe(true);
  });

  // T6b — EXACT per-firm-scan failure lock cleanup: one scan throws, later firms still run,
  //        unlock exactly once, client release exactly once, acquire+unlock on same raw client.
  it("T6b — one per-firm scan throws (NOT enumeration): unlock=1, release=1, same raw PoolClient, later firms still scanned", async () => {
    type QueryCall = { sqlText: string; params: any[] };
    const queries: QueryCall[] = [];
    let clientReleaseCount = 0;
    const SAME_CLIENT_TAG = Symbol("firm_scan_fail_same_raw_client");
    const firmsTouchedByScan: number[] = [];
    const fakeRawClient: any = {
      __tag: SAME_CLIENT_TAG,
      async query(sqlOrText: any, maybeBindings?: any[]) {
        // Verify identity: every query comes from this object
        expect(this).toBe(fakeRawClient);
        expect(this.__tag).toBe(SAME_CLIENT_TAG);
        const sqlText = typeof sqlOrText === "string" ? sqlOrText : sqlOrText?.sql ?? String(sqlOrText);
        const params = Array.isArray(maybeBindings) ? maybeBindings : [];
        queries.push({ sqlText, params });
        if (/pg_try_advisory_lock/.test(sqlText)) return { rows: [{ ok: true }] };
        if (/pg_advisory_unlock/.test(sqlText)) return { rows: [{ ok: true }] };
        return { rows: [] };
      },
      release(_d?: boolean) { clientReleaseCount++; expect(this).toBe(fakeRawClient); },
    };
    // Reuse real tryAcquireLock against the fakeRawClient to prove same-client identity across acquire+unlock.
    const fakeAcquire = () => tryAcquireLock(fakeRawClient as any);
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      if (opts?.ctx?.stage === "case_bottleneck_monitor_list_firms") {
        return await fn({ select: () => ({ from: () => ({ where: () => Promise.resolve<any[]>([{ id: 101 }, { id: 102 }, { id: 103 }]) }) }) });
      }
      return await fn({ insert: () => ({ values: () => ({}) }) });
    });
    mockWithTenantSafeDb.mockImplementation(async (firmId: number, fn: any) => {
      firmsTouchedByScan.push(firmId);
      if (firmId === 102) throw new Error("FIRM_102_PER_FIRM_SCAN_FAIL");
      return await fn(fakeEmptyFirmScopedDb());
    });
    const result = await tickAllFirms({ acquireLockFn: fakeAcquire });
    // Later firms proceed past failure.
    expect(firmsTouchedByScan).toEqual([101, 102, 103]);
    expect(result.skipped).toBe(false);
    // Queries: 1 acquire + 1 unlock.
    const acquire = queries.filter(q => /pg_try_advisory_lock/.test(q.sqlText));
    const unlock = queries.filter(q => /pg_advisory_unlock/.test(q.sqlText));
    expect(acquire.length).toBe(1);
    expect(unlock.length).toBe(1);
    expect(acquire[0].params).toEqual(["case_bottleneck_monitor"]);
    expect(unlock[0].params).toEqual(["case_bottleneck_monitor"]);
    // Raw PoolClient released exactly once.
    expect(clientReleaseCount).toBe(1);
    // Acquire + unlock both ran on the SAME raw fakeRawClient instance (proved by expect(this).toBe inside query/release mocks above + only 2 queries both tracked).
    expect(queries.length).toBe(2);
  });

  // T6a — thrown tick (enumerate throws) still releases the owned lock exactly once.
  it("T6a — enumeration itself throws: acquired lock still released once (unlock + pool return)", async () => {
    let unlockCalls = 0;
    let clientReturnCalls = 0;
    const fakeAcquire = async (): Promise<any> => {
      let released = false;
      return {
        acquired: true,
        release: async () => {
          if (released) return;
          released = true;
          unlockCalls++;
          clientReturnCalls++;
        },
      };
    };
    mockWithAuthSafeDb.mockImplementation(async () => {
      throw new Error("ENUMERATE_FIRMS_DB_DOWN");
    });
    await expect(tickAllFirms({ acquireLockFn: fakeAcquire })).rejects.toBeDefined();
    // One unlock + one client return, even though the tick threw.
    expect(unlockCalls).toBe(1);
    expect(clientReturnCalls).toBe(1);
  });

  // T7 — no allowUnsafe:true ever used by any monitor call site.
  it("T7 — monitor never passes allowUnsafe:true; withTenantSafeDb signature does not include allowUnsafe", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const fakeHandle = { acquired: true, release } as any;
    const allOpts: Array<{ which: string; opts: any }> = [];
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      allOpts.push({ which: "auth", opts });
      if (opts?.ctx?.stage === "case_bottleneck_monitor_list_firms") {
        return await fn({ select: () => ({ from: () => ({ where: () => Promise.resolve<any[]>([{ id: 401 }]) }) }) });
      }
      return await fn({ insert: () => ({ values: () => ({}) }), select: () => ({ from: () => ({ where: () => Promise.resolve<any[]>([]) }) }) });
    });
    mockWithTenantSafeDb.mockImplementation(async (_firmId: number, fn: any, opts?: any) => {
      allOpts.push({ which: "tenant", opts });
      return await fn(fakeEmptyFirmScopedDb());
    });
    await tickAllFirms({ lockHandle: fakeHandle });
    for (const entry of allOpts) {
      expect(entry?.opts?.allowUnsafe !== true).toBe(true);
    }
  });

  // T7b — Retry policy per stage:
  //        enumerateActiveFirmIds   (READ)  → retry:true  maxRetries:1
  //        scanBottlenecksForFirm  (WRITE) → retry:false maxRetries:0
  //        tick-level writeAuditLog(WRITE) → retry:false maxRetries:0
  it("T7b — retry policy per stage: enumeration READ may retry; per-firm WRITE / tick-audit WRITE must NOT retry", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const fakeHandle = { acquired: true, release } as any;
    const byStage: Record<string, any> = {};
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      byStage[opts?.ctx?.stage ?? "unknown"] = opts;
      if (opts?.ctx?.stage === "case_bottleneck_monitor_list_firms") {
        return await fn({ select: () => ({ from: () => ({ where: () => Promise.resolve<any[]>([{ id: 501 }]) }) }) });
      }
      return await fn({ insert: () => ({ values: () => ({}) }) });
    });
    mockWithTenantSafeDb.mockImplementation(async (_firmId: number, fn: any, opts?: any) => {
      byStage[opts?.ctx?.stage ?? "unknown_tenant"] = opts;
      // The real scanBottlenecksForFirmWithDb function returns BottleneckScanResult.
      // In our mocked fakeEmptyFirmScopedDb, reads return empty so the function
      // returns empty arrays → createdSnapshots.length=0. We therefore force
      // the return value to include one created + one escalated so the outer
      // tick audit write branch fires.
      const _inner = fn(fakeEmptyFirmScopedDb());
      void _inner; // ignore actual scan for retry opts testing
      return {
        createdSnapshots: [{ id: 1 }],
        resolvedSnapshots: [],
        escalatedSnapshots: [{ id: 2 }],
        scannedAt: new Date(),
        escalationConfig: null as any,
      };
    });
    // Diagnose: enumerate active firms first
    const r = await tickAllFirms({ lockHandle: fakeHandle });
    void r;

    // A. Founder enumeration (READ ONLY): retry allowed.
    const enumOpts = byStage["case_bottleneck_monitor_list_firms"];
    expect(enumOpts?.retry).toBe(true);
    expect(enumOpts?.maxRetries).toBe(1);

    // B. Per-firm scan (contains INSERT/UPDATE writes): NO retry.
    const firmScanOpts = byStage["case_bottleneck_monitor_scan"];
    expect(firmScanOpts?.retry).toBe(false);
    expect(firmScanOpts?.maxRetries).toBe(0);

    // C. Tick-level audit (writeAuditLog INSERT): NO retry.
    const tickAuditOpts = byStage["case_bottleneck_monitor_tick_audit"];
    expect(tickAuditOpts).not.toBeUndefined();
    expect(tickAuditOpts?.retry).toBe(false);
    expect(tickAuditOpts?.maxRetries).toBe(0);
  });

  // T8 — all INSERT/UPDATE/SELECT paths flow through passed scopedDb (not global).
  it("T8 — scoped INSERT/UPDATE/SELECT paths flow through the passed firm RLS db, not global", async () => {
    let selectCount = 0, insertCount = 0, updateCount = 0;
    const trackedDb = () => ({
      selectDistinctOn: (_cols: any, shape: any) => {
        selectCount++;
        return { from: () => ({ innerJoin: () => ({ where: () => chainable([{ id: 8001 }]) }) }) };
      },
      select: (shape: any) => {
        selectCount++;
        return {
          from: (_t: any) => ({
            where: () => {
              // LoadEscalationConfig approval rules row.
              if (shape && typeof shape === "object" && "approvalRules" in shape) {
                return chainable([
                  {
                    approvalRules: {
                      bottleneckEscalation: {
                        escalateToPartnerAtSeverity: "attention",
                        autoEscalateKinds: ["pv_delay", "case_no_movement", "approval_waiting", "case_waiting", "case_on_hold", "urgent"],
                        partnerBottleneckDigestEnabled: false,
                      },
                    },
                  },
                ]);
              }
              // Overdue PV row.
              if (shape && typeof shape === "object" && "voucherNo" in shape) {
                return chainable([
                  {
                    id: 9111, voucherNo: "PV-9111",
                    paymentDueAt: new Date(Date.now() - 300 * 3600 * 1000),
                    caseId: 8001, amount: "200.00", status: "pending",
                    responsibleLawyerId: 10, firmId: 1,
                  },
                ]);
              }
              // Existence check for PV bottleneck snapshot → empty.
              return chainable([]);
            },
            leftJoin: () => ({
              where: () => chainable([
                { id: 5001, caseId: 8001, monitorKind: "case_no_movement" },
              ]),
            }),
            innerJoin: () => ({
              where: () => {
                if (shape && typeof shape === "object" && ("roleInCase" in shape)) {
                  return chainable([
                    { caseId: 8001, userId: 10, roleInCase: "lawyer" },
                    { caseId: 8001, userId: 11, roleInCase: "manager" },
                  ]);
                }
                return chainable([{ id: 8001 }]);
              },
            }),
            orderBy: () => chainable([{ createdAt: new Date() }]),
            groupBy: () => chainable([{ caseId: 8001, lastUpdated: new Date(Date.now() - 365 * 24 * 3600 * 1000) }]),
            limit: () => chainable([]),
          }),
        };
      },
      insert: (_t: any) => { insertCount++; return { values: (_v: any) => ({ returning: () => Promise.resolve<any[]>([{ id: 7000 + insertCount }]) }) }; },
      update: (_t: any) => { updateCount++; return { set: (_vs: any) => ({ where: () => Promise.resolve<any>({ rowCount: 1 }) }) }; },
    });
    mockWithTenantSafeDb.mockImplementation(async (_firmId: number, fn: any) => fn(trackedDb()));
    const r = await scanBottlenecksForFirm(1);
    expect(selectCount).toBeGreaterThan(0);
    // PV overdue snapshot inserted + log + escalate audit = insertCount positive.
    expect(insertCount).toBeGreaterThan(0);
    // Snapshot resolution updates should be counted also.
    expect(updateCount).toBeGreaterThan(0);
  });

  // T9 — escalate + tick writeAuditLog pass scopedDb; no global fallback used.
  it("T9 — escalateSnapshot audit + tickAudit both pass scoped options.db to writeAuditLog (no global fallback sentinel)", async () => {
    const invocations: any[] = [];
    (mockWriteAuditLog as any).mockImplementation(async (params: any, options?: any) => {
      invocations.push({ params, options });
      if (!options?.db) throw new DirectGlobalDbAccessSentinel(`missing options.db in ${params?.action}`);
    });
    const fakeAcquire = async (): Promise<any> => ({ acquired: true, release: vi.fn().mockResolvedValue(undefined) });
    const TICK_DB_TAG = { __kind: "TICK_AUDIT_SCOPED_DB" };
    const FIRM_DB_TAG = { __kind: "FIRM_SCAN_SCOPED_DB" };
    mockWithAuthSafeDb.mockImplementation(async (fn: any, opts?: any) => {
      if (opts?.ctx?.stage === "case_bottleneck_monitor_list_firms") {
        return await fn({ select: () => ({ from: () => ({ where: () => Promise.resolve<any[]>([{ id: 11 }]) }) }) });
      }
      return await fn({ insert: () => ({ values: () => ({}) }), select: () => ({ from: () => ({ where: () => Promise.resolve<any[]>([]) }) }), ...TICK_DB_TAG });
    });
    mockWithTenantSafeDb.mockImplementation(async (_firmId: number, fn: any) => {
      return await fn({
        ...FIRM_DB_TAG,
        selectDistinctOn: () => ({ from: () => ({ innerJoin: () => ({ where: () => chainable([{ id: 99 }]) }) }) }),
        select: (shape: any) => ({
          from: () => ({
            where: () => {
              if (shape && "approvalRules" in shape) {
                return chainable([
                  {
                    approvalRules: {
                      bottleneckEscalation: {
                        escalateToPartnerAtSeverity: "attention",
                        autoEscalateKinds: ["pv_delay"],
                        partnerBottleneckDigestEnabled: false,
                      },
                    },
                  },
                ]);
              }
              if (shape && "voucherNo" in shape) {
                return chainable([
                  {
                    id: 999, voucherNo: "PV-009",
                    paymentDueAt: new Date(Date.now() - 300 * 3600 * 1000),
                    caseId: 99, amount: "500.00", status: "pending",
                    responsibleLawyerId: 10, firmId: 11,
                  },
                ]);
              }
              return chainable([]);
            },
            leftJoin: () => ({ where: () => chainable([]) }),
            innerJoin: () => ({
              where: () => chainable([
                { caseId: 99, userId: 10, roleInCase: "lawyer" },
                { caseId: 99, userId: 11, roleInCase: "manager" },
              ]),
            }),
            orderBy: () => chainable([]),
            groupBy: () => chainable([]),
            limit: () => chainable([]),
          }),
        }),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve<any[]>([{ id: 31337 }]) }) }),
        update: () => ({ set: () => ({ where: () => Promise.resolve<any>({}) }) }),
      });
    });
    await tickAllFirms({ acquireLockFn: fakeAcquire });
    // writeAuditLog should have been called at least twice (escalate + tick audit)
    // each time passing options.db from inside a scoped callback with a tag
    // matching the scoped db kind — proving the db came from with*SafeDb.
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    for (const inv of invocations) {
      const d = inv?.options?.db;
      expect(d).toBeDefined();
      const kind = d?.__kind;
      expect(kind === "TICK_AUDIT_SCOPED_DB" || kind === "FIRM_SCAN_SCOPED_DB").toBe(true);
    }
    // At least one escalate and one tick invocation.
    const escalateCalls = invocations.filter(i => i.params?.action === "escalate");
    const tickCalls = invocations.filter(i => i.params?.action === "tick");
    expect(escalateCalls.length >= 1).toBe(true);
    expect(tickCalls.length >= 1).toBe(true);
    expect(escalateCalls[0]?.options?.db?.__kind).toBe("FIRM_SCAN_SCOPED_DB");
    expect(tickCalls[0]?.options?.db?.__kind).toBe("TICK_AUDIT_SCOPED_DB");
  });
});
