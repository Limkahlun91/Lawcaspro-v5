import { describe, expect, it } from "vitest";
import { formatLegalDate } from "../lib/documentVariables";

describe("formatLegalDate", () => {
  it("formats ISO yyyy-mm-dd", () => {
    expect(formatLegalDate("2026-05-01")).toBe("01.05.2026");
    expect(formatLegalDate("2026-12-05")).toBe("05.12.2026");
  });

  it("formats dd/mm/yyyy", () => {
    expect(formatLegalDate("01/05/2026")).toBe("01.05.2026");
  });

  it("formats dd Month yyyy", () => {
    expect(formatLegalDate("01 May 2026")).toBe("01.05.2026");
  });

  it("returns — for empty", () => {
    expect(formatLegalDate("")).toBe("—");
    expect(formatLegalDate(null)).toBe("—");
    expect(formatLegalDate(undefined)).toBe("—");
  });

  it("does not output Invalid Date", () => {
    expect(formatLegalDate("not a date")).toBe("—");
    expect(formatLegalDate("2026-99-99")).toBe("—");
  });
});

