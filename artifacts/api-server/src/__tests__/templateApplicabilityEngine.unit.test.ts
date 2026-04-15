import { describe, it, expect } from "vitest";
import { evaluateTemplateApplicabilityV2 } from "../lib/templateApplicabilityEngine";

const legacyTemplate = {
  isActive: true,
  isTemplateCapable: true,
  appliesToPurchaseMode: null,
  appliesToTitleType: "any",
  appliesToCaseType: null,
};

describe("templateApplicabilityEngine", () => {
  it("keeps universal template applicable without rules", () => {
    const r = evaluateTemplateApplicabilityV2({
      legacyTemplate,
      legacyInput: { purchaseMode: "cash", titleType: "master", caseType: null },
      context: { purchase_mode: "cash" },
      applicabilityMode: "universal",
      applicabilityRules: null,
    });
    expect(r.applicabilityStatus).toBe("applicable");
  });

  it("marks not_applicable for rules_only when rule fails", () => {
    const r = evaluateTemplateApplicabilityV2({
      legacyTemplate,
      legacyInput: { purchaseMode: "cash", titleType: "master", caseType: null },
      context: { purchase_mode: "cash" },
      applicabilityMode: "rules_only",
      applicabilityRules: { all: [{ field: "purchase_mode", operator: "equals", value: "loan" }] },
    });
    expect(r.applicabilityStatus).toBe("not_applicable");
    expect(r.manuallyOverridable).toBe(false);
  });

  it("marks overridable for rules_with_manual_override", () => {
    const r = evaluateTemplateApplicabilityV2({
      legacyTemplate,
      legacyInput: { purchaseMode: "cash", titleType: "master", caseType: null },
      context: { purchase_mode: "cash" },
      applicabilityMode: "rules_with_manual_override",
      applicabilityRules: { all: [{ field: "purchase_mode", operator: "equals", value: "loan" }] },
    });
    expect(r.applicabilityStatus).toBe("not_applicable");
    expect(r.manuallyOverridable).toBe(true);
  });

  it("returns warning when field missing in rule context", () => {
    const r = evaluateTemplateApplicabilityV2({
      legacyTemplate,
      legacyInput: { purchaseMode: "loan", titleType: "master", caseType: null },
      context: {},
      applicabilityMode: "rules_only",
      applicabilityRules: { all: [{ field: "bank_name", operator: "contains", value: "MAYBANK" }] },
    });
    expect(r.applicabilityStatus).toBe("warning");
    expect(r.applicabilityReasons.some((x) => x.includes("Field missing"))).toBe(true);
  });
});

