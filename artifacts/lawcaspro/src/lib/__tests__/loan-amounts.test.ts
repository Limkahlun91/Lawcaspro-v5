import { describe, expect, it } from "vitest";
import { calculateLoanAmounts, parseMoneyAmountsFromText } from "../loan-amounts";

describe("parseMoneyAmountsFromText", () => {
  it("parses a single RM amount", () => {
    expect(parseMoneyAmountsFromText("MRTA OF RM 14,500.00")).toEqual([14500]);
  });

  it("parses multiple amounts from mixed plain text and RM-prefixed text", () => {
    expect(parseMoneyAmountsFromText("4,500.00 AND LEGAL FEES OF RM2,000.00")).toEqual([4500, 2000]);
  });

  it("parses multiple RM-prefixed amounts", () => {
    expect(parseMoneyAmountsFromText("MRTA RM4,500.00 AND LEGAL FEES RM2,000.00")).toEqual([4500, 2000]);
  });

  it("parses colon-separated amounts", () => {
    expect(parseMoneyAmountsFromText("MRTA: 4500; LEGAL FEES: 2000")).toEqual([4500, 2000]);
  });

  it("parses comma-separated RM amounts", () => {
    expect(parseMoneyAmountsFromText("RM4,500.00, RM2,000.00, RM300.00")).toEqual([4500, 2000, 300]);
  });
});

describe("calculateLoanAmounts", () => {
  it("sums all detected amounts into total loan", () => {
    expect(calculateLoanAmounts({
      financingSum: 780000,
      others: "4,500.00 AND LEGAL FEES OF RM2,000.00",
    })).toEqual({
      financingSum: 780000,
      detectedAmounts: [4500, 2000],
      othersTotal: 6500,
      totalLoan: 786500,
      totalLoanWords: "Ringgit Malaysia Seven Hundred Eighty Six Thousand Five Hundred",
    });
  });

  it("supports a single detected others amount", () => {
    expect(calculateLoanAmounts({
      financingSum: 780000,
      others: "MRTA OF RM 14,500.00",
    })).toEqual({
      financingSum: 780000,
      detectedAmounts: [14500],
      othersTotal: 14500,
      totalLoan: 794500,
      totalLoanWords: "Ringgit Malaysia Seven Hundred Ninety Four Thousand Five Hundred",
    });
  });

  it("treats blank others as zero without crashing", () => {
    expect(calculateLoanAmounts({
      financingSum: 780000,
      others: "",
    })).toEqual({
      financingSum: 780000,
      detectedAmounts: [],
      othersTotal: 0,
      totalLoan: 780000,
      totalLoanWords: "Ringgit Malaysia Seven Hundred Eighty Thousand",
    });
  });
});
