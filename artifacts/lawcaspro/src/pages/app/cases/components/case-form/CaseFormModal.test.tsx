import { describe, expect, it } from "vitest";
import { createDefaultCaseFormValues } from "./CaseForm";
import { buildCasePayloadFromFormValues } from "./CaseFormModal";

describe("buildCasePayloadFromFormValues", () => {
  it("stores raw others text together with computed totals", () => {
    const values = createDefaultCaseFormValues();
    values.caseType = "developer_sales";
    values.financingSum = "780000";
    values.othersSum = "4,500.00 AND LEGAL FEES OF RM2,000.00";

    const payload = buildCasePayloadFromFormValues(values) as {
      loanDetails?: Record<string, unknown>;
    };

    expect(payload.loanDetails).toMatchObject({
      propertyFinancingSum: 780000,
      othersSum: 6500,
      othersText: "4,500.00 AND LEGAL FEES OF RM2,000.00",
      totalLoan: 786500,
      totalLoanWords: "Ringgit Malaysia Seven Hundred Eighty Six Thousand Five Hundred and Sen Zero",
    });
  });
});
