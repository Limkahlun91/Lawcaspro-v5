import { describe, expect, it, vi } from "vitest";
import { leaveBalanceAdvisoryLockKey, effectiveBalanceDays } from "../modules/hr/leave/leave-balance-lock.js";
import { essEnsureCurrentUserOnly } from "../modules/hr/services/hr-ess-idor-guard.js";
import type { Request, Response } from "express";
import Decimal from "decimal.js";

describe("F36 Leave concurrency + F42 ESS IDOR (no DB; VITEST_SKIP_DB=1 compatible)", () => {
  it("F36: leaveBalanceAdvisoryLockKey is deterministic per firmId/empId/leaveType", () => {
    const k1 = leaveBalanceAdvisoryLockKey(1, 2, "ANNUAL");
    const k2 = leaveBalanceAdvisoryLockKey(1, 2, "ANNUAL");
    const k3 = leaveBalanceAdvisoryLockKey(1, 2, "SICK");
    expect(typeof k1).toBe("bigint");
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it("F36: effectiveBalanceDays sums correctly (entitled + carry + adjust - taken - pending)", () => {
    const r = {
      entitledDays: new Decimal(12),
      carriedForwardDays: new Decimal(3),
      adjustedDays: new Decimal(0),
      takenDays: new Decimal(2),
      pendingApprovalDays: new Decimal(1),
      version: 1,
    };
    expect(effectiveBalanceDays(r).toFixed(2)).toBe("12.00");
  });

  it("F36: Two concurrent balance consumes → exactly ONE succeeds (Promise.all in-memory simulation using locked flag)", async () => {
    type Row = {
      entitledDays: Decimal;
      carriedForwardDays: Decimal;
      adjustedDays: Decimal;
      takenDays: Decimal;
      pendingApprovalDays: Decimal;
      version: number;
      consumedCount: number;
      lockHeld: boolean;
    };
    const row: Row = {
      entitledDays: new Decimal(1),
      carriedForwardDays: new Decimal(0),
      adjustedDays: new Decimal(0),
      takenDays: new Decimal(0),
      pendingApprovalDays: new Decimal(0),
      version: 1,
      consumedCount: 0,
      lockHeld: false,
    };
    async function attemptConsume(caller: string, consumeStr: string): Promise<{ ok: boolean; caller: string; takenAfter: string }> {
      if (row.lockHeld) return { ok: false, caller, takenAfter: row.takenDays.toFixed(2) };
      row.lockHeld = true;
      try {
        const available = effectiveBalanceDays(row);
        const consume = new Decimal(consumeStr);
        if (available.lt(consume)) return { ok: false, caller, takenAfter: row.takenDays.toFixed(2) };
        row.takenDays = row.takenDays.plus(consume);
        row.consumedCount += 1;
        row.version += 1;
        return { ok: true, caller, takenAfter: row.takenDays.toFixed(2) };
      } finally {
        row.lockHeld = false;
      }
    }
    const results = await Promise.all([
      attemptConsume("caller-A", "1"),
      attemptConsume("caller-B", "1"),
    ]);
    const successes = results.filter((r) => r.ok).length;
    expect(successes).toBe(1);
    expect(row.consumedCount).toBe(1);
    expect(row.takenDays.toFixed(2)).toBe("1.00");
    expect(results.some((r) => !r.ok)).toBe(true);
  });

  it("F42: ESS guard rejects explicit userId / employeeId param in req.params (IDOR reject 403)", () => {
    let statusSent = 0;
    let jsonSent: any = null;
    const res = {
      status: (code: number) => {
        statusSent = code;
        return { json: (o: any) => { jsonSent = o; return res; } };
      },
      json: (o: any) => { jsonSent = o; return res; },
    } as unknown as Response;
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = {
      path: "/hr/me/profile",
      params: { userId: "99999", employee_id: "123" },
      query: {},
      body: {},
      auth: { user: { id: 1 } },
    } as unknown as Request;
    essEnsureCurrentUserOnly(req, res, next);
    expect(nextCalled).toBe(false);
    expect(statusSent).toBe(403);
    expect(jsonSent?.error?.code).toBe("HR_PERMISSION_DENIED");
  });

  it("F42: ESS guard passes when NO explicit userId/employeeId params/query/body; next() invoked", () => {
    let statusSent = 0;
    const res = {
      status: (code: number) => {
        statusSent = code;
        return { json: () => res };
      },
      json: () => res,
    } as unknown as Response;
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = {
      path: "/hr/me/profile",
      params: {},
      query: {},
      body: {},
      auth: { user: { id: 42 } },
      firmId: 5,
    } as unknown as Request;
    essEnsureCurrentUserOnly(req, res, next);
    expect(statusSent).toBe(0);
    expect(nextCalled).toBe(true);
  });

  it("F42: ESS guard rejects linked_user_id passed via req.body as-if attacker controlled", () => {
    let statusSent = 0;
    let jsonSent: any = null;
    const res = {
      status: (code: number) => {
        statusSent = code;
        return { json: (o: any) => { jsonSent = o; return res; } };
      },
      json: (o: any) => { jsonSent = o; return res; },
    } as unknown as Response;
    const req = {
      path: "/hr/me/claims",
      params: {},
      query: {},
      body: { linked_user_id: "31337" },
      auth: { user: { id: 7 } },
    } as unknown as Request;
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    essEnsureCurrentUserOnly(req, res, next);
    expect(nextCalled).toBe(false);
    expect(statusSent).toBe(403);
    expect(jsonSent?.error?.details?.rejectedKey).toBe("linked_user_id");
  });
});
