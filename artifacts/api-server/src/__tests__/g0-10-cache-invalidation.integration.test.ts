import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { AuthRequest } from "../lib/auth.js";
import { firmEntitlementOverridesTable } from "@workspace/db";
import { setFirmEntitlementsCacheDirty } from "../services/entitlement-resolver";
import { invalidateAllUserFeatureCachesForFirm } from "../services/user-feature-access";
import { applyEntitlementFoundationDdl, seedCanonicalFeatureRegistry } from "./pglite-bootstrap";

type TestDb = ReturnType<typeof drizzle>;

const authMocks = vi.hoisted(() => {
  const sessionStore = new Map<string, {
    firmId: number; userId: number; roleId: number; roleName: string;
    userType: "firm_user" | "founder";
    permissions: Array<{ module: string; action: string }>;
  }>();
  let tokenCounter = 1;
  return {
    sessionStore,
    issueToken(actor: (typeof sessionStore) extends Map<any, infer V> ? V : never) {
      const token = `sess_${tokenCounter++}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sessionStore.set(token, actor);
      return token;
    },
    testDbRef: null as TestDb | null,
  };
});

vi.mock("../lib/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
  return {
    ...actual,
    requireAuth: async (req: AuthRequest, _res: any, next: any) => {
      const cookie = String(req.headers.cookie ?? "");
      const m = cookie.match(/auth_token=([^;]+)/);
      const token = m ? m[1] : null;
      const actor = token ? authMocks.sessionStore.get(token) : null;
      if (!actor || !token) {
        _res.statusCode = 401; return _res.json({ ok: false, error: "NO_AUTH" });
      }
      req.userType = actor.userType;
      req.userId = actor.userId;
      req.firmId = actor.firmId;
      req.roleId = actor.roleId;
      req.roleName = actor.roleName;
      (req as any)._authHydrated = true;
      (req as any)._sessionToken = token;
      next();
    },
    requireFirmUser: async (req: AuthRequest, _res: any, next: any) => {
      const actor = authMocks.sessionStore.get((req as any)._sessionToken);
      if (!actor) { _res.statusCode = 401; return _res.json({ ok: false, error: "NO_FIRM_USER" }); }
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
    requireFounder: async (req: AuthRequest, _res: any, next: any) => {
      const actor = authMocks.sessionStore.get((req as any)._sessionToken);
      if (!actor || actor.userType !== "founder") {
        _res.statusCode = 403; return _res.json({ ok: false, error: "FORBIDDEN" });
      }
      (req as any)._founderHydrated = true;
      next();
    },
    requireFounderPermission: (_perm: any) => async (_req: AuthRequest, _res: any, next: any) => next(),
  };
});

vi.mock("../services/entitlement-resolver", async () => {
  const actual = await vi.importActual<typeof import("../services/entitlement-resolver")>("../services/entitlement-resolver");
  return {
    ...actual,
    setFirmEntitlementsCacheDirty: vi.fn(((...args: any[]) => (actual as any).setFirmEntitlementsCacheDirty(...args)) as any),
  };
});
vi.mock("../services/user-feature-access", async () => {
  const actual = await vi.importActual<typeof import("../services/user-feature-access")>("../services/user-feature-access");
  return {
    ...actual,
    invalidateAllUserFeatureCachesForFirm: vi.fn(((...args: any[]) => (actual as any).invalidateAllUserFeatureCachesForFirm(...args)) as any),
  };
});

vi.mock("@workspace/db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      return (authMocks as any).testDbRef ?? actual.db;
    },
  };
});

vi.mock("../lib/api-response", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-response")>("../lib/api-response");
  return {
    ...actual,
    sendError: (res: any, err: any) => {
      // eslint-disable-next-line no-console
      console.error("[G0.10 sendError debug]", err?.stack ?? err?.message ?? String(err));
      return (actual as any).sendError(res, err);
    },
  };
});

const FIRM_A_ID = 1001;
const FIRM_B_ID = 1002;
const FEATURE_KEY = "cases.create";

describe("G0.10 Locked flow + PATCH alias regression (REAL single-feature endpoints)", () => {
  let pg: PGlite;
  let db: TestDb;
  let app: express.Application;

  const PERMS_FULL: Array<{ module: string; action: string }> = [
    { module: "cases", action: "read" },
    { module: "accounting", action: "read" },
    { module: "accounting", action: "update" },
    { module: "entitlements", action: "read" },
    { module: "entitlements", action: "update" },
  ];

  function newFirmASessionCookie(): string {
    return "auth_token=" + authMocks.issueToken({
      userType: "firm_user", firmId: FIRM_A_ID, userId: 3001, roleId: 301,
      roleName: "Partner", permissions: PERMS_FULL,
    });
  }
  function newFirmBSessionCookie(): string {
    return "auth_token=" + authMocks.issueToken({
      userType: "firm_user", firmId: FIRM_B_ID, userId: 4001, roleId: 401,
      roleName: "Partner", permissions: PERMS_FULL,
    });
  }
  function newFounderSessionCookie(): string {
    return "auth_token=" + authMocks.issueToken({
      userType: "founder", firmId: 0, userId: 1, roleId: 1,
      roleName: "Founder", permissions: PERMS_FULL,
    });
  }
  // G0.10 HARD FIX — Browser-style agent builders that persist cookies across
  // requests (supertest.agent).  We explicitly POST to a login helper URL in
  // this test router so the agent jar acquires its cookie naturally, matching
  // the exact ON↔OFF↔ON + Logout/Login scenario from the user-supplied spec.
  async function loginAgentWithCookie(agent: any, cookieValue: string): Promise<void> {
    // Supertest agent treats "Set-Cookie: <name>=<value>" on any response as
    // jar-persistent.  Use a tiny temporary login endpoint on the test app.
    const loginPath = "/__g010_test/login";
    const logoutPath = "/__g010_test/logout";
    if (!((app as any)._g010_login_installed)) {
      (app as any).use(loginPath, express.json(), (req: any, res: any) => {
        const c = String((req.body && req.body.cookie) || "");
        if (c) res.setHeader("Set-Cookie", c + "; Path=/; HttpOnly");
        res.status(200).json({ ok: true });
      });
      (app as any).use(logoutPath, express.json(), (_req: any, res: any) => {
        res.setHeader("Set-Cookie", "auth_token=; Path=/; HttpOnly; Max-Age=0");
        res.status(200).json({ ok: true });
      });
      (app as any)._g010_login_installed = true;
    }
    await agent.post(loginPath).send({ cookie: cookieValue });
  }
  async function logoutAgent(agent: any): Promise<void> {
    await agent.post("/__g010_test/logout").send({});
  }

  async function getEffectiveEnabled(appArg: express.Application, cookie: string, key: string): Promise<boolean | null> {
    const r = await request(appArg).get("/api/users/_self/effective-features").set("Cookie", cookie);
    if (r.status !== 200) return null;
    const body = r.body as any;
    return body?.effective?.[key]?.effectiveEnabled ?? null;
  }
  // G0.10 HARD FIX — Same shape but using a persisted supertest agent.  Reads
  // the effective-features route from the provided agent (which carries its
  // own cookie jar) — proves that session-bound F5 refreshes / logout/login
  // sequences really work without manual cookie threading.
  async function getEffectiveEnabledAgent(agent: any, key: string): Promise<boolean | null> {
    const r = await agent.get("/api/users/_self/effective-features");
    if (r.status !== 200) return null;
    const body = r.body as any;
    // G0.10 HARD FIX — Mirror exactly `res.body.data['cases.create'].enabled` from
    // the user-supplied assertion shape.  The resolver returns:
    //   body.effective[key].effectiveEnabled  (canonical internal field)
    //   body.data[key].enabled                (user-asserted wire shape)
    // We compute both from the same bulk result so either accessor is valid;
    // prefer data-first (user spec), fallback to effective on old payloads.
    const direct = body?.data?.[key]?.enabled;
    if (typeof direct === "boolean") return direct;
    return body?.effective?.[key]?.effectiveEnabled ?? null;
  }

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    authMocks.testDbRef = db;

    await applyEntitlementFoundationDdl(pg);

    await pg.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
        id serial PRIMARY KEY,
        role_id integer NOT NULL,
        module text NOT NULL,
        action text NOT NULL,
        allowed boolean DEFAULT true,
        created_at timestamptz DEFAULT now()
      );
    `);

    await pg.exec(`
      INSERT INTO subscription_plans (id, name, slug, is_active) VALUES (1, 'Starter', 'starter', true) ON CONFLICT DO NOTHING;
      INSERT INTO firms (id, name, slug, status, subscription_plan_id, subscription_status) VALUES
        (${FIRM_A_ID}, 'Firm A', 'firm-a', 'active', 1, 'active') ON CONFLICT DO NOTHING;
      INSERT INTO firms (id, name, slug, status, subscription_plan_id, subscription_status) VALUES
        (${FIRM_B_ID}, 'Firm B', 'firm-b', 'active', 1, 'active') ON CONFLICT DO NOTHING;
      INSERT INTO roles (id, name, firm_id, permissions) VALUES
        (301, 'Partner', ${FIRM_A_ID}, '{}'::jsonb),
        (401, 'Partner', ${FIRM_B_ID}, '{}'::jsonb)
      ON CONFLICT DO NOTHING;
      INSERT INTO users (id, email, full_name, password_hash, user_type, firm_id, role_id, status) VALUES
        (3001, 'partner@firma.test', 'Partner A', 'hash', 'firm_user', ${FIRM_A_ID}, 301, 'active'),
        (4001, 'partner@firmb.test', 'Partner B', 'hash', 'firm_user', ${FIRM_B_ID}, 401, 'active')
      ON CONFLICT DO NOTHING;
      INSERT INTO permissions (role_id, module, action, allowed) VALUES
        (301, 'cases', 'read', true),
        (301, 'accounting', 'read', true),
        (301, 'accounting', 'update', true),
        (301, 'entitlements', 'read', true),
        (301, 'entitlements', 'update', true),
        (401, 'cases', 'read', true),
        (401, 'accounting', 'read', true),
        (401, 'entitlements', 'read', true),
        (401, 'entitlements', 'update', true)
      ON CONFLICT DO NOTHING;
    `);

    await seedCanonicalFeatureRegistry(pg);
    await pg.exec(`UPDATE firms SET subscription_plan_id = 1 WHERE id IN (${FIRM_A_ID}, ${FIRM_B_ID});`);

    app = express();
    app.use(express.json());
    const usersRouter = (await import("../routes/users")).default as any;
    const entitlementsRouter = (await import("../routes/entitlements")).default as any;
    app.use("/api", usersRouter);
    app.use("/api", entitlementsRouter);

    await db.delete(firmEntitlementOverridesTable);
  }, 60000);

  beforeEach(() => {
    vi.clearAllMocks();
    setFirmEntitlementsCacheDirty(FIRM_A_ID);
    setFirmEntitlementsCacheDirty(FIRM_B_ID);
    invalidateAllUserFeatureCachesForFirm(FIRM_A_ID);
    invalidateAllUserFeatureCachesForFirm(FIRM_B_ID);
  }, 120000);

  it("Block 1: Locked A→H flow via supertest.agent (persisted Cookie Jar). Founder PATCH cases.create ON→OFF → immediate OFF, OFF→ON → immediate ON, F5 + logout/login + Firm B untouched. NO timers.", async () => {
    vi.mocked(setFirmEntitlementsCacheDirty).mockClear();
    vi.mocked(invalidateAllUserFeatureCachesForFirm).mockClear();

    // G0.10 HARD FIX — real browser-style agents with automatic cookie jars.
    const staffAgent = request.agent(app);
    const firmBAgent = request.agent(app);
    const founderAgent = request.agent(app);
    await loginAgentWithCookie(staffAgent, newFirmASessionCookie());
    await loginAgentWithCookie(firmBAgent, newFirmBSessionCookie());
    await loginAgentWithCookie(founderAgent, newFounderSessionCookie());

    await pg.exec(`DELETE FROM firm_entitlement_overrides WHERE firm_id = ${FIRM_A_ID} AND feature_key = '${FEATURE_KEY}';`);

    // A. BASELINE ON (agent-driven, F5-style persisted session)
    const stepAVal = await getEffectiveEnabledAgent(staffAgent, FEATURE_KEY);
    expect(stepAVal).toBe(true);

    const bBaseline = await getEffectiveEnabledAgent(firmBAgent, FEATURE_KEY);
    expect(bBaseline).toBe(true);

    // B. Founder PATCH /founder/firms/... mode=disabled
    const stepB = await founderAgent
      .patch(`/api/founder/firms/${FIRM_A_ID}/features/${FEATURE_KEY}`)
      .send({ mode: "disabled" });
    expect(stepB.status).toBeGreaterThanOrEqual(200);
    expect(stepB.status).toBeLessThan(300);
    expect((stepB.body as any).effectiveEnabled).toBe(false);

    // Invalidation checks for Firm A recorded (Firm B NOT in call list)
    const setDirtyCallsAfterToggleOff = vi.mocked(setFirmEntitlementsCacheDirty).mock.calls;
    const invalidateCallsAfterToggleOff = vi.mocked(invalidateAllUserFeatureCachesForFirm).mock.calls;
    expect(setDirtyCallsAfterToggleOff.some(([id]) => id === FIRM_A_ID)).toBe(true);
    expect(invalidateCallsAfterToggleOff.some(([id]) => id === FIRM_A_ID)).toBe(true);

    // C. IMMEDIATE NEXT GET (no timer) via SAME staff agent → OFF
    const stepCVal = await getEffectiveEnabledAgent(staffAgent, FEATURE_KEY);
    expect(stepCVal).toBe(false);

    // D. Founder PATCH SAME FEATURE AGAIN mode=enabled
    const stepD = await founderAgent
      .patch(`/api/founder/firms/${FIRM_A_ID}/features/${FEATURE_KEY}`)
      .send({ mode: "enabled" });
    expect(stepD.status).toBeGreaterThanOrEqual(200);
    expect(stepD.status).toBeLessThan(300);
    expect((stepD.body as any).effectiveEnabled).toBe(true);

    // E. IMMEDIATE NEXT GET via SAME staff agent (no timer) → ON (critical OFF→ON immediate)
    const stepEVal = await getEffectiveEnabledAgent(staffAgent, FEATURE_KEY);
    expect(stepEVal).toBe(true);

    // F. F5 — another call on the SAME staff agent (jar still holds original session cookie) → still ON
    const stepFVal = await getEffectiveEnabledAgent(staffAgent, FEATURE_KEY);
    expect(stepFVal).toBe(true);

    // G. Logout (clears jar) → re-login with brand-new token → still ON
    await logoutAgent(staffAgent);
    await loginAgentWithCookie(staffAgent, newFirmASessionCookie());
    const stepGVal = await getEffectiveEnabledAgent(staffAgent, FEATURE_KEY);
    expect(stepGVal).toBe(true);

    // H. Tenant isolation: Firm B still ON, 0 invalidation calls for B all sequence
    const bFinal = await getEffectiveEnabledAgent(firmBAgent, FEATURE_KEY);
    expect(bFinal).toBe(true);
    const totalDirtyCalls = vi.mocked(setFirmEntitlementsCacheDirty).mock.calls;
    const totalInvCalls = vi.mocked(invalidateAllUserFeatureCachesForFirm).mock.calls;
    expect(totalDirtyCalls.some(([id]) => id === FIRM_B_ID)).toBe(false);
    expect(totalInvCalls.some(([id]) => id === FIRM_B_ID)).toBe(false);
  }, 180000);

  it("Block 2a: Founder route regression. Repeated PATCH disabled→enabled→disabled→enabled via agents. No 500/409. Each toggle returns correct enabled.", async () => {
    const staffAgent = request.agent(app);
    const founderAgent = request.agent(app);
    await loginAgentWithCookie(staffAgent, newFirmASessionCookie());
    await loginAgentWithCookie(founderAgent, newFounderSessionCookie());
    await pg.exec(`DELETE FROM firm_entitlement_overrides WHERE firm_id = ${FIRM_A_ID} AND feature_key = '${FEATURE_KEY}';`);
    vi.mocked(setFirmEntitlementsCacheDirty).mockClear();
    vi.mocked(invalidateAllUserFeatureCachesForFirm).mockClear();

    const sequence: Array<"disabled" | "enabled"> = ["disabled", "enabled", "disabled", "enabled"];
    for (let i = 0; i < sequence.length; i++) {
      const mode = sequence[i];
      const r = await founderAgent
        .patch(`/api/founder/firms/${FIRM_A_ID}/features/${FEATURE_KEY}`)
        .send({ mode });
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(300);
      const expected = mode === "enabled";
      expect((r.body as any).effectiveEnabled).toBe(expected);
      // Immediate GET confirms value
      const v = await getEffectiveEnabledAgent(staffAgent, FEATURE_KEY);
      expect(v).toBe(expected);
      // G0.10 FINAL RULE — permanent row atomicity: NO double permanent rows.
      //  After EACH toggle (insert first → then 3× update subsequent), DB
      //  permanent override count for (firm,feature) MUST remain ≤1.
      const cnt = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int n FROM firm_entitlement_overrides WHERE firm_id = $1 AND feature_key = $2 AND override_kind = 'permanent'`,
        [FIRM_A_ID, FEATURE_KEY],
      );
      expect(Number(cnt.rows[0].n)).toBeLessThanOrEqual(1);
    }
  }, 180000);

  it("Block 2b: Platform alias route regression. Repeated PATCH disabled→enabled→disabled→enabled via agents. No 500/409. Each toggle returns correct enabled.", async () => {
    const staffAgent = request.agent(app);
    const founderAgent = request.agent(app);
    await loginAgentWithCookie(staffAgent, newFirmASessionCookie());
    await loginAgentWithCookie(founderAgent, newFounderSessionCookie());
    await pg.exec(`DELETE FROM firm_entitlement_overrides WHERE firm_id = ${FIRM_A_ID} AND feature_key = '${FEATURE_KEY}';`);
    vi.mocked(setFirmEntitlementsCacheDirty).mockClear();
    vi.mocked(invalidateAllUserFeatureCachesForFirm).mockClear();

    const sequence: Array<"disabled" | "enabled"> = ["disabled", "enabled", "disabled", "enabled"];
    for (let i = 0; i < sequence.length; i++) {
      const mode = sequence[i];
      const r = await founderAgent
        .patch(`/api/platform/firms/${FIRM_A_ID}/features/${FEATURE_KEY}`)
        .send({ mode });
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(300);
      const expected = mode === "enabled";
      expect((r.body as any).effectiveEnabled).toBe(expected);
      const v = await getEffectiveEnabledAgent(staffAgent, FEATURE_KEY);
      expect(v).toBe(expected);
      // G0.10 FINAL RULE — alias route same atomicity guarantee as Lb Founder.
      const cnt = await pg.query<{ n: number }>(
        `SELECT COUNT(*)::int n FROM firm_entitlement_overrides WHERE firm_id = $1 AND feature_key = $2 AND override_kind = 'permanent'`,
        [FIRM_A_ID, FEATURE_KEY],
      );
      expect(Number(cnt.rows[0].n)).toBeLessThanOrEqual(1);
    }
  }, 180000);
});
