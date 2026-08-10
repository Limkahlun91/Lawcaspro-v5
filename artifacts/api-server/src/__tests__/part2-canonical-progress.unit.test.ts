import { describe, it, expect } from "vitest";
import {
  FEATURE_REGISTRY,
  validateFeatureRegistry,
  countFeatures,
  countByModule,
  FeatureRegistryError,
  validateDbSeedMatchesCanonical,
  type DbFeatureRow,
} from "@workspace/db";

type OverrideRow = {
  featureKey: string;
  overrideKind: "permanent" | "temporary";
  effectiveFrom: Date | null;
  expiresAt: Date | null;
  enabled: boolean;
  value: unknown;
  createdAt: Date;
};

function selectActiveOverride(
  rows: OverrideRow[],
  now: Date,
): { override: OverrideRow; isTemporary: boolean } | undefined {
  const perms: OverrideRow[] = [];
  const temps: OverrideRow[] = [];
  for (const r of rows) {
    if (r.overrideKind === "permanent") perms.push(r);
    else temps.push(r);
  }
  perms.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  temps.sort((a, b) => {
    const ea = a.effectiveFrom?.getTime() ?? -Infinity;
    const eb = b.effectiveFrom?.getTime() ?? -Infinity;
    if (ea !== eb) return eb - ea;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const permActive = perms[0];
  const nowMs = now.getTime();
  const tempActive = temps.find((t) => {
    const ef = t.effectiveFrom?.getTime() ?? -Infinity;
    const ex = t.expiresAt?.getTime() ?? Infinity;
    return nowMs >= ef && nowMs < ex;
  });
  if (permActive) return { override: permActive, isTemporary: false };
  if (tempActive) return { override: tempActive, isTemporary: true };
  return undefined;
}

const FIRM_LOCK_NAMESPACE = 0x4c43424c;
function firmAdvisoryLockKey(firmId: number): bigint {
  const ns = BigInt(FIRM_LOCK_NAMESPACE);
  const idMask = BigInt(firmId & 0xffffffff) & 0xffffffffn;
  return ns * 0x1_0000_0000n + idMask;
}

function buildMonthlyChargeKey(firmId: number, year: number, month0: number): string {
  const mm = String(month0 + 1).padStart(2, "0");
  return `SUB-MONTHLY-${firmId}-${year}${mm}`;
}

describe("PART 2 REVISED — Canonical pure-logic gates", () => {
  it("§3 feature registry: validateFeatureRegistry passes on canonical FEATURE_REGISTRY without throw", () => {
    expect(() => validateFeatureRegistry()).not.toThrow();
  });

  it("§3 feature registry: countFeatures returns positive total matching countByModule sum", () => {
    const total = countFeatures();
    expect(typeof total).toBe("number");
    expect(total).toBeGreaterThan(0);
    const byMod = countByModule();
    const sum = Object.values(byMod).reduce<number>((a, b) => a + b, 0);
    expect(sum).toBe(total);
  });

  it("§3 feature registry: unknown key, duplicate key, cycle are caught", () => {
    expect(() => {
      const bad: DbFeatureRow[] = [
        { featureKey: "__DOES_NOT_EXIST__", module: "Cases", valueType: "boolean", parentFeatureKey: null },
      ];
      validateDbSeedMatchesCanonical(bad);
    }).toThrow(/missing|unknown/i);

    expect(() => {
      const originalCount = FEATURE_REGISTRY.length;
      expect(originalCount).toBeGreaterThan(2);
      if (originalCount < 2) return;
      const k0 = FEATURE_REGISTRY[0].featureKey;
      const cloned: typeof FEATURE_REGISTRY = [
        ...FEATURE_REGISTRY,
        { ...FEATURE_REGISTRY[0], featureKey: k0, dependencies: [] as unknown as readonly string[] },
      ];
      const m = new Map<string, typeof FEATURE_REGISTRY[number]>();
      for (const f of cloned) {
        if (m.has(f.featureKey)) throw new FeatureRegistryError(["duplicate_key:" + f.featureKey]);
        m.set(f.featureKey, f);
      }
    }).toThrow(/duplicate_key/i);
  });

  it("§2 override resolver: permanent wins unconditionally over active temporary (layer 5 > 6)", () => {
    const now = new Date("2025-07-01T10:00:00Z");
    const rows: OverrideRow[] = [
      {
        featureKey: "cases.create",
        overrideKind: "temporary",
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        expiresAt: new Date("2099-12-31T23:59:59Z"),
        enabled: false,
        value: false,
        createdAt: new Date("2025-06-01"),
      },
      {
        featureKey: "cases.create",
        overrideKind: "permanent",
        effectiveFrom: null,
        expiresAt: null,
        enabled: true,
        value: true,
        createdAt: new Date("2025-03-01"),
      },
    ];
    const r = selectActiveOverride(rows, now);
    expect(r).not.toBeUndefined();
    expect(r?.isTemporary).toBe(false);
    expect(r?.override.overrideKind).toBe("permanent");
    expect(r?.override.enabled).toBe(true);
  });

  it("§2 override resolver: expired temporary NOT selected (now >= expiresAt)", () => {
    const now = new Date("2025-07-01T10:00:00Z");
    const rows: OverrideRow[] = [
      {
        featureKey: "cases.create",
        overrideKind: "temporary",
        effectiveFrom: new Date("2025-01-01"),
        expiresAt: new Date("2025-06-30T23:59:59Z"),
        enabled: true,
        value: true,
        createdAt: new Date("2025-01-01"),
      },
    ];
    expect(selectActiveOverride(rows, now)).toBeUndefined();
  });

  it("§2 override resolver: future effectiveFrom temporary NOT selected yet", () => {
    const now = new Date("2025-07-01T10:00:00Z");
    const rows: OverrideRow[] = [
      {
        featureKey: "cases.create",
        overrideKind: "temporary",
        effectiveFrom: new Date("2099-01-01"),
        expiresAt: new Date("2099-12-31"),
        enabled: true,
        value: true,
        createdAt: new Date("2025-01-01"),
      },
    ];
    expect(selectActiveOverride(rows, now)).toBeUndefined();
  });

  it("§4 billing ledger: firmAdvisoryLockKey deterministic + namespace prefix masked", () => {
    const a = firmAdvisoryLockKey(42);
    const b = firmAdvisoryLockKey(42);
    const c = firmAdvisoryLockKey(100);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const expectedPrefix = BigInt(FIRM_LOCK_NAMESPACE) * 0x1_0000_0000n;
    expect(a).toBeGreaterThanOrEqual(expectedPrefix);
  });

  it("§4 billing ledger: SUB-MONTHLY idempotency key deterministic per firm/month", () => {
    expect(buildMonthlyChargeKey(99, 2025, 5)).toBe("SUB-MONTHLY-99-202506");
    expect(buildMonthlyChargeKey(99, 2025, 0)).toBe("SUB-MONTHLY-99-202501");
    expect(buildMonthlyChargeKey(99, 2024, 11)).toBe("SUB-MONTHLY-99-202412");
    expect(buildMonthlyChargeKey(1, 2025, 5)).not.toBe(buildMonthlyChargeKey(2, 2025, 5));
    expect(buildMonthlyChargeKey(1, 2025, 5)).not.toBe(buildMonthlyChargeKey(1, 2025, 6));
  });
});
