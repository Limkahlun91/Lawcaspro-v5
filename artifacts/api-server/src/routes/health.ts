import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
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
  try {
    const tables = [
      "case_key_dates",
      "case_workflow_steps",
      "case_billing_entries",
      "case_communications",
    ] as const;

    const results: Record<string, { exists: boolean; columns?: string[] }> = {};
    for (const t of tables) {
      const [{ reg }] = await pool.query<{ reg: string | null }>(
        "SELECT to_regclass($1) AS reg",
        [`public.${t}`],
      ).then((r) => r.rows);

      if (!reg) {
        results[t] = { exists: false };
        continue;
      }

      const cols = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
        [t],
      );
      results[t] = { exists: true, columns: cols.rows.map((c) => c.column_name) };
    }

    res.json({ status: "ok", schema: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Schema check failed";
    res.status(500).json({ status: "error", schema: "error", error: message });
  }
});

export default router;
