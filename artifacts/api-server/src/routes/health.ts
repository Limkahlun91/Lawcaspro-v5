import express, { type Router as ExpressRouter } from "express";
import { pool } from "@workspace/db";
import crypto from "crypto";
import { db, sql, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

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

const hash10 = (v: string): string => crypto.createHash("sha256").update(v).digest("hex").slice(0, 10);
const maskEmail = (email: string): string => {
  const [local, domain] = email.split("@", 2);
  if (!domain) return "***";
  const localMasked = local.length <= 2 ? `${local[0] ?? "*"}*` : `${local[0]}***${local[local.length - 1]}`;
  return `${localMasked}@${domain}`;
};

type HealthCheckResponseBody = { status: string };

routerInternal.get("/healthz", (_req: ReqLike, res: ResLike) => {
  const data: HealthCheckResponseBody = { status: "ok" };
  res.json(data);
});

routerInternal.get("/healthz/dbinfo", async (_req: ReqLike, res: ResLike) => {
  const databaseUrl = process.env.DATABASE_URL ?? null;
  const isPostgresUrl = typeof databaseUrl === "string" && (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://"));
  const sanitized = (() => {
    if (!isPostgresUrl) return null;
    try {
      const u = new URL(databaseUrl);
      u.username = "";
      u.password = "";
      return u.toString();
    } catch {
      return null;
    }
  })();
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

  try {
    const r = await pool.query<{ db: string; user: string; server: string; project_ref: string | null }>(
      "select current_database() as db, current_user as user, inet_server_addr()::text as server, current_setting('supabase.project_ref', true) as project_ref",
    );
    const row = r.rows?.[0] ?? null;
    res.json({
      status: "ok",
      isPostgresUrl,
      hostSuffix: host ? host.split(".").slice(-2).join(".") : null,
      hostHash,
      dbNameHash,
      currentDatabase: row?.db ?? null,
      currentUser: row?.user ?? null,
      serverAddr: row?.server ?? null,
      supabaseProjectRef: row?.project_ref ?? null,
      databaseUrlSanitized: sanitized,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "DB connection failed";
    res.status(500).json({ status: "error", error: message, isPostgresUrl, databaseUrlSanitized: sanitized });
  }
});

routerInternal.get("/healthz/founder-exists", async (req: ReqLike, res: ResLike) => {
  const emailRaw = req.query?.email;
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  if (!email) {
    res.status(400).json({ error: "Missing email" });
    return;
  }
  try {
    const [u] = await db
      .select({ id: usersTable.id, status: usersTable.status })
      .from(usersTable)
      .where(and(eq(usersTable.userType, "founder"), eq(sql`lower(trim(${usersTable.email}))`, email)))
      .limit(1);
    res.json({ status: "ok", exists: Boolean(u), userId: u?.id ?? null, userStatus: u?.status ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Query failed";
    res.status(500).json({ status: "error", error: message });
  }
});

routerInternal.get("/healthz/founder-status", async (_req: ReqLike, res: ResLike) => {
  const expectedEmail = "lun.6923@hotmail.com";
  const client = await pool.connect();
  let destroyClient = false;
  try {
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
      id: number;
      email: string;
      user_type: string;
      status: string;
    }>("select id, email, user_type, status from users where user_type = 'founder'");
    const founders = r.rows ?? [];

    const normalized = founders
      .map((f) => ({
        id: f.id,
        email: String(f.email ?? "").trim().toLowerCase(),
        userType: String((f as unknown as { user_type?: unknown }).user_type ?? "").trim().toLowerCase(),
        status: String(f.status ?? ""),
      }))
      .filter((f) => f.email.length > 0);

    const match = normalized.find((f) => f.email === expectedEmail) ?? null;
    const activeCount = normalized.filter((f) => f.status === "active").length;
    const founderCount = normalized.length;
    const first = normalized[0] ?? null;

    res.json({
      status: "ok",
      expectedFounderEmail: expectedEmail,
      expectedEmail,
      founderCount,
      activeFounderCount: activeCount,
      activeCount,
      expectedExists: Boolean(match),
      expectedActive: match?.status === "active",
      currentFounderEmail: match ? expectedEmail : null,
      currentFounderEmailMasked: match ? maskEmail(expectedEmail) : first ? maskEmail(first.email) : null,
      currentFounderEmailHash: match ? hash10(expectedEmail) : first ? hash10(first.email) : null,
    });
  } catch (err) {
    destroyClient = true;
    const message = err instanceof Error ? err.message : "Query failed";
    res.status(500).json({ status: "error", error: message });
  } finally {
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
});

routerInternal.get("/healthz/version", (_req: ReqLike, res: ResLike) => {
  const commit =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.COMMIT_SHA ??
    null;
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("pragma", "no-cache");
  res.setHeader("expires", "0");
  res.json({ status: "ok", commit });
});

routerInternal.get("/healthz/db", async (_req: ReqLike, res: ResLike) => {
  try {
    await pool.query("select 1 as ok");
    res.json({ status: "ok", db: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "DB connection failed";
    res.status(500).json({ status: "error", db: "error", error: message });
  }
});

routerInternal.get("/healthz/schema", async (_req: ReqLike, res: ResLike) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '3000ms'");

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

    const results: Record<string, { exists: boolean; selectOk?: boolean; selectError?: string }> = {};
    for (const [name, isPresent] of Object.entries(exists)) {
      results[name] = { exists: Boolean(isPresent) };
    }

    const trySelect = async (table: string) => {
      try {
        await client.query(`SELECT 1 FROM public.${table} LIMIT 1`);
        results[table].selectOk = true;
      } catch (err) {
        results[table].selectOk = false;
        results[table].selectError = err instanceof Error ? err.message : "Unknown error";
      }
    };

    if (exists.case_key_dates) await trySelect("case_key_dates");
    if (exists.case_workflow_steps) await trySelect("case_workflow_steps");
    if (exists.case_billing_entries) await trySelect("case_billing_entries");
    if (exists.case_communications) await trySelect("case_communications");

    res.json({ status: "ok", schema: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Schema check failed";
    res.status(500).json({ status: "error", schema: "error", error: message });
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
    }
    client.release();
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
