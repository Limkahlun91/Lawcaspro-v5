import { describe, it, expect } from "vitest";
import {
  assertActiveSupportSessionForFirm,
  type FounderGovernanceContext,
} from "../services/founder-governance/index.js";

function baseCtx(partial: Partial<FounderGovernanceContext["impersonation"]> = {}): FounderGovernanceContext {
  return {
    actorUserId: 1001,
    actorEmail: "founder@lawcaspro.test",
    impersonation: {
      active: false,
      supportSessionId: null,
      targetFirmId: null,
      ...partial,
    },
    permissions: new Set(),
    highestRoleLevel: null,
  };
}

describe("G2-1 assertActiveSupportSessionForFirm — fail-closed perimeter", () => {
  it("G2-1.1 status=requested (no active session) → 403 PERMISSION_DENIED literal", () => {
    const ctx = baseCtx({
      active: false,
      supportSessionId: 42,
      targetFirmId: 7,
    });
    expect(() => assertActiveSupportSessionForFirm(ctx, 7)).toThrow(
      expect.objectContaining({
        status: 403,
        code: "PERMISSION_DENIED",
      }),
    );
  });

  it("G2-1.2 wrong targetFirmId → 403 PERMISSION_DENIED literal", () => {
    const ctx = baseCtx({
      active: true,
      supportSessionId: 42,
      targetFirmId: 7,
    });
    expect(() => assertActiveSupportSessionForFirm(ctx, 999)).toThrow(
      expect.objectContaining({
        status: 403,
        code: "PERMISSION_DENIED",
      }),
    );
  });

  it("G2-1.3 active session + targetFirmId match → PASS no throw", () => {
    const ctx = baseCtx({
      active: true,
      supportSessionId: 42,
      targetFirmId: 7,
    });
    expect(() => assertActiveSupportSessionForFirm(ctx, 7)).not.toThrow();
  });
});
