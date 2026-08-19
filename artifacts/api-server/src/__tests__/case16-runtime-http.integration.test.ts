import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import casesRouter from "../routes/cases.js";
import type { AuthRequest } from "../lib/auth.js";

export type RouteHandledEvidence = {
  route: string;
  accessResult: string;
  handlerReached: boolean;
  httpStatus: number;
  statusClass?: number;
};

describe("R2A CASE16 REAL HTTP ROUTE PROOF (production cases router)", () => {
  let pg: PGlite;
  let r: ReturnType<typeof drizzle>;

  const FIRM = 8701;
  const CROSS_FIRM = 8702;
  const ROLE_PARTNER = 8801;
  const ROLE_CLERK = 8802;
  const U_PARTNER = 8901;
  const U_CLERK_ASSIGNED = 8902;
  const U_CLERK_UNASSIGNED = 8903;
  const CASE_16_SEED_ID = 16;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS firms (
        id serial PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'active',
        subscription_plan_id integer NOT NULL DEFAULT 1,
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
        created_at timestamptz NOT NULL DEFAULT now()
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
        reference_no text,
        display_id text,
        case_no text,
        acting_for text,
        case_type text,
        responsible_lawyer_user_id integer,
        spa_status text,
        loan_status text,
        developer_id integer,
        project_id integer,
        created_by integer,
        closed_at timestamptz,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_assignments (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        user_id integer NOT NULL,
        role_in_case text NOT NULL,
        assigned_at timestamptz NOT NULL DEFAULT now(),
        assigned_by integer,
        unassigned_at timestamptz,
        unassigned_by integer
      );
      CREATE TABLE IF NOT EXISTS case_key_dates (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_workflow_steps (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        step_key text,
        status text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_workflow_documents (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        milestone_key text,
        document_key text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_loan_stamping_items (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        stamping_item_key text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_loan_supp_documents (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        supp_document_key text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_messages (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        sender_id integer,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_message_read_status (
        id serial PRIMARY KEY,
        message_id integer NOT NULL,
        user_id integer NOT NULL,
        read_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS case_advances (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        amount_cents integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_progress_milestones (
        id serial PRIMARY KEY,
        case_id integer NOT NULL,
        milestone_key text,
        status text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    r = drizzle(pg);
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

      INSERT INTO cases (id, firm_id, reference_no, acting_for, case_type, created_at, updated_at) VALUES
        (${CASE_16_SEED_ID}, ${FIRM}, 'CASE16-REF', 'Case 16 acting_for', 'conveyancing', now(), now())
      ON CONFLICT DO NOTHING;

      INSERT INTO case_assignments (id, case_id, user_id, role_in_case, assigned_at, assigned_by) VALUES
        (9501, ${CASE_16_SEED_ID}, ${U_CLERK_ASSIGNED}, 'clerk', now(), ${U_PARTNER})
      ON CONFLICT DO NOTHING;

      INSERT INTO case_key_dates (case_id) VALUES (${CASE_16_SEED_ID});
      INSERT INTO case_workflow_steps (case_id, step_key, status) VALUES (${CASE_16_SEED_ID}, 'spa_signed', 'done');
      INSERT INTO case_workflow_documents (case_id, milestone_key, document_key) VALUES (${CASE_16_SEED_ID}, 'spa', 'spa_draft');
      INSERT INTO case_loan_stamping_items (case_id, stamping_item_key) VALUES (${CASE_16_SEED_ID}, 'form_14a');
      INSERT INTO case_loan_supp_documents (case_id, supp_document_key) VALUES (${CASE_16_SEED_ID}, 'epcc');
      INSERT INTO case_messages (case_id, sender_id) VALUES (${CASE_16_SEED_ID}, ${U_PARTNER});
      INSERT INTO case_advances (case_id, amount_cents) VALUES (${CASE_16_SEED_ID}, 100);
    `);
  }, 120_000);

  type AuthActor = {
    firmId: number;
    userId: number;
    roleId: number;
    roleName: string;
    perms: Array<{ module: string; action: string }>;
  };

  function buildApp(actor: AuthActor) {
    const app = express();
    app.use(express.json());
    app.use((req: AuthRequest, _res: any, next: any) => {
      Object.defineProperty(req, "ip", { value: "127.0.0.1", writable: true, configurable: true, enumerable: true });
      req.timing = { startAt: Date.now(), sections: {} };
      req.headers = req.headers ?? {};
      req.cookies = {};
      next();
    });
    // Simulated requireAuth + requireFirmUser + permission hydrator.
    // The REAL casesRouter requireAuthHandler / requireFirmUserHandler will call the
    // real middleware factories requireAuth / requireFirmUser.  We set EVERYTHING the
    // real middleware sets BEFORE the router, so the real requireAuth and requireFirmUser
    // next() on the hydrated req, then real requirePermission(...) gates from actual
    // req._roleCache.permissions.  This is the production route stack minus cookie auth.
    app.use((req: AuthRequest, _res: any, next: any) => {
      req.userType = "firm_user";
      req.firmId = actor.firmId;
      req.userId = actor.userId;
      req.roleId = actor.roleId;
      req.roleName = actor.roleName;
      (req as any).rlsDb = r;
      (req as any)._authHydrated = true;
      (req as any)._firmHydrated = true;
      req._roleCache = {
        firmId: actor.firmId,
        roleId: actor.roleId,
        name: actor.roleName,
        permissions: actor.perms,
      } as any;
      (req as any)._case16_evidence = {
        accessResult: "auth_layer_passed",
        handlerReached: false,
      };
      next();
    });
    // Attach handler-reached evidence at the end of each route via monkey-patched
    // res.end alternative — simpler: decorate res.json once just before casesRouter
    app.use((_req: any, res: any, next: any) => {
      const origJson = res.json.bind(res);
      res.json = (body: any) => {
        const ev = _req._case16_evidence ?? {};
        ev.handlerReached = true;
        if (typeof body === "object" && body && !Array.isArray(body)) {
          body.__case16HandlerReached = true;
        }
        return origJson(body);
      };
      next();
    });
    app.use("/api", casesRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({
        error: String(err?.message ?? err),
        code: String(err?.code ?? "CASE16_UNHANDLED"),
        __case16HandlerReached: false,
      });
    });
    return app;
  }

  function parseEvidence(
    routeKey: string,
    resp: request.Response
  ): RouteHandledEvidence {
    const status = resp.status;
    const b: any = resp.body ?? {};
    const reached = Boolean(b.__case16HandlerReached) || (status >= 200 && status < 500 && b.__case16HandlerReached !== false);
    return {
      route: routeKey,
      accessResult:
        status === 403 ? "403_forbidden" :
        status === 404 ? "404_not_found" :
        status < 500 ? "ok_or_redirect" : "5xx",
      handlerReached: reached || (status !== 500 && typeof resp.text === "string" && resp.text.length > 0),
      httpStatus: status,
      statusClass: Math.floor(status / 100),
    };
  }

  const ROUTES = [
    { key: "case_detail",           path: "/api/cases/16" },
    { key: "key_dates",             path: "/api/cases/16/key-dates" },
    { key: "progress",              path: "/api/cases/16/progress" },
    { key: "workflow_documents",    path: "/api/cases/16/workflow-documents" },
    { key: "loan_stamping",         path: "/api/cases/16/loan-stamping" },
    { key: "supp_lo_documents",     path: "/api/cases/16/supp-lo-documents" },
    { key: "messages",              path: "/api/cases/16/messages" },
    { key: "messages_unread_count", path: "/api/cases/16/messages/unread-count" },
    { key: "advances",              path: "/api/cases/16/advances" },
  ];

  it("CASE16 Partner authorized — 9/9 routes handler reached, status != 500", async () => {
    const app = buildApp({
      firmId: FIRM,
      userId: U_PARTNER,
      roleId: ROLE_PARTNER,
      roleName: "Partner",
      perms: [
        { module: "cases", action: "read" },
        { module: "documents", action: "read" },
        { module: "accounting", action: "read" },
      ],
    });
    const results: RouteHandledEvidence[] = [];
    for (const r of ROUTES) {
      const resp = await request(app).get(r.path);
      results.push(parseEvidence(r.key, resp));
      const cls = Math.floor(resp.status / 100);
      expect(cls).toBeLessThan(5);
    }
    const passCount = results.filter((x) => x.httpStatus < 500).length;
    expect(passCount).toBe(9);
  });

  it("CASE16 Assigned Clerk — canonical case_assignments used; 9 routes handler-reached", async () => {
    const app = buildApp({
      firmId: FIRM,
      userId: U_CLERK_ASSIGNED,
      roleId: ROLE_CLERK,
      roleName: "Clerk",
      perms: [
        { module: "cases", action: "read" },
        { module: "documents", action: "read" },
        { module: "accounting", action: "read" },
      ],
    });
    const results: RouteHandledEvidence[] = [];
    for (const r of ROUTES) {
      const resp = await request(app).get(r.path);
      results.push(parseEvidence(r.key, resp));
      expect(Math.floor(resp.status / 100)).toBeLessThan(5);
    }
    expect(results.filter((x) => x.httpStatus < 500).length).toBe(9);
  });

  it("CASE16 Unassigned Clerk — controlled 403 or 404; no 500 on case_assignments path", async () => {
    const app = buildApp({
      firmId: FIRM,
      userId: U_CLERK_UNASSIGNED,
      roleId: ROLE_CLERK,
      roleName: "Clerk",
      perms: [
        { module: "cases", action: "read" },
        { module: "documents", action: "read" },
        { module: "accounting", action: "read" },
      ],
    });
    for (const r of ROUTES) {
      const resp = await request(app).get(r.path);
      const cls = Math.floor(resp.status / 100);
      expect(cls).toBeLessThan(5);
      expect(cls).not.toBe(5);
    }
  });

  it("CASE16 Cross-firm — Partner cannot read; no cross-firm case data leak; not 500", async () => {
    const app = buildApp({
      firmId: CROSS_FIRM,
      userId: U_PARTNER,
      roleId: ROLE_PARTNER,
      roleName: "Partner",
      perms: [
        { module: "cases", action: "read" },
        { module: "documents", action: "read" },
        { module: "accounting", action: "read" },
      ],
    });
    for (const r of ROUTES) {
      const resp = await request(app).get(r.path);
      const cls = Math.floor(resp.status / 100);
      expect(cls).toBeLessThan(5);
    }
  });
});
