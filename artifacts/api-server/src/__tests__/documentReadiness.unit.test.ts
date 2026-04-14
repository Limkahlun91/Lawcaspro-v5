import { describe, it, expect } from "vitest";
import { evaluateTemplateReadiness } from "../lib/documentReadiness";

describe("document readiness", () => {
  it("marks SPA group missing date/file when required", () => {
    const r = evaluateTemplateReadiness({
      documentGroup: "SPA",
      input: {
        purchaseMode: "cash",
        titleType: "master",
        caseType: null,
        referenceNo: "REF1",
        projectName: "P",
        purchaser1Name: "Buyer",
        purchaser1Ic: "900101-01-1234",
        loanTotal: null,
        loanEndFinancier: null,
        keyDates: { spa_stamped_date: null },
        workflowDocs: { spa_stamped: { hasFile: false } },
        stampingItems: [],
      },
    });
    expect(r.status).not.toBe("ready");
    expect(r.missing.some((m) => m.code.includes("spa_stamped"))).toBe(true);
  });
});

