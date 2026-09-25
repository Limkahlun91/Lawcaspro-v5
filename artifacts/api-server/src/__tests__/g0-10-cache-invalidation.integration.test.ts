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

  async function getEffectiveEnabled(appArg: express.Application, cookie: string, key: string): Promise<boolean | null> {
    const r = await request(appArg).get("/api/users/_self/effective-features").set("Cookie", cookie);
    if (r.status !== 200) return null;
    const body = r.body as any;
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

  it("Block 1: Locked A→H flow. Founder PATCH cases.create ON→OFF → immediate OFF, OFF→ON → immediate ON, F5 + logout/login + Firm B untouched. NO timers.", async () => {
    vi.mocked(setFirmEntitlementsCacheDirty).mockClear();
    vi.mocked(invalidateAllUserFeatureCachesForFirm).mockClear();

    const S1 = newFirmASessionCookie();
    const SB = newFirmBSessionCookie();

    // A. BASELINE ON
    const stepAVal = await getEffectiveEnabled(app, S1, FEATURE_KEY);
    expect(stepAVal).toBe(true);

    const bBaseline = await getEffectiveEnabled(app, SB, FEATURE_KEY);
    expect(bBaseline).toBe(true);

    const F0 = newFounderSessionCookie();
    await pg.exec(`DELETE FROM firm_entitlement_overrides WHERE firm_id = ${FIRM_A_ID} AND feature_key = '${FEATURE_KEY}';`);

    // B. Founder PATCH /founder/firms/... mode=disabled
    const stepB = await request(app)
      .patch(`/api/founder/firms/${FIRM_A_ID}/features/${FEATURE_KEY}`)
      .set("Cookie", F0)
      .send({ mode: "disabled" });
    expect(stepB.status).toBeGreaterThanOrEqual(200);
    expect(stepB.status).toBeLessThan(300);
    expect((stepB.body as any).effectiveEnabled).toBe(false);

    // Invalidation checks for Firm A recorded (Firm B NOT in call list)
    const setDirtyCallsAfterToggleOff = vi.mocked(setFirmEntitlementsCacheDirty).mock.calls;
    const invalidateCallsAfterToggleOff = vi.mocked(invalidateAllUserFeatureCachesForFirm).mock.calls;
    expect(setDirtyCallsAfterToggleOff.some(([id]) => id === FIRM_A_ID)).toBe(true);
    expect(invalidateCallsAfterToggleOff.some(([id]) => id === FIRM_A_ID)).toBe(true);

    // C. IMMEDIATE NEXT GET (no timer) → OFF
    const stepCVal = await getEffectiveEnabled(app, S1, FEATURE_KEY);
    expect(stepCVal).toBe(false);

    // D. Founder PATCH SAME FEATURE AGAIN mode=enabled
    const stepD = await request(app)
      .patch(`/api/founder/firms/${FIRM_A_ID}/features/${FEATURE_KEY}`)
      .set("Cookie", F0)
      .send({ mode: "enabled" });
    expect(stepD.status).toBeGreaterThanOrEqual(200);
    expect(stepD.status).toBeLessThan(300);
    expect((stepD.body as any).effectiveEnabled).toBe(true);

    // E. IMMEDIATE NEXT GET (no timer) → ON (critical direction OFF→ON immediate)
    const stepEVal = await getEffectiveEnabled(app, S1, FEATURE_KEY);
    expect(stepEVal).toBe(true);

    // F. F5 (same session S1, fresh supertest call) → still ON
    const stepFVal = await getEffectiveEnabled(app, S1, FEATURE_KEY);
    expect(stepFVal).toBe(true);

    // G. Logout/S1 invalidated → new session S2 login → still ON
    for (const t of authMocks.sessionStore.keys()) {
      const raw = S1.replace("auth_token=", "");
      if (t === raw) { authMocks.sessionStore.delete(t); break; }
    }
    const S2 = newFirmASessionCookie();
    const stepGVal = await getEffectiveEnabled(app, S2, FEATURE_KEY);
    expect(stepGVal).toBe(true);

    // H. Tenant isolation: Firm B still ON, 0 invalidation calls for B all sequence
    const bFinal = await getEffectiveEnabled(app, SB, FEATURE_KEY);
    expect(bFinal).toBe(true);
    const totalDirtyCalls = vi.mocked(setFirmEntitlementsCacheDirty).mock.calls;
    const totalInvCalls = vi.mocked(invalidateAllUserFeatureCachesForFirm).mock.calls;
    expect(totalDirtyCalls.some(([id]) => id === FIRM_B_ID)).toBe(false);
    expect(totalInvCalls.some(([id]) => id === FIRM_B_ID)).toBe(false);
  }, 180000);

  it("Block 2a: Founder route regression. Repeated PATCH disabled→enabled→disabled→enabled. No 500/409. Each toggle returns correct enabled.", async () => {
    const F0 = newFounderSessionCookie();
    const SA = newFirmASessionCookie();
    await pg.exec(`DELETE FROM firm_entitlement_overrides WHERE firm_id = ${FIRM_A_ID} AND feature_key = '${FEATURE_KEY}';`);
    vi.mocked(setFirmEntitlementsCacheDirty).mockClear();
    vi.mocked(invalidateAllUserFeatureCachesForFirm).mockClear();

    const sequence: Array<"disabled" | "enabled"> = ["disabled", "enabled", "disabled", "enabled"];
    for (let i = 0; i < sequence.length; i++) {
      const mode = sequence[i];
      const r = await request(app)
        .patch(`/api/founder/firms/${FIRM_A_ID}/features/${FEATURE_KEY}`)
        .set("Cookie", F0)
        .send({ mode });
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(300);
      const expected = mode === "enabled";
      expect((r.body as any).effectiveEnabled).toBe(expected);
      // Immediate GET confirms value
      const v = await getEffectiveEnabled(app, SA, FEATURE_KEY);
      expect(v).toBe(expected);
    }
  }, 180000);

  it("Block 2b: Platform alias route regression. Repeated PATCH disabled→enabled→disabled→enabled. No 500/409. Each toggle returns correct enabled.", async () => {
    const F0 = newFounderSessionCookie();
    const SA = newFirmASessionCookie();
    await pg.exec(`DELETE FROM firm_entitlement_overrides WHERE firm_id = ${FIRM_A_ID} AND feature_key = '${FEATURE_KEY}';`);
    vi.mocked(setFirmEntitlementsCacheDirty).mockClear();
    vi.mocked(invalidateAllUserFeatureCachesForFirm).mockClear();

    const sequence: Array<"disabled" | "enabled"> = ["disabled", "enabled", "disabled", "enabled"];
    for (let i = 0; i < sequence.length; i++) {
      const mode = sequence[i];
      const r = await request(app)
        .patch(`/api/platform/firms/${FIRM_A_ID}/features/${FEATURE_KEY}`)
        .set("Cookie", F0)
        .send({ mode });
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(300);
      const expected = mode === "enabled";
      expect((r.body as any).effectiveEnabled).toBe(expected);
      const v = await getEffectiveEnabled(app, SA, FEATURE_KEY);
      expect(v).toBe(expected);
    }
  }, 180000);
});
