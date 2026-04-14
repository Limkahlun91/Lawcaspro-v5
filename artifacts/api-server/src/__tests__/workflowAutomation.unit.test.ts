import { describe, it, expect } from "vitest";
import { deriveStatusFromRequirement } from "../lib/workflowAutomation";

describe("workflowAutomation", () => {
  it("derives keyDate-only completion", () => {
    expect(deriveStatusFromRequirement({ kind: "keyDate", keyDateField: "x" }, { keyDates: { x: null }, workflowDocs: {} })).toBe("missing_date");
    expect(deriveStatusFromRequirement({ kind: "keyDate", keyDateField: "x" }, { keyDates: { x: "2026-04-09" }, workflowDocs: {} })).toBe("completed");
  });

  it("derives date+file completion and missing states", () => {
    const req = { kind: "dateAndWorkflowDoc" as const, keyDateField: "d", docKey: "spa_stamped" as const };
    expect(deriveStatusFromRequirement(req, { keyDates: { d: null }, workflowDocs: {} })).toBe("incomplete");
    expect(deriveStatusFromRequirement(req, { keyDates: { d: "2026-04-09" }, workflowDocs: {} })).toBe("missing_file");
    expect(deriveStatusFromRequirement(req, { keyDates: { d: null }, workflowDocs: { spa_stamped: { hasFile: true } } })).toBe("missing_date");
    expect(deriveStatusFromRequirement(req, { keyDates: { d: "2026-04-09" }, workflowDocs: { spa_stamped: { hasFile: true } } })).toBe("completed");
  });
});
