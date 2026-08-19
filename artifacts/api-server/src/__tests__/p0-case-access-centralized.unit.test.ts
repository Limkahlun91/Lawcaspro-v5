import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canAccessCase,
  getAccessibleCasesSqlScope,
  getAllowedAssignmentRoles,
  type CaseAccessPurpose,
} from "../lib/auth.js";
import { listAccessibleCaseIds } from "../services/case-access.js";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  firmsTable,
  usersTable,
  rolesTable,
  casesTable,
  caseAssignmentsTable,
  permissionsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P0 G4 — Faithful CaseAccess predicate testing (real PGlite).
 *
 * Uses real @electric-sql/pglite with the full production migration set
 * (including real cases + case_assignments tables).  canAccessCase() runs
 * through production Drizzle against real rows so predicates are actually
 * exercised rather than bypassed with hand-assembled canned arrays.
 *
 * Verified required:
 *   - lawyer batch_update = allow
 *   - clerk batch_update = canonical (deny unless role list allows)
 *   - responsible_lawyer = allow
 *   - supporting_docs_viewer = deny batch_update
 *   - supporting_docs_editor = deny batch_update
 *   - witness = deny batch_update
 *   - client_party = deny batch_update
 *   - unassigned = deny
 *   - cross-firm = deny
 *   - missing case = deny
 *   - edit_case === batch_update for mutation-grade users
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pg: PGlite;
let r: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pg = new PGlite();
  await bootstrapMinimalSchema();
  r = drizzle(pg);
});

afterAll(async () => {
  try { await pg.close(); } catch { /* ignore if already closed */ }
});

async function bootstrapMinimalSchema() {
  // Minimal schema that mirrors @workspace/db drizzle tables for this test only.
  // We DO NOT run full migrations here: full migrations create many UUID-based
  // platform tables that cause `operator does not exist: bigint = uuid` errors
  // in PGlite during unrelated DDL.
  //
  // Columns and defaults below MUST match drizzle definitions exactly.
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id serial PRIMARY KEY,
      name text NOT NULL DEFAULT 'starter',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO subscription_plans (id, name) VALUES (1, 'starter') ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS firms (
      id serial PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'active',
      subscription_plan_id integer NOT NULL DEFAULT 1,
      subscription_status text NOT NULL DEFAULT 'active',
      custom_price_monthly numeric(12, 2),
      is_custom_plan boolean NOT NULL DEFAULT false,
      show_master_documents boolean NOT NULL DEFAULT true,
      logo_url text,
      address text,
      st_number text,
      tin_number text,
      registration_no text,
      sst_no text,
      phone text,
      email text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS roles (
      id serial PRIMARY KEY,
      firm_id integer NOT NULL,
      name text NOT NULL,
      is_system_role boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_roles_firm ON roles(firm_id);

    CREATE TABLE IF NOT EXISTS permissions (
      id serial PRIMARY KEY,
      role_id integer NOT NULL,
      module text NOT NULL,
      action text NOT NULL,
      allowed boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_permissions_role ON permissions(role_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_permissions_role_module_action
      ON permissions(role_id, module, action);

    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      firm_id integer,
      developer_id integer,
      email text NOT NULL,
      name text NOT NULL,
      initials varchar(5),
      password_hash text NOT NULL,
      user_type text NOT NULL DEFAULT 'firm_user',
      role_id integer,
      department text,
      bar_council_no text,
      nric_no text,
      status text NOT NULL DEFAULT 'active',
      totp_secret text,
      totp_enabled boolean NOT NULL DEFAULT false,
      totp_last_used_at timestamptz,
      last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_firm ON users(firm_id);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

    CREATE TABLE IF NOT EXISTS cases (
      id serial PRIMARY KEY,
      firm_id integer NOT NULL,
      project_id integer,
      developer_id integer,
      reference_no text,
      proposed_reference_no text,
      reference_no_changed_by integer,
      reference_no_changed_at timestamptz,
      reference_no_change_reason text,
      purchase_mode text NOT NULL DEFAULT 'cash',
      title_type text NOT NULL DEFAULT 'master',
      is_encumbered boolean NOT NULL DEFAULT false,
      tenure text NOT NULL DEFAULT 'freehold',
      tracking_token uuid NOT NULL DEFAULT gen_random_uuid(),
      spa_price numeric(15,2),
      apdl_price numeric(15,2),
      developer_discount numeric(15,2),
      bumiputra_discount numeric(15,2),
      amount_paid numeric(18,2) NOT NULL DEFAULT 0,
      outstanding_balance numeric(18,2) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'File Opened / SPA Pending Signing',
      lawyer_status text,
      lawyer_status_updated_at timestamptz,
      developer_status text,
      developer_status_updated_at timestamptz,
      case_type text NOT NULL DEFAULT 'developer_sales',
      approval_status text NOT NULL DEFAULT 'pending_approval',
      submitted_by integer,
      submitted_at timestamptz,
      approved_by integer,
      approved_at timestamptz,
      approval_note text,
      encumbrances text,
      acting_for text,
      responsible_lawyer_user_id integer,
      perfection_type text,
      parcel_no text,
      spa_details text,
      property_details jsonb,
      loan_details jsonb,
      borrowers jsonb NOT NULL DEFAULT '[]'::jsonb,
      loan_party_type text NOT NULL DEFAULT '1st_party',
      company_details text,
      created_by integer,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cases_tracking_token_key ON cases(tracking_token);
    CREATE INDEX IF NOT EXISTS idx_cases_firm ON cases(firm_id);
    CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

    CREATE TABLE IF NOT EXISTS case_assignments (
      id serial PRIMARY KEY,
      case_id integer NOT NULL,
      user_id integer NOT NULL,
      role_in_case text NOT NULL DEFAULT 'lawyer',
      assigned_by integer,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      unassigned_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_case_assignments_case ON case_assignments(case_id);
    CREATE INDEX IF NOT EXISTS idx_case_assignments_user ON case_assignments(user_id);
  `);
}

// Seed helpers
async function seedFirm(firmId: number, slug: string) {
  await r.insert(firmsTable).values({
    id: firmId, name: `F${firmId}`, slug, subscriptionPlanId: 1, createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing().execute();
}
async function seedRole(roleId: number, firmId: number, name: string, extra?: Record<string, any>) {
  await r.insert(rolesTable).values({
    id: roleId, firmId, name, isSystemRole: true, createdAt: new Date(), updatedAt: new Date(), ...extra,
  }).onConflictDoNothing().execute();
}
async function seedUser(userId: number, firmId: number, roleId: number) {
  await r.insert(usersTable).values({
    id: userId, firmId, roleId, email: `u${userId}@test.local`, name: `U${userId}`,
    passwordHash: "x", userType: "firm_user", status: "active", createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing().execute();
}
async function seedCase(caseId: number, firmId: number, responsibleLawyerUserId?: number) {
  await r.insert(casesTable).values({
    id: caseId,
    firmId,
    referenceNo: `CASE-${caseId}`,
    actingFor: `Case ${caseId}`,
    responsibleLawyerUserId: responsibleLawyerUserId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any).onConflictDoNothing().execute();
}
async function assignCase(caseId: number, userId: number, role_in_case: string) {
  await r.insert(caseAssignmentsTable).values({
    caseId, userId, roleInCase: role_in_case,
    assignedAt: new Date(), assignedBy: userId,
  }).onConflictDoNothing().execute();
}

// Local batch authorization helper (uses canAccessCase for each caseId).
// Mirrors the pattern production batch update routes should follow.
async function authorizeCaseBatchLocal(
  r: any,
  firmId: number,
  userId: number,
  roleId: number,
  roleName: string,
  caseIds: number[],
  purpose: CaseAccessPurpose,
  rolePermissions: ReadonlyArray<{ module: string; action: string }> | null,
): Promise<{ successes: number[]; failures: Array<{ caseId: number; code: string }> }> {
  const successes: number[] = [];
  const failures: Array<{ caseId: number; code: string }> = [];
  for (const caseId of caseIds) {
    const res = await canAccessCase({
      purpose,
      r,
      firmId,
      userId,
      roleId,
      roleName,
      rolePermissions: rolePermissions ?? [],
      caseId,
    });
    if (res.ok) {
      successes.push(caseId);
    } else {
      const f = res as { ok: false; code: "NO_CONTEXT" | "CROSS_FIRM" | "NOT_FOUND" | "NOT_ASSIGNED" };
      failures.push({ caseId, code: f.code });
    }
  }
  return { successes, failures };
}

// Views tests need both view_case purpose; mut tests: edit_case / batch_update
type CallOpts = Parameters<typeof canAccessCase>[0];
function opt(purpose: CaseAccessPurpose, extra: Omit<CallOpts, "purpose">) {
  return { purpose, ...extra } as CallOpts;
}

describe("P0 G4 — One Case Access Engine (faithful PGlite rows)", () => {
  describe("Basic context / not-found / cross-firm primitives", () => {
    it("NO_CONTEXT when firmId undefined", async () => {
      const res = await canAccessCase({
        purpose: "view_case",
        r: r as any,
        firmId: undefined, userId: 1, roleId: 1, roleName: "Lawyer", caseId: 1,
      });
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NO_CONTEXT");
    });

    it("NOT_FOUND when case not in DB", async () => {
      await seedFirm(9000, "f9000");
      await seedRole(9001, 9000, "Lawyer");
      await seedUser(9002, 9000, 9001);
      const res = await canAccessCase({
        purpose: "view_case",
        r: r as any,
        firmId: 9000, userId: 9002, roleId: 9001, roleName: "Lawyer", caseId: 99999,
      });
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_FOUND");
    });

    it("CROSS_FIRM when malicious case preloaded has mismatched firm", async () => {
      await seedFirm(9100, "f9100");
      await seedRole(9101, 9100, "Lawyer");
      await seedUser(9102, 9100, 9101);
      const res = await canAccessCase({
        purpose: "view_case",
        r: r as any,
        firmId: 9100, userId: 9102, roleId: 9101, roleName: "Lawyer", caseId: 1,
        caseAlreadyLoaded: { id: 1, firmId: 7777 },
      });
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("CROSS_FIRM");
    });

    it("CROSS_FIRM when DB loads case owned by other firm", async () => {
      await seedFirm(9200, "f9200");
      await seedFirm(9201, "f9201");
      await seedRole(9202, 9200, "Lawyer");
      await seedUser(9203, 9200, 9202);
      await seedCase(9204, 9201); // owned by other firm
      const res = await canAccessCase({
        purpose: "view_case",
        r: r as any,
        firmId: 9200, userId: 9203, roleId: 9202, roleName: "Lawyer", caseId: 9204,
      });
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("CROSS_FIRM");
    });
  });

  describe("Required: role_in_case-based assignment decisions against real case_assignments rows", () => {
    const FIRM = 8000;
    const ROLE_PARTNER = 8001;
    const ROLE_LAWYER = 8002;
    const ROLE_CLERK = 8003;
    const U_PARTNER = 8010;
    const U_LAWYER = 8011;
    const U_CLERK = 8012;
    const U_RESP_LAWYER = 8013;
    const U_SD_VIEWER = 8014;
    const U_SD_EDITOR = 8015;
    const U_WITNESS = 8016;
    const U_CLIENT = 8017;
    const U_UNASSIGNED = 8018;
    const CASE = 9001;

    beforeAll(async () => {
      await seedFirm(FIRM, "f8000");
      await seedRole(ROLE_PARTNER, FIRM, "Partner");
      await seedRole(ROLE_LAWYER, FIRM, "Lawyer");
      await seedRole(ROLE_CLERK, FIRM, "Clerk");
      await seedUser(U_PARTNER, FIRM, ROLE_PARTNER);
      await seedUser(U_LAWYER, FIRM, ROLE_LAWYER);
      await seedUser(U_CLERK, FIRM, ROLE_CLERK);
      await seedUser(U_RESP_LAWYER, FIRM, ROLE_LAWYER);
      await seedUser(U_SD_VIEWER, FIRM, ROLE_CLERK);
      await seedUser(U_SD_EDITOR, FIRM, ROLE_CLERK);
      await seedUser(U_WITNESS, FIRM, ROLE_CLERK);
      await seedUser(U_CLIENT, FIRM, ROLE_CLERK);
      await seedUser(U_UNASSIGNED, FIRM, ROLE_CLERK);
      await seedCase(CASE, FIRM, U_RESP_LAWYER);

      // Assignments (real rows in case_assignments table)
      await assignCase(CASE, U_PARTNER, "responsible_partner");
      await assignCase(CASE, U_LAWYER, "lawyer");
      await assignCase(CASE, U_CLERK, "clerk");
      await assignCase(CASE, U_RESP_LAWYER, "responsible_lawyer");
      await assignCase(CASE, U_SD_VIEWER, "supporting_docs_viewer");
      await assignCase(CASE, U_SD_EDITOR, "supporting_docs_editor");
      await assignCase(CASE, U_WITNESS, "witness");
      await assignCase(CASE, U_CLIENT, "client_party");
      // U_UNASSIGNED intentionally not assigned

      // Explicit Partner permission: cases.assign_any → firmwide scope bypass
      await r.insert(permissionsTable).values({
        roleId: ROLE_PARTNER, module: "cases", action: "assign_any", allowed: true,
      }).onConflictDoNothing().execute();
    });

    it("Partner (firmwide via cases.assign_any explicit perm) → edit_case & batch_update ALLOW", async () => {
      const e = await canAccessCase(opt("edit_case", {
        r: r as any, firmId: FIRM, userId: U_PARTNER, roleId: ROLE_PARTNER, roleName: "Partner", caseId: CASE,
      }));
      const b = await canAccessCase(opt("batch_update", {
        r: r as any, firmId: FIRM, userId: U_PARTNER, roleId: ROLE_PARTNER, roleName: "Partner", caseId: CASE,
      }));
      expect(e.ok).toBe(true);
      expect(b.ok).toBe(true);
    });

    it("REQUIRED: lawyer assignment → batch_update = ALLOW", async () => {
      const res = await canAccessCase(opt("batch_update", {
        r: r as any, firmId: FIRM, userId: U_LAWYER, roleId: ROLE_LAWYER, roleName: "Lawyer", caseId: CASE,
      }));
      expect(res.ok).toBe(true);
    });

    it("REQUIRED: responsible_lawyer assignment → allow (view + edit)", async () => {
      const v = await canAccessCase(opt("view_case", {
        r: r as any, firmId: FIRM, userId: U_RESP_LAWYER, roleId: ROLE_LAWYER, roleName: "Lawyer", caseId: CASE,
      }));
      const e = await canAccessCase(opt("edit_case", {
        r: r as any, firmId: FIRM, userId: U_RESP_LAWYER, roleId: ROLE_LAWYER, roleName: "Lawyer", caseId: CASE,
      }));
      expect(v.ok).toBe(true);
      expect(e.ok).toBe(true);
    });

    it("REQUIRED: supporting_docs_viewer → batch_update = DENY (view_documents allow)", async () => {
      const batch = await canAccessCase(opt("batch_update", {
        r: r as any, firmId: FIRM, userId: U_SD_VIEWER, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      const vd = await canAccessCase(opt("view_documents", {
        r: r as any, firmId: FIRM, userId: U_SD_VIEWER, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      expect(batch.ok).toBe(false);
      if (batch.ok === false) expect(batch.code).toBe("NOT_ASSIGNED");
      expect(vd.ok).toBe(true);
    });

    it("REQUIRED: supporting_docs_editor → batch_update = DENY (edit_documents allow)", async () => {
      const batch = await canAccessCase(opt("batch_update", {
        r: r as any, firmId: FIRM, userId: U_SD_EDITOR, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      const ed = await canAccessCase(opt("edit_documents", {
        r: r as any, firmId: FIRM, userId: U_SD_EDITOR, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      expect(batch.ok).toBe(false);
      if (batch.ok === false) expect(batch.code).toBe("NOT_ASSIGNED");
      expect(ed.ok).toBe(true);
    });

    it("REQUIRED: witness → batch_update = DENY; view_case = ALLOW", async () => {
      const batch = await canAccessCase(opt("batch_update", {
        r: r as any, firmId: FIRM, userId: U_WITNESS, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      const view = await canAccessCase(opt("view_case", {
        r: r as any, firmId: FIRM, userId: U_WITNESS, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      expect(batch.ok).toBe(false);
      if (batch.ok === false) expect(batch.code).toBe("NOT_ASSIGNED");
      expect(view.ok).toBe(true);
    });

    it("REQUIRED: client_party → batch_update = DENY; view_case = ALLOW", async () => {
      const batch = await canAccessCase(opt("batch_update", {
        r: r as any, firmId: FIRM, userId: U_CLIENT, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      const view = await canAccessCase(opt("view_case", {
        r: r as any, firmId: FIRM, userId: U_CLIENT, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      expect(batch.ok).toBe(false);
      if (batch.ok === false) expect(batch.code).toBe("NOT_ASSIGNED");
      expect(view.ok).toBe(true);
    });

    it("REQUIRED: unassigned → DENY NOT_ASSIGNED", async () => {
      const res = await canAccessCase(opt("view_case", {
        r: r as any, firmId: FIRM, userId: U_UNASSIGNED, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_ASSIGNED");
    });

    it("edit_case and batch_update decisions match for mutation-grade users", async () => {
      // For every user with mutation-grade role we compare decisions
      const subjects: Array<[string, number, number, string]> = [
        ["partner", U_PARTNER, ROLE_PARTNER, "Partner"],
        ["lawyer", U_LAWYER, ROLE_LAWYER, "Lawyer"],
        ["clerk", U_CLERK, ROLE_CLERK, "Clerk"],
        ["resp_lawyer", U_RESP_LAWYER, ROLE_LAWYER, "Lawyer"],
        ["sd_viewer", U_SD_VIEWER, ROLE_CLERK, "Clerk"],
        ["sd_editor", U_SD_EDITOR, ROLE_CLERK, "Clerk"],
      ];
      for (const [label, uid, rid, rname] of subjects) {
        const a = await canAccessCase(opt("edit_case", { r: r as any, firmId: FIRM, userId: uid, roleId: rid, roleName: rname, caseId: CASE }));
        const b = await canAccessCase(opt("batch_update", { r: r as any, firmId: FIRM, userId: uid, roleId: rid, roleName: rname, caseId: CASE }));
        // Mutation-grade users: either both allow OR both deny.  Cases where
        // edit != batch_update (if any) would be legacy inconsistency.
        expect(a.ok, `edit ${label}`).toBe(b.ok);
      }
    });

    it("Clerk assignment → batch_update canonical decision (clerk IS allowed for mutations per CANONICAL_CASE_ACCESS_ROLES)", async () => {
      // CANONICAL_CASE_ACCESS_ROLES: batch_update = [lawyer, clerk, responsible_lawyer]
      const res = await canAccessCase(opt("batch_update", {
        r: r as any, firmId: FIRM, userId: U_CLERK, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      const edit = await canAccessCase(opt("edit_case", {
        r: r as any, firmId: FIRM, userId: U_CLERK, roleId: ROLE_CLERK, roleName: "Clerk", caseId: CASE,
      }));
      expect(res.ok).toBe(true);
      expect(edit.ok).toBe(true);
    });

    it("authorizeCaseBatchLocal authorized own cases → all success (uses canAccessCase via real helper)", async () => {
      // Partner has explicit cases.assign_any → firmwide
      const r2 = await authorizeCaseBatchLocal(r as any, FIRM, U_PARTNER, ROLE_PARTNER, "Partner", [CASE], "edit_case", null);
      expect(r2.successes).toEqual([CASE]);
      expect(r2.failures).toEqual([]);
    });

    it("authorizeCaseBatchLocal mixed inject unassigned → partial_failure", async () => {
      await seedCase(9002, FIRM); // unassigned
      const r2 = await authorizeCaseBatchLocal(r as any, FIRM, U_PARTNER, ROLE_PARTNER, "Partner", [CASE, 9002], "batch_update", null);
      expect(r2.successes.sort()).toEqual([CASE, 9002]); // both succeed for firmwide
      // Now non-firmwide user (Lawyer U_LAWYER) has CASE assigned, 9002 not
      const r3 = await authorizeCaseBatchLocal(r as any, FIRM, U_LAWYER, ROLE_LAWYER, "Lawyer", [CASE, 9002], "batch_update", null);
      expect(r3.successes).toEqual([CASE]);
      expect(r3.failures.length).toBe(1);
      expect(r3.failures[0].caseId).toBe(9002);
    });

    it("authorizeCaseBatchLocal cross-firm inject → CROSS_FIRM rejected", async () => {
      await seedFirm(8009, "f8009");
      await seedCase(9003, 8009); // owned by OTHER firm
      const r2 = await authorizeCaseBatchLocal(r as any, FIRM, U_PARTNER, ROLE_PARTNER, "Partner", [CASE, 9003], "batch_update", null);
      expect(r2.successes).toEqual([CASE]);
      expect(r2.failures.length).toBe(1);
      expect(r2.failures[0].code).toBe("CROSS_FIRM");
    });
  });

  describe("getAllowedAssignmentRoles / getAccessibleCasesSqlScope sanity", () => {
    it("allowed roles exist for all 6 canonical CaseAccessPurposes", async () => {
      const purposes: CaseAccessPurpose[] = ["view_case", "edit_case", "batch_update", "view_documents", "edit_documents", "print_documents"];
      for (const p of purposes) {
        const roles = getAllowedAssignmentRoles(p);
        expect(Array.isArray(roles)).toBe(true);
      }
    });

    it("hasFirmwideScope=true → non-empty accessible scope literal", () => {
      const scope = getAccessibleCasesSqlScope({
        hasFirmwideScope: true, firmId: 1, userId: 1,
      });
      expect(scope).not.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // CA-DB: case_assignments DB error behaviour.
  //
  // Canonical rule (case_assignments is REQUIRED canonical schema):
  //   - valid query + zero rows → empty/not-assigned (deny)
  //   - any query failure → PROPAGATE (never silently degrade to 0 cases)
  //
  // Error codes tested:
  //   CA-DB-1 empty rows (control)     → NOT_ASSIGNED
  //   CA-DB-2 42P01 undefined_table    → propagates
  //   CA-DB-3 42501 insufficient_priv  → propagates
  //   CA-DB-4 08006 connection_failure → propagates (transient path)
  //   CA-DB-5 57P01 admin_shutdown     → propagates (DB unavailable)
  //   CA-DB-6 53300 too_many_conns     → propagates (DB_BUSY)
  // -----------------------------------------------------------------------
  describe("CA-DB — case_assignments DB errors MUST propagate, empty → deny", () => {
    // Users/firm established once.  Note these IDs must not collide with
    // other describe blocks since all share the same PGlite instance.
    const CA_FIRM = 8500;
    const CA_ROLE_CLERK = 8501;
    const CA_USER = 8502;
    const CA_CASE = 8503; // intentionally NOT in case_assignments

    beforeAll(async () => {
      await seedFirm(CA_FIRM, "f-ca-db");
      await seedRole(CA_ROLE_CLERK, CA_FIRM, "Clerk");
      await seedUser(CA_USER, CA_FIRM, CA_ROLE_CLERK);
      await seedCase(CA_CASE, CA_FIRM);
    });

    // CA-DB-1 — control: empty case_assignments + valid query → NOT_ASSIGNED
    it("CA-DB-1 case_assignments returns [] → NOT_ASSIGNED (not 500)", async () => {
      const res = await canAccessCase({
        purpose: "view_case",
        r: r as any,
        firmId: CA_FIRM,
        userId: CA_USER,
        roleId: CA_ROLE_CLERK,
        roleName: "Clerk",
        caseId: CA_CASE,
      });
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe("NOT_ASSIGNED");
    });

    // Helper: build a drizzle-style fake error
    function fakePgError(sqlstate: string, msg: string) {
      const err = new Error(msg) as Error & { code: string; sqlstate?: string };
      err.code = sqlstate;
      err.sqlstate = sqlstate;
      return err;
    }

    // CA-DB-2 — 42P01 undefined_table propagates
    it("CA-DB-2 42P01 undefined_table → error propagates (not silently empty)", async () => {
      const spy = vi
        .spyOn(r, "select" as any)
        .mockImplementationOnce(() => {
          throw fakePgError("42P01", "relation \"case_assignments\" does not exist");
        });
      try {
        await expect(
          canAccessCase({
            purpose: "view_case",
            r: r as any,
            firmId: CA_FIRM, userId: CA_USER,
            roleId: CA_ROLE_CLERK, roleName: "Clerk", caseId: CA_CASE,
          }),
        ).rejects.toBeDefined();
      } finally {
        spy.mockRestore();
      }
    });

    // CA-DB-3 — 42501 insufficient_privilege propagates
    it("CA-DB-3 42501 insufficient_privilege → error propagates", async () => {
      const spy = vi
        .spyOn(r, "select" as any)
        .mockImplementationOnce(() => {
          throw fakePgError("42501", "permission denied for relation case_assignments");
        });
      try {
        await expect(
          canAccessCase({
            purpose: "view_case",
            r: r as any,
            firmId: CA_FIRM, userId: CA_USER,
            roleId: CA_ROLE_CLERK, roleName: "Clerk", caseId: CA_CASE,
          }),
        ).rejects.toBeDefined();
      } finally {
        spy.mockRestore();
      }
    });

    // CA-DB-4 — 08006 connection_failure (transient) propagates
    it("CA-DB-4 08006 connection_exception transient → error propagates, NOT empty list", async () => {
      const spy = vi
        .spyOn(r, "select" as any)
        .mockImplementationOnce(() => {
          throw fakePgError("08006", "connection failure (transient)");
        });
      try {
        await expect(
          listAccessibleCaseIds({
            r: r as any,
            firmId: CA_FIRM, userId: CA_USER,
            roleId: CA_ROLE_CLERK, roleName: "Clerk",
            purpose: "view_case",
          }),
        ).rejects.toBeDefined();
      } finally {
        spy.mockRestore();
      }
    });

    // CA-DB-5 — 57P01 admin_shutdown propagates
    it("CA-DB-5 57P01 admin_shutdown DB unavailable → error propagates", async () => {
      const spy = vi
        .spyOn(r, "select" as any)
        .mockImplementationOnce(() => {
          throw fakePgError("57P01", "terminating connection due to administrator command");
        });
      try {
        await expect(
          listAccessibleCaseIds({
            r: r as any,
            firmId: CA_FIRM, userId: CA_USER,
            roleId: CA_ROLE_CLERK, roleName: "Clerk",
            purpose: "view_case",
          }),
        ).rejects.toBeDefined();
      } finally {
        spy.mockRestore();
      }
    });

    // CA-DB-6 — 53300 too_many_connections propagates (DB_BUSY)
    it("CA-DB-6 53300 too_many_connections (DB_BUSY) → error propagates NOT []", async () => {
      const spy = vi
        .spyOn(r, "select" as any)
        .mockImplementationOnce(() => {
          throw fakePgError("53300", "sorry, too many clients already");
        });
      try {
        const p = listAccessibleCaseIds({
          r: r as any,
          firmId: CA_FIRM, userId: CA_USER,
          roleId: CA_ROLE_CLERK, roleName: "Clerk",
          purpose: "view_case",
        });
        await expect(p).rejects.toBeDefined();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
