import { eq, and, sql } from "drizzle-orm";
import {
  firmNumberSequencesTable,
  invoicesTable,
  receiptsTable,
} from "@workspace/db";

type DbConnLike = {
  select: (...args: unknown[]) => any;
  update: (...args: unknown[]) => any;
  insert: (...args: unknown[]) => any;
  execute: (...args: unknown[]) => any;
};

export async function nextInvoiceNo(r: DbConnLike, firmId: number): Promise<string> {
  const yr = new Date().getFullYear();
  const prefix = `INV-${yr}-`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bumped = await r
        .update(firmNumberSequencesTable)
        .set({ nextValue: sql`${firmNumberSequencesTable.nextValue} + 1`, updatedAt: new Date(), lastPrefix: prefix })
        .where(and(eq(firmNumberSequencesTable.firmId, firmId), eq(firmNumberSequencesTable.seqName, 'invoice_no'), sql`${firmNumberSequencesTable.lastPrefix} IS NOT DISTINCT FROM ${prefix}`))
        .returning({ nextValue: firmNumberSequencesTable.nextValue });
      if (bumped[0]) return `${prefix}${(Number(bumped[0].nextValue) - 1).toString().padStart(4, "0")}`;
      const upserted = await r.insert(firmNumberSequencesTable).values({
        firmId, seqName: 'invoice_no', nextValue: sql`
          (SELECT COALESCE(MAX(CASE WHEN invoice_no LIKE ${prefix + '%'} THEN SUBSTRING(invoice_no FROM ${prefix.length + 1} FOR 4)::INTEGER END), 0) + 1 FROM invoices WHERE firm_id = ${firmId} AND invoice_no LIKE ${prefix + '%'})
        `, lastPrefix: prefix, updatedAt: new Date()
      }).onConflictDoNothing().returning({ nextValue: firmNumberSequencesTable.nextValue });
      if (upserted[0]) return `${prefix}${(Number(upserted[0].nextValue) - 1).toString().padStart(4, "0")}`;
      continue;
    } catch (e) {
      if (e && String((e as any).code) === '23505' && attempt < 2) continue;
      throw e;
    }
  }
  await r.execute(sql`SELECT pg_advisory_xact_lock(hashtext('firm_seq_invoice_' || ${firmId}::text))`);
  const [row] = await r.select({ c: sql<number>`COALESCE(MAX(CASE WHEN invoice_no LIKE ${prefix + '%'} THEN SUBSTRING(invoice_no FROM ${prefix.length + 1} FOR 4)::INTEGER END), 0)` }).from(invoicesTable).where(eq(invoicesTable.firmId, firmId));
  const n = Number(row?.c ?? 0) + 1;
  await r.insert(firmNumberSequencesTable).values({ firmId, seqName: 'invoice_no', nextValue: n + 1, lastPrefix: prefix, updatedAt: new Date() }).onConflictDoUpdate({ target: [firmNumberSequencesTable.firmId, firmNumberSequencesTable.seqName], set: { nextValue: n + 1, lastPrefix: prefix, updatedAt: new Date() } });
  return `${prefix}${n.toString().padStart(4, "0")}`;
}

export async function nextReceiptNo(r: DbConnLike, firmId: number): Promise<string> {
  const yr = new Date().getFullYear();
  const prefix = `REC-${yr}-`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bumped = await r
        .update(firmNumberSequencesTable)
        .set({ nextValue: sql`${firmNumberSequencesTable.nextValue} + 1`, updatedAt: new Date(), lastPrefix: prefix })
        .where(and(eq(firmNumberSequencesTable.firmId, firmId), eq(firmNumberSequencesTable.seqName, 'receipt_no'), sql`${firmNumberSequencesTable.lastPrefix} IS NOT DISTINCT FROM ${prefix}`))
        .returning({ nextValue: firmNumberSequencesTable.nextValue });
      if (bumped[0]) return `${prefix}${(Number(bumped[0].nextValue) - 1).toString().padStart(4, "0")}`;
      const upserted = await r.insert(firmNumberSequencesTable).values({
        firmId, seqName: 'receipt_no', nextValue: sql`
          (SELECT COALESCE(MAX(CASE WHEN receipt_no LIKE ${prefix + '%'} THEN SUBSTRING(receipt_no FROM ${prefix.length + 1} FOR 4)::INTEGER END), 0) + 1 FROM receipts WHERE firm_id = ${firmId} AND receipt_no LIKE ${prefix + '%'})
        `, lastPrefix: prefix, updatedAt: new Date()
      }).onConflictDoNothing().returning({ nextValue: firmNumberSequencesTable.nextValue });
      if (upserted[0]) return `${prefix}${(Number(upserted[0].nextValue) - 1).toString().padStart(4, "0")}`;
      continue;
    } catch (e) {
      if (e && String((e as any).code) === '23505' && attempt < 2) continue;
      throw e;
    }
  }
  await r.execute(sql`SELECT pg_advisory_xact_lock(hashtext('firm_seq_receipt_' || ${firmId}::text))`);
  const [row] = await r.select({ c: sql<number>`COALESCE(MAX(CASE WHEN receipt_no LIKE ${prefix + '%'} THEN SUBSTRING(receipt_no FROM ${prefix.length + 1} FOR 4)::INTEGER END), 0)` }).from(receiptsTable).where(eq(receiptsTable.firmId, firmId));
  const n = Number(row?.c ?? 0) + 1;
  await r.insert(firmNumberSequencesTable).values({ firmId, seqName: 'receipt_no', nextValue: n + 1, lastPrefix: prefix, updatedAt: new Date() }).onConflictDoUpdate({ target: [firmNumberSequencesTable.firmId, firmNumberSequencesTable.seqName], set: { nextValue: n + 1, lastPrefix: prefix, updatedAt: new Date() } });
  return `${prefix}${n.toString().padStart(4, "0")}`;
}
