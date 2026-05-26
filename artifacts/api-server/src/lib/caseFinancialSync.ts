import { sql } from "@workspace/db";

type DbConn = {
  execute: (q: unknown) => Promise<unknown>;
};

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as any).rows;
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }
  return [];
}

const columnExistsCache = new Map<string, boolean>();

async function columnExists(r: DbConn, args: { schema: string; table: string; column: string }): Promise<boolean> {
  const key = `${args.schema}.${args.table}.${args.column}`;
  const cached = columnExistsCache.get(key);
  if (cached !== undefined) return cached;
  const rows = rowsOf(await r.execute(sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = ${args.schema}
      AND table_name = ${args.table}
      AND column_name = ${args.column}
    LIMIT 1
  `));
  const ok = Boolean(rows[0]);
  columnExistsCache.set(key, ok);
  return ok;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : (typeof v === "string" ? Number(v) : NaN);
  return Number.isFinite(n) ? n : 0;
}

export async function syncCaseFinancialTotals(r: DbConn, args: { firmId: number; caseId: number }): Promise<void> {
  const hasAmountPaid = await columnExists(r, { schema: "public", table: "cases", column: "amount_paid" });
  const hasOutstanding = await columnExists(r, { schema: "public", table: "cases", column: "outstanding_balance" });
  if (!hasAmountPaid && !hasOutstanding) return;

  const totals = rowsOf(await r.execute(sql`
    SELECT
      COALESCE((
        SELECT SUM(i.grand_total::numeric)
        FROM invoices i
        WHERE i.firm_id = ${args.firmId}
          AND i.deleted_at IS NULL
          AND i.case_id = ${args.caseId}
          AND i.status IN ('issued','partially_paid','paid')
      ), 0)::numeric AS total_invoiced,
      COALESCE((
        SELECT SUM(r.amount::numeric)
        FROM receipts r
        WHERE r.firm_id = ${args.firmId}
          AND r.is_reversed = false
          AND r.case_id = ${args.caseId}
      ), 0)::numeric AS total_collected
  `))[0];

  const totalInvoiced = num(totals?.total_invoiced);
  const totalCollected = num(totals?.total_collected);
  const outstanding = Math.max(0, totalInvoiced - totalCollected);

  await r.execute(sql`
    UPDATE cases
    SET
      ${hasAmountPaid ? sql`amount_paid = ${totalCollected.toFixed(2)}` : sql``}
      ${hasAmountPaid && hasOutstanding ? sql`, ` : sql``}
      ${hasOutstanding ? sql`outstanding_balance = ${outstanding.toFixed(2)}` : sql``}
    WHERE firm_id = ${args.firmId}
      AND id = ${args.caseId}
  `);
}

