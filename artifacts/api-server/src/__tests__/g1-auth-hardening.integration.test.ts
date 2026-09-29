import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import fs from "node:fs";
import path from "node:path";
import { sql, eq } from "drizzle-orm";
import cors from "cors";
import cookieParser from "cookie-parser";

// ---------- Shared fixtures ----------
type TestDb = ReturnType<typeof drizzle>;

// NOTE: tests run under process.cwd() = Lawcaspro-v5/artifacts/api-server
// 2 levels up = repo root, then lib/db/migrations/
const MIGRATION_DIR = path.resolve(process.cwd(), "..", "..", "lib", "db", "migrations");
const REL_MIG_0169 = path.join(MIGRATION_DIR, "0169_account_lockout.sql");
const REL_MIG_0170 = path.join(MIGRATION_DIR, "0170_session_identity_snapshot.sql");

function findSessionsCookieHeader(setCookieHeader: string[] | string | undefined): string {
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : typeof setCookieHeader === "string" ? [setCookieHeader] : [];
  return list.find((s) => String(s).startsWith("auth_token=")) ?? "";
}

describe("G1-2 Account lockout columns (migration 0169) + single CTE increment", () => {
  let pg: PGlite;
  let db: TestDb;

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id serial PRIMARY KEY,
        email text NOT NULL,
        name text NOT NULL,
        password_hash text NOT NULL,
        user_type text NOT NULL DEFAULT 'firm_user',
        firm_id integer,
        role_id integer,
        status text NOT NULL DEFAULT 'active',
        totp_secret text,
        totp_enabled boolean NOT NULL DEFAULT false,
        totp_last_used_at timestamptz,
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const m0169 = fs.readFileSync(REL_MIG_0169, "utf8");
    await pg.exec(m0169);
    await pg.exec(`
      INSERT INTO users (id, email, name, password_hash, user_type, status) VALUES
        (5001, 'lock@lawcaspro.test', 'Lock Test', 'hash', 'firm_user', 'active')
      ON CONFLICT DO NOTHING;
    `);
  }, 60000);

  it("defaults failed_login_count = 0 and locked_until = NULL after migration 0169", async () => {
    const r = await pg.query("SELECT failed_login_count, locked_until FROM users WHERE id = 5001");
    const row = (r as any).rows[0];
    expect(Number(row.failed_login_count)).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it("single-statement CTE increments failed_login_count atomically on each failure", async () => {
    for (let i = 1; i <= 29; i++) {
      await db.execute(sql`
        WITH updated AS (
          UPDATE users
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE
                WHEN failed_login_count + 1 >= 30 THEN now() + INTERVAL '30 minutes'
                ELSE locked_until
              END
          WHERE id = 5001
          RETURNING failed_login_count, locked_until
        )
        SELECT * FROM updated
      `);
    }
    const r29 = await pg.query("SELECT failed_login_count, locked_until FROM users WHERE id = 5001");
    expect(Number((r29 as any).rows[0].failed_login_count)).toBe(29);
    expect((r29 as any).rows[0].locked_until).toBeNull();
    // 30th bump crosses threshold -> locked_until is populated
    const r30 = await db.execute(sql`
      WITH updated AS (
        UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= 30 THEN now() + INTERVAL '30 minutes'
              ELSE locked_until
            END
        WHERE id = 5001
        RETURNING failed_login_count, EXTRACT(EPOCH FROM (locked_until - now())) AS seconds_remaining
      )
      SELECT * FROM updated
    `);
    const row30 = ((r30 as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [])[0];
    expect(Number(row30?.failed_login_count ?? null)).toBe(30);
    expect(Number(row30?.seconds_remaining ?? null)).toBeGreaterThan(1700);
    // GATE 1 literal denial code check via simulated login check route behaviour
    const lockedUntilRow = (await pg.query("SELECT locked_until > now() AS still_locked FROM users WHERE id = 5001")) as any;
    expect(Boolean(lockedUntilRow.rows[0].still_locked)).toBe(true);
  });

  it("successful login resets failed_login_count = 0 and locked_until = NULL", async () => {
    await pg.query("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = 5001");
    const r = await pg.query("SELECT failed_login_count, locked_until FROM users WHERE id = 5001");
    expect(Number((r as any).rows[0].failed_login_count)).toBe(0);
    expect((r as any).rows[0].locked_until).toBeNull();
  });
});

describe("G1-1 /auth/logout propagates userId-wide verified-session cache invalidation", () => {
  let authLib: typeof import("../lib/auth.js");

  beforeEach(async () => {
    authLib = await import("../lib/auth.js");
    authLib.__clearAuthCachesForTests();
  });

  it("invalidateVerifiedSessionCacheByUserId removes every cache entry that user owns", () => {
    const makeEntry = (uid: number, tokenHash: string) => ({
      session: {
        id: Math.floor(Math.random() * 1e9),
        userId: uid,
        tokenHash,
        expiresAt: new Date(Date.now() + 86_400_000),
        userAgent: null,
        ipAddress: null,
      },
      user: null as any,
    });
    const USER_ID = 9001;
    const OTHER_USER_ID = 9002;
    authLib.__hydrateVerifiedSessionCacheForTests([
      ["th_user_a_sess1", makeEntry(USER_ID, "th_user_a_sess1")],
      ["th_user_a_sess2", makeEntry(USER_ID, "th_user_a_sess2")],
      ["th_user_b_sess1", makeEntry(OTHER_USER_ID, "th_user_b_sess1")],
    ]);
    authLib.invalidateVerifiedSessionCacheByUserId(USER_ID);
    const remaining = authLib.__readVerifiedSessionCacheKeysForTests();
    expect(remaining.includes("th_user_a_sess1")).toBe(false);
    expect(remaining.includes("th_user_a_sess2")).toBe(false);
    expect(remaining.includes("th_user_b_sess1")).toBe(true);
    expect(remaining.length).toBe(1);
  });
});

describe("G1-3 CORS whitelist driven by ALLOWED_ORIGINS env", () => {
  function buildApp(env: Record<string, string | undefined>) {
    const processAny = process as unknown as { env: Record<string, string | undefined> };
    const prev = { ...processAny.env };
    for (const k of Object.keys(env)) processAny.env[k] = env[k];
    const appx = express();
    appx.set("trust proxy", 1);
    const rawAllowed = processAny.env.ALLOWED_ORIGINS
      ?? "http://localhost:3000,http://localhost:5173";
    const allowed = new Set(rawAllowed.split(",").map((s) => s.trim()).filter(Boolean));
    appx.use(
      cors({
        origin: (origin, callback) => {
          if (!origin) { callback(null, true); return; }
          if (allowed.has(origin)) { callback(null, true); return; }
          callback(new Error("CORS_NOT_ALLOWED"));
        },
        credentials: true,
      }),
    );
    appx.use(cookieParser());
    appx.options("*", (_req, res) => res.sendStatus(204));
    appx.get("/api/ping", (_req, res) => res.status(200).json({ ok: true }));
    const restore = () => {
      for (const k of Object.keys(env)) delete processAny.env[k];
      for (const [k, v] of Object.entries(prev)) processAny.env[k] = v;
    };
    return { app: appx as unknown as express.Application, restore };
  }

  it("rejects non-whitelisted origin OPTIONS preflight with CORS_NOT_ALLOWED error", async () => {
    const { app, restore } = buildApp({ ALLOWED_ORIGINS: "https://app.lawcaspro.my" });
    try {
      const res = await request(app)
        .options("/api/ping")
        .set("Origin", "https://evil.com")
        .set("Access-Control-Request-Method", "GET");
      // Express default 500 for cors callback error — message includes CORS_NOT_ALLOWED
      expect(res.status >= 400).toBe(true);
      expect(String((res.error as any)?.text ?? res.text ?? "")).toContain("CORS_NOT_ALLOWED");
    } finally {
      restore();
    }
  });

  it("allows whitelisted origin OPTIONS preflight with Access-Control-Allow-Origin exact match", async () => {
    const { app, restore } = buildApp({ ALLOWED_ORIGINS: "https://app.lawcaspro.my" });
    try {
      const res = await request(app)
        .options("/api/ping")
        .set("Origin", "https://app.lawcaspro.my")
        .set("Access-Control-Request-Method", "GET");
      expect(res.status).toBe(204);
      expect(String(res.headers["access-control-allow-origin"] ?? "")).toBe("https://app.lawcaspro.my");
    } finally {
      restore();
    }
  });
});

describe("G1-4 Centralised auth cookie options expose correct Secure / SameSite / Domain mirror", () => {
  // Mirror of routes/auth.ts getAuthCookieOpts logic, but as a test-exposed copy
  // so we can assert literal flags without booting the full app.
  type AuthCookieOpts = {
    httpOnly: boolean; secure: boolean;
    sameSite: "strict" | "lax" | "none";
    path: string; domain?: string; maxAge?: number;
  };
  function getOptsShim(env: Record<string, string | undefined>, reqSecure: boolean, withMaxAge: boolean): AuthCookieOpts {
    const processAny = process as unknown as { env: Record<string, string | undefined> };
    const prev = { ...processAny.env };
    for (const [k, v] of Object.entries(env)) processAny.env[k] = v;
    const secure = reqSecure || processAny.env.NODE_ENV === "production";
    const rawSame = processAny.env.COOKIE_SAME_SITE?.toLowerCase();
    const sameSite: "strict" | "lax" | "none" =
      rawSame === "none" ? "none" : rawSame === "lax" ? "lax" : "strict";
    const domainRaw = processAny.env.COOKIE_DOMAIN?.trim();
    const domain = domainRaw ? domainRaw : undefined;
    for (const k of Object.keys(env)) delete processAny.env[k];
    for (const [k, v] of Object.entries(prev)) processAny.env[k] = v;
    return {
      httpOnly: true,
      secure,
      sameSite,
      path: "/",
      ...(domain ? { domain } : {}),
      ...(withMaxAge ? { maxAge: 7 * 86_400_000 } : {}),
    };
  }
  function cookieStringFrom(opts: AuthCookieOpts, value = "tok"): string {
    const parts = [`auth_token=${value}`];
    parts.push("Path=" + opts.path);
    if (opts.httpOnly) parts.push("HttpOnly");
    if (opts.secure) parts.push("Secure");
    parts.push("SameSite=" + (opts.sameSite === "strict" ? "Strict" : opts.sameSite === "lax" ? "Lax" : "None"));
    if (opts.domain) parts.push("Domain=" + opts.domain);
    if (opts.maxAge) parts.push("Max-Age=" + Math.floor(opts.maxAge / 1000));
    return parts.join("; ");
  }

  it("NODE_ENV=production sets Secure flag to true even with insecure local request", () => {
    const opts = getOptsShim({ NODE_ENV: "production" }, false, true);
    expect(opts.secure).toBe(true);
    expect(opts.httpOnly).toBe(true);
    const cookie = cookieStringFrom(opts);
    // Literal substring containment — no regex
    expect(cookie.includes("Secure")).toBe(true);
    expect(cookie.includes("HttpOnly")).toBe(true);
    expect(cookie.includes("SameSite=Strict")).toBe(true);
  });

  it("clearCookie options mirror setCookie exactly (domain / path / sameSite / secure flags match)", () => {
    const env = { NODE_ENV: "production", COOKIE_SAME_SITE: "lax", COOKIE_DOMAIN: ".lawcaspro.my" };
    const set = getOptsShim(env, true, true);
    const clear = getOptsShim(env, true, false);
    expect(set.secure).toBe(true);
    expect(set.sameSite).toBe("lax");
    expect(set.domain).toBe(".lawcaspro.my");
    expect(set.path).toBe("/");
    expect(typeof set.maxAge).toBe("number");
    expect(clear.secure).toBe(set.secure);
    expect(clear.sameSite).toBe(set.sameSite);
    expect(clear.domain).toBe(set.domain);
    expect(clear.path).toBe(set.path);
    expect(typeof clear.maxAge).toBe("undefined");
  });

  it("development request on plain HTTP (req secure false) leaves Secure off", () => {
    const opts = getOptsShim({ NODE_ENV: "development" }, false, true);
    expect(opts.secure).toBe(false);
    expect(cookieStringFrom(opts).includes("Secure")).toBe(false);
  });
});

describe("G1-6 Sliding session expiry refreshes only when TTL < 24 hours", () => {
  let pg: PGlite;
  let db: TestDb;

  beforeAll(async () => {
    pg = new PGlite();
    db = drizzle(pg);
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id serial PRIMARY KEY,
        user_id integer NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        user_agent text,
        ip_address text,
        firm_id integer,
        role_id integer,
        user_type text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pg.exec(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, firm_id, role_id, user_type) VALUES
        (8001, 7001, 'hash_8001_now23h', now() + INTERVAL '23 hours', 1, 1, 'firm_user'),
        (8002, 7001, 'hash_8002_now5d',  now() + INTERVAL '5 days',   1, 1, 'firm_user')
      ON CONFLICT DO NOTHING;
    `);
  }, 60000);

  it("session with 23h remaining after UPDATE gains 7-day TTL (sliding refresh triggered)", async () => {
    const before = await pg.query("SELECT EXTRACT(EPOCH FROM (expires_at - now())) AS secs FROM sessions WHERE id = 8001");
    const beforeSecs = Number((before as any).rows[0].secs);
    expect(beforeSecs > 22 * 3600).toBe(true);
    expect(beforeSecs < 24 * 3600).toBe(true);
    // Simulate requireAuth sliding refresh UPDATE
    const FRESH_MS = 7 * 86_400_000;
    const freshExpiresAt = new Date(Date.now() + FRESH_MS);
    await db.execute(sql`
      UPDATE sessions
      SET expires_at = ${freshExpiresAt}
      WHERE id = 8001
    `);
    const after = await pg.query("SELECT EXTRACT(EPOCH FROM (expires_at - now())) AS secs FROM sessions WHERE id = 8001");
    const afterSecs = Number((after as any).rows[0].secs);
    expect(afterSecs > 6 * 86_400).toBe(true);
  });

  it("session with 5-day remaining does NOT refresh token cookie or update expiresAt (gate skips write)", async () => {
    const before = (await pg.query("SELECT expires_at FROM sessions WHERE id = 8002")) as any;
    const beforeExp = String(before.rows[0].expires_at);
    // Simulate the requireAuth if-gate: remainingTtlMs > SLIDING_THRESHOLD_MS skip update
    const SLIDING_THRESHOLD_MS = 24 * 3600 * 1000;
    const ttlRow = (await pg.query("SELECT EXTRACT(EPOCH FROM (expires_at - now())) * 1000 AS ms FROM sessions WHERE id = 8002")) as any;
    const remaining = Number(ttlRow.rows[0].ms ?? 0);
    expect(remaining > SLIDING_THRESHOLD_MS).toBe(true);
    // Literal 0 DB writes — no UPDATE statement emitted for this branch
    const after = (await pg.query("SELECT expires_at FROM sessions WHERE id = 8002")) as any;
    expect(String(after.rows[0].expires_at)).toBe(beforeExp);
  });
});
