import { describe, expect, it } from "vitest";
import { aggregateGenerationJobFailureSummary, isHeartbeatStale } from "../services/document-generation.service";
import { normalizeMissingRequiredVariables } from "../services/document-variable.service";

describe("document-generation.service", () => {
  it("aggregateGenerationJobFailureSummary includes item error codes", () => {
    const out = aggregateGenerationJobFailureSummary({
      successCount: 0,
      failedItems: [
        { status: "failed", errorCode: "TEMPLATE_OBJECT_PATH_MISSING", errorMessage: "Template object path is missing" },
        { status: "failed", errorCode: "OUTPUT_MISSING", errorMessage: "Generated file missing" },
      ],
    });
    expect(out.errorCode).toBe("GENERATION_FAILED");
    expect(out.errorSummary).toMatch(/TEMPLATE_OBJECT_PATH_MISSING/);
    expect(out.errorSummary).toMatch(/OUTPUT_MISSING/);
  });

  it("aggregateGenerationJobFailureSummary returns diagnosable fallback when success=0 and no failed message", () => {
    const out = aggregateGenerationJobFailureSummary({ successCount: 0, failedItems: [] });
    expect(out.errorCode).toBe("NO_OUTPUT_GENERATED");
    expect(out.errorSummary).toMatch(/Check item diagnostics/i);
  });

  it("isHeartbeatStale detects stale heartbeat", () => {
    const now = Date.now();
    expect(isHeartbeatStale(new Date(now - 10_000), 30_000, now)).toBe(false);
    expect(isHeartbeatStale(new Date(now - 60_000), 30_000, now)).toBe(true);
  });

  it("normalizeMissingRequiredVariables extracts list", () => {
    expect(normalizeMissingRequiredVariables({ missingRequiredVariables: ["a", "b"] })).toEqual(["a", "b"]);
    expect(normalizeMissingRequiredVariables({})).toEqual([]);
  });
});

