import { describe, it, expect } from "vitest";
import { parseDateOnlyInput } from "../lib/dateOnly";

describe("dateOnly.parseDateOnlyInput", () => {
  it("handles null/empty/ymd/datetime/invalid predictably", () => {
    expect(parseDateOnlyInput(null)).toBeNull();
    expect(parseDateOnlyInput("")).toBeNull();
    expect(parseDateOnlyInput("   ")).toBeNull();
    expect(parseDateOnlyInput("2026-04-09")).toBe("2026-04-09");
    expect(parseDateOnlyInput("2026-04-09T00:00:00.000Z")).toBe("2026-04-09");
    expect(parseDateOnlyInput("2026-13-01")).toBeUndefined();
    expect(parseDateOnlyInput("not-a-date")).toBeUndefined();
  });
});

