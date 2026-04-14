import { describe, it, expect } from "vitest";
import { evaluateTemplateApplicability } from "../lib/documentApplicability";

describe("document applicability", () => {
  it("blocks inactive templates", () => {
    const r = evaluateTemplateApplicability(
      { isActive: false, appliesToPurchaseMode: null, appliesToTitleType: null, appliesToCaseType: null },
      { purchaseMode: "loan", titleType: "master", caseType: "Primary Market" }
    );
    expect(r.applicable).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("applies purchase mode and title type rules when present", () => {
    const r = evaluateTemplateApplicability(
      { isActive: true, appliesToPurchaseMode: "cash", appliesToTitleType: "master", appliesToCaseType: null },
      { purchaseMode: "loan", titleType: "master", caseType: null }
    );
    expect(r.applicable).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/purchase mode/i);
  });
});

