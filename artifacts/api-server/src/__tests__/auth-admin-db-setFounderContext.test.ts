import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Module-level mock factory.
//
// Shared lifecycle event stream captures:
//   query:BEGIN | query:COMMIT | query:ROLLBACK
//   setFounderContext(client)
//   makeRlsDb(client) -> returned rlsDb
//   callback(rlsDb)
//   clearTenantContext(client)
//   release:false / release:true
//
// Each test verifies exact ordering of this stream,
// delegating setFounderContext internals to lib/db/tenant-context.ts
// (canonical owner of app_user role switch + safe-role assert + set_config).
// ============================================================

type LifecycleEvent =
  | { kind: "query"; sql: string }
  | { kind: "setFounderContext"; clientId: number }
  | { kind: "makeRlsDb"; clientId: number }
  | { kind: "callback" }
  | { kind: "clearTenantContext"; clientId: number }
  | { kind: "release"; destroy: boolean };

const hoisted = vi.hoisted(() => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  // Shared lifecycle event stream. Reset to [] at start of every test.
  const events: LifecycleEvent[] = [];

  function buildFakeClient(clientId: number) {
    const client: any = {
      __clientId: clientId,
      async query(sql: any, _params?: any[]) {
        const sqlText = typeof sql === "string" ? sql : sql?.sql ?? String(sql ?? "");
        events.push({ kind: "query", sql: sqlText });
        return { rows: [] };
      },
      release(destroy?: boolean) {
        events.push({ kind: "release", destroy: Boolean(destroy) });
      },
    };
    return client;
  }

  const poolsByUrl = new Map<string, any>();

  function fakeGetOrCreateSharedPool(url: string) {
    if (!poolsByUrl.has(url)) {
      let nextClientId = 1;
      const pool: any = {
        __url: url,
        totalCount: 5,
        idleCount: 2,
        waitingCount: 0,
        async connect() {
          return buildFakeClient(nextClientId++);
        },
      };
      poolsByUrl.set(url, pool);
    }
    return poolsByUrl.get(url)!;
  }

  const fakeSetFounderContext = vi.fn(async (client: any) => {
    events.push({ kind: "setFounderContext", clientId: Number(client.__clientId) });
    return undefined;
  });

  const fakeClearTenantContext = vi.fn(async (client: any) => {
    events.push({ kind: "clearTenantContext", clientId: Number(client.__clientId) });
    return undefined;
  });

  const fakeMakeRlsDb = vi.fn((client: any) => {
    events.push({ kind: "makeRlsDb", clientId: Number(client.__clientId) });
    return { __tag: "fakeRlsDb", client };
  });

  function _reset() {
    events.length = 0;
    logger.info.mockReset?.();
    logger.warn.mockReset?.();
    logger.error.mockReset?.();
    fakeSetFounderContext.mockClear?.();
    fakeClearTenantContext.mockClear?.();
    fakeMakeRlsDb.mockClear?.();
    poolsByUrl.clear();
  }

  return {
    logger,
    events,
    fakeSetFounderContext,
    fakeClearTenantContext,
    fakeMakeRlsDb,
    fakeGetOrCreateSharedPool,
    poolsByUrl,
    _reset,
  };
});

vi.mock("../lib/logger.js", () => ({ logger: hoisted.logger }));

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();
  return {
    ...actual,
    getOrCreateSharedPool: hoisted.fakeGetOrCreateSharedPool,
    setFounderContext: hoisted.fakeSetFounderContext,
    clearTenantContext: hoisted.fakeClearTenantContext,
    makeRlsDb: hoisted.fakeMakeRlsDb,
  };
});

// Import AFTER all mocks are installed
import { withAuthAdminDb, isAuthAdminDbConfigured } from "../lib/auth-admin-db.js";

function summarise(events: LifecycleEvent[]): string[] {
  return events.map((e): string => {
    switch (e.kind) {
      case "query": {
        if (e.sql === "BEGIN") return "query:BEGIN";
        if (e.sql === "COMMIT") return "query:COMMIT";
        if (e.sql === "ROLLBACK") return "query:ROLLBACK";
        return `query:${e.sql}`;
      }
      case "setFounderContext": return "setFounderContext";
      case "makeRlsDb": return "makeRlsDb";
      case "callback": return "callback";
      case "clearTenantContext": return "clearTenantContext";
      case "release": return `release:${e.destroy}`;
    }
  });
}

describe("withAuthAdminDb() — setFounderContext delegation + lifecycle ordering", () => {
  beforeEach(() => {
    hoisted._reset();
    process.env.ADMIN_DATABASE_URL = "postgres://auth_admin_test:pw@localhost:5432/lawcaspro_test?schema=public";
    delete process.env.AUTH_DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.ADMIN_DATABASE_URL;
    delete process.env.AUTH_DATABASE_URL;
    hoisted._reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("A1 — SUCCESS lifecycle: exact ordering BEGIN → setFounderContext → makeRlsDb → callback → COMMIT → clearTenantContext → release:false", async () => {
    const returned = await withAuthAdminDb(async (db: any) => {
      hoisted.events.push({ kind: "callback" });
      expect(db?.__tag).toBe("fakeRlsDb");
      return { ok: true };
    }, { stage: "auth_login", route: "/api/auth/login" });
    expect(returned).toEqual({ ok: true });
    const order = summarise(hoisted.events);
    expect(order).toEqual([
      "query:BEGIN",
      "setFounderContext",
      "makeRlsDb",
      "callback",
      "query:COMMIT",
      "clearTenantContext",
      "release:false",
    ]);
    // Delegation sanity: one client identity used throughout
    const setCtx = hoisted.events.find((e) => e.kind === "setFounderContext") as Extract<LifecycleEvent, { kind: "setFounderContext" }>;
    const makeDb = hoisted.events.find((e) => e.kind === "makeRlsDb") as Extract<LifecycleEvent, { kind: "makeRlsDb" }>;
    const clearCtx = hoisted.events.find((e) => e.kind === "clearTenantContext") as Extract<LifecycleEvent, { kind: "clearTenantContext" }>;
    expect(setCtx.clientId).toBeGreaterThan(0);
    expect(makeDb.clientId).toBe(setCtx.clientId);
    expect(clearCtx.clientId).toBe(setCtx.clientId);
  });

  it("A2 — FAILURE lifecycle: exact ordering BEGIN → setFounderContext → makeRlsDb → callback throws → ROLLBACK → clearTenantContext → release:true", async () => {
    const injected = new Error("LOGIN_FAILED_INTERNAL");
    (injected as any).sqlState = "42501";
    (injected as any).cause = { message: "permission denied for table users", code: "42501" };
    await expect(
      withAuthAdminDb(async (_db: any) => {
        hoisted.events.push({ kind: "callback" });
        throw injected;
      }, { stage: "auth_login", route: "/api/auth/login", reqId: "req-abc" }),
    ).rejects.toBe(injected);
    const order = summarise(hoisted.events);
    expect(order).toEqual([
      "query:BEGIN",
      "setFounderContext",
      "makeRlsDb",
      "callback",
      "query:ROLLBACK",
      "clearTenantContext",
      "release:true",
    ]);
    // Safe logger fired with auth-admin-db.query_failed category
    expect(hoisted.logger.error).toHaveBeenCalledTimes(1);
    const [meta, evt] = hoisted.logger.error.mock.calls[0];
    expect(evt).toBe("auth-admin-db.query_failed");
    expect(meta.stage).toBe("auth_login");
    expect(meta.route).toBe("/api/auth/login");
    expect(meta.reqId).toBe("req-abc");
    expect(meta.sqlState).toBe("42501");
    expect(String(meta.errMessageShort ?? "")).toContain("LOGIN_FAILED_INTERNAL");
  });

  it("A3 — setFounderContext is invoked with same PoolClient identity that makeRlsDb receives and callback observes", async () => {
    let callbackDb: unknown = null;
    await withAuthAdminDb(async (db: any) => {
      callbackDb = db;
      return "ok";
    });
    expect(hoisted.fakeSetFounderContext).toHaveBeenCalledTimes(1);
    expect(hoisted.fakeMakeRlsDb).toHaveBeenCalledTimes(1);
    const setCtxArg = hoisted.fakeSetFounderContext.mock.calls[0][0];
    const makeDbArg = hoisted.fakeMakeRlsDb.mock.calls[0][0];
    // Same client instance passed to setFounderContext as to makeRlsDb
    expect(makeDbArg).toBe(setCtxArg);
    // Callback's db.__client is the same client identity
    expect((callbackDb as any)?.client).toBe(setCtxArg);
  });

  it("A4 — release called exactly once on success with destroy=false; no ROLLBACK sent", async () => {
    await withAuthAdminDb(async () => 7);
    const releases = hoisted.events.filter((e) => e.kind === "release");
    expect(releases).toHaveLength(1);
    expect((releases[0] as Extract<LifecycleEvent, { kind: "release" }>).destroy).toBe(false);
    const sqls = hoisted.events.filter((e) => e.kind === "query").map((e) => (e as Extract<LifecycleEvent, { kind: "query" }>).sql);
    expect(sqls).toContain("COMMIT");
    expect(sqls).not.toContain("ROLLBACK");
  });

  it("A5 — release called exactly once on failure with destroy=true; no COMMIT sent", async () => {
    const err = new Error("boom");
    await expect(withAuthAdminDb(async () => { throw err; })).rejects.toBe(err);
    const releases = hoisted.events.filter((e) => e.kind === "release");
    expect(releases).toHaveLength(1);
    expect((releases[0] as Extract<LifecycleEvent, { kind: "release" }>).destroy).toBe(true);
    const sqls = hoisted.events.filter((e) => e.kind === "query").map((e) => (e as Extract<LifecycleEvent, { kind: "query" }>).sql);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });

  it("B1 — withAuthAdminDb delegates founder setup to canonical setFounderContext and itself emits no manual SET LOCAL app.* GUC statements", async () => {
    await withAuthAdminDb(async () => 42, { stage: "auth_login" });
    // 1. withAuthAdminDb must invoke canonical setFounderContext exactly once.
    //    Internals of setFounderContext (app_user role switch + safe role assert + set_config)
    //    are owned by lib/db/src/tenant-context.ts and are NOT re-tested here
    //    to avoid duplicating contract ownership.
    expect(hoisted.fakeSetFounderContext).toHaveBeenCalledTimes(1);

    // 2. Direct client.query calls made BY withAuthAdminDb itself must NOT contain
    //    any of the 4 manual SET LOCAL app.* GUC patterns we previously used.
    //    (setFounderContext internals would emit their own queries in a real DB,
    //    but in this mocked harness the captured `query` stream reflects only
    //    withAuthAdminDb's direct BEGIN / COMMIT / ROLLBACK calls.)
    const directQueries = hoisted.events
      .filter((e) => e.kind === "query")
      .map((e) => (e as Extract<LifecycleEvent, { kind: "query" }>).sql);
    for (const s of directQueries) {
      expect(s).not.toMatch(/SET\s+LOCAL\s+app\.is_founder\s*=/i);
      expect(s).not.toMatch(/SET\s+LOCAL\s+app\.current_firm_id\s*=/i);
      expect(s).not.toMatch(/SET\s+LOCAL\s+app\.firm_id\s*=/i);
      expect(s).not.toMatch(/SET\s+LOCAL\s+app\.current_user_id\s*=/i);
    }
  });

  it("C1 — isAuthAdminDbConfigured() gate respects AUTH_DATABASE_URL / ADMIN_DATABASE_URL presence", async () => {
    delete process.env.ADMIN_DATABASE_URL;
    delete process.env.AUTH_DATABASE_URL;
    expect(isAuthAdminDbConfigured()).toBe(false);
    process.env.AUTH_DATABASE_URL = "postgres://fallback:pw@localhost/test";
    expect(isAuthAdminDbConfigured()).toBe(true);
  });

  it("C2 — Slow connect (>250ms) triggers existing pool_connect_slow warn logger (connect timing diagnostic preserved)", async () => {
    const before = hoisted.logger.warn.mock.calls.length;
    const FAKE_CONNECT_DELAY_MS = 350;
    let nowCalls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      const base = 1_700_000_000_000;
      if (nowCalls === 1) return base;
      return base + FAKE_CONNECT_DELAY_MS;
    });
    hoisted.poolsByUrl.clear();
    await withAuthAdminDb(async () => "ok", { stage: "auth_login" });
    nowSpy.mockRestore();
    expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
    const [meta, evt] = hoisted.logger.warn.mock.calls[before];
    expect(evt).toBe("auth-admin-db.pool_connect_slow");
    expect(Number(meta.connectMs)).toBeGreaterThanOrEqual(FAKE_CONNECT_DELAY_MS);
    expect(meta.poolTotal).toBe(5);
    expect(meta.poolIdle).toBe(2);
    expect(meta.poolWaiting).toBe(0);
  });
});
