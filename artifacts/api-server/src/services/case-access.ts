import { and, eq, inArray, isNull } from "drizzle-orm";
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

// ---------------------------------------------------------------------------
// Thin adapter to the CANONICAL case-access engine in auth.ts.
//
// Canonical source of truth is:
//   lib/auth.ts →
//     - getAllowedAssignmentRoles(purpose)  (one role matrix)
//     - hasCasesFirmwideScope()              (management role fast-path)
//     - canAccessCase()                      (one authorization engine)
//     - enforceCaseAccessGeneric()           (route-level enforcement)
//
// case_assignments is REQUIRED canonical schema.
//   - valid query + zero rows → not assigned
//   - query failure (42P01, 42501, 080xx, 57Pxx, 53300, timeout, conn, unknown)
//     → PROPAGATE, never silently degrade to 0 cases
//
// This adapter exists for backward-compat with existing callers that
// import from ../services/case-access.js.
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

export async function canUserAccessCase(
  input: CanUserAccessCaseInput,
): Promise<CanUserAccessCaseResult> {
  const { r, firmId, userId, caseId, roleId, roleName, purpose, preloaded } = input;

  if (!firmId || !userId || !caseId) {
    return { ok: false, code: "FIRM_MISMATCH", reason: "Missing ids" };
  }

  if (
    preloaded?.caseFirmId !== undefined &&
    preloaded?.caseFirmId !== null &&
    preloaded.caseFirmId !== firmId
  ) {
    return { ok: false, code: "FIRM_MISMATCH" };
  }

  const elevated = await hasCasesFirmwideScope(r as any, firmId, roleId, roleName, null);
  if (elevated) return { ok: true, code: "OK", via: "partner_manager" };

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

  return { ok: false, code: "NOT_CASE_ASSIGNED" };
}

// ---------------------------------------------------------------------------
// List-scoped access.
//
// Errors (case_assignments REQUIRED canonical schema):
//   42P01, 42501, 080xx, 57Pxx, 53300, timeout, connection, unknown
//     → ALL PROPAGATE.
//   Only "valid query + zero rows" → empty set (legitimately no assigned cases).
//
// Management/firmwide scope returns empty Set with mode="all_firm" — callers
// treat this as "skip filter, allow all cases in firm".
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

  const allowedRoles: ReadonlyArray<string> = getAllowedAssignmentRoles(purpose);

  const predicate =
    allowedRoles.length > 0
      ? inArray(caseAssignmentsTable.roleInCase, allowedRoles as unknown as string[])
      : undefined;
  const clauses: any[] = [
    eq(caseAssignmentsTable.userId, userId),
    isNull(caseAssignmentsTable.unassignedAt),
  ];
  if (predicate) clauses.push(predicate);
  if (caseIdsHint && caseIdsHint.length > 0) {
    clauses.push(inArray(caseAssignmentsTable.caseId, caseIdsHint));
  }

  const rows = await r
    .select({ caseId: caseAssignmentsTable.caseId })
    .from(caseAssignmentsTable)
    .where(and(...clauses))
    .limit(limit);

  for (const r2 of rows) {
    if (typeof r2.caseId === "number") caseIds.add(r2.caseId);
  }

  return { caseIds, mode: "explicit_list" };
}
