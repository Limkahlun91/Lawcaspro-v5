import { describe, it, expect } from "vitest";
import { isLoanStampingItemKeyAllowedForTitleType, normalizeTitleType } from "../lib/loanStamping";

describe("loanStamping", () => {
  it("normalizes title types safely", () => {
    expect(normalizeTitleType(null)).toBeNull();
    expect(normalizeTitleType("")).toBeNull();
    expect(normalizeTitleType("master title")).toBe("master");
    expect(normalizeTitleType("master_title")).toBe("master");
    expect(normalizeTitleType("strata title")).toBe("strata");
    expect(normalizeTitleType("individual title")).toBe("individual");
  });

  it("enforces per-title-type stamping item keys", () => {
    expect(isLoanStampingItemKeyAllowedForTitleType("master", "deed_of_assignment")).toBe(true);
    expect(isLoanStampingItemKeyAllowedForTitleType("master", "power_of_attorney")).toBe(true);
    expect(isLoanStampingItemKeyAllowedForTitleType("master", "charge_annexure")).toBe(false);

    expect(isLoanStampingItemKeyAllowedForTitleType("strata", "charge_annexure")).toBe(true);
    expect(isLoanStampingItemKeyAllowedForTitleType("individual", "charge_annexure")).toBe(true);
    expect(isLoanStampingItemKeyAllowedForTitleType("strata", "deed_of_assignment")).toBe(false);
    expect(isLoanStampingItemKeyAllowedForTitleType("individual", "power_of_attorney")).toBe(false);
  });
});

