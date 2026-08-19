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
import { extractDbErrorInfo } from "../lib/db-error.js";

// ---------------------------------------------------------------------------
// Part 2 §12-14 / C1-B2 — ONE canonical case access engine.
//
// Access evaluation order (early-return on ALLOW; DENY at end):
//   A. validate ids                (DENY on missing)
//   B. management role fast path  (Partner/Manager same-firm = ALLOW)
//   C. canonical case_assignments table with unassigned_at IS NULL (ALLOW)
//   D. optional legacy assigned_lawyer_id / assigned_clerk_id compatibility
//      (ONLY undefined column / 42703 falls back — DB transient errors rethrow)
//   E. DENY
//
// Cases schema TRUTH per @workspace/db + PGlite tests:
//   - cases table DOES NOT require assigned_lawyer_id/assigned_clerk_id columns.
//   - canonical truth is case_assignments table (role_in_case + unassigned_at).
// ---------------------------------------------------------------------------

export type CanUserAccessCaseInput = {
  r: AppDb | RlsDb;
  firmId: number;
  userId: number;
  caseId: number;
  roleId: number | null;
  roleName: string | null;
  purpose?: "view_case" | "edit_case" | "view_documents" | "edit_documents";
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

// Step D helper: ONLY undefined-column (42703) returns {available:false}.
// Everything else — DB transient, connection, auth, constraint, etc — RE-THROWS.
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
    // UNDEFINED COLUMN — legacy schema simply doesn't have these cols (42703).
    if (state === "42703") {
      return { available: false, assignedLawyerId: null, assignedClerkId: null };
    }
    // Every other class of error propagates.
    throw err;
  }
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

  // A. validate ids
  if (!firmId || !userId || !caseId) {
    return { ok: false, code: "FIRM_MISMATCH", reason: "Missing ids" };
  }

  // Preloaded firm match: authoritative if caller provided.
  if (preloaded?.caseFirmId !== undefined && preloaded?.caseFirmId !== null) {
    if (preloaded.caseFirmId !== firmId) return { ok: false, code: "FIRM_MISMATCH" };
  }

  // B. management role fast path (same-firm access)
  if (isManagementRole(roleName)) {
    return { ok: true, code: "OK", via: "partner_manager" };
  }

  // Preloaded legacy shortcut: if caller already has them (optimization only).
  if (preloaded?.assignedLawyerId === userId) {
    return { ok: true, code: "OK", via: "assigned_lawyer" };
  }
  if (preloaded?.assignedClerkId === userId) {
    return { ok: true, code: "OK", via: "assigned_clerk" };
  }

  // C. canonical case_assignments (Drizzle on @workspace/db table)
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
    // If case_assignments table genuinely missing (42P01 undefined_table),
    // we gracefully skip this path and continue to D.  Otherwise RE-THROW.
    const info = extractDbErrorInfo(err);
    const state = (info.sqlstate || info.code || "").toUpperCase();
    if (state !== "42P01") throw err;
  }

  // D. optional legacy compatibility (available:false → skip harmlessly on 42703)
  if (preloaded?.assignedLawyerId === null && preloaded?.assignedClerkId === null) {
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

  // E. deny
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
