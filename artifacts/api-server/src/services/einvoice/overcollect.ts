import { eq, and, sql } from "drizzle-orm";
import { db, invoicesTable, receiptsTable, receiptAllocationsTable, caseLedgersTable } from "@workspace/db";

export type OvercollectTransferProposal = {
  originalTransactionId: number;
  caseId: number | null;
  customerId: number | null;
  amount: string;
  reason: string;
  ageDays: number;
  requiresApprovedByRole: "partner";
  alreadyHasValidEinvoiceLink: boolean;
};

export async function identifyOvercollectTransfers(
  r: typeof db,
  args: {
    firmId: number;
    customerId?: number | null;
    caseId?: number | null;
    periodStartDate?: string;
    periodEndDate?: string;
    minAgeMonths?: number;
  },
): Promise<OvercollectTransferProposal[]> {
  const minAgeMonths = args.minAgeMonths ?? 3;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - minAgeMonths);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const conds: any[] = [eq(receiptsTable.firmId, args.firmId)];
  if (args.caseId) conds.push(eq(receiptsTable.caseId, args.caseId));
  if (args.periodStartDate) conds.push(sql`${receiptsTable.receivedDate} >= ${args.periodStartDate}::date`);
  if (args.periodEndDate) conds.push(sql`${receiptsTable.receivedDate} <= ${args.periodEndDate}::date`);
  conds.push(sql`${receiptsTable.receivedDate} < ${cutoffIso}::date`);

  const allocations = await r
    .select({
      id: receiptAllocationsTable.id,
      receiptId: receiptAllocationsTable.receiptId,
      invoiceId: receiptAllocationsTable.invoiceId,
      amount: receiptAllocationsTable.amount,
      notes: receiptAllocationsTable.notes,
      createdAt: receiptAllocationsTable.createdAt,
      receivedDate: receiptsTable.receivedDate,
      caseId: receiptsTable.caseId,
      invoiceGrandTotal: invoicesTable.grandTotal,
      einvoiceStatus: invoicesTable.einvoiceStatus,
      einvoiceSourceInvoiceId: invoicesTable.einvoiceSourceInvoiceId,
    })
    .from(receiptAllocationsTable)
    .innerJoin(receiptsTable, eq(receiptAllocationsTable.receiptId, receiptsTable.id))
    .leftJoin(invoicesTable, eq(receiptAllocationsTable.invoiceId, invoicesTable.id))
    .where(and(...conds));

  const proposals: OvercollectTransferProposal[] = [];
  for (const a of allocations) {
    const allocAmt = Number(a.amount ?? 0);
    const invAmt = Number(a.invoiceGrandTotal ?? 0);
    if (allocAmt <= invAmt) continue;
    const over = allocAmt - invAmt;
    if (over <= 0) continue;

    const ageMs = Date.now() - new Date(String(a.receivedDate)).getTime();
    const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000));

    const alreadyHasValidEinvoiceLink =
      !!a.einvoiceSourceInvoiceId &&
      ["VALID", "SUBMITTED"].includes(String(a.einvoiceStatus ?? ""));

    proposals.push({
      originalTransactionId: Number(a.receiptId),
      caseId: a.caseId ? Number(a.caseId) : null,
      customerId: args.customerId ?? null,
      amount: over.toFixed(2),
      reason: `Advance payment over allocated invoice by RM${over.toFixed(2)} (age ${ageDays}d)`,
      ageDays,
      requiresApprovedByRole: "partner",
      alreadyHasValidEinvoiceLink,
    });
  }
  return proposals;
}
