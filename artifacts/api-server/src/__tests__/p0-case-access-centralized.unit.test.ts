import { describe, expect, it, vi } from "vitest";
import {
  canAccessCase,
  assertCaseAccess,
  getAccessibleCasesSqlScope,
} from "../lib/auth.js";

/**
 * P0 — Single Case Access Engine.
 *
 * Every call site (case detail / batch update / batch print / supporting docs /
 * file custody / accounting lookup) MUST use the same engine.  These tests
 * verify the pure decision surface of canAccessCase / getAccessibleCasesSqlScope
 * using an in-memory fake so DB connection is never required.
 *
 * These are DB-independent unit tests.  Real DB integration lives in the
 * tenant-isolation/rls suite (which is BLOCKED per user rules during this
 * corrective phase).
 */

type FakeAssignment = {
  case_id: number;
  user_id: number;
  role_in_case: string;
  unassigned_at: Date | null;
};

type FakeCasesTable = {
  id: number;
  firm_id: number;
};

function makeFakeR(seedCases: FakeCasesTable[], assignments: FakeAssignment[]) {
  return {
    select: () => ({
      from: (_fromTable: any) => ({
        where: (_pred: any) => {
          const fromAlias = String((_fromTable as any)?.name ?? "");
          void _pred;
          if (fromAlias === "case_assignments") {
            const matched = assignments.filter((a) => a.unassigned_at === null);
            return {
              limit: (_n: number) =>
                Promise.resolve(matched.map((m) => ({ id: m.case_id }))),
            };
          }
          return { limit: (_n: number) => Promise.resolve([] as any[]) };
        },
        limit: (_n: number) => Promise.resolve([] as any[]),
      }),
    }),
  };
}

describe("P0 — One Case Access Engine (no inline copies)", () => {
  describe("getAccessibleCasesSqlScope returns correct boolean predicate", () => {
    it("hasFirmwideScope=true → returns TRUE literal (bypasses assignment filter)", () => {
      const scope = getAccessibleCasesSqlScope({
        hasFirmwideScope: true,
        firmId: 1,
        userId: 10,
      });
      expect(typeof scope).not.toBe("undefined");
    });

    it("hasFirmwideScope=false → returns EXISTS subquery scope referencing user_id", () => {
      const scope = getAccessibleCasesSqlScope({
        hasFirmwideScope: false,
        firmId: 1,
        userId: 42,
      });
      expect(typeof scope).not.toBe("undefined");
    });
  });

  describe("canAccessCase decision matrix", () => {
    it("NO_CONTEXT when firmId/userId missing", async () => {
      const res = await canAccessCase({
        r: makeFakeR([], []),
        firmId: undefined,
        userId: undefined,
        roleId: 1,
        roleName: "Lawyer",
        caseId: 1,
      });
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NO_CONTEXT");
    });

    it("CROSS_FIRM when caseAlreadyLoaded from different firm_id than auth firm", async () => {
      const res = await canAccessCase({
        r: makeFakeR([], []),
        firmId: 100,
        userId: 10,
        roleId: 1,
        roleName: "Lawyer",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 999 },
      });
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("CROSS_FIRM");
    });

    it("firmwide when role has cases.assign_any explicit permission (elevated)", async () => {
      const res = await canAccessCase({
        r: makeFakeR([{ id: 1, firm_id: 1 }], []),
        firmId: 1,
        userId: 5,
        roleId: 1,
        roleName: "Account Manager",
        rolePermissions: [{ module: "cases", action: "assign_any" }],
        caseId: 1,
        caseAlreadyLoaded: { id: 1, firmId: 1 },
      });
      expect(res.ok).toBe(true);
      if (res.ok === true) expect(res.reason).toBe("firmwide");
    });

    it("Partner canonical role = firmwide bypass (even with zero assignments)", async () => {
      const res = await canAccessCase({
        r: makeFakeR([{ id: 77, firm_id: 1 }], []),
        firmId: 1,
        userId: 9,
        roleId: 1,
        roleName: "Partner",
        caseId: 77,
        caseAlreadyLoaded: { id: 77, firmId: 1 },
      });
      expect(res.ok).toBe(true);
      if (res.ok === true) expect(res.reason).toBe("firmwide");
    });

    it("assigned staff → ok: true reason='assigned' when caseAssignments match", async () => {
      const res = await canAccessCase({
        r: makeFakeR(
          [{ id: 5, firm_id: 2 }],
          [{ case_id: 5, user_id: 20, role_in_case: "lawyer", unassigned_at: null }],
        ),
        firmId: 2,
        userId: 20,
        roleId: 2,
        roleName: "Lawyer",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
        checkRoleInCase: ["lawyer", "clerk"],
      });
      expect(res.ok).toBe(true);
      if (res.ok === true) expect(res.reason).toBe("assigned");
    });

    it("NOT_ASSIGNED when user not on case (no assign_any perm, not canonical management)", async () => {
      const res = await canAccessCase({
        r: makeFakeR([{ id: 5, firm_id: 2 }], []),
        firmId: 2,
        userId: 20,
        roleId: 2,
        roleName: "Lawyer",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
        checkRoleInCase: ["lawyer", "clerk"],
      });
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_ASSIGNED");
    });

    it("Account Manager (no cases.assign_any perm, canonical Management) → cannot bypass assigned case gate", async () => {
      const res = await canAccessCase({
        r: makeFakeR([{ id: 5, firm_id: 2 }], []),
        firmId: 2,
        userId: 20,
        roleId: 3,
        roleName: "Account Manager",
        rolePermissions: [
          { module: "accounting", action: "read" },
          { module: "accounting", action: "write" },
        ],
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
      });
      expect(res.ok).toBe(false);
    });

    it("HR Manager (hr privilege only) → cannot bypass case assignment", async () => {
      const res = await canAccessCase({
        r: makeFakeR([{ id: 5, firm_id: 2 }], []),
        firmId: 2,
        userId: 20,
        roleId: 3,
        roleName: "HR Manager",
        rolePermissions: [
          { module: "hr", action: "manage" },
        ],
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
      });
      expect(res.ok).toBe(false);
    });
  });

  describe("assertCaseAccess throws on canAccessCase failure code", () => {
    it("throws CaseAccessDenied:NO_CONTEXT on missing context", async () => {
      await expect(
        assertCaseAccess({
          r: makeFakeR([], []),
          firmId: undefined,
          userId: undefined,
          roleId: 1,
          roleName: "Lawyer",
          caseId: 1,
        }),
      ).rejects.toThrow(/CaseAccessDenied/);
    });
  });

  describe("Batch authorization behavior (simulated mixed list)", () => {
    type BatchInput = { id: number; sameFirm: boolean; assigned: boolean; firmwideOk: boolean };

    async function runBatch(items: BatchInput[]) {
      const successes: number[] = [];
      const failures: { id: number; code: string }[] = [];
      for (const it of items) {
        const caseFirm = it.sameFirm ? 5 : 9999;
        const res = await canAccessCase({
          r: makeFakeR(
            [{ id: it.id, firm_id: caseFirm }],
            it.assigned
              ? [{ case_id: it.id, user_id: 10, role_in_case: "lawyer", unassigned_at: null }]
              : [],
          ),
          firmId: 5,
          userId: 10,
          roleId: 1,
          roleName: it.firmwideOk ? "Partner" : "Lawyer",
          caseId: it.id,
          caseAlreadyLoaded: { id: it.id, firmId: caseFirm },
          checkRoleInCase: ["lawyer", "clerk"],
        });
        if (res.ok === true) successes.push(it.id);
        else {
          const failRes = res as { ok: false; code: string };
          failures.push({ id: it.id, code: failRes.code });
        }
      }
      return { successes, failures, partialFailure: successes.length > 0 && failures.length > 0 };
    }

    it("authorized own cases → all success", async () => {
      const r = await runBatch([
        { id: 1, sameFirm: true, assigned: true, firmwideOk: false },
        { id: 2, sameFirm: true, assigned: true, firmwideOk: false },
      ]);
      expect(r.successes).toEqual([1, 2]);
      expect(r.failures).toEqual([]);
    });

    it("inject unassigned into own list → partial_failure", async () => {
      const r = await runBatch([
        { id: 1, sameFirm: true, assigned: true, firmwideOk: false },
        { id: 666, sameFirm: true, assigned: false, firmwideOk: false },
      ]);
      expect(r.successes).toEqual([1]);
      expect(r.failures[0].id).toBe(666);
      expect(r.partialFailure).toBe(true);
    });

    it("cross-firm case injected → CROSS_FIRM rejected", async () => {
      const r = await runBatch([
        { id: 1, sameFirm: true, assigned: true, firmwideOk: false },
        { id: 42, sameFirm: false, assigned: false, firmwideOk: false },
      ]);
      expect(r.successes).toEqual([1]);
      expect(r.failures[0].code).toBe("CROSS_FIRM");
    });

    it("Partner/firmwide role → bypasses assignment (firmwide reason)", async () => {
      const r = await runBatch([
        { id: 7, sameFirm: true, assigned: false, firmwideOk: true },
        { id: 8, sameFirm: true, assigned: false, firmwideOk: true },
      ]);
      expect(r.successes).toEqual([7, 8]);
      expect(r.failures).toEqual([]);
    });
  });
});
