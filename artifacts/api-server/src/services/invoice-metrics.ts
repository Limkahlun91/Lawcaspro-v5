import { db, sql, type RlsDb } from "@workspace/db";

type DbConn = typeof db | RlsDb;

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

function toNumber0(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

export type InvoiceMetrics = {
  totalInvoiced: number;
  totalCollected: number;
  totalOutstanding: number;
  invoiceCount: number;
};

export async function computeInvoiceMetrics(r: DbConn, args: { firmId: number; caseIds?: number[] }): Promise<InvoiceMetrics> {
  const caseIds = Array.isArray(args.caseIds) ? args.caseIds.filter((x) => Number.isInteger(x) && x > 0) : [];
  const caseFilter = caseIds.length
    ? sql`AND case_id IN (${sql.join(caseIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const [row] = await queryRows(r, sql`
    SELECT
      COALESCE(SUM(grand_total), 0) as total_invoiced,
      COALESCE(SUM(amount_paid), 0) as total_collected,
      COALESCE(SUM(amount_due), 0) as total_outstanding,
      COUNT(*) as invoice_count
    FROM invoices
    WHERE firm_id = ${args.firmId}
      AND deleted_at IS NULL
      AND status IN ('issued','partially_paid','paid')
      ${caseFilter}
  `);
  return {
    totalInvoiced: toNumber0(row?.total_invoiced),
    totalCollected: toNumber0(row?.total_collected),
    totalOutstanding: toNumber0(row?.total_outstanding),
    invoiceCount: toNumber0(row?.invoice_count),
  };
}

