export const LOAN_STAMPING_ITEM_KEYS = [
  "facility_agreement",
  "deed_of_assignment",
  "power_of_attorney",
  "charge_annexure",
  "other",
] as const;

export type LoanStampingItemKey = (typeof LOAN_STAMPING_ITEM_KEYS)[number];

export type NormalizedTitleType = "master" | "strata" | "individual" | null;

export function normalizeTitleType(raw: string | null | undefined): NormalizedTitleType {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "master" || s === "master title" || s === "master_title") return "master";
  if (s === "strata" || s === "strata title" || s === "strata_title") return "strata";
  if (s === "individual" || s === "individual title" || s === "individual_title") return "individual";
  return null;
}

export function isLoanStampingItemKeyAllowedForTitleType(
  titleType: NormalizedTitleType,
  itemKey: LoanStampingItemKey
): boolean {
  if (!titleType) return true;
  if (itemKey === "charge_annexure") return titleType === "strata" || titleType === "individual";
  if (itemKey === "deed_of_assignment" || itemKey === "power_of_attorney") return titleType === "master";
  return true;
}

