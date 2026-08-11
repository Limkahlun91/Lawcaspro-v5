/**
 * Platform ↔ Firm Feature Control (canonical service, Part 1A).
 *
 * Reuses the existing 9-layer EntitlementResolver (entitlement-resolver.ts)
 * as the single source of truth.  This module provides the narrower, typed
 * interface specified in Part 1A:
 *
 *   FirmFeatureState
 *   getEffectiveFirmFeatures(db, firmId) → Map<featureKey, FirmFeatureState>
 *   assertFirmFeatureEnabled(db, firmId, featureKey) → void
 *
 * Priority (documented here for clarity; enforcement lives in resolver):
 *   ACTIVE temporary override  >  Founder permanent override
 *   >  Plan default  >  registry default
 *
 * Founder Admin UI enable/disable/inherit uses entitlements routes; this
 * module exposes the typed read-side used by guards and downstream logic.
 */

import type { AppDb, RlsDb } from "@workspace/db";
import {
  resolveEntitlementsBulk,
  getEffectiveEntitlement,
  type EntitlementResult,
} from "../../services/entitlement-resolver.js";
import { isFeatureRegistered, FEATURE_REGISTRY } from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";

export type FirmFeatureOverrideSource =
  | "plan"
  | "founder_override"
  | "temporary_override"
  | "registry_default";

export interface FirmFeatureState {
  featureKey: string;
  enabled: boolean;
  source: FirmFeatureOverrideSource;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
}

function mapSource(r: EntitlementResult["source"]): FirmFeatureOverrideSource {
  switch (r) {
    case "firm_override_temporary":
      return "temporary_override";
    case "firm_override_permanent":
      return "founder_override";
    case "plan_entitlement":
      return "plan";
    case "feature_default":
    case "denial":
    default:
      return "registry_default";
  }
}

/**
 * Return the effective feature map for a firm.  Keys = ALL registered
 * features (consistent with canonical feature registry), not just those
 * with plan-level entitlements rows.
 */
export async function getEffectiveFirmFeatures(
  dbConn: AppDb | RlsDb,
  firmId: number,
): Promise<Map<string, FirmFeatureState>> {
  const allKeys = FEATURE_REGISTRY.map((f) => f.featureKey);
  const resolved = await resolveEntitlementsBulk(firmId, allKeys, {
    conn: dbConn,
  });
  const out = new Map<string, FirmFeatureState>();
  for (const key of allKeys) {
    const r = resolved[key];
    out.set(key, {
      featureKey: key,
      enabled: !!r?.enabled,
      source: r ? mapSource(r.source) : "registry_default",
      effectiveFrom: null,
      effectiveUntil: null,
    });
  }
  return out;
}

/**
 * Fail-closed guard: throws ApiError 403 FEATURE_DISABLED when the feature
 * is off for the firm.  Matches the contract from Part 1A §Disabled.
 */
export async function assertFirmFeatureEnabled(
  dbConn: AppDb | RlsDb,
  firmId: number,
  featureKey: string,
): Promise<void> {
  if (!isFeatureRegistered(featureKey)) {
    throw new ApiError({
      status: 403,
      code: "FEATURE_DISABLED",
      message: `Feature disabled for this firm: ${featureKey} (not registered)`,
      retryable: false,
      details: { featureKey, error: "Feature disabled for this firm", code: "FEATURE_DISABLED" },
    });
  }
  const r = await getEffectiveEntitlement(firmId, featureKey, {
    conn: dbConn,
  });
  if (!r.enabled) {
    throw new ApiError({
      status: 403,
      code: "FEATURE_DISABLED",
      message: `Feature disabled for this firm`,
      retryable: false,
      details: {
        featureKey,
        error: "Feature disabled for this firm",
        code: "FEATURE_DISABLED",
        source: r.source,
        denial: r.denied,
      },
    });
  }
}
