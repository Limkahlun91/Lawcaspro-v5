import { describe, it, expect } from "vitest";
import { applyResolvedAliases, resolveCustomVariables } from "../lib/customVariables";

describe("customVariables", () => {
  it("renders unknown placeholders as blank", () => {
    const out = resolveCustomVariables({
      customVariables: [{ key: "property_full_description", bodyTemplate: "Hello {{unknown_token}}" }],
      baseResolved: {},
      maxDepth: 5,
    });
    expect(out.resolved.property_full_description).toBe("Hello ");
    expect(out.warnings).toEqual([]);
  });

  it("prevents self recursion", () => {
    const out = resolveCustomVariables({
      customVariables: [{ key: "a", bodyTemplate: "{{a}}" }],
      baseResolved: {},
      maxDepth: 5,
    });
    expect(out.resolved.a).toBeNull();
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it("prevents mutual recursion", () => {
    const out = resolveCustomVariables({
      customVariables: [
        { key: "a", bodyTemplate: "{{b}}" },
        { key: "b", bodyTemplate: "{{a}}" },
      ],
      baseResolved: {},
      maxDepth: 5,
    });
    expect(out.resolved.a).toBeNull();
    expect(out.resolved.b).toBeNull();
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it("applies variable aliases without overwriting existing keys", () => {
    const base = { to: "1", from: "keep" } as Record<string, unknown>;
    const out = applyResolvedAliases(base, [{ fromKey: "from", toKey: "to", isActive: true }]);
    expect(out.resolved.from).toBe("keep");
    expect(out.usedAliases).toEqual([]);
  });

  it("applies variable aliases when fromKey is missing", () => {
    const base = { to: "1" } as Record<string, unknown>;
    const out = applyResolvedAliases(base, [{ fromKey: "from", toKey: "to", isActive: true }]);
    expect(out.resolved.from).toBe("1");
    expect(out.usedAliases).toEqual(["from"]);
  });
});

