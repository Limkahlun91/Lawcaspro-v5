export type EInvoiceClassification =
  | "OFFICE_INCOME"
  | "TAXABLE_TRAVEL_MISC"
  | "CLIENT_STAKEHOLDER_MONEY"
  | "REIMBURSEMENT"
  | "DISBURSEMENT"
  | "OVERCOLLECT_TRANSFER";

export type InvoiceLineLike = {
  description?: string | null;
  itemType?: string | null;
  itemCategory?: string | null;
};

const STAKEHOLDER_KEYWORDS = [
  "stamp duty", "stampduty", "stamp-duty",
  "registration fee", "registration", "land office",
  "npft", "quit rent", "assessment",
  "cukai tanah", "cukai pintar",
  "miscellaneous fees - government",
  "filer fee", "efiling", "e-filing",
  "bar council", "solicitor remuneration",
  "court fee", "filing fee",
];

const TRAVEL_MISC_KEYWORDS = [
  "travel", "travelling", "transport", "toll", "parking",
  "mileage", "fuel", "petrol", "taxi", "grab",
  "flight", "hotel", "accommodation", "meal", "entertainment",
];

const REIMBURSEMENT_KEYWORDS = [
  "reimburse", "reimbursement", "reimbursed",
  "claim back", "pass-through", "pass through",
];

export function classifyInvoiceLineForEInvoice(line: InvoiceLineLike): EInvoiceClassification {
  const desc = (line.description ?? "").toLowerCase().trim();
  const itemType = (line.itemType ?? "").toLowerCase().trim();
  const itemCategory = (line.itemCategory ?? "").toLowerCase().trim();

  if (STAKEHOLDER_KEYWORDS.some((kw) => desc.includes(kw) || itemType.includes(kw))) {
    return "CLIENT_STAKEHOLDER_MONEY";
  }

  if (itemCategory === "disbursement" || itemType === "disbursement" || itemType === "trust_amount" || itemType === "pass_through") {
    if (REIMBURSEMENT_KEYWORDS.some((kw) => desc.includes(kw) || itemType.includes(kw))) {
      return "REIMBURSEMENT";
    }
    if (TRAVEL_MISC_KEYWORDS.some((kw) => desc.includes(kw) || itemType.includes(kw))) {
      return "TAXABLE_TRAVEL_MISC";
    }
    return "DISBURSEMENT";
  }

  if (REIMBURSEMENT_KEYWORDS.some((kw) => desc.includes(kw) || itemType.includes(kw))) {
    return "REIMBURSEMENT";
  }

  if (TRAVEL_MISC_KEYWORDS.some((kw) => desc.includes(kw) || itemType.includes(kw))) {
    return "TAXABLE_TRAVEL_MISC";
  }

  return "OFFICE_INCOME";
}

export const CLASSIFICATION_PRIORITY: EInvoiceClassification[] = [
  "OVERCOLLECT_TRANSFER",
  "CLIENT_STAKEHOLDER_MONEY",
  "TAXABLE_TRAVEL_MISC",
  "REIMBURSEMENT",
  "DISBURSEMENT",
  "OFFICE_INCOME",
];

export function resolveHeaderClassification(lines: InvoiceLineLike[]): EInvoiceClassification | null {
  const valid = lines
    .map(classifyInvoiceLineForEInvoice)
    .filter(Boolean) as EInvoiceClassification[];
  if (valid.length === 0) return null;
  const byRank = [...valid].sort(
    (a, b) => CLASSIFICATION_PRIORITY.indexOf(a) - CLASSIFICATION_PRIORITY.indexOf(b),
  );
  return byRank[0]!;
}
