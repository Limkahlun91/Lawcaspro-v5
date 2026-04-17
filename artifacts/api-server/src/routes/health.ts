import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import crypto from "crypto";
import { db, usersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/dbinfo", async (_req, res) => {
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
    const r = await pool.query<{ db: string; user: string; server: string }>(
      "select current_database() as db, current_user as user, inet_server_addr()::text as server",
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
      databaseUrlSanitized: sanitized,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "DB connection failed";
    res.status(500).json({ status: "error", error: message, isPostgresUrl, databaseUrlSanitized: sanitized });
  }
});

router.get("/healthz/founder-exists", async (req, res) => {
  const emailRaw = req.query.email;
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

router.get("/healthz/version", (_req, res) => {
  const commit =
    process.env.RENDER_GIT_COMMIT ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.COMMIT_SHA ??
    null;
  res.json({ status: "ok", commit });
});

router.get("/healthz/db", async (_req, res) => {
  try {
    await pool.query("select 1 as ok");
    res.json({ status: "ok", db: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "DB connection failed";
    res.status(500).json({ status: "error", db: "error", error: message });
  }
});

router.get("/healthz/schema", async (_req, res) => {
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

export default router;
