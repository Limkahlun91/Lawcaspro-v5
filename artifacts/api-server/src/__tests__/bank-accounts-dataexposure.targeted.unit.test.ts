import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// BANK-ACC-ROUTER-LEVEL — Real exported router tests
//
// Strategy:
//   1. Vi-mock EXTERNAL DEPENDENCIES ONLY (auth/perms/feature-resolver/db/
//      storage) so routes pass middleware and run the PRODUCTION handler code
//      (no synthetic /synthetic routes, no copied ternaries).
//   2. Import real router default export:
//          import firmSettingsRouter from "../routes/firm-settings.js";
//      mount at /api and exercise:
//          GET   /api/firm-settings
//          PATCH /api/firm-settings
//   3. Track firmBankAccountsTable select() invocations via counter so we can
//      PROVE disabled-path runs exactly 0 DB queries against the table.
//   4. Mutation guard tests live in part2b1-targeted-structural-rdb (kept).
// ---------------------------------------------------------------------------

// Runtime counters and toggles — reset fresh in beforeEach.
let firmBankTableSelectCount = 0;
let resolveFeatureCallCount = 0;
let lastRequestedFeatureKey: string | null = null;
let bankFeatureEffectiveEnabled: boolean = true;

// ---------------------------------------------------------------------------
// 1. Logger (imported transitively by lib/auth → lib/auth → routes/firm-settings)
// ---------------------------------------------------------------------------
vi.mock("../lib/logger.js", () => ({
  logger: {
    child: () => ({}),
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
  },
}));

// ---------------------------------------------------------------------------
// 2. Supabase storage (module instantiates `new SupabaseStorageService()`
//    during import — must be mocked before importing firm-settings).
// ---------------------------------------------------------------------------
vi.mock("../lib/objectStorage.js", () => ({
  SupabaseStorageService: class {},
  getSupabaseStorageConfigError: () => null,
  ObjectNotFoundError: class extends Error {},
}));

// ---------------------------------------------------------------------------
// 3. Auth middleware + writeAuditLog
//
//    Pass requireAuth + requireFirmUser transparently, attaching the same
//    shape of request context real auth middleware would:
//        req.userId = firm user id
//        req.userType = "firm_user"
//        req.firmId = 1
//        req.roleId = 2
//        req.log = noop logger
//    requirePermission is likewise passed (real RBAC tests are elsewhere).
// ---------------------------------------------------------------------------
vi.mock("../lib/auth.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...(real ?? {}),
    requireAuth: (_req: any, _res: any, next: any) => {
      _req.userId = 7;
      _req.userType = "firm_user";
      _req.firmId = 1;
      _req.roleId = 2;
      _req.user = { id: 7, type: "firm_user", firmId: 1, roleId: 2 };
      if (!_req.headers) _req.headers = {};
      _req.headers["user-agent"] = _req.headers["user-agent"] || "vitest-agent";
      _req.log = { info: () => {}, warn: () => {}, error: () => {} };
      next();
    },
    requireFirmUser: (_req: any, _res: any, next: any) => next(),
    requirePermission: (_mod: string, _act: string) =>
      (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async (..._a: any[]) => {},
  };
});

// ---------------------------------------------------------------------------
// 4. @workspace/db — fake DB layer whose SELECTs we can COUNT.
//
//    Must export: db (with select/execute/update/insert/delete),
//    firmsTable, firmBankAccountsTable, eq, and, sql.
// ---------------------------------------------------------------------------
vi.mock("@workspace/db", async (importOriginal) => {
  const real = (await importOriginal()) as any;

  return {
    ...(real ?? {}),

    // firms — rows returned by SELECT ... FROM firms.
    firmsTable: {
      id: "id" as any,
      name: "name" as any,
      logoUrl: "logoUrl" as any,
      showMasterDocuments: "showMasterDocuments" as any,
    },

    // firmBankAccountsTable — its select() bumps our counter only when the
    // PRODUCTION handler actually chooses to run it.
    firmBankAccountsTable: {
      firmId: "firmId" as any,
      id: "id" as any,
      bankName: "bankName" as any,
      accountNo: "accountNo" as any,
      accountType: "accountType" as any,
      isDefault: "isDefault" as any,
    },

    eq: (l: any, r: any) => `${String(l)} = ${String(r)}`,
    and: (...xs: any[]) => xs.join(" AND "),

    // Tagged template sql builder; the production code runs `execute` or
    // `.select().from(table).where()` against this connection.
    sql: (strings: TemplateStringsArray, ...vals: any[]) =>
      ({
        queryChunks: strings.map((s, i) =>
          i < vals.length ? `${s}${typeof vals[i] === "string" ? `'${vals[i]}'` : "?"}` : s,
        ),
      }) as any,

    // The shared db object used as default/fallback for `rdb(req) ?? db` when
    // req.rlsDb is undefined (we leave it undefined in this test; the
    // production helper rdb then falls back here for every query).
    db: {
      execute: async (query: any) => {
        const text: string = (query?.queryChunks ?? []).join(" ");
        // firm_settings table may not exist (42P01 code path); return empty
        // if table name isn't 'firms' to keep test simple.
        if (/FROM\s+firms/i.test(text) && /show_master_documents|logo_url|name|slug/i.test(text)) {
          return [
            {
              id: 1,
              name: "MockFirm Sdn Bhd",
              slug: "mockfirm",
              logo_url: "/objects/mock/logo.png",
              address: "1 Mock Street",
              st_number: "S001",
              tin_number: "T001",
              registration_no: "R001",
              sst_no: "SST-01",
              phone: "+60 1",
              email: "mock@firm.test",
              show_master_documents: true,
            },
          ];
        }
        return [];
      },
      select: () => ({
        from: (table: any) => ({
          where: () => {
            // Recognize the bank accounts table by a marker property.
            if (
              table &&
              typeof table === "object" &&
              "bankName" in table &&
              "accountNo" in table &&
              "firmId" in table
            ) {
              firmBankTableSelectCount += 1;
              return Promise.resolve([
                {
                  id: 42,
                  bankName: "MOCK HONG LEONG ISLAMIC",
                  accountNo: "1-2345-678901",
                  accountType: "office",
                  isDefault: true,
                  firmId: 1,
                },
                {
                  id: 43,
                  bankName: "MOCK CIMB CLIENT ACCOUNT",
                  accountNo: "2-2222-3333",
                  accountType: "client",
                  isDefault: false,
                  firmId: 1,
                },
              ]);
            }
            // firms lookup fallback
            if (
              table &&
              typeof table === "object" &&
              "showMasterDocuments" in table &&
              !("bankName" in table)
            ) {
              return Promise.resolve([
                { logoUrl: "/objects/mock/logo.png" } as any,
              ]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
      update: (_tbl: any) => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: 1 }]),
          }),
        }),
      }),
      insert: (_tbl: any) => ({
        values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }),
      }),
      delete: (_tbl: any) => ({ where: () => Promise.resolve([]) }),
    },
  };
});

// ---------------------------------------------------------------------------
// 5. user-feature-access service
//    - requireUserFeatureAccess = middleware passthrough (real entitlement
//      middleware tested in structural suite) — because GET/PATCH /firm-settings
//      is intentionally NOT blocked by it (it has other settings sections).
//    - resolveUserFeatureAccess = returns our toggled effectiveEnabled.
//    - resolveRequestFirmRoleName = returns a stable role name.
// ---------------------------------------------------------------------------
vi.mock("../services/user-feature-access.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...(real ?? {}),
    requireUserFeatureAccess: (_key: string) =>
      (_req: any, _res: any, next: any) => next(),
    resolveRequestFirmRoleName: async () => "partner",
    resolveUserFeatureAccess: async (params: any) => {
      resolveFeatureCallCount += 1;
      lastRequestedFeatureKey = params?.featureKey ?? null;
      return {
        featureKey: params?.featureKey,
        firmEnabled: bankFeatureEffectiveEnabled,
        userEnabled: bankFeatureEffectiveEnabled,
        effectiveEnabled: bankFeatureEffectiveEnabled,
        source: bankFeatureEffectiveEnabled ? "firm_toggle" : "firm_disabled",
        denialCode: bankFeatureEffectiveEnabled ? undefined : "FIRM_DISABLED",
      };
    },
  };
});

// ---------------------------------------------------------------------------
// 6. Now import the REAL router AFTER all vi.mocks are installed.
// ---------------------------------------------------------------------------
import firmSettingsRouter from "../routes/firm-settings.js";

// ---------------------------------------------------------------------------
// Build a minimal Express app that mounts it exactly at /api — no other
// middleware that could short-circuit, no synthetic routes.
// ---------------------------------------------------------------------------
function buildApp(): express.Express {
  const a = express();
  a.use(express.json());
  // Wrap the exported firmSettingsRouter layer handlers to catch rejections.
  (firmSettingsRouter as any).stack?.forEach?.((layer: any) => {
    layer.route?.stack?.forEach?.((rL: any) => {
      const handle = rL.handle;
      if (typeof handle === "function") {
        rL.handle = function wrappedHandler(req: any, res: any, next: any) {
          try {
            const result = (handle as any).apply(this, [req, res, next]);
            if (result && typeof result.catch === "function") {
              result.catch((err: any) => {
                console.error("HANDLER ASYNC ERROR:", layer.route?.path, err?.stack ?? String(err));
                if (!res.headersSent) {
                  res.status(500).json({ error: String(err?.message || err) });
                }
              });
            }
          } catch (err) {
            console.error("HANDLER SYNC ERROR:", layer.route?.path, String(err));
            if (!res.headersSent) {
              res.status(500).json({ error: String((err as any)?.message || err) });
            }
          }
        };
      }
    });
  });

  a.use("/api", firmSettingsRouter);

  // Catch-all error handler (4-arg).
  a.use((err: any, req: any, res: any, _next: any) => {
    console.error("EXPRESS ERROR:", err?.stack ?? String(err));
    if (!res.headersSent) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  return a;
}

describe("BANK-ACC-ROUTER-LEVEL (A,B,C,D) — real firmSettingsRouter at /api", () => {
  const app = buildApp();

  beforeEach(() => {
    firmBankTableSelectCount = 0;
    resolveFeatureCallCount = 0;
    lastRequestedFeatureKey = null;
  });

  // =================================================================
  // (A,B) — GET /api/firm-settings DISABLED path
  // =================================================================
  it("ROUTER-A (A): GET /api/firm-settings with accounting.bank_account disabled returns HTTP 200 with unrelated Firm Settings + bankAccounts=[]", async () => {
    bankFeatureEffectiveEnabled = false;
    const res = await request(app).get("/api/firm-settings");
    expect(res.status, "GET must succeed overall (other settings still work)").toBe(200);
    expect(res.body?.ok, "GET ok:true").toBe(true);
    // Unrelated firm settings sections still populated (firm name/logo/etc.)
    expect(res.body?.data?.name, "Firm name still returned when bank feature disabled").toBe("MockFirm Sdn Bhd");
    expect(res.body?.data?.slug, "Firm slug still returned").toBe("mockfirm");
    // Bank Accounts explicitly empty
    expect(Array.isArray(res.body?.data?.bankAccounts), "bankAccounts must always be array").toBe(true);
    expect(res.body?.data?.bankAccounts, "bankAccounts must be [] when disabled").toEqual([]);
    // The ONE feature key asked for must be canonical singular
    expect(lastRequestedFeatureKey).toBe("accounting.bank_account");
  });

  it("ROUTER-B (B): GET disabled path runs ZERO firmBankAccountsTable select() queries (NOT filtered post-hoc)", async () => {
    bankFeatureEffectiveEnabled = false;
    await request(app).get("/api/firm-settings");
    // Strong proof: the production conditional short-circuits and never
    // evaluates the .select().from(firmBankAccountsTable) IIFE branch.
    expect(firmBankTableSelectCount, "firmBankAccountsTable select count").toBe(0);
    // But feature resolver was definitely called — no silent bypass
    expect(resolveFeatureCallCount).toBeGreaterThan(0);
  });

  // =================================================================
  // (C) — GET /api/firm-settings ENABLED path
  // =================================================================
  it("ROUTER-C (C): GET /api/firm-settings with feature enabled queries firmBankAccountsTable and returns mocked bank account rows", async () => {
    bankFeatureEffectiveEnabled = true;
    const res = await request(app).get("/api/firm-settings");
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(firmBankTableSelectCount, "bank accounts query must run when enabled").toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body?.data?.bankAccounts)).toBe(true);
    expect(res.body?.data?.bankAccounts.length, "bank accounts returned").toBeGreaterThan(0);
    const first = res.body?.data?.bankAccounts?.[0];
    expect(first, "first bank account row returned").toBeDefined();
    expect(first?.bankName, "bank name exposed via standard mapper").toBe("MOCK HONG LEONG ISLAMIC");
    expect(first?.accountNo).toBe("1-2345-678901");
    expect(first?.accountType).toBe("office");
    expect(first?.isDefault).toBe(true);
    expect(typeof first?.id).toBe("number");
  });

  // =================================================================
  // (D1) — PATCH /api/firm-settings general update DISABLED path
  // =================================================================
  it("ROUTER-D1 (D): PATCH /api/firm-settings disabled => general update succeeds, bankAccounts=[], firmBankAccountsTable select count=0", async () => {
    bankFeatureEffectiveEnabled = false;
    const res = await request(app)
      .patch("/api/firm-settings")
      .send({ name: "Updated Mock Firm", address: "New Address 123", phone: "+60 12-345 6789" });
    expect(res.status, "PATCH must succeed overall (firm info update allowed)").toBe(200);
    expect(res.body?.ok).toBe(true);
    // Update response still returns the updated firm row
    expect(typeof res.body?.data?.name === "string", "firm name returned from update response").toBe(true);
    // Bank Accounts explicitly empty
    expect(Array.isArray(res.body?.data?.bankAccounts)).toBe(true);
    expect(res.body?.data?.bankAccounts).toEqual([]);
    // Query was NEVER issued
    expect(firmBankTableSelectCount).toBe(0);
  });

  // =================================================================
  // (D2) — PATCH /api/firm-settings general update ENABLED path
  // =================================================================
  it("ROUTER-D2 (D): PATCH /api/firm-settings with feature enabled runs the bank account query and returns mocked rows", async () => {
    bankFeatureEffectiveEnabled = true;
    const res = await request(app)
      .patch("/api/firm-settings")
      .send({ name: "Second Update" });
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(firmBankTableSelectCount, "bank accounts query must run in post-update response when enabled").toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body?.data?.bankAccounts)).toBe(true);
    expect(res.body?.data?.bankAccounts.length).toBeGreaterThan(0);
    const second = res.body?.data?.bankAccounts?.[1];
    expect(second?.bankName).toBe("MOCK CIMB CLIENT ACCOUNT");
    expect(second?.accountType).toBe("client");
  });
});
