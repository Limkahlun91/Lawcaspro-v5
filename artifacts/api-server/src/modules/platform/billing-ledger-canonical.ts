import type { NewLedgerEntry, BillingEntryType } from "../../services/billing-ledger.js";

export type PlatformBillingEntryType =
  | "subscription_charge"
  | "credit"
  | "discount"
  | "adjustment"
  | "payment"
  | "refund";

export type PlatformBillingEntry = {
  firmId: number;
  entryType: PlatformBillingEntryType;
  amountCents: number;
  description: string;
  sourceType?: string;
  sourceId?: string;
  idempotencyKey: string;
};

export function mapPlatformBillingToLedger(
  entry: PlatformBillingEntry,
  opts: { createdBy?: number | null; currency?: string; dueDate?: Date | null } = {},
): NewLedgerEntry {
  const { amountCents, entryType, ...rest } = entry;
  const negative = entryType === "credit" || entryType === "discount" || entryType === "refund";
  const debitOrCredit: Partial<NewLedgerEntry> =
    entryType === "payment"
      ? { credit: (amountCents / 100).toFixed(2) }
      : negative
        ? { credit: (amountCents / 100).toFixed(2) }
        : { debit: (amountCents / 100).toFixed(2) };

  const mappedType: BillingEntryType =
    entryType === "credit" ? "credit_note"
    : entryType === "discount" ? "adjustment"
    : entryType;

  return {
    firmId: entry.firmId,
    entryType: mappedType,
    description: entry.description,
    idempotencyKey: entry.idempotencyKey,
    sourceType: entry.sourceType ?? null,
    sourceId: entry.sourceId ? Number(entry.sourceId) || null : null,
    currency: opts.currency ?? "MYR",
    createdBy: opts.createdBy ?? null,
    dueDate: opts.dueDate ?? null,
    ...debitOrCredit,
  };
}
