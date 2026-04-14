export type PurchaseMode = "cash" | "loan";
export type TemplatePurchaseModeRule = "cash" | "loan" | "both" | null;
export type TitleType = "master" | "strata" | "individual";
export type TemplateTitleTypeRule = "master" | "strata" | "individual" | "any";

export type TemplateApplicabilityFields = {
  isActive: boolean;
  appliesToPurchaseMode: string | null;
  appliesToTitleType: string | null;
  appliesToCaseType: string | null;
};

export type CaseApplicabilityInputs = {
  purchaseMode: string | null;
  titleType: string | null;
  caseType: string | null;
};

export type ApplicabilityResult = {
  applicable: boolean;
  reasons: string[];
};

export function normalizePurchaseMode(v: string | null | undefined): PurchaseMode | null {
  const s = (v || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "cash") return "cash";
  if (s === "loan") return "loan";
  return null;
}

export function normalizeTitleType(v: string | null | undefined): TitleType | null {
  const s = (v || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "master" || s === "master title" || s === "master_title") return "master";
  if (s === "strata" || s === "strata title" || s === "strata_title") return "strata";
  if (s === "individual" || s === "individual title" || s === "individual_title") return "individual";
  return null;
}

export function normalizeTemplatePurchaseModeRule(v: string | null | undefined): TemplatePurchaseModeRule {
  const s = (v || "").trim().toLowerCase();
  if (!s || s === "null" || s === "any") return null;
  if (s === "cash") return "cash";
  if (s === "loan") return "loan";
  if (s === "both") return "both";
  return null;
}

export function normalizeTemplateTitleTypeRule(v: string | null | undefined): TemplateTitleTypeRule {
  const s = (v || "").trim().toLowerCase();
  if (!s || s === "any") return "any";
  if (s === "master") return "master";
  if (s === "strata") return "strata";
  if (s === "individual") return "individual";
  return "any";
}

export function evaluateTemplateApplicability(
  template: TemplateApplicabilityFields,
  input: CaseApplicabilityInputs
): ApplicabilityResult {
  const reasons: string[] = [];

  if (!template.isActive) {
    return { applicable: false, reasons: ["Template is inactive"] };
  }

  const pmRule = normalizeTemplatePurchaseModeRule(template.appliesToPurchaseMode);
  const pm = normalizePurchaseMode(input.purchaseMode);
  if (pmRule && pm) {
    if (pmRule !== "both" && pmRule !== pm) {
      reasons.push(`Not applicable for purchase mode: ${pm}`);
    }
  }

  const ttRule = normalizeTemplateTitleTypeRule(template.appliesToTitleType);
  const tt = normalizeTitleType(input.titleType);
  if (ttRule !== "any" && tt) {
    if (ttRule !== tt) reasons.push(`Not applicable for title type: ${tt}`);
  }

  const caseTypeRule = (template.appliesToCaseType || "").trim();
  const caseType = (input.caseType || "").trim();
  if (caseTypeRule && caseType) {
    if (caseTypeRule.toLowerCase() !== caseType.toLowerCase()) {
      reasons.push(`Not applicable for case type: ${caseType}`);
    }
  }

  return { applicable: reasons.length === 0, reasons };
}

