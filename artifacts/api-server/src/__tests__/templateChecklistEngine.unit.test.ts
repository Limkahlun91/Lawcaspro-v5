import { describe, it, expect } from "vitest";
import { evaluateTemplateChecklist } from "../lib/templateChecklistEngine";

describe("templateChecklistEngine", () => {
  it("off mode returns ready", () => {
    const r = evaluateTemplateChecklist({
      checklistMode: "off",
      checklistItems: [{ id: "a", label: "A", type: "required_case_field", required: true, config: { fieldKey: "our_ref" } }],
      caseContext: {},
    });
    expect(r.checklistStatus).toBe("ready");
  });

  it("advisory mode warns when missing", () => {
    const r = evaluateTemplateChecklist({
      checklistMode: "advisory",
      checklistItems: [{ id: "a", label: "A", type: "required_case_field", required: true, config: { fieldKey: "our_ref" } }],
      caseContext: {},
    });
    expect(r.checklistStatus).toBe("warning");
    expect(r.missingRequiredItems).toBe(1);
  });

  it("required_to_generate blocks when missing", () => {
    const r = evaluateTemplateChecklist({
      checklistMode: "required_to_generate",
      checklistItems: [{ id: "a", label: "A", type: "required_case_field", required: true, config: { fieldKey: "our_ref" } }],
      caseContext: {},
    });
    expect(r.checklistStatus).toBe("blocked");
  });

  it("manual confirmation passes when checked", () => {
    const r = evaluateTemplateChecklist({
      checklistMode: "required_with_manual_override",
      checklistItems: [{ id: "confirm_1", label: "Partner approved", type: "manual_confirmation", required: true }],
      caseContext: {},
      manualConfirmations: { confirm_1: { passed: true, checkedBy: 12, checkedAt: "2026-01-01" } },
    });
    expect(r.checklistStatus).toBe("ready");
    expect(r.items[0].checkedBy).toBe(12);
  });

  it("required_generated_variable is skipped when variable not used by template", () => {
    const r = evaluateTemplateChecklist({
      checklistMode: "required_to_generate",
      checklistItems: [{ id: "a", label: "Purchaser NRIC", type: "required_generated_variable", required: true, config: { variableKey: "purchaser_ic" } }],
      caseContext: {},
      usedVariableKeys: ["date", "reference_no"],
    });
    expect(r.checklistStatus).toBe("ready");
    expect(r.missingRequiredItems).toBe(0);
  });

  it("required_generated_variable is treated as pass when variables snapshot is unavailable", () => {
    const r = evaluateTemplateChecklist({
      checklistMode: "required_to_generate",
      checklistItems: [{ id: "a", label: "Purchaser NRIC", type: "required_generated_variable", required: true, config: { variableKey: "purchaser_ic" } }],
      caseContext: {},
      usedVariableKeys: null,
    });
    expect(r.checklistStatus).toBe("ready");
  });

  it("required_generated_variable blocks when used and missing", () => {
    const r = evaluateTemplateChecklist({
      checklistMode: "required_to_generate",
      checklistItems: [{ id: "a", label: "Purchaser NRIC", type: "required_generated_variable", required: true, config: { variableKey: "purchaser_ic" } }],
      caseContext: { purchaser_ic: "" },
      usedVariableKeys: ["purchaser_ic"],
    });
    expect(r.checklistStatus).toBe("blocked");
    expect(r.missingRequiredItems).toBe(1);
  });
});
