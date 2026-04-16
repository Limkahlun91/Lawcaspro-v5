import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
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
