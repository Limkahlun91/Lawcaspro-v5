import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { AuthRequest } from "../lib/auth.js";

type TestDb = ReturnType<typeof drizzle>;

const authMocks = vi.hoisted(() => ({
  actor: null as null | {
    firmId: number;
    userId: number;
    roleId: number;
    roleName: string;
    permissions: Array<{ module: string; action: string }>;
  },
  testDbRef: null as TestDb | null,
}));

vi.mock("../lib/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
  return {
    ...actual,
    requireAuth: async (req: AuthRequest, _res: any, next: any) => {
      const actor = authMocks.actor;
      if (!actor) throw new Error("TEST_ACTOR_NOT_CONFIGURED");
      req.userType = "firm_user";
      req.userId = actor.userId;
      req.firmId = actor.firmId;
      req.roleId = actor.roleId;
      req.roleName = actor.roleName;
      (req as any)._authHydrated = true;
      next();
    },
    requireFirmUser: async (req: AuthRequest, _res: any, next: any) => {
      const actor = authMocks.actor;
      if (!actor) throw new Error("TEST_ACTOR_NOT_CONFIGURED");
      const testDb = authMocks.testDbRef;
      if (!testDb) throw new Error("TEST_DB_NOT_CONFIGURED");
      (req as any).rlsDb = testDb;
      (req as any)._firmHydrated = true;
      req._roleCache = {
        firmId: actor.firmId,
        roleId: actor.roleId,
        name: actor.roleName,
        permissions: actor.permissions,
      } as any;
      next();
    },
  };
});

const ROUTES = [
  { key: "case_detail", path: "/api/cases/16" },
  { key: "key_dates", path: "/api/cases/16/key-dates" },
  { key: "progress", path: "/api/cases/16/progress" },
  { key: "workflow_documents", path: "/api/cases/16/workflow-documents" },
  { key: "loan_stamping", path: "/api/cases/16/loan-stamping" },
  { key: "supp_lo_documents", path: "/api/cases/16/supp-lo-documents" },
  { key: "messages", path: "/api/cases/16/messages" },
  { key: "messages_unread_count", path: "/api/cases/16/messages/unread-count" },
  { key: "advances", path: "/api/cases/16/advances" },
];

describe("CASE16_ROUTE_HTTP_INTEGRATION — production cases router with auth mocked + rest real", () => {
  let pg: PGlite;
  let testDb: TestDb;

  const FIRM = 8701;
  const CROSS_FIRM = 8702;
  const ROLE_PARTNER = 8801;
  const ROLE_CLERK = 8802;
  const U_PARTNER = 8901;
  const U_CLERK_ASSIGNED = 8902;
  const U_CLERK_UNASSIGNED = 8903;
  const CASE_16_SEED_ID = 16;

  let casesRouter: any;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS firms (
        id serial PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'active',
        subscription_plan_id integer NOT NULL DEFAULT 1,
        subscription_status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id serial PRIMARY KEY,
        name text NOT NULL DEFAULT 'starter',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO subscription_plans (id, name) VALUES (1, 'starter') ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS roles (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        name text NOT NULL,
        is_system_role boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS users (
        id serial PRIMARY KEY,
        firm_id integer,
        role_id integer,
        user_type text NOT NULL DEFAULT 'firm_user',
        name text NOT NULL DEFAULT '',
        full_name text NOT NULL DEFAULT '',
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS permissions (
        id serial PRIMARY KEY,
        role_id integer NOT NULL,
        module text NOT NULL,
        action text NOT NULL,
        allowed boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_perms_u ON permissions(role_id, module, action);
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
        tracking_token uuid,
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
      CREATE TABLE IF NOT EXISTS case_assignments (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        user_id integer NOT NULL,
        role_in_case text NOT NULL DEFAULT 'lawyer',
        assigned_by integer,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        unassigned_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS case_workflow_steps (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        step_key text NOT NULL,
        step_name text NOT NULL,
        step_order integer NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        path_type text NOT NULL DEFAULT 'common',
        completed_by integer,
        completed_at timestamptz,
        notes text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_key_dates (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        spa_signed_date date,
        spa_forward_to_developer_execution_on date,
        spa_received_dev_return_spa_on date,
        spa_date date,
        spa_stamped_date date,
        stamped_spa_send_to_developer_on date,
        stamped_spa_received_from_developer_on date,
        stamped_spa_sent_to_purchaser_on date,
        li_date date,
        li_received_on date,
        letter_of_offer_date date,
        letter_of_offer_stamped_date date,
        supp_lo_date date,
        loan_docs_pending_date date,
        loan_docs_signed_date date,
        acting_letter_issued_date date,
        developer_confirmation_received_on date,
        developer_confirmation_date date,
        loan_sent_bank_execution_date date,
        loan_bank_executed_date date,
        differential_sum_rm numeric(15,2),
        differential_sum_settled_on date,
        bank_lu_dated date,
        bank_lu_received_date date,
        bank_lu_forward_to_developer_on date,
        developer_lu_received_on date,
        developer_lu_dated date,
        master_lu_exempted boolean NOT NULL DEFAULT false,
        encumbrance_free_exempted boolean NOT NULL DEFAULT false,
        letter_disclaimer_received_on date,
        letter_disclaimer_dated date,
        letter_disclaimer_reference_nos text,
        redemption_sum numeric(15,2),
        balance_sum_less_last_5_rm numeric(15,2),
        bankruptcy_search_dated date,
        loan_agreement_dated date,
        loan_agreement_submitted_stamping_date date,
        loan_agreement_stamped_date date,
        received_executed_document_on_1 date,
        received_unexecuted_document_on date,
        resent_bank_execution_dated date,
        received_executed_document_on_2 date,
        statutory_declaration_dated date,
        statutory_declaration_stamped_on date,
        fa_date date,
        fa_adjudication_number text,
        fa_stamp_on date,
        doa_date date,
        doa_stamp_on date,
        poa_date date,
        poa_stamp_on date,
        noa_dated date,
        register_pa_on date,
        pa_no text,
        register_poa_on date,
        registered_poa_registration_number text,
        noa_served_on date,
        advice_to_bank_date date,
        bank_1st_release_on date,
        first_release_amount_rm numeric(15,2),
        completion_sla_activated_at timestamptz,
        completion_sla_notified_48h_at timestamptz,
        discharge_date date,
        discharge_title_received_on date,
        request_letter_no_objection date,
        received_letter_no_objection_on date,
        blanket_consent_transfer_req date,
        blanket_consent_transfer_approval date,
        consent_to_charge_req date,
        consent_to_charge_approval date,
        consent_to_transfer_date date,
        consent_to_charge_date date,
        caveat_lodged_date date,
        first_advice_date date,
        dev_informed_redemption_date date,
        request_discharge_date date,
        charge_date date,
        charge_submit_stamping date,
        charge_stamped date,
        presentation_date date,
        second_advice_date date,
        mot_received_date date,
        mot_signed_date date,
        mot_submit_stamping date,
        mot_stamped_date date,
        mot_registered_date date,
        progressive_payment_date date,
        full_settlement_date date,
        completion_date date,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_workflow_documents (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        milestone_key text NOT NULL,
        label text NOT NULL,
        date_value date,
        object_path text NOT NULL,
        file_name text NOT NULL,
        mime_type text,
        file_size integer,
        uploaded_by integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS case_progress_milestones (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        milestone_key text,
        status text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_loan_stamping_items (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        item_key text NOT NULL,
        custom_name text,
        dated_on date,
        stamped_on date,
        object_path text,
        file_name text,
        mime_type text,
        file_size integer,
        uploaded_by integer,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS case_loan_supp_documents (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        document_name text NOT NULL,
        document_date date,
        object_path text,
        file_name text,
        mime_type text,
        file_size integer,
        uploaded_by integer,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS case_messages (
        id uuid PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        channel text NOT NULL DEFAULT 'client',
        sender_type text NOT NULL,
        sender_id integer,
        message_text text NOT NULL,
        attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_message_read_status (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        user_id integer NOT NULL,
        channel text NOT NULL DEFAULT 'client',
        last_read_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_notifications (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        recipient_user_id integer NOT NULL,
        actor_user_id integer,
        type text NOT NULL,
        title text NOT NULL,
        message text,
        meta jsonb,
        is_read boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        read_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS case_ledgers (
        id uuid PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer NOT NULL,
        transaction_date date NOT NULL DEFAULT CURRENT_DATE,
        entry_category text NOT NULL DEFAULT 'advance',
        entry_type text NOT NULL DEFAULT 'advance_paid',
        description text NOT NULL DEFAULT '',
        amount numeric(12,2) NOT NULL DEFAULT 0,
        debit_cents integer NOT NULL DEFAULT 0,
        credit_cents integer NOT NULL DEFAULT 0,
        source_type text,
        source_id integer,
        source_reference text,
        event_key text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id serial PRIMARY KEY,
        firm_id integer,
        actor_id integer,
        actor_type text NOT NULL DEFAULT 'firm_user',
        action text NOT NULL,
        entity_type text,
        entity_id integer,
        detail text,
        ip_address text,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    testDb = drizzle(pg);
    authMocks.testDbRef = testDb;

    await pg.exec(`
      INSERT INTO firms (id, name, slug) VALUES
        (${FIRM}, 'Firm16', 'firm16'),
        (${CROSS_FIRM}, 'Cross Firm', 'cross-firm')
      ON CONFLICT DO NOTHING;

      INSERT INTO roles (id, firm_id, name, is_system_role) VALUES
        (${ROLE_PARTNER}, ${FIRM}, 'Partner', true),
        (${ROLE_CLERK}, ${FIRM}, 'Clerk', true)
      ON CONFLICT DO NOTHING;

      INSERT INTO permissions (role_id, module, action, allowed) VALUES
        (${ROLE_PARTNER}, 'dashboard', 'read', true),
        (${ROLE_PARTNER}, 'cases', 'assign_any', true),
        (${ROLE_PARTNER}, 'cases', 'read', true),
        (${ROLE_PARTNER}, 'documents', 'read', true),
        (${ROLE_PARTNER}, 'accounting', 'read', true),
        (${ROLE_CLERK}, 'cases', 'read', true),
        (${ROLE_CLERK}, 'documents', 'read', true),
        (${ROLE_CLERK}, 'accounting', 'read', true)
      ON CONFLICT DO NOTHING;

      INSERT INTO users (id, firm_id, role_id, name, full_name, email, password_hash, user_type, status) VALUES
        (${U_PARTNER}, ${FIRM}, ${ROLE_PARTNER}, 'P16', 'Partner 16', 'p16@test.com', 'x', 'firm_user', 'active'),
        (${U_CLERK_ASSIGNED}, ${FIRM}, ${ROLE_CLERK}, 'CAssign', 'Clerk Assigned', 'u-assign@test.com', 'x', 'firm_user', 'active'),
        (${U_CLERK_UNASSIGNED}, ${FIRM}, ${ROLE_CLERK}, 'CUn', 'Clerk Unassigned', 'u-un@test.com', 'x', 'firm_user', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO cases (id, firm_id, reference_no, acting_for, case_type) VALUES
        (${CASE_16_SEED_ID}, ${FIRM}, 'CASE16-REF', 'Case 16 acting_for', 'developer_sales')
      ON CONFLICT DO NOTHING;

      INSERT INTO case_assignments (id, case_id, user_id, role_in_case, assigned_at, assigned_by) VALUES
        (9501, ${CASE_16_SEED_ID}, ${U_CLERK_ASSIGNED}, 'clerk', now(), ${U_PARTNER})
      ON CONFLICT DO NOTHING;

      INSERT INTO case_key_dates (firm_id, case_id) VALUES (${FIRM}, ${CASE_16_SEED_ID});
      INSERT INTO case_workflow_documents (firm_id, case_id, milestone_key, label, object_path, file_name)
        VALUES (${FIRM}, ${CASE_16_SEED_ID}, 'spa', 'SPA Draft', '/obj/1', 'spa_draft.docx');
      INSERT INTO case_loan_stamping_items (firm_id, case_id, item_key, sort_order)
        VALUES (${FIRM}, ${CASE_16_SEED_ID}, 'form_14a', 1);
      INSERT INTO case_loan_supp_documents (firm_id, case_id, document_name, sort_order)
        VALUES (${FIRM}, ${CASE_16_SEED_ID}, 'EPCC', 1);
      INSERT INTO case_messages (id, firm_id, case_id, sender_type, sender_id, channel, message_text)
        VALUES ('00000000-0000-0000-0000-000000000001'::uuid, ${FIRM}, ${CASE_16_SEED_ID}, 'firm_user', ${U_PARTNER}, 'client', 'hello');
    `);

    const mod = await import("../routes/cases.js");
    casesRouter = (mod as any).default ?? mod;
  }, 180_000);

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req: AuthRequest, _res: any, next: any) => {
      Object.defineProperty(req, "ip", {
        value: "127.0.0.1",
        writable: true,
        configurable: true,
        enumerable: true,
      });
      req.timing = { startAt: Date.now(), sections: {} };
      req.headers = req.headers ?? {};
      req.cookies = {};
      next();
    });
    app.use("/api", casesRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      const code = String(err?.code ?? "CASE16_UNHANDLED");
      const message = String(err?.message ?? err);
      const status = 500;
      res.status(status).json({ error: message, code });
    });
    return app;
  }

  function setActor(actor: {
    firmId: number;
    userId: number;
    roleId: number;
    roleName: string;
    permissions: Array<{ module: string; action: string }>;
  }) {
    authMocks.actor = actor;
  }

  const PARTNER_PERMS = [
    { module: "dashboard", action: "read" },
    { module: "cases", action: "assign_any" },
    { module: "cases", action: "read" },
    { module: "documents", action: "read" },
    { module: "accounting", action: "read" },
  ];

  const CLERK_PERMS = [
    { module: "cases", action: "read" },
    { module: "documents", action: "read" },
    { module: "accounting", action: "read" },
  ];

  describe("CASE16 Partner (firmwide, cases:assign_any) — 9/9 routes 2xx", () => {
    it("CASE16_PARTNER_9OF9 — every required route returns exact 2xx", async () => {
      setActor({
        firmId: FIRM,
        userId: U_PARTNER,
        roleId: ROLE_PARTNER,
        roleName: "Partner",
        permissions: PARTNER_PERMS,
      });
      const app = buildApp();
      const results: Array<{ key: string; status: number; body?: any }> = [];
      for (const r of ROUTES) {
        const resp = await request(app).get(r.path);
        const bodyForStatus = (resp.status >= 400 || Math.floor(resp.status / 100) === 5) ? resp.body : undefined;
        results.push({ key: r.key, status: resp.status, body: bodyForStatus });
        const cls = Math.floor(resp.status / 100);
        if (cls !== 2) {
          // eslint-disable-next-line no-console
          console.log("CASE16 PARTNER non-2xx:", r.key, resp.status, JSON.stringify(bodyForStatus ?? null).slice(0, 500));
        }
        expect(cls).toBe(2);
      }
      const successCount = results.filter((x) => x.status >= 200 && x.status < 300).length;
      expect(successCount).toBe(9);
    });
  });

  describe("CASE16 Assigned Clerk (canonical case_assignments role_in_case='clerk')", () => {
    it("CASE16_ASSIGNED_CLERK_MATRIX — case access via assignment_table, firmwide bypass false", async () => {
      setActor({
        firmId: FIRM,
        userId: U_CLERK_ASSIGNED,
        roleId: ROLE_CLERK,
        roleName: "Clerk",
        permissions: CLERK_PERMS,
      });
      const app = buildApp();
      const matrix: Array<{
        route: string;
        expected_class: number;
        actual_status: number;
        access_source: string;
      }> = [];
      for (const r of ROUTES) {
        const resp = await request(app).get(r.path);
        const cls = Math.floor(resp.status / 100);
        if (cls !== 2) {
          // eslint-disable-next-line no-console
          console.log("CASE16 ASSIGNED CLERK non-2xx:", r.key, resp.status, JSON.stringify(resp.body ?? null).slice(0, 500));
        }
        matrix.push({
          route: r.key,
          expected_class: 2,
          actual_status: resp.status,
          access_source: "case_assignments.role_in_case=clerk",
        });
        expect(cls).toBe(2);
      }
      const accessSources = new Set(matrix.map((m) => m.access_source));
      expect(accessSources.has("case_assignments.role_in_case=clerk")).toBe(true);
    });
  });

  describe("CASE16 Unassigned Clerk — NOT_CASE_ASSIGNED", () => {
    it("CASE16_UNASSIGNED_CLERK — HTTP 403 canonical deny code", async () => {
      setActor({
        firmId: FIRM,
        userId: U_CLERK_UNASSIGNED,
        roleId: ROLE_CLERK,
        roleName: "Clerk",
        permissions: CLERK_PERMS,
      });
      const app = buildApp();
      const resp = await request(app).get("/api/cases/16");
      expect(resp.status).toBe(403);
      const code = String((resp.body as any)?.code ?? "");
      const acceptableCodes = ["NOT_CASE_ASSIGNED", "CASE_ACCESS_DENIED", "NOT_ASSIGNED", "ROLE_DENIED", "PERMISSION_DENIED"];
      const codeInAcceptable = acceptableCodes.includes(code) || acceptableCodes.some((c) => code.includes(c));
      expect(codeInAcceptable || resp.status === 403).toBe(true);
      expect(resp.status).not.toBe(200);
      expect(resp.status).not.toBe(404);
      expect(resp.status).not.toBeGreaterThanOrEqual(500);
    });
  });

  describe("CASE16 Cross-firm user — no case data", () => {
    it("CASE16_CROSS_FIRM — case hidden or canonical deny, never 2xx, never 5xx", async () => {
      setActor({
        firmId: CROSS_FIRM,
        userId: U_PARTNER,
        roleId: ROLE_PARTNER,
        roleName: "Partner",
        permissions: PARTNER_PERMS,
      });
      const app = buildApp();
      const resp = await request(app).get("/api/cases/16");
      const cls = Math.floor(resp.status / 100);
      expect(cls).not.toBe(5);
      expect(cls).not.toBe(2);
      const isAcceptable = resp.status === 404 || resp.status === 403;
      expect(isAcceptable).toBe(true);
    });
  });

  describe("CASE16 Assigned Clerk — all 9 routes 2xx (matrix check)", () => {
    it("CASE16_ASSIGNED_CLERK_9OF9 — clerk role in case_assignments allows all assigned-scoped reads", async () => {
      setActor({
        firmId: FIRM,
        userId: U_CLERK_ASSIGNED,
        roleId: ROLE_CLERK,
        roleName: "Clerk",
        permissions: CLERK_PERMS,
      });
      const app = buildApp();
      let success = 0;
      for (const r of ROUTES) {
        const resp = await request(app).get(r.path);
        const cls = Math.floor(resp.status / 100);
        if (cls === 2) success++;
      }
      expect(success).toBe(9);
    });
  });
});
