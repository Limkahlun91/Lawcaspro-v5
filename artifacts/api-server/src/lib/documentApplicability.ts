export type PurchaseMode = "cash" | "loan";
export type TemplatePurchaseModeRule = "cash" | "loan" | "both" | null;
export type TitleType = "master" | "strata" | "individual";
export type TemplateTitleTypeRule = "master" | "strata" | "individual" | "any";

export type TemplateApplicabilityFields = {
  isActive: boolean;
  isTemplateCapable?: boolean | null;
  appliesToPurchaseMode: string | null;
  appliesToTitleType: string | null;
  appliesToCaseType: string | null;
  projectType?: string | null;
  titleSubType?: string | null;
  developmentCondition?: string | null;
  unitCategory?: string | null;
};

export type CaseApplicabilityInputs = {
  purchaseMode: string | null;
  titleType: string | null;
  caseType: string | null;
  projectType?: string | null;
  titleSubType?: string | null;
  developmentCondition?: string | null;
  unitCategory?: string | null;
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

  if (template.isTemplateCapable === false) {
    return { applicable: false, reasons: ["Template is not template-capable"] };
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

  const projectTypeRule = (template.projectType || "").trim();
  const projectType = (input.projectType || "").trim();
  if (projectTypeRule && projectType) {
    if (projectTypeRule.toLowerCase() !== projectType.toLowerCase()) {
      reasons.push(`Not applicable for project type: ${projectType}`);
    }
  }

  const titleSubTypeRule = (template.titleSubType || "").trim();
  const titleSubType = (input.titleSubType || "").trim();
  if (titleSubTypeRule && titleSubType) {
    if (titleSubTypeRule.toLowerCase() !== titleSubType.toLowerCase()) {
      reasons.push(`Not applicable for title sub type: ${titleSubType}`);
    }
  }

  const devCondRule = (template.developmentCondition || "").trim();
  const devCond = (input.developmentCondition || "").trim();
  if (devCondRule && devCond) {
    if (devCondRule.toLowerCase() !== devCond.toLowerCase()) {
      reasons.push(`Not applicable for development condition: ${devCond}`);
    }
  }

  const unitCatRule = (template.unitCategory || "").trim();
  const unitCat = (input.unitCategory || "").trim();
  if (unitCatRule && unitCat) {
    if (unitCatRule.toLowerCase() !== unitCat.toLowerCase()) {
      reasons.push(`Not applicable for unit category: ${unitCat}`);
    }
  }

  return { applicable: reasons.length === 0, reasons };
}

