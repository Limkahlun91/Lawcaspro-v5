import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

async function queryRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

router.get("/reports/overview", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const casesByStatus = await queryRows(sql`
    SELECT status, COUNT(*) as count
    FROM cases WHERE firm_id = ${req.firmId!}
    GROUP BY status ORDER BY count DESC
  `);

  const casesByType = await queryRows(sql`
    SELECT purchase_mode, title_type, COUNT(*) as count
    FROM cases WHERE firm_id = ${req.firmId!}
    GROUP BY purchase_mode, title_type ORDER BY count DESC
  `);

  const casesByMonth = await queryRows(sql`
    SELECT TO_CHAR(created_at, 'YYYY-MM') as month, COUNT(*) as count
    FROM cases WHERE firm_id = ${req.firmId!}
    GROUP BY TO_CHAR(created_at, 'YYYY-MM')
    ORDER BY month ASC
    LIMIT 12
  `);

  const workflowCompletion = await queryRows(sql`
    SELECT
      c.id as case_id, c.reference_no,
      COUNT(ws.id) as total_steps,
      SUM(CASE WHEN ws.status = 'completed' THEN 1 ELSE 0 END) as completed_steps
    FROM cases c
    JOIN case_workflow_steps ws ON ws.case_id = c.id
    WHERE c.firm_id = ${req.firmId!}
    GROUP BY c.id, c.reference_no
    ORDER BY completed_steps::numeric / NULLIF(COUNT(ws.id), 0) ASC
    LIMIT 10
  `);

  const lawyerWorkload = await queryRows(sql`
    SELECT u.name, u.id as user_id, COUNT(DISTINCT ca.case_id) as case_count
    FROM case_assignments ca
    JOIN users u ON ca.user_id = u.id
    WHERE ca.unassigned_at IS NULL AND u.firm_id = ${req.firmId!}
    GROUP BY u.id, u.name
    ORDER BY case_count DESC
  `);

  const billingTotals = await queryRows(sql`
    SELECT
      SUM(amount * quantity) as total_billed,
      SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as total_paid,
      SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as total_outstanding,
      COUNT(DISTINCT case_id) as billed_cases
    FROM case_billing_entries
    WHERE firm_id = ${req.firmId!}
  `);

  const communicationStats = await queryRows(sql`
    SELECT type, direction, COUNT(*) as count
    FROM case_communications WHERE firm_id = ${req.firmId!}
    GROUP BY type, direction ORDER BY count DESC
  `);

  res.json({
    casesByStatus,
    casesByType,
    casesByMonth,
    workflowCompletion,
    lawyerWorkload,
    billingTotals: billingTotals[0] ?? { total_billed: 0, total_paid: 0, total_outstanding: 0, billed_cases: 0 },
    communicationStats,
  });
});

export default router;
