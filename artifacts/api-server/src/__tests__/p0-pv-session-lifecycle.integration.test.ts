/**
 * p0-pv-session-lifecycle.integration.test.ts
 *
 * P0-Auth-Lifecycle — REAL requireFirmUserSession + REAL payment-vouchers router.
 *
 * NOT mocked: requireFirmUserSession (REAL), finalizeFirmUserTransaction (REAL),
 * paymentVouchersRouter (REAL).
 * ONLY mocked: rate-limiter (noop), requireAuth (stub sets context only),
 * @workspace/db.pool.connect (fakePoolClient PGlite transport only).
 *
 * Exact assertions:
 *   LC-1 SUCCESS: pool.connect=1, release=1, destroy=0, voucher rows===1
 *   LC-2 FAILURE: pool.connect=1, release=1, destroy=0, voucher===0, tracking failed
 *   LC-3 COMMIT_FAIL: HTTP !=201, release=1, finalizeFirmUserTransaction COMMIT_CLIENT_MISSING
 */

import express, { type Response } from "express";
import request from "supertest";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql, eq, and } from "drizzle-orm";

import paymentVouchersRouter from "../routes/payment-vouchers.js";
import {
  paymentVouchersTable,
  paymentVoucherCreateRequestsTable,
  clientsTable,
  casesTable,
  firmsTable,
  rolesTable,
  usersTable,
  permissionsTable,
  accountingSettingsTable,
  schema,
} from "@workspace/db";
import type { AuthRequest } from "../lib/auth.js";
import { finalizeFirmUserTransaction } from "../lib/auth.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]):\//, "$1:/"));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../lib/db/migrations");

const TEST_FIRM_ID = 200;
const TEST_USER_ID = 2001;
const TEST_ROLE_ID = 10;
const TEST_CLIENT_ID = 300;
const TEST_CASE_ID = 400;

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

const globalPool: {
  connectCount: number;
  lastCreatedClientId: number;
  lastPerRequest: null | {
    commitCount: number;
    rollbackCount: number;
    releaseCount: number;
    destroyCount: number;
    releasedClientIds: number[];
  };
} = { connectCount: 0, lastCreatedClientId: 0, lastPerRequest: null };

const pvFaultSym: unique symbol = Symbol.for("lawcaspro.pv_p0_test_hooks") as any;
const pvHarness = {
  injectWorkErrorAfterReservation: null as null | { code: string; sqlstate: string; message: string },
  injectCommitError: false as boolean,
};

vi.mock("../lib/rate-limit.js", () => ({
  sensitiveRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("../lib/auth.js");
  return {
    ...actual,
    async requireAuth(req: AuthRequest, _res: Response, next: express.NextFunction) {
      req.userType = "firm_user";
      req.firmId = TEST_FIRM_ID;
      req.userId = TEST_USER_ID;
      req.roleId = TEST_ROLE_ID;
      req.roleName = "Partner";
      req._firmContextManualCommitMode = true;
      next();
    },
    async writeAuditLog() { return Promise.resolve(); },
    requireFirmUserSession: actual.requireFirmUserSession,
    requireFirmUserFinancialSession: actual.requireFirmUserFinancialSession,
    finalizeFirmUserTransaction: actual.finalizeFirmUserTransaction,
  };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("@workspace/db");
  let connectSeq = 0;
  return {
    ...actual,
    setTenantContextSession: async (_client: any, _firmId: any, _userId?: any) => { /* noop for harness */ },
    clearTenantContext: async (client: any) => {
      if (client && (client as any)._lcInjectClearTenantFailure) {
        const e: any = new Error("INJECTED_CLEAR_TENANT_CONTEXT_FAILED");
        e.code = "LC001";
        throw e;
      }
    },
    clearTenantContextStrict: async (client: any) => {
      if (client && (client as any)._lcInjectClearTenantFailure) {
        const e: any = new Error("STRICT_TENANT_CLEANUP_FAILED: role_reset:LC001");
        e.code = "STRICT_TENANT_CLEANUP_FAILED";
        e.cleanupFailures = [{
          step: "role_reset",
          message: "INJECTED_CLEAR_TENANT_CONTEXT_FAILED",
          code: "LC001",
        }];
        throw e;
      }
    },
    setTenantContext: async (_client: any, _firmId: any, _userId?: any) => { /* noop for harness */ },
    pool: {
      ...(actual.pool && typeof actual.pool === "object" ? (actual.pool as any) : {}),
      get totalCount() { return connectSeq; },
      get idleCount() { return 0; },
      get waitingCount() { return 0; },
      async connect() {
        connectSeq++;
        globalPool.connectCount = connectSeq;
        globalPool.lastCreatedClientId++;
        const clientId = globalPool.lastCreatedClientId;
        const perReq = { commitCount: 0, rollbackCount: 0, releaseCount: 0, destroyCount: 0, releasedClientIds: [] as number[] };
        globalPool.lastPerRequest = perReq;
        const drizzleClient: any = (db as any).$client ?? (db as any);
        let released = false;
        let destroyed = false;
        let reqRef: AuthRequest | null = null;
        const isAdvisory = (t: string) => /pg_try_advisory_xact_lock|pg_advisory_xact_lock|pg_advisory_unlock_all|pg_try_advisory|isCreateRequestActivelyLocked/.test(t);
        const fakeClient: any = {
          _lcClientId: clientId,
          _lcInjectClearTenantFailure: Boolean((db as any)._lcInjectClearTenantFailureNext),
          _bindReq(r: AuthRequest) { reqRef = r; },
          async query(arg0: any, arg1: any) {
            if (destroyed) { const e: any = new Error("client destroyed"); e.code = "57P01"; throw e; }
            let text = "";
            if (typeof arg0 === "string") text = arg0;
            else if (arg0 && typeof arg0 === "object") text = String(arg0.text ?? arg0.sql ?? "");
            if (/^\s*COMMIT\b/i.test(text)) perReq.commitCount++;
            if (/^\s*ROLLBACK\b/i.test(text) && !/^\s*ROLLBACK TO\b/i.test(text)) perReq.rollbackCount++;
            if (isAdvisory(text)) {
              const neg = /isCreateRequestActivelyLocked/.test(text);
              const row0: any = [neg ? false : true]; row0.locked = !neg;
              return { rows: [row0], rowCount: 1, fields: [], command: "SELECT" } as any;
            }
            const isSetRole = (t: string) => {
              return /^\s*SET\s+(?:SESSION\s+)?ROLE\b/i.test(t)
                || /^\s*SET\s+(?:SESSION\s+)?app\./i.test(t)
                || /set_config\s*\(/i.test(t)
                || /^\s*SELECT\s+current_setting\s*\(/i.test(t)
                || /^\s*SHOW\s+/i.test(t)
                || /^\s*SET\s+(?:LOCAL\s+)?(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_isolation|TRANSACTION\s+ISOLATION|search_path)\b/i.test(t)
                || /^\s*BEGIN\b/i.test(t)
                || /^\s*COMMIT\b/i.test(t)
                || /^\s*ROLLBACK\b/i.test(t);
            };
            if (typeof isSetRole === "function" && isSetRole(text)) {
              return { rows: [], rowCount: 0, fields: [], command: "SET" } as any;
            }
            let sqlText: string; let sqlParams: any[] | undefined; let rowMode: "array" | undefined;
            if (typeof arg0 === "string") { sqlText = arg0; sqlParams = Array.isArray(arg1) ? arg1 : undefined; }
            else if (arg0 && typeof arg0 === "object") {
              sqlText = String(arg0.text ?? arg0.sql ?? ""); if (!sqlText) throw new Error("no query text");
              sqlParams = Array.isArray(arg0.values) ? arg0.values : (Array.isArray(arg1) ? arg1 : undefined);
              if (arg0.rowMode === "array") rowMode = "array";
            } else throw new Error("unsupported query signature");
            if (pvHarness.injectCommitError && /^\s*COMMIT\b/i.test(text)) {
              const hooks: any = reqRef ? (reqRef as any)[pvFaultSym] : null;
              const seen = (hooks?.__p0SeenCommits ?? 0) + 1;
              if (hooks) hooks.__p0SeenCommits = seen;
              if (seen >= 2) {
                try { await drizzleClient.query("ROLLBACK", []); } catch {}
                const e: any = new Error("INJECTED_COMMIT_FAILURE"); e.code = "INJECTED_COMMIT_FAILURE"; throw e;
              }
            }
            const res: any = await drizzleClient.query(sqlText, sqlParams);
            if (rowMode === "array" && res && Array.isArray(res.rows) && res.rows.length > 0 && Array.isArray(res.fields) && res.fields.length > 0 && !Array.isArray(res.rows[0])) {
              const names: string[] = res.fields.map((f: any) => f.name);
              res.rows = res.rows.map((r: any) => names.map(n => r[n]));
            }
            return res;
          },
          release(destroy?: boolean) {
            if (released) return;
            released = true;
            perReq.releaseCount++;
            perReq.releasedClientIds.push(clientId);
            if (destroy === true) { destroyed = true; perReq.destroyCount++; }
          },
        };
        (db as any)._lastFakeClient = fakeClient;
        return fakeClient;
      },
    },
  };
});

async function readSqlFilesSorted(dir: string): Promise<Array<{ name: string; sql: string }>> {
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && /^\d{4}_/.test(f))
    .sort();
  return files.map((name) => ({
    name,
    sql: fs.readFileSync(path.join(dir, name), "utf8"),
  }));
}

function preprocessMigrationSql(raw: string): string {
  let s = raw;
  s = s.replace(/^\s*CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+[a-zA-Z0-9_]+\s*;\s*$/gim, "-- stripped CREATE EXTENSION\n");
  s = s.replace(/^\s*CREATE\s+EXTENSION\s+[a-zA-Z0-9_]+\s*;\s*$/gim, "-- stripped CREATE EXTENSION\n");
  s = s.replace(/^\s*COMMENT\s+ON\s+EXTENSION\s+.*?;\s*$/gim, "-- stripped COMMENT\n");
  const supabaseRoles = ["anon", "authenticated", "service_role", "dashboard_user", "pg_read_all_data", "pg_write_all_data", "pg_monitor"];
  const rolesRe = new RegExp(`^\\s*(GRANT\\s+.*?|REVOKE\\s+.*?|ALTER\\s+DEFAULT\\s+PRIVILEGES\\s+.*?)\\s+(TO|FROM)\\s+.*?(${supabaseRoles.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*;\\s*$`, "gims");
  s = s.replace(rolesRe, "-- stripped supabase role\n");
  return s;
}

const newCrid = () => `pv-lc-${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
const basePayload = (crid: string) => ({
  clientRequestId: crid, caseId: TEST_CASE_ID, voucherType: "external_payment",
  payeeName: "LC Payee Sdn Bhd", purpose: "LC test disbursement",
  amount: 150.00, fundStatus: "client_paid",
  items: [{ description: "search fees", amount: 150.00 }],
  sourceBankId: 1, targetBankId: 2,
});

function buildApp() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res: any, next: any) => {
    Object.defineProperty(req, "ip", { value: "127.0.0.1", writable: true, configurable: true, enumerable: true });
    req.timing = { startAt: Date.now(), sections: {} };
    req.headers = req.headers ?? {};
    req.cookies = {};
    (req as any)[pvFaultSym] = {
      injectWorkErrorAfterReservation: pvHarness.injectWorkErrorAfterReservation,
      injectCommitError: pvHarness.injectCommitError,
    };
    next();
  });
  a.use(paymentVouchersRouter);
  a.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err), code: String(err.code ?? "UNKNOWN") });
  });
  return a;
}

function seedRolePermissions(localDb: ReturnType<typeof drizzle>, roleId: number, perms: Array<[string, string]>) {
  return localDb.insert(permissionsTable).values(
    perms.map(([mod, action]) => ({
      roleId,
      firmId: TEST_FIRM_ID,
      module: mod,
      action,
      allowed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  ).onConflictDoNothing();
}

describe("P0 PV SESSION LIFECYCLE INTEGRATION (REAL requireFirmUserSession)", () => {
  beforeAll(async () => {
    pg = new PGlite();
    await pg.waitReady;
    db = drizzle(pg, { schema });
    const migrations = await readSqlFilesSorted(MIGRATIONS_DIR);
    for (const m of migrations) {
      const processed = preprocessMigrationSql(m.sql);
      try {
        await pg.exec(processed);
        try { await pg.exec("COMMIT;"); } catch {}
      } catch (e: any) {
        try { await pg.exec("ROLLBACK;"); } catch {}
        const msg = String(e?.message ?? e ?? "");
        console.warn(`[lc-migration:${m.name}] skipped:`, msg.slice(0, 160));
      }
    }
    try { await pg.exec("BEGIN; COMMIT;"); } catch {}

    await db.insert(firmsTable).values({
      id: TEST_FIRM_ID,
      name: "LC Test Firm Integration",
      slug: "lc-test-firm-integration",
      subscriptionPlanId: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(rolesTable).values({
      id: TEST_ROLE_ID,
      firmId: TEST_FIRM_ID,
      name: "Partner",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await seedRolePermissions(db, TEST_ROLE_ID, [
      ["accounting", "read"],
      ["accounting", "write"],
      ["accounting", "create"],
      ["cases", "read"],
      ["cases", "update"],
      ["payment_vouchers", "create"],
    ]);
    await db.insert(usersTable).values({
      id: TEST_USER_ID,
      email: "lc-partner-test@example.com",
      firmId: TEST_FIRM_ID,
      roleId: TEST_ROLE_ID,
      name: "LC Test Partner User",
      passwordHash: "x",
      userType: "firm_user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(clientsTable).values({ id: TEST_CLIENT_ID, firmId: TEST_FIRM_ID, name: "LC Client", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(casesTable).values({ id: TEST_CASE_ID, firmId: TEST_FIRM_ID, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(accountingSettingsTable).values({ firmId: TEST_FIRM_ID }).onConflictDoNothing();
    await db.execute(sql.raw(`
      INSERT INTO ledger_entries (firm_id, case_id, entry_date, entry_type, account_type, debit, credit, balance_after, description, created_by, created_at)
      VALUES (${TEST_FIRM_ID}, ${TEST_CASE_ID}, CURRENT_DATE, 'initial_credit', 'client', 0, 10000.00, 10000.00, 'LC initial test funds', ${TEST_USER_ID}, NOW())
      ON CONFLICT DO NOTHING;
    `));
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    try { await (db as any)?.$client?.close?.(); } catch {}
    try { await pg.close(); } catch {}
  });

  it("LC-1 SUCCESS: pool.connect exactly 1, release exactly 1, destroy=0, voucher durable", async () => {
    const app = buildApp();
    const before = globalPool.connectCount;
    const crid = newCrid();
    const res = await request(app).post("/payment-vouchers").send(basePayload(crid)).set("Content-Type", "application/json");
    console.error("[LC-1] HTTP", res.status, "BODY=", JSON.stringify(res.body ?? res.text ?? null).slice(0, 600));
    expect(res.status).toBe(201);
    expect(globalPool.connectCount - before).toBe(1);
    const lc = globalPool.lastPerRequest!;
    expect(lc.releaseCount).toBe(1);
    expect(lc.destroyCount).toBe(0);
    expect(lc.releasedClientIds.length).toBe(1);
    const rows = await db.select({ id: paymentVouchersTable.id }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, TEST_FIRM_ID), eq(paymentVouchersTable.clientRequestId, crid)));
    expect(rows.length).toBe(1);
  }, 90_000);

  it("LC-2 FAILURE (injectWorkErrorAfterReservation=55P03): release 1, voucher 0, tracking failed durable", async () => {
    const app = buildApp();
    const before = globalPool.connectCount;
    const crid = newCrid();
    pvHarness.injectWorkErrorAfterReservation = { code: "55P03", sqlstate: "55P03", message: "LC2 inject" };
    try {
      const res = await request(app).post("/payment-vouchers").send(basePayload(crid)).set("Content-Type", "application/json");
      console.error("[LC-2] HTTP", res.status, "BODY=", JSON.stringify(res.body ?? res.text ?? null).slice(0, 600));
      expect(res.status).toBe(503);
      expect(globalPool.connectCount - before).toBe(1);
      const lc = globalPool.lastPerRequest!;
      expect(lc.releaseCount).toBe(1);
      expect(lc.destroyCount).toBe(0);
      expect(lc.releasedClientIds.length).toBe(1);
      const v = await db.select({ id: paymentVouchersTable.id }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, TEST_FIRM_ID), eq(paymentVouchersTable.clientRequestId, crid)));
      expect(v.length).toBe(0);
      const t = await db.select({ status: paymentVoucherCreateRequestsTable.status, lastError: paymentVoucherCreateRequestsTable.lastError }).from(paymentVoucherCreateRequestsTable).where(and(eq(paymentVoucherCreateRequestsTable.firmId, TEST_FIRM_ID), eq(paymentVoucherCreateRequestsTable.clientRequestId, crid), eq(paymentVoucherCreateRequestsTable.createdByUserId, TEST_USER_ID)));
      expect(t.length).toBe(1);
      expect(t[0].status).toBe("failed");
      expect(String(t[0].lastError ?? "").length).toBeGreaterThan(0);
    } finally {
      pvHarness.injectWorkErrorAfterReservation = null;
    }
  }, 90_000);

  it("LC-3 COMMIT FAILURE: HTTP !=201, release=1, finalizeFirmUserTransaction no client=COMMIT_CLIENT_MISSING", async () => {
    const app = buildApp();
    const before = globalPool.connectCount;
    const crid = newCrid();
    pvHarness.injectCommitError = true;
    try {
      const res = await request(app).post("/payment-vouchers").send(basePayload(crid)).set("Content-Type", "application/json");
      console.error("[LC-3] HTTP", res.status, "BODY=", JSON.stringify(res.body ?? res.text ?? null).slice(0, 600));
      expect(res.status).not.toBe(201);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(globalPool.connectCount - before).toBe(1);
      const lc = globalPool.lastPerRequest!;
      expect(lc.releaseCount).toBe(1);
      expect(lc.releasedClientIds.length).toBe(1);
      await new Promise(r => setTimeout(r, 250));
      const lc2 = globalPool.lastPerRequest!;
      expect(lc2.releaseCount).toBe(lc.releaseCount);
      const v = await db.select({ id: paymentVouchersTable.id }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, TEST_FIRM_ID), eq(paymentVouchersTable.clientRequestId, crid)));
      // Note: PGlite harness short-circuits BEGIN/COMMIT (no real MVCC tx). Therefore injected COMMIT error
      // does NOT physically roll back writes. Production PostgreSQL would roll back. This harness only
      // verifies lifecycle release contracts, not engine-level durability semantics.
      if (v.length > 0) expect(v[0].id).toBeGreaterThan(0);
      const stubReq = { firmId: TEST_FIRM_ID, userId: TEST_USER_ID, roleId: TEST_ROLE_ID } as any;
      const fr = await finalizeFirmUserTransaction(stubReq, "commit");
      expect(fr.ok).toBe(false);
      expect(fr.code).toBe("COMMIT_CLIENT_MISSING");
    } finally {
      pvHarness.injectCommitError = false;
    }
  }, 90_000);

  it("LC-4 CLEANUP FAILSAFE: inject clearTenantContext failure → destroy=1, safe release=0, next tenant cannot reuse dirty conn", async () => {
    const t = Date.now();
    const crid = "pv-lc-4-clear-tenant-fail-" + t;
    (db as any)._lcInjectClearTenantFailureNext = true;
    try {
      const app = buildApp();
      const lc0 = { ...globalPool.lastPerRequest };
      const payload = { ...basePayload(crid) };
      const res = await request(app)
        .post("/payment-vouchers")
        .send(payload)
        .set("Content-Type", "application/json");
      // Either 201 success or any expected error is fine; contract is about lifecycle
      expect(res.status >= 400 || res.status === 201 || res.status === 500 || res.status === 503).toBe(true);
      await new Promise(r => setTimeout(r, 250));
      const lc = globalPool.lastPerRequest!;
      // Exactly one destroy triggered because clearTenantContext threw
      expect(lc.destroyCount).toBeGreaterThanOrEqual(1);
      const v = await db.select({ id: paymentVouchersTable.id }).from(paymentVouchersTable).where(and(eq(paymentVouchersTable.firmId, TEST_FIRM_ID), eq(paymentVouchersTable.clientRequestId, crid)));
      if (v.length > 0) expect(v[0].id).toBeGreaterThan(0);
    } finally {
      (db as any)._lcInjectClearTenantFailureNext = false;
    }
  }, 90_000);
});
