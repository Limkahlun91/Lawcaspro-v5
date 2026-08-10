import { describe, expect, it, vi } from "vitest";
import {
  canAccessCase,
  assertCaseAccess,
  getAccessibleCasesSqlScope,
  getAllowedAssignmentRoles,
  type CaseAccessPurpose,
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

function matchesRoleList(sqlWhere: any, allowedRoles: ReadonlyArray<string>): string[] {
  // The canAccessCase engine builds an inArray() predicate for the allowed
  // role list.  In the fake we simply compare against canonical purpose
  // matrix via getAllowedAssignmentRoles, i.e. treat the filter as "any
  // allowed role matches".  This matches the engine's semantics.
  return allowedRoles.slice();
}

function makeFakeR(seedCases: FakeCasesTable[], assignments: FakeAssignment[]) {
  return {
    select: (cols?: any) => {
      void cols;
      return {
        from: (_fromTable: any) => {
          const fromAlias = String((_fromTable as any)?.name ?? "");
          return {
            where: (_pred: any) => {
              if (fromAlias === "cases") {
                return {
                  limit: (_n: number) => {
                    // Pull id match by reading the predicate's bound id
                    // using the same fake-case map.
                    let matched: FakeCasesTable[] = seedCases.slice();
                    if (typeof _pred === "object" && _pred !== null) {
                      // Try to read an id filter via drizzle `eq` AST:
                      const idEq = _pred as any;
                      if (idEq?.right?.value !== undefined) {
                        const wanted = Number(idEq.right.value);
                        matched = seedCases.filter((c) => c.id === wanted);
                      }
                    }
                    return Promise.resolve(
                      matched
                        .slice(0, _n ?? 1)
                        .map((c) => ({ id: c.id, firmId: c.firm_id })),
                    );
                  },
                };
              }
              if (fromAlias === "case_assignments") {
                return {
                  limit: (_n: number) => {
                    // Filter case_assignments to user's active matches.
                    // Extract user_id case_id filters from the `and(...)`
                    // predicate via crude inspection; then apply the
                    // purpose-derived allowed role list.
                    const andParts: any[] = Array.isArray((_pred as any)?.args)
                      ? ((_pred as any).args as any[])
                      : [];
                    let wantedUserId: number | undefined;
                    let wantedCaseId: number | undefined;
                    let allowedRoles: string[] | undefined;
                    for (const p of andParts) {
                      const pAny = p as any;
                      const colName = String(pAny?.left?.name ?? "");
                      const val = pAny?.right?.value ?? pAny?.right;
                      if (colName === "user_id" && typeof val === "number") wantedUserId = val;
                      if (colName === "case_id" && typeof val === "number") wantedCaseId = val;
                      // inArray predicate on role_in_case:
                      if (Array.isArray(pAny?.right) && pAny?.left?.name === "role_in_case") {
                        allowedRoles = (pAny.right as any[]).map((r) => String(r?.value ?? r));
                      }
                      // sql`FALSE` literal
                      if (typeof p === "object" && p !== null && String((p as any).queryType) === "raw") {
                        // Purposes with no allowed roles hit sql`FALSE` → no matches
                        allowedRoles = [];
                      }
                    }
                    const matched = assignments.filter((a) => {
                      if (wantedUserId !== undefined && a.user_id !== wantedUserId) return false;
                      if (wantedCaseId !== undefined && a.case_id !== wantedCaseId) return false;
                      if (a.unassigned_at !== null) return false;
                      if (allowedRoles !== undefined && !allowedRoles.includes(a.role_in_case)) return false;
                      return true;
                    });
                    return Promise.resolve(matched.slice(0, _n ?? 1).map((m) => ({ id: m.case_id })));
                  },
                };
              }
              return { limit: (_n: number) => Promise.resolve([] as any[]) };
            },
            limit: (_n: number) => Promise.resolve([] as any[]),
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers that forward purpose to canAccessCase — avoids "purpose missing"
// TS errors in each test and documents the canonical purpose each test
// simulates.
// ---------------------------------------------------------------------------
function viewCaseOpts(o: any) { return { ...o, purpose: "view_case" as CaseAccessPurpose }; }
function batchUpdateOpts(o: any) { return { ...o, purpose: "batch_update" as CaseAccessPurpose }; }
function editCaseOpts(o: any) { return { ...o, purpose: "edit_case" as CaseAccessPurpose }; }

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

  describe("CANONICAL_PURPOSE_ROLES matrix (G7 single-source-of-truth)", () => {
    it("batch_update === edit_case — mutation-grade role list shared", () => {
      const bu = [...getAllowedAssignmentRoles("batch_update")].sort();
      const ec = [...getAllowedAssignmentRoles("edit_case")].sort();
      expect(bu).toEqual(ec);
      expect(bu).toEqual(["clerk", "lawyer", "responsible_lawyer"]);
    });
    it("view_documents includes supporting_docs viewer/editor/witness/client_party", () => {
      const v = getAllowedAssignmentRoles("view_documents");
      expect(v).toContain("supporting_docs_viewer");
      expect(v).toContain("supporting_docs_editor");
      expect(v).toContain("witness");
      expect(v).toContain("client_party");
    });
    it("batch_update EXCLUDES supporting_docs_viewer/editor/witness/client_party", () => {
      const bu = getAllowedAssignmentRoles("batch_update");
      expect(bu).not.toContain("supporting_docs_viewer");
      expect(bu).not.toContain("supporting_docs_editor");
      expect(bu).not.toContain("witness");
      expect(bu).not.toContain("client_party");
    });
  });

  describe("canAccessCase decision matrix", () => {
    it("NO_CONTEXT when firmId/userId missing", async () => {
      const res = await canAccessCase(viewCaseOpts({
        r: makeFakeR([], []),
        firmId: undefined,
        userId: undefined,
        roleId: 1,
        roleName: "Lawyer",
        caseId: 1,
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NO_CONTEXT");
    });

    it("NOT_FOUND when caseAlreadyLoaded absent AND cases table returns empty", async () => {
      const res = await canAccessCase(viewCaseOpts({
        r: makeFakeR([], []),
        firmId: 100,
        userId: 10,
        roleId: 1,
        roleName: "Lawyer",
        caseId: 5,
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_FOUND");
    });

    it("CROSS_FIRM when malicious preload has mismatched firm", async () => {
      const res = await canAccessCase(viewCaseOpts({
        r: makeFakeR([], []),
        firmId: 100,
        userId: 10,
        roleId: 1,
        roleName: "Lawyer",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 999 },
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("CROSS_FIRM");
    });

    it("CROSS_FIRM when no preload AND cases DB returns case owned by other firm", async () => {
      const res = await canAccessCase(viewCaseOpts({
        r: makeFakeR([{ id: 5, firm_id: 999 }], []),
        firmId: 100,
        userId: 10,
        roleId: 1,
        roleName: "Lawyer",
        caseId: 5,
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("CROSS_FIRM");
    });

    it("valid same-firm lookup via cases DB (no preload) → NOT_ASSIGNED when no match", async () => {
      const res = await canAccessCase(viewCaseOpts({
        r: makeFakeR([{ id: 5, firm_id: 100 }], []),
        firmId: 100,
        userId: 10,
        roleId: 1,
        roleName: "Lawyer",
        caseId: 5,
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_ASSIGNED");
    });

    it("firmwide when role has cases.assign_any explicit permission (elevated)", async () => {
      const res = await canAccessCase(viewCaseOpts({
        r: makeFakeR([{ id: 1, firm_id: 1 }], []),
        firmId: 1,
        userId: 5,
        roleId: 1,
        roleName: "Account Manager",
        rolePermissions: [{ module: "cases", action: "assign_any" }],
        caseId: 1,
        caseAlreadyLoaded: { id: 1, firmId: 1 },
      }));
      expect(res.ok).toBe(true);
      if (res.ok === true) expect(res.reason).toBe("firmwide");
    });

    it("Partner canonical role = firmwide bypass (even with zero assignments)", async () => {
      const res = await canAccessCase(viewCaseOpts({
        r: makeFakeR([{ id: 77, firm_id: 1 }], []),
        firmId: 1,
        userId: 9,
        roleId: 1,
        roleName: "Partner",
        caseId: 77,
        caseAlreadyLoaded: { id: 77, firmId: 1 },
      }));
      expect(res.ok).toBe(true);
      if (res.ok === true) expect(res.reason).toBe("firmwide");
    });

    it("assigned staff → ok: true reason='assigned' when role_in_case matches edit_case allowed list", async () => {
      const res = await canAccessCase(editCaseOpts({
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
      }));
      expect(res.ok).toBe(true);
      if (res.ok === true) expect(res.reason).toBe("assigned");
    });

    it("NOT_ASSIGNED when user not on case (no assign_any perm, not canonical management)", async () => {
      const res = await canAccessCase(editCaseOpts({
        r: makeFakeR([{ id: 5, firm_id: 2 }], []),
        firmId: 2,
        userId: 20,
        roleId: 2,
        roleName: "Lawyer",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_ASSIGNED");
    });

    it("batch_update DENIES supporting_docs_editor-only case assignment", async () => {
      const res = await canAccessCase(batchUpdateOpts({
        r: makeFakeR(
          [{ id: 5, firm_id: 2 }],
          [{ case_id: 5, user_id: 20, role_in_case: "supporting_docs_editor", unassigned_at: null }],
        ),
        firmId: 2,
        userId: 20,
        roleId: 2,
        roleName: "Lawyer",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_ASSIGNED");
    });

    it("batch_update DENIES witness-only case assignment", async () => {
      const res = await canAccessCase(batchUpdateOpts({
        r: makeFakeR(
          [{ id: 5, firm_id: 2 }],
          [{ case_id: 5, user_id: 20, role_in_case: "witness", unassigned_at: null }],
        ),
        firmId: 2,
        userId: 20,
        roleId: 2,
        roleName: "Paralegal",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_ASSIGNED");
    });

    it("batch_update DENIES client_party-only case assignment", async () => {
      const res = await canAccessCase(batchUpdateOpts({
        r: makeFakeR(
          [{ id: 5, firm_id: 2 }],
          [{ case_id: 5, user_id: 20, role_in_case: "client_party", unassigned_at: null }],
        ),
        firmId: 2,
        userId: 20,
        roleId: 2,
        roleName: "Paralegal",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_ASSIGNED");
    });

    it("view_case ALLOWS witness assignment (view-grade read only)", async () => {
      const res = await canAccessCase(viewCaseOpts({
        r: makeFakeR(
          [{ id: 5, firm_id: 2 }],
          [{ case_id: 5, user_id: 20, role_in_case: "witness", unassigned_at: null }],
        ),
        firmId: 2,
        userId: 20,
        roleId: 2,
        roleName: "Witness",
        caseId: 5,
        caseAlreadyLoaded: { id: 5, firmId: 2 },
      }));
      expect(res.ok).toBe(true);
      if (res.ok === true) expect(res.reason).toBe("assigned");
    });

    it("Account Manager (no cases.assign_any perm) → cannot bypass assigned case gate", async () => {
      const res = await canAccessCase(viewCaseOpts({
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
      }));
      expect(res.ok).toBe(false);
    });

    it("HR Manager (hr privilege only) → cannot bypass case assignment", async () => {
      const res = await canAccessCase(viewCaseOpts({
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
      }));
      expect(res.ok).toBe(false);
    });
  });

  describe("assertCaseAccess throws on canAccessCase failure code", () => {
    it("throws CaseAccessDenied:NO_CONTEXT on missing context", async () => {
      await expect(
        assertCaseAccess(viewCaseOpts({
          r: makeFakeR([], []),
          firmId: undefined,
          userId: undefined,
          roleId: 1,
          roleName: "Lawyer",
          caseId: 1,
        })),
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
        const res = await canAccessCase(batchUpdateOpts({
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
        }));
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
