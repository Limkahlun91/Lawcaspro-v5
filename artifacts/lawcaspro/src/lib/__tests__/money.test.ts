import { describe, expect, it } from "vitest";
import { amountToEnglishWords, formatRMAmount, toMoneyNumber } from "../money";

describe("formatRMAmount", () => {
  it("formats decimal amounts with RM prefix and commas", () => {
    expect(formatRMAmount(1234567.89)).toBe("RM1,234,567.89");
  });

  it("formats integer amounts with two decimals", () => {
    expect(formatRMAmount(780000)).toBe("RM780,000.00");
  });

  it("formats numeric strings", () => {
    expect(formatRMAmount("794500")).toBe("RM794,500.00");
  });

  it("falls back to RM0.00 for null", () => {
    expect(formatRMAmount(null)).toBe("RM0.00");
  });

  it("formats negative values without adding spaces", () => {
    expect(formatRMAmount(-1234)).toBe("-RM1,234.00");
  });
});

describe("amountToEnglishWords", () => {
  it("formats mixed ringgit and sen amounts", () => {
    expect(amountToEnglishWords(1234567.89)).toBe(
      "Ringgit Malaysia One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven and Sen Eighty Nine",
    );
  });

  it("formats whole amounts with zero sen", () => {
    expect(amountToEnglishWords(780000)).toBe(
      "Ringgit Malaysia Seven Hundred Eighty Thousand",
    );
  });

  it("formats loan total amounts", () => {
    expect(amountToEnglishWords(794500)).toBe(
      "Ringgit Malaysia Seven Hundred Ninety Four Thousand Five Hundred",
    );
    expect(amountToEnglishWords(786500)).toBe(
      "Ringgit Malaysia Seven Hundred Eighty Six Thousand Five Hundred",
    );
  });

  it("formats sen values without trailing only", () => {
    expect(amountToEnglishWords(1000.5)).toBe(
      "Ringgit Malaysia One Thousand and Sen Fifty",
    );
  });

  it("formats zero amount explicitly", () => {
    expect(amountToEnglishWords(0)).toBe("Ringgit Malaysia Zero");
  });
});

describe("toMoneyNumber", () => {
  it("parses formatted strings safely", () => {
    expect(toMoneyNumber("RM1,234,567.89")).toBe(1234567.89);
  });
});
