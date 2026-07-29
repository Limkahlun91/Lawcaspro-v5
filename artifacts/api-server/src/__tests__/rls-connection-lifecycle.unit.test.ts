import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => {
  const pool = {
    connect: vi.fn(),
  };

  const setTenantContextSession = vi.fn(async (client: any, firmId: number, userId?: number) => {
    await client.query("SET ROLE app_user");
    await client.query("select set_config('app.current_firm_id', $1, false)", [String(firmId)]);
    await client.query("select set_config('app.firm_id', $1, false)", [String(firmId)]);
    await client.query("select set_config('app.is_founder', 'false', false)");
    if (userId !== undefined) {
      await client.query("select set_config('app.current_user_id', $1, false)", [String(userId)]);
    }
  });

  const clearTenantContext = vi.fn(async (client: any) => {
    await client.query("select set_config('app.current_firm_id', '0', false)");
    await client.query("select set_config('app.firm_id', '0', false)");
    await client.query("select set_config('app.is_founder', 'false', false)");
    await client.query("select set_config('app.current_user_id', '0', false)");
    await client.query("RESET ROLE");
  });

  const makeRlsDb = (client: any) => ({ __client: client });

  return {
    pool,
    setTenantContextSession,
    clearTenantContext,
    makeRlsDb,
  };
});

type Req = {
  userType: "firm_user" | "founder" | null;
  firmId: number | null;
  userId: number | null;
  path: string;
  method: string;
  ip?: string;
  headers: Record<string, string | undefined>;
  timing?: any;
  rlsDb?: any;
};

function makeRes() {
  const emitter = new EventEmitter();
  const res: any = emitter;
  res.locals = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.once = emitter.once.bind(emitter);
  res.on = emitter.on.bind(emitter);
  return res as any;
}

async function flushAsync(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("requireFirmUser RLS connection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not execute an outer BEGIN and binds req.rlsDb to the checked-out client", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const queries: any[] = [];
    const originalQuery = (...args: any[]) => {
      queries.push(args);
      const last = args[args.length - 1];
      if (typeof last === "function") {
        last(null, { rows: [] });
        return {};
      }
      return Promise.resolve({ rows: [] });
    };
    const client: any = { query: originalQuery, release: vi.fn() };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.rlsDb?.__client).toBe(client);
    expect(queries.flat().join(" ")).not.toContain("BEGIN");
  });

  it("sets session tenant context before next()", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const calls: string[] = [];
    dbMod.setTenantContextSession.mockImplementationOnce(async () => {
      calls.push("setTenantContextSession");
    });

    const client: any = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      release: vi.fn(),
    };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn(() => { calls.push("next"); });

    await requireFirmUser(req as any, res as any, next as any);

    expect(calls).toEqual(["setTenantContextSession", "next"]);
  });

  it("finish clears context and releases exactly once", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const client: any = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      release: vi.fn(),
    };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);
    res.emit("finish");
    await flushAsync();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(dbMod.clearTenantContext).toHaveBeenCalledTimes(1);
  });

  it("close clears context and releases exactly once", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const client: any = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      release: vi.fn(),
    };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);
    res.emit("close");
    await flushAsync();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(dbMod.clearTenantContext).toHaveBeenCalledTimes(1);
  });

  it("finish followed by close does not double-release", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const client: any = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      release: vi.fn(),
    };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);
    res.emit("finish");
    res.emit("close");
    await flushAsync();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(dbMod.clearTenantContext).toHaveBeenCalledTimes(1);
  });

  it("clearTenantContext failure destroys the connection", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    dbMod.clearTenantContext.mockRejectedValueOnce(new Error("fail"));

    const client: any = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      release: vi.fn(),
    };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);
    res.emit("finish");
    await flushAsync();

    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("middleware error destroys/releases safely", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    dbMod.setTenantContextSession.mockRejectedValueOnce(new Error("set context failed"));

    const client: any = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      release: vi.fn(),
    };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);

    expect(next).toHaveBeenCalledTimes(0);
    expect(res.status).toHaveBeenCalledWith(503);
    await flushAsync();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("query Promise overload still works after query tracking patch", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const originalQuery = vi.fn((...args: any[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        last(null, { rows: [{ ok: 1 }] });
        return { cb: true };
      }
      return Promise.resolve({ rows: [] });
    });
    const client: any = { query: originalQuery, release: vi.fn() };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);

    const result = await (client.query as any)("select 1");
    expect(result).toEqual({ rows: [] });
  });

  it("query callback overload still works after query tracking patch", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const originalQuery = vi.fn((...args: any[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        last(null, { rows: [{ ok: 1 }] });
        return { cb: true };
      }
      return Promise.resolve({ rows: [] });
    });
    const client: any = { query: originalQuery, release: vi.fn() };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);

    const cb = vi.fn();
    const ret = (client.query as any)("select 1", cb);
    expect(ret).toEqual({ cb: true });
    expect(cb).toHaveBeenCalled();
  });

  it("pending queries finish before cleanup (promise + callback)", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    let resolveSlow: (() => void) | null = null;
    const slow = new Promise<void>((r) => { resolveSlow = () => r(); });

    const callOrder: string[] = [];
    dbMod.clearTenantContext.mockImplementationOnce(async () => {
      callOrder.push("clearTenantContext");
    });

    const originalQuery = vi.fn((...args: any[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        slow.then(() => last(null, { rows: [] }));
        return { cb: true };
      }
      if (String(args[0]).includes("select slow")) {
        return slow.then(() => ({ rows: [] }));
      }
      return Promise.resolve({ rows: [] });
    });
    const client: any = { query: originalQuery, release: vi.fn() };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);

    const p1 = (client.query as any)("select slow");
    const cb = vi.fn();
    (client.query as any)("select slow cb", cb);

    res.emit("finish");
    expect(client.release).toHaveBeenCalledTimes(0);
    expect(callOrder).toEqual([]);

    resolveSlow?.();
    await p1;
    await flushAsync();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(dbMod.clearTenantContext).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("query failure does not leak tenant context (cleanup still runs)", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const err = new Error("boom");
    const originalQuery = vi.fn((sqlText: string) => {
      if (String(sqlText).includes("select boom")) return Promise.reject(err);
      return Promise.resolve({ rows: [] });
    });
    const client: any = { query: originalQuery, release: vi.fn() };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    const next = vi.fn();

    await requireFirmUser(req as any, res as any, next as any);

    await expect((client.query as any)("select boom")).rejects.toThrow("boom");

    res.emit("finish");
    await flushAsync();
    expect(dbMod.clearTenantContext).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("the next request cannot inherit the previous firm/user context", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const calls: any[] = [];
    const originalQuery = (...args: any[]) => {
      calls.push(args);
      const last = args[args.length - 1];
      if (typeof last === "function") {
        last(null, { rows: [] });
        return {};
      }
      return Promise.resolve({ rows: [] });
    };
    const client: any = { query: originalQuery, release: vi.fn() };
    dbMod.pool.connect.mockResolvedValue(client);

    const req1: Req = { userType: "firm_user", firmId: 1, userId: 2, path: "/x", method: "GET", headers: {} };
    const res1 = makeRes();
    await requireFirmUser(req1 as any, res1 as any, vi.fn() as any);
    res1.emit("finish");
    await flushAsync();

    const req2: Req = { userType: "firm_user", firmId: 9, userId: 99, path: "/y", method: "GET", headers: {} };
    const res2 = makeRes();
    await requireFirmUser(req2 as any, res2 as any, vi.fn() as any);
    res2.emit("finish");
    await flushAsync();

    const sqlText = calls.map((c) => String(c[0]));
    expect(sqlText.some((s) => s.includes("set_config('app.current_firm_id'"))).toBe(true);
    expect(sqlText.some((s) => s.includes("set_config('app.current_firm_id', '0'"))).toBe(true);
  });

  it("route-level transaction does not clear session tenant context prematurely (cleanup only on finish)", async () => {
    const { requireFirmUser } = await import("../lib/auth.js");
    const dbMod: any = await import("@workspace/db");

    const originalQuery = vi.fn(() => Promise.resolve({ rows: [] }));
    const client: any = { query: originalQuery, release: vi.fn() };
    dbMod.pool.connect.mockResolvedValue(client);

    const req: Req = {
      userType: "firm_user",
      firmId: 1,
      userId: 2,
      path: "/x",
      method: "GET",
      headers: {},
    };
    const res = makeRes();
    await requireFirmUser(req as any, res as any, vi.fn() as any);

    await (client.query as any)("BEGIN");
    await (client.query as any)("select 1");
    await (client.query as any)("COMMIT");

    expect(dbMod.clearTenantContext).toHaveBeenCalledTimes(0);
    res.emit("finish");
    await flushAsync();
    expect(dbMod.clearTenantContext).toHaveBeenCalledTimes(1);
  });
});
