import express, { type Router as ExpressRouter } from "express";
import { pool } from "@workspace/db";
import crypto from "crypto";
import { db, sql, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import { getDocxToPdfHealth } from "../services/document-generation/docx-to-pdf.js";

type ReqLike = IncomingMessage & {
  headers: IncomingHttpHeaders;
  path?: string;
  method?: string;
  query?: Record<string, unknown>;
};

type ResLike = ServerResponse & {
  locals?: Record<string, unknown>;
  status: (code: number) => ResLike;
  json: (body: unknown) => ResLike;
  setHeader: (name: string, value: number | string | readonly string[]) => ResLike;
};

type HandlerLike = (req: ReqLike, res: ResLike) => void | Promise<void>;

type RouterInternalLike = {
  get: (path: string, handler: HandlerLike) => RouterInternalLike;
};

const expressRouter = express.Router();
const routerInternal = expressRouter as unknown as RouterInternalLike;

const TIMING_ZERO = (() => {
  try {
    return crypto.createHash("sha256").update("", "utf8").digest();
  } catch {
      return Buffer.alloc(32, 0);
  }
})();

const sha256Digest = (s: string): Buffer => {
  try {
    return crypto.createHash("sha256").update(s, "utf8").digest();
  } catch {
    return TIMING_ZERO;
  }
};

const requireDebugToken = (req: ReqLike, res: ResLike): boolean => {
  const serverToken = process.env.API_DEBUG_TOKEN ?? "";
  if (!serverToken) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  const headerValRaw = req.headers?.["x-debug-token"];
  const headerVal = Array.isArray(headerValRaw) ? headerValRaw[0] ?? "" : typeof headerValRaw === "string" ? headerValRaw : "";
  const expectedDigest = sha256Digest(serverToken);
  const providedDigest = sha256Digest(headerVal);
  try {
    if (!crypto.timingSafeEqual(expectedDigest, providedDigest)) {
      res.status(404).json({ error: "Not found" });
      return false;
    }
  } catch {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
};

type HealthCheckResponseBody = { status: string };

const startedAtIso = new Date().toISOString();

const GENERIC_HEALTH_ERROR = { status: "error" as const, error: "Health check unavailable" };

const safeHealthError = (_err: unknown) => GENERIC_HEALTH_ERROR;

routerInternal.get("/health", (_req: ReqLike, res: ResLike) => {
  const data: HealthCheckResponseBody = { status: "ok" };
  res.setHeader("cache-control", "no-store, max-age=0");
  res.status(200).json(data);
});

routerInternal.get("/healthz", (_req: ReqLike, res: ResLike) => {
  const data: HealthCheckResponseBody = { status: "ok" };
  res.json(data);
});

routerInternal.get("/healthz/docx-pdf", async (_req: ReqLike, res: ResLike) => {
  res.setHeader("cache-control", "no-store, max-age=0");
  const h = await getDocxToPdfHealth();
  res.status(200).json(h);
});

routerInternal.get("/healthz/dbinfo", async (req: ReqLike, res: ResLike) => {
  if (!requireDebugToken(req, res)) return;

  const databaseUrl = process.env.DATABASE_URL ?? null;
  const isPostgresUrl = typeof databaseUrl === "string" && (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://"));
  const host = (() => {
    if (!isPostgresUrl) return null;
    try {
      return new URL(databaseUrl).hostname;
    } catch {
      return null;
    }
  })();
  const dbName = (() => {
    if (!isPostgresUrl) return null;
    try {
      const u = new URL(databaseUrl);
      const p = u.pathname?.replace(/^\//, "") ?? "";
      return p || null;
    } catch {
      return null;
    }
  })();
  const hostHash = host ? crypto.createHash("sha256").update(host).digest("hex").slice(0, 10) : null;
  const dbNameHash = dbName ? crypto.createHash("sha256").update(dbName).digest("hex").slice(0, 10) : null;
  let hostClass = "UNKNOWN";
  if (host && /pooler\.supabase\.com$/.test(host)) hostClass = "SUPABASE_POOLER";
  else if (host && /supabase\.com$/.test(host)) hostClass = "DIRECT_SUPABASE";
  else if (host && host.length > 4) hostClass = "OTHER";

  try {
    const r = await pool.query<{ db: string; user: string; project_ref: string | null }>(
      "select current_database() as db, current_user as user, current_setting('supabase.project_ref', true) as project_ref",
    );
    const row = r.rows?.[0] ?? null;
    res.json({
      status: "ok",
      hostClass,
      hostHash,
      dbNameHash,
      currentDatabase: row?.db ?? null,
      currentUser: row?.user ?? null,
      supabaseProjectRef: row?.project_ref ?? null,
    });
  } catch (err) {
    res.status(500).json(safeHealthError(err));
  }
});

routerInternal.get("/healthz/founder-exists", async (req: ReqLike, res: ResLike) => {
  if (!requireDebugToken(req, res)) return;

  const emailRaw = req.query?.email;
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  if (!email) {
    res.status(400).json({ error: "Missing email" });
    return;
  }
  try {
    const [u] = await db
      .select({ status: usersTable.status })
      .from(usersTable)
      .where(and(eq(usersTable.userType, "founder"), eq(sql`lower(trim(${usersTable.email}))`, email)))
      .limit(1);
    res.json({
      status: "ok",
      exists: Boolean(u),
      accountStatus: u?.status ?? null,
    });
  } catch (err) {
    res.status(500).json(safeHealthError(err));
  }
});

routerInternal.get("/healthz/founder-status", async (req: ReqLike, res: ResLike) => {
  if (!requireDebugToken(req, res)) return;

  let client: PoolClient | null = null;
  let destroyClient = false;
  try {
    client = await pool.connect();
    try {
      await client.query("SET ROLE app_user");
    } catch {
    }
    try {
      await client.query("SET app.is_founder = 'true'");
      await client.query("SET app.current_firm_id = '0'");
      await client.query("SET app.current_user_id = '0'");
    } catch {
    }

    const r = await client.query<{
      status: string;
    }>("select status from users where user_type = 'founder'");
    const rows = r.rows ?? [];
    const founderCount = rows.length;
    const activeFounderCount = rows.filter((f) => String(f.status ?? "") === "active").length;

    res.json({
      status: "ok",
      founderCount,
      activeFounderCount,
    });
  } catch (err) {
    destroyClient = true;
    res.status(500).json(safeHealthError(err));
  } finally {
    if (client) {
      try {
        await client.query("SET app.current_firm_id = '0'");
        await client.query("SET app.is_founder = 'false'");
        await client.query("SET app.current_user_id = '0'");
      } catch {
      }
      try {
        await client.query("RESET ROLE");
      } catch {
      }
      client.release(destroyClient);
    }
  }
});

routerInternal.get("/healthz/version", (_req: ReqLike, res: ResLike) => {
  const commit = (
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.COMMIT_SHA ??
    ""
  ).trim() || null;
  const buildTime = (process.env.BUILD_TIME ?? process.env.VERCEL_BUILD_TIME ?? "").trim() || null;
  const appVersion = (process.env.APP_VERSION ?? process.env.npm_package_version ?? "").trim() || null;
  const environment = (process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "").trim() || null;
  const deploymentId = (process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_DEPLOYMENT ?? "").trim() || null;
  const region = (process.env.VERCEL_REGION ?? "").trim() || null;
  const vercelUrl = (process.env.VERCEL_URL ?? "").trim() || null;
  const now = Date.now();
  const uptimeMs = now - Date.parse(startedAtIso);
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  res.json({
    status: "ok",
    commit,
    appVersion,
    environment,
    deploymentId,
    region,
    vercelUrl,
    buildTime,
    startedAt: startedAtIso,
    uptimeMs: Number.isFinite(uptimeMs) ? uptimeMs : null,
  });
});

routerInternal.get("/healthz/db", async (_req: ReqLike, res: ResLike) => {
  try {
    await pool.query("select 1 as ok");
    res.json({ status: "ok", db: "ok" });
  } catch {
    res.status(500).json({ status: "error", db: "error" });
    return;
  }
});

routerInternal.get("/healthz/rls-role", async (req: ReqLike, res: ResLike) => {
  if (!requireDebugToken(req, res)) return;

  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  let client: PoolClient | null = null;
  let destroyClient = false;
  try {
    client = await pool.connect();
    const base = await client.query<{
      role: string;
      bypass: boolean;
      superuser: boolean;
    }>("select current_user as role, rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = current_user");
    const row = base.rows[0] ?? null;

    let canSetRoleAppUser = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      canSetRoleAppUser = true;
      await client.query("ROLLBACK");
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
    }

    const role = row?.role ?? "unknown";
    const bypassRls = Boolean(row?.bypass);
    const superuser = Boolean(row?.superuser);
    const ok = !bypassRls && !superuser;
    res.status(200).json(
      ok
        ? { ok: true, role, bypassRls, superuser, canSetRoleAppUser }
        : {
            ok: false,
            role,
            bypassRls,
            superuser,
            canSetRoleAppUser,
            error: "DATABASE_URL is not safe for firm-scoped RLS requests",
          },
    );
  } catch (err) {
    destroyClient = true;
    res.status(500).json({ ok: false, ...safeHealthError(err) });
  } finally {
    if (client) {
      try {
        await client.query("RESET ROLE");
      } catch {
      }
      client.release(destroyClient);
    }
  }
});

routerInternal.get("/healthz/schema", async (req: ReqLike, res: ResLike) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!requireDebugToken(req, res)) return;

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '3000ms'");

    const existsRow = await client.query<{
      case_key_dates: boolean;
      case_workflow_steps: boolean;
      case_billing_entries: boolean;
      case_communications: boolean;
    }>(`
      SELECT
        to_regclass('public.case_key_dates') IS NOT NULL AS case_key_dates,
        to_regclass('public.case_workflow_steps') IS NOT NULL AS case_workflow_steps,
        to_regclass('public.case_billing_entries') IS NOT NULL AS case_billing_entries,
        to_regclass('public.case_communications') IS NOT NULL AS case_communications
    `);

    const exists = existsRow.rows[0] ?? {
      case_key_dates: false,
      case_workflow_steps: false,
      case_billing_entries: false,
      case_communications: false,
    };

    const results: Record<string, { exists: boolean; selectOk?: boolean }> = {};
    for (const [name, isPresent] of Object.entries(exists)) {
      results[name] = { exists: Boolean(isPresent) };
    }

    const trySelect = async (table: string) => {
      try {
        await client!.query(`SELECT 1 FROM public.${table} LIMIT 1`);
        results[table].selectOk = true;
      } catch {
        results[table].selectOk = false;
      }
    };

    if (exists.case_key_dates) await trySelect("case_key_dates");
    if (exists.case_workflow_steps) await trySelect("case_workflow_steps");
    if (exists.case_billing_entries) await trySelect("case_billing_entries");
    if (exists.case_communications) await trySelect("case_communications");

    await client.query("COMMIT");
    res.json({ status: "ok", schema: results });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {
      }
    }
    res.status(500).json({ status: "error", schema: "error", ...safeHealthError(err) });
  } finally {
    if (client) client.release();
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
