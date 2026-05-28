import { describe, expect, it } from "vitest";
import { normalizeAssignedToUserIdParam } from "../cases/case-filter-utils";

describe("cases milestone drilldown filters", () => {
  it("normalizes assignedToUserId for non-partner users", () => {
    expect(normalizeAssignedToUserIdParam("123", { myUserId: 5, isPartnerOrManager: false })).toBe("5");
  });

  it("keeps assignedToUserId for partner users", () => {
    expect(normalizeAssignedToUserIdParam("123", { myUserId: 5, isPartnerOrManager: true })).toBe("123");
  });

  it("returns all for invalid values", () => {
    expect(normalizeAssignedToUserIdParam(null, { myUserId: 5, isPartnerOrManager: true })).toBe("all");
    expect(normalizeAssignedToUserIdParam("0", { myUserId: 5, isPartnerOrManager: true })).toBe("all");
    expect(normalizeAssignedToUserIdParam("abc", { myUserId: 5, isPartnerOrManager: true })).toBe("all");
  });
});

