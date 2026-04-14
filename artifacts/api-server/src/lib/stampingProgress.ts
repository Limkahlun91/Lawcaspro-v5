import { isLoanStampingItemKeyAllowedForTitleType, type LoanStampingItemKey, type NormalizedTitleType } from "./loanStamping";

export type StampingDerivedStatus =
  | "completed"
  | "incomplete"
  | "missing_date"
  | "missing_stamped_on"
  | "missing_file"
  | "missing_name";

export type StampingItemInput = {
  id: number | null;
  itemKey: LoanStampingItemKey;
  customName: string | null;
  datedOn: string | null;
  stampedOn: string | null;
  hasFile: boolean;
  sortOrder: number;
};

export function deriveStampingItemStatus(it: StampingItemInput): StampingDerivedStatus {
  if (it.itemKey === "other" && !it.customName?.trim()) return "missing_name";
  if (!it.datedOn) return "missing_date";
  if (!it.stampedOn) return "missing_stamped_on";
  if (!it.hasFile) return "missing_file";
  return "completed";
}

export function filterStampingItemsByTitleType(
  titleType: NormalizedTitleType,
  items: StampingItemInput[]
): StampingItemInput[] {
  return items.filter((x) => isLoanStampingItemKeyAllowedForTitleType(titleType, x.itemKey));
}

export function computeStampingSummary(
  titleType: NormalizedTitleType,
  items: StampingItemInput[]
): { completed: number; total: number; missing: Array<{ itemKey: LoanStampingItemKey; id: number | null; status: StampingDerivedStatus }> } {
  const filtered = filterStampingItemsByTitleType(titleType, items);
  const missing = [];
  let completed = 0;
  for (const it of filtered) {
    const status = deriveStampingItemStatus(it);
    if (status === "completed") completed++;
    else missing.push({ itemKey: it.itemKey, id: it.id, status });
  }
  return { completed, total: filtered.length, missing };
}

