export const DOCUMENT_TYPES = [
  "spa",
  "loan_agreement",
  "letter_of_offer",
  "mot",
  "noa",
  "power_of_attorney",
  "stamping_receipt",
  "acting_letter",
  "undertaking",

  "letter_forward_bank_execution",
  "letter_forward_bank_lu_to_dev",
  "letter_advice_spa_sol_lu",
  "letter_send_spa_to_developer_execution",
  "letter_send_stamped_spa_to_developer",
  "letter_send_stamped_spa_to_purchaser",

  "other",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  spa: "SPA",
  loan_agreement: "Loan Agreement",
  letter_of_offer: "Letter of Offer",
  mot: "MOT",
  noa: "Notice of Assignment",
  power_of_attorney: "Power of Attorney",
  stamping_receipt: "Stamping Receipt",
  acting_letter: "Acting Letter",
  undertaking: "Undertaking",
  letter_forward_bank_execution: "Letter Forward Bank Execution",
  letter_forward_bank_lu_to_dev: "Letter Forward Bank’s LU to Dev.",
  letter_advice_spa_sol_lu: "Letter Advice & SPA Sol. LU",
  letter_send_spa_to_developer_execution: "Letter Send SPA to Developer execution",
  letter_send_stamped_spa_to_developer: "Letter Send Stamped SPA to Developer",
  letter_send_stamped_spa_to_purchaser: "Letter Send Stamped SPA to Purchaser",
  other: "Other",
};

export const LETTERHEAD_APPLICABLE_DOCUMENT_TYPES = new Set<DocumentType>([
  "letter_of_offer",
  "acting_letter",
  "undertaking",
  "letter_forward_bank_execution",
  "letter_forward_bank_lu_to_dev",
  "letter_advice_spa_sol_lu",
  "letter_send_spa_to_developer_execution",
  "letter_send_stamped_spa_to_developer",
  "letter_send_stamped_spa_to_purchaser",
]);

export function normalizeDocumentType(input: unknown): DocumentType {
  const s = typeof input === "string" ? input.toLowerCase() : "";
  return (DOCUMENT_TYPES as readonly string[]).includes(s) ? (s as DocumentType) : "other";
}

export function isLetterheadApplicableDocumentType(documentType: unknown): boolean {
  return LETTERHEAD_APPLICABLE_DOCUMENT_TYPES.has(normalizeDocumentType(documentType));
}

export function isMasterDocumentLetterLike(d: { name?: string; category?: string; fileName?: string } | undefined): boolean {
  const name = (d?.name || "").toLowerCase();
  const category = (d?.category || "").toLowerCase();
  const fileName = (d?.fileName || "").toLowerCase();
  if (category === "letter") return true;
  const parts = `${name} ${fileName}`;
  if (/(^|[\s_\-])letter($|[\s_\-])/i.test(parts)) return true;
  if (/(^|[\s_\-])acting[\s_\-]+letter($|[\s_\-])/i.test(parts)) return true;
  if (/(^|[\s_\-])undertaking($|[\s_\-])/i.test(parts)) return true;
  if (/(^|[\s_\-])letter[\s_\-]+of[\s_\-]+offer($|[\s_\-])/i.test(parts)) return true;
  return false;
}

export type PrintKey =
  | "acting_letter"
  | "letter_forward_bank_execution"
  | "letter_forward_bank_lu_to_dev"
  | "noa"
  | "letter_advice_spa_sol_lu"
  | "letter_send_spa_to_developer_execution"
  | "letter_send_stamped_spa_to_developer"
  | "letter_send_stamped_spa_to_purchaser";

export const PRINT_ACTIONS: Record<PrintKey, { documentType: DocumentType; label: string }> = {
  acting_letter: { documentType: "acting_letter", label: "Acting Letter" },
  letter_forward_bank_execution: { documentType: "letter_forward_bank_execution", label: "Letter Forward Bank Execution" },
  letter_forward_bank_lu_to_dev: { documentType: "letter_forward_bank_lu_to_dev", label: "Letter Forward Bank’s LU to Dev." },
  noa: { documentType: "noa", label: "NOA" },
  letter_advice_spa_sol_lu: { documentType: "letter_advice_spa_sol_lu", label: "Letter Advice & SPA Sol. LU" },
  letter_send_spa_to_developer_execution: { documentType: "letter_send_spa_to_developer_execution", label: "Letter Send SPA to Developer execution" },
  letter_send_stamped_spa_to_developer: { documentType: "letter_send_stamped_spa_to_developer", label: "Letter Send Stamped SPA to Developer" },
  letter_send_stamped_spa_to_purchaser: { documentType: "letter_send_stamped_spa_to_purchaser", label: "Letter Send Stamped SPA to Purchaser" },
};
