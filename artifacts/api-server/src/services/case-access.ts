import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type AppDb,
  type RlsDb,
  caseAssignmentsTable,
} from "@workspace/db";
import {
  hasCasesFirmwideScope,
  getAllowedAssignmentRoles,
  canAccessCase as canonicalCanAccessCase,
  type CaseAccessPurpose,
} from "../lib/auth.js";
import { extractDbErrorInfo } from "../lib/db-error.js";

// ---------------------------------------------------------------------------
// R2A Gate 12-17 — Thin adapter to the CANONICAL case-access engine in auth.ts.
//
// OLD services/case-access.ts used to own its own role matrix.
// That DUPLICATED TRUTH has been REMOVED.
//
// Canonical source of truth now is:
//   @workspace/db lib/auth.ts →
//     - getAllowedAssignmentRoles(purpose)  (one role matrix)
//     - hasCasesFirmwideScope()              (management role fast-path)
//     - canAccessCase()                      (one authorization engine)
//     - enforceCaseAccessGeneric()           (route-level enforcement)
//
// This adapter is PURELY for backward-compat with existing callers that
// import from ../services/case-access.js (himself.ts, cases.ts legacy callers).
// ---------------------------------------------------------------------------

export type CanUserAccessCaseInput = {
  r: AppDb | RlsDb;
  firmId: number;
  userId: number;
  caseId: number;
  roleId: number | null;
  roleName: string | null;
  purpose?: CaseAccessPurpose | "view_case" | "edit_case" | "view_documents" | "edit_documents";
  scope?: "default" | "wide" | "documents_only";
  preloaded?: {
    assignedLawyerId?: number | null;
    assignedClerkId?: number | null;
    caseFirmId?: number;
  };
};

export type CanUserAccessCaseResult = {
  ok: boolean;
  code?:
    | "FIRM_MISMATCH"
    | "NOT_CASE_ASSIGNED"
    | "ROLE_DENIED"
    | "PERMISSION_DENIED"
    | "OK";
  via?:
    | "partner_manager"
    | "assigned_lawyer"
    | "assigned_clerk"
    | "assignment_table"
    | "case_team"
    | "permission_override";
  reason?: string;
};

// Gate 17: explicit hasOwnProperty-based preload detection.
// Using `=== null` is ambiguous — an actual loaded value could be null
// if user genuinely not-assigned in a legacy schema.  Presence of keys
// in preloaded object → preload intent, regardless of their value.
function hasLegacyPreload(preloaded: CanUserAccessCaseInput["preloaded"]): boolean {
  if (!preloaded) return false;
  return (
    Object.prototype.hasOwnProperty.call(preloaded, "assignedLawyerId") ||
    Object.prototype.hasOwnProperty.call(preloaded, "assignedClerkId")
  );
}

// Gate 16/17: legacy compat helper.  ONLY 42703 (undefined column) may
// return {available:false}.  42P01, 080xx, 57Pxx, authz, timeouts, conn,
// unknown errors → RE-THROW exactly as caught.  Database outage MUST NOT
// degrade to "no accessible cases".
async function tryLoadLegacyCaseAssignees(
  r: AppDb | RlsDb,
  firmId: number,
  caseId: number,
): Promise<{
  available: boolean;
  assignedLawyerId: number | null;
  assignedClerkId: number | null;
}> {
  try {
    const rawRows = await r.execute(sql`
      SELECT
        assigned_lawyer_id AS "assignedLawyerId",
        assigned_clerk_id AS "assignedClerkId"
      FROM cases
      WHERE id=${caseId}
        AND firm_id=${firmId}
      LIMIT 1
    `);
    const rowsArr: unknown[] =
      rawRows && typeof rawRows === "object" && Array.isArray((rawRows as any).rows)
        ? (rawRows as any).rows
        : Array.isArray(rawRows)
        ? rawRows
        : [];
    const row = rowsArr[0] as
      | { assignedLawyerId?: unknown; assignedClerkId?: unknown }
      | undefined;
    const l = row?.assignedLawyerId;
    const cl = row?.assignedClerkId;
    return {
      available: true,
      assignedLawyerId: typeof l === "number" ? l : null,
      assignedClerkId: typeof cl === "number" ? cl : null,
    };
  } catch (err) {
    const info = extractDbErrorInfo(err);
    const state = (info.sqlstate || info.code || "").toUpperCase();
    if (state === "42703") {
      return { available: false, assignedLawyerId: null, assignedClerkId: null };
    }
    throw err;
  }
}

/**
 * Backward-compat adapter.  All new code should use auth.ts canAccessCase()
 * directly.  This function translates CanUserAccessCaseInput → canonical
 * auth.ts canAccessCase call, with preloaded optimizations preserved.
 *
 * If live schema HAS legacy assigned_* columns (older deployments), the
 * fallback path still runs and short-circuits via via=assigned_lawyer/assigned_clerk.
 */
export async function canUserAccessCase(
  input: CanUserAccessCaseInput,
): Promise<CanUserAccessCaseResult> {
  const { r, firmId, userId, caseId, roleId, roleName, purpose, preloaded } = input;

  if (!firmId || !userId || !caseId) {
    return { ok: false, code: "FIRM_MISMATCH", reason: "Missing ids" };
  }

  // Preloaded case firm mismatch short-circuit (pure optimization).
  if (
    preloaded?.caseFirmId !== undefined &&
    preloaded?.caseFirmId !== null &&
    preloaded.caseFirmId !== firmId
  ) {
    return { ok: false, code: "FIRM_MISMATCH" };
  }

  // Management fast-path: let canonical hasCasesFirmwideScope decide truth.
  const elevated = await hasCasesFirmwideScope(r as any, firmId, roleId, roleName, null);
  if (elevated) return { ok: true, code: "OK", via: "partner_manager" };

  // Preloaded legacy shortcut (only if caller explicitly opted in via the
  // preloaded object having the relevant keys — Gate 17 explicit check).
  if (hasLegacyPreload(preloaded)) {
    if (preloaded?.assignedLawyerId === userId) {
      return { ok: true, code: "OK", via: "assigned_lawyer" };
    }
    if (preloaded?.assignedClerkId === userId) {
      return { ok: true, code: "OK", via: "assigned_clerk" };
    }
  }

  // Canonical single-case engine — ONE policy, ONE role matrix.
  const purp = (purpose ?? "view_case") as CaseAccessPurpose;
  const rCanonical = await canonicalCanAccessCase({
    r: r as any,
    firmId,
    userId,
    roleId,
    roleName,
    caseId,
    purpose: purp,
    caseAlreadyLoaded: preloaded?.caseFirmId !== undefined ? { id: caseId, firmId: preloaded.caseFirmId! } : null,
  });

  if (rCanonical.ok) {
    return {
      ok: true,
      code: "OK",
      via: rCanonical.reason === "firmwide" ? "partner_manager" : "assignment_table",
    };
  }

  // Compatibility legacy path: ONLY when canonical denied AND caller has
  // NOT preloaded legacy values (otherwise we'd have short-circuited above).
  if (!hasLegacyPreload(preloaded)) {
    const legacy = await tryLoadLegacyCaseAssignees(r, firmId, caseId);
    if (legacy.available) {
      if (legacy.assignedLawyerId === userId) {
        return { ok: true, code: "OK", via: "assigned_lawyer" };
      }
      if (legacy.assignedClerkId === userId) {
        return { ok: true, code: "OK", via: "assigned_clerk" };
      }
    }
  }

  return { ok: false, code: "NOT_CASE_ASSIGNED" };
}

// ---------------------------------------------------------------------------
// List-scoped access.  Uses canonical getAllowedAssignmentRoles +
// hasCasesFirmwideScope (NOT locally duplicated arrays).
//
// Error classification (Gate 16 fix):
//   - 42P01 (case_assignments missing)   → skip case_assignments path
//   - 42703 (legacy assigned_* missing)  → skip legacy columns path
//   - everything else (080xx, 57Pxx,
//     53300, authz, constraint, unknown) → RE-THROW.
// Never silently show 0 cases on a DB outage.
// ---------------------------------------------------------------------------
export async function listAccessibleCaseIds(
  params: {
    r: AppDb | RlsDb;
    firmId: number;
    userId: number;
    roleId: number | null;
    roleName: string | null;
    limit?: number;
    caseIdsHint?: ReadonlyArray<number>;
    purpose?: CaseAccessPurpose;
  },
): Promise<{ caseIds: Set<number>; mode: "all_firm" | "explicit_list" }> {
  const {
    r,
    firmId,
    userId,
    roleId,
    roleName,
    limit = 5000,
    caseIdsHint,
    purpose = "view_case",
  } = params;

  const elevated = await hasCasesFirmwideScope(r as any, firmId, roleId, roleName, null);
  if (elevated) {
    return { caseIds: new Set<number>(), mode: "all_firm" };
  }

  const caseIds = new Set<number>();

  // Canonical allowed roles per purpose — the same array used by
  // canAccessCase() in auth.ts.
  const allowedRoles: ReadonlyArray<string> = getAllowedAssignmentRoles(purpose);

  // A) legacy assigned_* compatibility (Gate 16 + 17 strict)
  try {
    const raw1 = await r.execute(sql`
      SELECT id
      FROM cases
      WHERE firm_id = ${firmId}
        AND (assigned_lawyer_id = ${userId} OR assigned_clerk_id = ${userId})
      LIMIT ${limit}
    `);
    const rows1: unknown[] =
      raw1 && typeof raw1 === "object" && Array.isArray((raw1 as any).rows)
        ? (raw1 as any).rows
        : Array.isArray(raw1)
        ? raw1
        : [];
    for (const r1 of rows1) {
      if (typeof (r1 as any)?.id === "number") caseIds.add((r1 as any).id);
    }
  } catch (err) {
    const info = extractDbErrorInfo(err);
    const state = (info.sqlstate || info.code || "").toUpperCase();
    if (state !== "42703") throw err;
  }

  // B) canonical case_assignments table (Gate 2 fix — REQUIRED, NO swallow)
  // case_assignments was confirmed to exist in live Supabase schema probe.
  // 42P01/42501/080xx/57Pxx/timeouts/unknown -> all propagate; never silently 0.
  const predicate =
    allowedRoles.length > 0
      ? inArray(caseAssignmentsTable.roleInCase, allowedRoles as unknown as string[])
      : sql`FALSE`;
  const clauses = [
    predicate,
    eq(caseAssignmentsTable.userId, userId),
    isNull(caseAssignmentsTable.unassignedAt),
  ] as any[];
  if (caseIdsHint && caseIdsHint.length > 0) {
    clauses.push(inArray(caseAssignmentsTable.caseId, caseIdsHint));
  }
  const rows2 = await r
    .select({ caseId: caseAssignmentsTable.caseId })
    .from(caseAssignmentsTable)
    .where(and(...clauses))
    .limit(limit);
  for (const r2 of rows2) {
    if (typeof r2.caseId === "number") caseIds.add(r2.caseId);
  }

  // Hint filter (for legacy assigned_* cases not in case_assignments)
  if (caseIdsHint && caseIdsHint.length > 0) {
    const hintSet = new Set(caseIdsHint);
    for (const k of Array.from(caseIds)) {
      if (!hintSet.has(k)) caseIds.delete(k);
    }
  }

  return { caseIds, mode: "explicit_list" };
}
