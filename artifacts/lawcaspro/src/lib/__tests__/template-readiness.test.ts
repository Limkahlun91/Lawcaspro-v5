import { describe, expect, it } from "vitest";
import { blocksTemplateGenerate, templateFileReadinessLabel } from "../template-readiness";

describe("template-readiness", () => {
  it("missing_file blocks generate and labels as Missing template file", () => {
    expect(blocksTemplateGenerate("missing_file")).toBe(true);
    expect(templateFileReadinessLabel("missing_file")).toBe("Missing template file");
  });
});

