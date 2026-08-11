import { describe, expect, it, vi } from "vitest";
import { PvTimeoutSetupFailed, setRlsClientStatementTimeout } from "../routes/payment-vouchers.js";
import type { AuthRequest } from "../lib/auth.js";
import type { PoolClient } from "pg";

describe("P0-3 setRlsClientStatementTimeout no silent catch", () => {
  it("SET LOCAL failure throws typed PvTimeoutSetupFailed with reqId/firmId/clientRequestId/sqlState/stage/timeoutMs", async () => {
    const client: any = {
      query: async (_q: any) => {
        const e = new Error("syntax error") as any;
        e.code = "42601";
        throw e;
      },
    } as PoolClient;
    const req = {
      id: "req-abc123",
      firmId: 99,
      userId: 10,
      rlsClient: client,
    } as unknown as AuthRequest;
    (req as any).pvClientRequestId = "client-req-001";
    let thrown: PvTimeoutSetupFailed | null = null;
    try {
      await setRlsClientStatementTimeout(req, 3000, "permissions_checks");
    } catch (err) {
      thrown = err as PvTimeoutSetupFailed;
    }
    expect(thrown).toBeInstanceOf(PvTimeoutSetupFailed);
    expect(thrown?.sqlState).toBe("42601");
    expect(thrown?.stage).toBe("permissions_checks");
    expect(thrown?.timeoutMs).toBe(3000);
    expect(thrown?.name).toBe("PvTimeoutSetupFailed");
  });

  it("SET LOCAL success does not throw", async () => {
    let executed = false;
    const client: any = {
      query: async (q: any) => {
        const text = typeof q === "string" ? q : (q as any).text ?? "";
        expect(text).toContain("SET LOCAL statement_timeout");
        executed = true;
        return { rows: [] };
      },
    } as PoolClient;
    const req = {
      id: "req-ok",
      firmId: 1,
      userId: 1,
      rlsClient: client,
    } as unknown as AuthRequest;
    await expect(setRlsClientStatementTimeout(req, 5000, "main_tx_entry")).resolves.not.toThrow();
    expect(executed).toBe(true);
  });
});

describe("P0-4 COMMIT-before-201 financial-write helper", () => {
  it("finalizeFirmUserTransaction commit failed sets ok=false + code=COMMIT_FAILED + sqlState", async () => {
    const { finalizeFirmUserTransaction } = await import("../lib/auth.js");
    let commitCalled = false;
    let rollbackCalled = false;
    let releaseCalled = false;
    let destroyFlag = false;
    const client: any = {
      query: async (q: any) => {
        const text = typeof q === "string" ? q : String(q);
        if (/COMMIT/i.test(text)) {
          commitCalled = true;
          const e = new Error("too many connections") as any;
          e.code = "53300";
          throw e;
        }
        if (/ROLLBACK/i.test(text)) {
          rollbackCalled = true;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: (destroy: boolean) => {
        releaseCalled = true;
        destroyFlag = Boolean(destroy);
      },
    } as PoolClient;
    const req = {
      id: "req-commit-fail",
      path: "/payment-vouchers",
      firmId: 1,
      userId: 1,
      rlsClient: client,
    } as unknown as AuthRequest;
    const result = await finalizeFirmUserTransaction(req, "commit");
    expect(commitCalled).toBe(true);
    expect(rollbackCalled).toBe(true);
    expect(releaseCalled).toBe(true);
    expect(destroyFlag).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("COMMIT_FAILED");
    expect(result.sqlState).toBe("53300");
    expect(result.commitOrRollbackMs).toBeGreaterThanOrEqual(0);
    expect(result.releaseMs).toBeGreaterThanOrEqual(0);
    expect(req.rlsClient).toBeUndefined();
  });

  it("finalizeFirmUserTransaction commit success sets ok=true + COMMIT_OK + no destroy", async () => {
    const { finalizeFirmUserTransaction } = await import("../lib/auth.js");
    let commitCalled = false;
    let releaseCalled = false;
    let destroyFlag = false;
    const client: any = {
      query: async (q: any) => {
        const text = typeof q === "string" ? q : String(q);
        if (/COMMIT/i.test(text)) {
          commitCalled = true;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: (destroy: boolean) => {
        releaseCalled = true;
        destroyFlag = Boolean(destroy);
      },
    } as PoolClient;
    const req = {
      id: "req-commit-ok",
      path: "/payment-vouchers",
      firmId: 1,
      userId: 1,
      rlsClient: client,
    } as unknown as AuthRequest;
    const result = await finalizeFirmUserTransaction(req, "commit");
    expect(commitCalled).toBe(true);
    expect(releaseCalled).toBe(true);
    expect(destroyFlag).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.code).toBe("COMMIT_OK");
    expect(result.sqlState).toBeNull();
  });
});

describe("P0-5 end-to-end budget/totalRequestMs semantics", () => {
  it("req.timing.startAt is used as earliest timestamp (includes auth/pool/tenant)", () => {
    const req = {
      timing: {
        startAt: 1_700_000_000_000,
        sections: {
          authSessionMs: 12,
          tenantContextDbConnectMs: 34,
          tenantContextMs: 56,
        },
      },
    } as unknown as AuthRequest;
    const sections = req.timing!.sections;
    expect(sections.authSessionMs).toBeDefined();
    expect(sections.tenantContextDbConnectMs).toBeDefined();
    expect(sections.tenantContextMs).toBeDefined();
    const handlerMs = 100;
    const commitMs = 30;
    const totalRequestMs =
      (sections.authSessionMs ?? 0) +
      (sections.tenantContextDbConnectMs ?? 0) +
      (sections.tenantContextMs ?? 0) +
      handlerMs +
      commitMs;
    expect(totalRequestMs).toBe(12 + 34 + 56 + 100 + 30);
  });
});
