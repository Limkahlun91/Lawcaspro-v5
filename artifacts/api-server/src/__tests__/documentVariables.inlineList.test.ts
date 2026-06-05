import { describe, expect, it } from "vitest";
import { joinNamesWithAmpersand } from "../lib/documentVariables";

describe("documentVariables inline list formatting", () => {
  it("formats 1 item", () => {
    expect(joinNamesWithAmpersand(["A"])).toBe("A");
  });

  it("formats 2 items with ampersand", () => {
    expect(joinNamesWithAmpersand(["A", "B"])).toBe("A & B");
  });

  it("formats 3+ items with commas and ampersand", () => {
    expect(joinNamesWithAmpersand(["A", "B", "C"])).toBe("A, B & C");
    expect(joinNamesWithAmpersand(["A", "B", "C", "D"])).toBe("A, B, C & D");
  });
});

