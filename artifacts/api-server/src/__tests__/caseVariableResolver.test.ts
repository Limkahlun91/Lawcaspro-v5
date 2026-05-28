import { describe, expect, it } from "vitest";
import { selectPurchaserSource } from "../lib/caseVariableResolver";

describe("caseVariableResolver", () => {
  it("falls back when case_purchasers rows are empty-name placeholders", () => {
    const out = selectPurchaserSource({
      fromCasePurchasers: [{ name: "", ic_no: "930505-05-5555" }],
      fromCaseParties: [{ name: "CHUA SJ", ic_no: "930505-05-5555" }],
      fromSpaDetails: [],
    });

    expect(out.purchaserSourceUsed).toBe("case_parties");
    expect(out.purchaserRows).toHaveLength(1);
    expect(out.purchaserRows[0]?.name).toBe("CHUA SJ");
  });

  it("uses case_purchasers when it contains a valid purchaser name", () => {
    const out = selectPurchaserSource({
      fromCasePurchasers: [{ name: " CHUA SJ ", ic_no: "930505-05-5555" }],
      fromCaseParties: [{ name: "OTHER", ic_no: "111" }],
      fromSpaDetails: [],
    });

    expect(out.purchaserSourceUsed).toBe("case_purchasers");
    expect(out.purchaserRows[0]?.name).toBe("CHUA SJ");
  });
});

