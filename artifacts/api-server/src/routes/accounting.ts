import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

type SqlChunk = ReturnType<typeof sql>;

const router: IRouter = Router();

async function queryRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

const CATEGORIES = ["legal_fee", "disbursement", "stamp_duty", "professional_fee", "other"] as const;

router.get("/accounting", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const rows = await queryRows(sql`
    SELECT be.id, be.case_id, be.description, be.amount, be.quantity,
      be.is_paid as "isPaid", be.created_at as "billedAt",
      c.reference_no as "caseReferenceNo"
    FROM case_billing_entries be
    LEFT JOIN cases c ON be.case_id = c.id
    WHERE be.firm_id = ${req.firmId!}
    ORDER BY be.created_at DESC
    LIMIT 100
  `);
  res.json(rows);
});

router.get("/cases/:caseId/billing", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const rows = await queryRows(sql`
    SELECT be.*, u.name as created_by_name
    FROM case_billing_entries be
    LEFT JOIN users u ON be.created_by = u.id
    WHERE be.case_id = ${caseId} AND be.firm_id = ${req.firmId!}
    ORDER BY be.created_at ASC
  `);
  res.json(rows);
});

router.post("/cases/:caseId/billing", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const { category, description, amount, quantity, isPaid } = req.body as {
    category: string;
    description: string;
    amount: number;
    quantity?: number;
    isPaid?: boolean;
  };

  if (!description || amount == null) {
    res.status(400).json({ error: "description and amount are required" });
    return;
  }

  const rows = await queryRows(sql`
    INSERT INTO case_billing_entries (case_id, firm_id, category, description, amount, quantity, is_paid, created_by)
    VALUES (${caseId}, ${req.firmId!}, ${category ?? "disbursement"}, ${description}, ${amount}, ${quantity ?? 1}, ${isPaid ?? false}, ${req.userId!})
    RETURNING *
  `);

  res.status(201).json(rows[0]);
});

router.patch("/cases/:caseId/billing/:entryId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const entryId = Number(req.params.entryId);
  const { category, description, amount, quantity, isPaid } = req.body as Partial<{
    category: string;
    description: string;
    amount: number;
    quantity: number;
    isPaid: boolean;
  }>;

  const parts: SqlChunk[] = [];

  if (category !== undefined) parts.push(sql`category = ${category}`);
  if (description !== undefined) parts.push(sql`description = ${description}`);
  if (amount !== undefined) parts.push(sql`amount = ${amount}`);
  if (quantity !== undefined) parts.push(sql`quantity = ${quantity}`);
  if (isPaid !== undefined) {
    parts.push(sql`is_paid = ${isPaid}`);
    parts.push(isPaid ? sql`paid_at = NOW()` : sql`paid_at = NULL`);
  }
  parts.push(sql`updated_at = NOW()`);

  if (parts.length <= 1) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const setClause = sql.join(parts, sql`, `);

  const rows = await queryRows(sql`
    UPDATE case_billing_entries SET ${setClause}
    WHERE id = ${entryId} AND case_id = ${caseId} AND firm_id = ${req.firmId!}
    RETURNING *
  `);

  if (!rows[0]) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  res.json(rows[0]);
});

router.delete("/cases/:caseId/billing/:entryId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const entryId = Number(req.params.entryId);

  const rows = await queryRows(sql`
    DELETE FROM case_billing_entries
    WHERE id = ${entryId} AND case_id = ${caseId} AND firm_id = ${req.firmId!}
    RETURNING *
  `);

  if (!rows[0]) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/cases/:caseId/billing/summary", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const rows = await queryRows(sql`
    SELECT 
      category,
      COUNT(*) as entry_count,
      SUM(amount * quantity) as total,
      SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as paid,
      SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as outstanding
    FROM case_billing_entries
    WHERE case_id = ${caseId} AND firm_id = ${req.firmId!}
    GROUP BY category
    ORDER BY category
  `);

  const overall = await queryRows(sql`
    SELECT 
      COUNT(*) as entry_count,
      SUM(amount * quantity) as total,
      SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as paid,
      SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as outstanding
    FROM case_billing_entries
    WHERE case_id = ${caseId} AND firm_id = ${req.firmId!}
  `);

  res.json({ byCategory: rows, overall: overall[0] ?? { total: 0, paid: 0, outstanding: 0 } });
});

router.get("/accounting/summary", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const topCases = await queryRows(sql`
    SELECT c.reference_no, c.id as case_id,
      SUM(be.amount * be.quantity) as total,
      SUM(CASE WHEN be.is_paid THEN be.amount * be.quantity ELSE 0 END) as paid,
      SUM(CASE WHEN NOT be.is_paid THEN be.amount * be.quantity ELSE 0 END) as outstanding
    FROM case_billing_entries be
    JOIN cases c ON be.case_id = c.id
    WHERE be.firm_id = ${req.firmId!}
    GROUP BY c.id, c.reference_no
    ORDER BY total DESC
    LIMIT 10
  `);

  const monthly = await queryRows(sql`
    SELECT 
      TO_CHAR(created_at, 'YYYY-MM') as month,
      SUM(amount * quantity) as total,
      COUNT(*) as entry_count
    FROM case_billing_entries
    WHERE firm_id = ${req.firmId!}
    GROUP BY TO_CHAR(created_at, 'YYYY-MM')
    ORDER BY month DESC
    LIMIT 12
  `);

  const totals = await queryRows(sql`
    SELECT 
      SUM(amount * quantity) as total,
      SUM(CASE WHEN is_paid THEN amount * quantity ELSE 0 END) as paid,
      SUM(CASE WHEN NOT is_paid THEN amount * quantity ELSE 0 END) as outstanding,
      COUNT(DISTINCT case_id) as case_count
    FROM case_billing_entries
    WHERE firm_id = ${req.firmId!}
  `);

  const byCategory = await queryRows(sql`
    SELECT category, SUM(amount * quantity) as total
    FROM case_billing_entries
    WHERE firm_id = ${req.firmId!}
    GROUP BY category
    ORDER BY total DESC
  `);

  res.json({
    totals: totals[0] ?? { total: 0, paid: 0, outstanding: 0, case_count: 0 },
    byCategory,
    topCases,
    monthly: monthly.reverse(),
  });
});

export default router;
