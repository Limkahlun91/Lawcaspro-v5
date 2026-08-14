import { and, eq, inArray, isNull, sql, asc, desc } from "drizzle-orm";
import {
  db,
  type AppDb,
  type RlsDb,
  usersTable,
  rolesTable,
  caseAssignmentsTable,
  FEATURE_REGISTRY_MAP,
  getFeatureDefinition,
  isFeatureRegistered,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// Part 2 §12-14 — ONE canonical case access helper
//
// FIXES impossible-state bug: Clerk No.2 assigned to CON/001 → list shows it
// (direct WHERE assignedClerkId = userId OR in assignments) but /cases/:id
// used a different check → 403.  Now everything calls one helper.
// ---------------------------------------------------------------------------

export type CanUserAccessCaseInput = {
  r: AppDb | RlsDb;
  firmId: number;
  userId: number;
  caseId: number;
  roleId: number | null;
  roleName: string | null;
  purpose?: "view_case" | "edit_case" | "view_documents" | "edit_documents";
  /**
   * Allow additional access classes:
   *   "wide" = Partner/Manager + assignedLawyer + assignedClerk + assignments table + team membership
   */
  scope?: "default" | "wide" | "documents_only";
  /**
   * If caller already knows assignedLawyerId/assignedClerkId (e.g. from a row)
   * it can pass them in to avoid a SELECT.
   */
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

const MANAGEMENT_NAMES = new Set([
  "partner",
  "managing partner",
  "senior partner",
  "managing partner",
  "practice manager",
  "firm manager",
  "manager",
  "director",
]);

function isManagementRole(roleName: string | null): boolean {
  if (!roleName) return false;
  return MANAGEMENT_NAMES.has(roleName.trim().toLowerCase());
}

export async function canUserAccessCase(
  input: CanUserAccessCaseInput,
): Promise<CanUserAccessCaseResult> {
  const {
    r,
    firmId,
    userId,
    caseId,
    roleId,
    roleName,
    purpose = "view_case",
    scope = "default",
    preloaded,
  } = input;
  if (!firmId || !userId || !caseId) {
    return { ok: false, code: "FIRM_MISMATCH", reason: "Missing ids" };
  }

  // Fast path: preloaded assignees + management
  if (isManagementRole(roleName)) {
    // Still need firm match + purpose read permission
    if (preloaded?.caseFirmId && preloaded.caseFirmId !== firmId) {
      return { ok: false, code: "FIRM_MISMATCH" };
    }
    return { ok: true, code: "OK", via: "partner_manager" };
  }

  if (preloaded?.caseFirmId !== undefined && preloaded.caseFirmId !== null) {
    if (preloaded.caseFirmId !== firmId) return { ok: false, code: "FIRM_MISMATCH" };
  }
  if (preloaded?.assignedLawyerId === userId) {
    return { ok: true, code: "OK", via: "assigned_lawyer" };
  }
  if (preloaded?.assignedClerkId === userId) {
    return { ok: true, code: "OK", via: "assigned_clerk" };
  }

  // DB path: load case row + assignments table + case team (if any)
  // casesTable.assign* columns (not drizzle schema; fallback via SQL because
  // cases table schema may not expose assignedLawyerId/assignedClerkId as drizzle cols.)
  let caseFirmId = preloaded?.caseFirmId ?? null;
  let assignedLawyerId = preloaded?.assignedLawyerId ?? null;
  let assignedClerkId = preloaded?.assignedClerkId ?? null;
  if (
    caseFirmId === null ||
    assignedLawyerId === null ||
    assignedClerkId === null
  ) {
    const rawRows = await r.execute(sql`
      SELECT firm_id AS "firmId",
             assigned_lawyer_id AS "assignedLawyerId",
             assigned_clerk_id AS "assignedClerkId"
      FROM cases
      WHERE id = ${caseId}
      LIMIT 1
    `);
    const rowsArr: unknown[] =
      rawRows && typeof rawRows === "object" && Array.isArray((rawRows as any).rows)
        ? (rawRows as any).rows
        : Array.isArray(rawRows)
        ? rawRows
        : [];
    const actualRow = rowsArr[0] as
      | { firmId?: unknown; assignedLawyerId?: unknown; assignedClerkId?: unknown }
      | undefined;
    const f = actualRow?.firmId;
    const l = actualRow?.assignedLawyerId;
    const cl = actualRow?.assignedClerkId;
    if (typeof f === "number") caseFirmId = f;
    if (typeof l === "number") assignedLawyerId = l;
    if (typeof cl === "number") assignedClerkId = cl;
  }

  if (caseFirmId !== null && caseFirmId !== firmId) {
    return { ok: false, code: "FIRM_MISMATCH" };
  }
  if (assignedLawyerId === userId) {
    return { ok: true, code: "OK", via: "assigned_lawyer" };
  }
  if (assignedClerkId === userId) {
    return { ok: true, code: "OK", via: "assigned_clerk" };
  }

  // Canonical case_assignment table (lawyer, clerk, case_team_member)
  try {
    const [assign] = await r
      .select({
        id: caseAssignmentsTable.id,
        roleInCase: caseAssignmentsTable.roleInCase,
      })
      .from(caseAssignmentsTable)
      .where(
        and(
          eq(caseAssignmentsTable.caseId, caseId),
          eq(caseAssignmentsTable.userId, userId),
          inArray(caseAssignmentsTable.roleInCase, [
            "lawyer",
            "clerk",
            "case_team",
            "support_staff",
            "case_owner",
            "billing",
            "watching",
            "paralegal",
            "associate",
            "partner",
          ]),
          isNull(caseAssignmentsTable.unassignedAt),
        ),
      )
      .limit(1);
    if (assign) {
      return {
        ok: true,
        code: "OK",
        via: assign.roleInCase === "case_team" ? "case_team" : "assignment_table",
      };
    }
  } catch (err) {
    // case_assignments table may be missing; skip.
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code !== "42P01"
    ) {
      throw err;
    }
  }

  // Purpose-specific permission fallback (e.g., read:cases on list)
  if (purpose === "view_case" && scope !== "documents_only") {
    return { ok: false, code: "NOT_CASE_ASSIGNED" };
  }
  return { ok: false, code: "NOT_CASE_ASSIGNED" };
}

// ---------------------------------------------------------------------------
// List-scoped — return Set<number> of accessible caseIds for given purpose
// Avoids N+1 per-case check.  Used by GET /cases, MyWork, DocAuto search,
// HIMS tracker list, PV case search, Quotation case search.
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
  } = params;
  if (isManagementRole(roleName)) {
    return { caseIds: new Set<number>(), mode: "all_firm" };
  }
  const caseIds = new Set<number>();
  // assigned lawyer / clerk
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
  } catch {
    // assigned* columns may not exist; skip
  }
  // case_assignments table
  try {
    const rows2 = await r
      .select({ caseId: caseAssignmentsTable.caseId })
      .from(caseAssignmentsTable)
      .where(
        and(
          inArray(caseAssignmentsTable.roleInCase, [
            "lawyer",
            "clerk",
            "case_team",
            "support_staff",
            "case_owner",
            "billing",
            "watching",
            "paralegal",
            "associate",
            "partner",
          ]),
          eq(caseAssignmentsTable.userId, userId),
          isNull(caseAssignmentsTable.unassignedAt),
        ),
      )
      .limit(limit);
    for (const r2 of rows2) {
      if (typeof r2.caseId === "number") caseIds.add(r2.caseId);
    }
  } catch {
    // case_assignments may not exist; ignore
  }

  // Hint filter
  if (caseIdsHint && caseIdsHint.length > 0) {
    const hintSet = new Set(caseIdsHint);
    for (const k of Array.from(caseIds)) {
      if (!hintSet.has(k)) caseIds.delete(k);
    }
  }

  return { caseIds, mode: "explicit_list" };
}
