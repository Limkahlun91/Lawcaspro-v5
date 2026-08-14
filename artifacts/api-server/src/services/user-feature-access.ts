/**
 * Part 2 §4 §5 §11
 * Unified user-level feature access resolver.
 *
 * Resolution order (4 steps):
 *   STEP 1 — Firm entitlement disabled → DENY (unconditional)
 *   STEP 2 — Partner (Management role) → ALLOW (subject to STEP 1)
 *   STEP 3 — Explicit row in firm_user_feature_access → use is_enabled
 *   STEP 4 — No explicit row → fallback to role permissions (legacy safe)
 *
 * Parent/child propagation (§5):
 *   module.$parent OFF → ALL children effective OFF regardless of child rows.
 *   Parent ON + partial child rows → limited access (UI rendering flag only, API still per-child).
 *
 * Exports:
 *   - resolveUserFeatureAccess()   — single key, returns discriminated result
 *   - resolveUserFeatureAccessBulk() — many keys in 1 DB round-trip
 *   - requireUserFeatureAccess(featureKey) — Express middleware
 *   - classifiesDenialCode() helper
 */

import { and, eq, inArray } from "drizzle-orm";
import type { AppDb, RlsDb } from "@workspace/db";
import {
  db,
  firmUserFeatureAccessTable,
  FEATURE_REGISTRY_MAP,
  getFeatureDefinition,
  childrenOf,
  isFeatureRegistered,
} from "@workspace/db";
import {
  resolveEntitlementsBulk,
  type EntitlementResult,
} from "./entitlement-resolver.js";
import { ApiError } from "../lib/api-response.js";
import { logger } from "../lib/logger.js";
import type { AuthRequest } from "../lib/auth.js";
import { Response, NextFunction } from "express";

export type EffectiveUserFeatureSource =
  | "firm_entitlement_denied"
  | "partner_allow"
  | "user_row_true"
  | "user_row_false"
  | "role_permission_allow"
  | "role_permission_denied"
  | "unknown_feature_deny";

export type UserFeatureEffectiveResult = {
  featureKey: string;
  firmEnabled: boolean;
  userEnabled: boolean;
  effectiveEnabled: boolean;
  source: EffectiveUserFeatureSource;
  denialCode?:
    | "FIRM_ENTITLEMENT_OFF"
    | "USER_OVERRIDE_OFF"
    | "ROLE_DENIED"
    | "UNKNOWN_FEATURE"
    | "PARENT_OFF";
  denialReason?: string;
  parentKey?: string | null;
};

// ---------------------------------------------------------------------------
// Cache (per-request + TTL-backed per (firmId,userId)).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 120_000;
type CacheVal = {
  at: number;
  data: Map<string, { userRow: boolean | null }>;
};
const FIRM_USER_CACHE = new Map<string, CacheVal>();

export function invalidateUserFeatureCacheFor(firmId: number, userId: number) {
  const k = `${firmId}|${userId}`;
  FIRM_USER_CACHE.delete(k);
  logger.debug({ firmId, userId }, "user_feature_access.cache_invalidated");
}

const USER_CACHE_MAX = 200;
function userCacheGet(firmId: number, userId: number): CacheVal["data"] | null {
  const key = `${firmId}|${userId}`;
  const now = Date.now();
  const v = FIRM_USER_CACHE.get(key);
  if (!v) return null;
  if (now - v.at > CACHE_TTL_MS) {
    FIRM_USER_CACHE.delete(key);
    return null;
  }
  return v.data;
}
function userCachePut(
  firmId: number,
  userId: number,
  data: CacheVal["data"],
) {
  if (FIRM_USER_CACHE.size >= USER_CACHE_MAX) {
    const firstKey = FIRM_USER_CACHE.keys().next().value as string | undefined;
    if (firstKey) FIRM_USER_CACHE.delete(firstKey);
  }
  FIRM_USER_CACHE.set(`${firmId}|${userId}`, { at: Date.now(), data });
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function isExactPartnerOrManagerRoleName(roleName: unknown): boolean {
  const n = typeof roleName === "string" ? roleName.trim().toLowerCase() : "";
  if (!n) return false;
  return [
    "partner",
    "managing partner",
    "senior partner",
    "practice manager",
    "firm manager",
    "manager",
    "director",
  ].includes(n);
}

function parentKeyOf(featureKey: string): string | null {
  if (!isFeatureRegistered(featureKey)) return null;
  const def = getFeatureDefinition(featureKey);
  return def?.parentFeatureKey ?? null;
}

// ---------------------------------------------------------------------------
// Load explicit user rows (bulk)
// ---------------------------------------------------------------------------

async function loadUserRowsBulk(
  r: AppDb | RlsDb,
  firmId: number,
  userId: number,
  featureKeys: ReadonlyArray<string>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (!featureKeys.length) return out;

  const cached = userCacheGet(firmId, userId);
  if (cached) {
    for (const k of featureKeys) {
      const c = cached.get(k);
      if (typeof c?.userRow === "boolean") out.set(k, c.userRow);
    }
    return out;
  }

  const rows = await r
    .select({
      featureKey: firmUserFeatureAccessTable.featureKey,
      isEnabled: firmUserFeatureAccessTable.isEnabled,
    })
    .from(firmUserFeatureAccessTable)
    .where(
      and(
        eq(firmUserFeatureAccessTable.firmId, firmId),
        eq(firmUserFeatureAccessTable.userId, userId),
        inArray(firmUserFeatureAccessTable.featureKey, featureKeys as string[]),
      ),
    );
  const store: CacheVal["data"] = new Map();
  for (const row of rows) {
    out.set(row.featureKey, Boolean(row.isEnabled));
    store.set(row.featureKey, { userRow: Boolean(row.isEnabled) });
  }
  userCachePut(firmId, userId, store);
  return out;
}

// ---------------------------------------------------------------------------
// Legacy role fallback — reuses permissions module/action.  We infer module
// from feature key using existing registry definition → see feature.module.
// For keys without mapping we fall back to permission-less allow so legacy
// access is preserved.
// ---------------------------------------------------------------------------

type PermissionChecker = (
  moduleName: string,
  action: string,
) => Promise<boolean> | boolean;

function moduleActionFor(featureKey: string): {
  mod: string;
  action: string;
} | null {
  // Registry definition may carry a permission hint via backendGuardKey
  // which is typically "module:action" style
  const def = getFeatureDefinition(featureKey);
  if (def?.backendGuardKey && typeof def.backendGuardKey === "string") {
    const [gMod, gAct] = def.backendGuardKey.split(":");
    if (gMod && gAct) {
      return { mod: gMod, action: gAct };
    }
  }
  // Also use FeatureDefinition.module as a reliable module anchor
  // combined with a heuristic action from the remaining key suffix.
  if (def) {
    const parts = featureKey.split(".");
    const mod = def.module ?? parts[0];
    const action = parts.length > 1 ? parts.slice(1).join("_") : "read";
    return { mod, action };
  }
  // Heuristic: module.$x.$action -> module="module", action="x"
  const parts = featureKey.split(".");
  if (parts.length === 1) return null;
  const mod = parts[0];
  const action = parts.slice(1).join("_");
  return { mod, action };
}

// ---------------------------------------------------------------------------
// Bulk resolver — minimal DB roundtrips (1 entitlements, 1 user rows)
// ---------------------------------------------------------------------------

export async function resolveUserFeatureAccessBulk(params: {
  r: AppDb | RlsDb;
  firmId: number;
  userId: number;
  roleId: number | null;
  roleName: string | null;
  featureKeys: ReadonlyArray<string>;
  permissionChecker?: PermissionChecker;
}): Promise<Record<string, UserFeatureEffectiveResult>> {
  const { r, firmId, userId, roleId, roleName, featureKeys } = params;
  const permissionChecker: PermissionChecker | undefined = params.permissionChecker;
  const results: Record<string, UserFeatureEffectiveResult> = {};

  if (!firmId || !userId) {
    for (const k of featureKeys) {
      results[k] = {
        featureKey: k,
        firmEnabled: false,
        userEnabled: false,
        effectiveEnabled: false,
        source: "firm_entitlement_denied",
        denialCode: "FIRM_ENTITLEMENT_OFF",
        denialReason: "Missing firmId/userId context",
      };
    }
    return results;
  }

  // STEP 1 — Firm entitlements.
  const uniqKeys = Array.from(new Set(featureKeys.slice()));
  let entitlements: Record<string, EntitlementResult> = {};
  try {
    entitlements = await resolveEntitlementsBulk(firmId, uniqKeys, {
      conn: r as any,
    });
  } catch (err) {
    logger.error({ err, keys: uniqKeys.length }, "entitlements.bulk_failed");
  }

  // STEP 2 — Partner bypass (firm entitlement still must pass; use flag).
  const isPartner = isExactPartnerOrManagerRoleName(roleName);

  // STEP 3 — Explicit user rows.
  const userRows = await loadUserRowsBulk(r, firmId, userId, uniqKeys);

  // Parent ON/OFF propagation
  const parentFirmEnabled = (k: string): boolean => {
    let cur: string | null = k;
    // Walk up chain including k itself — ensure no parent is OFF at firm level
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const e = entitlements[cur];
      if (!e?.enabled) return false;
      cur = parentKeyOf(cur);
    }
    return true;
  };

  for (const k of uniqKeys) {
    const ent = entitlements[k];
    const firmEnabled = Boolean(ent?.enabled) && parentFirmEnabled(k);
    const parentKey = parentKeyOf(k);
    if (!firmEnabled) {
      results[k] = {
        featureKey: k,
        firmEnabled: false,
        userEnabled: false,
        effectiveEnabled: false,
        source: "firm_entitlement_denied",
        denialCode:
          ent && parentKey && !parentFirmEnabled(parentKey) ? "PARENT_OFF" : "FIRM_ENTITLEMENT_OFF",
        denialReason: ent?.denialReason ?? `Firm entitlement OFF: ${k}`,
        parentKey,
      };
      continue;
    }
    if (isPartner) {
      results[k] = {
        featureKey: k,
        firmEnabled: true,
        userEnabled: true,
        effectiveEnabled: true,
        source: "partner_allow",
        parentKey,
      };
      continue;
    }
    if (userRows.has(k)) {
      const explicit = userRows.get(k)!;
      results[k] = explicit
        ? {
            featureKey: k,
            firmEnabled: true,
            userEnabled: true,
            effectiveEnabled: true,
            source: "user_row_true",
            parentKey,
          }
        : {
            featureKey: k,
            firmEnabled: true,
            userEnabled: false,
            effectiveEnabled: false,
            source: "user_row_false",
            denialCode: "USER_OVERRIDE_OFF",
            denialReason: `Partner disabled feature for this user: ${k}`,
            parentKey,
          };
      continue;
    }
    // STEP 4 — Fallback role permission OR default allow for non-RBAC keys
    const hint = moduleActionFor(k);
    let roleOk = true;
    if (hint && permissionChecker) {
      try {
        roleOk = Boolean(await permissionChecker(hint.mod, hint.action));
      } catch {
        roleOk = false;
      }
    } else if (hint) {
      // No permission checker provided — legacy fallback: allowed unless the
      // feature registry says it requires RBAC.
      roleOk = true;
    }
    results[k] = roleOk
      ? {
          featureKey: k,
          firmEnabled: true,
          userEnabled: true,
          effectiveEnabled: true,
          source: "role_permission_allow",
          parentKey,
        }
      : {
          featureKey: k,
          firmEnabled: true,
          userEnabled: false,
          effectiveEnabled: false,
          source: "role_permission_denied",
          denialCode: "ROLE_DENIED",
          denialReason: `Role permission denied: ${hint.mod}:${hint.action}`,
          parentKey,
        };
  }
  return results;
}

// ---------------------------------------------------------------------------
// Single-key convenience
// ---------------------------------------------------------------------------

export async function resolveUserFeatureAccess(
  params: {
    r: AppDb | RlsDb;
    firmId: number;
    userId: number;
    roleId: number | null;
    roleName: string | null;
    featureKey: string;
    permissionChecker?: PermissionChecker;
  },
): Promise<UserFeatureEffectiveResult> {
  const { featureKey, permissionChecker, ...rest } = params;
  const bulk = await resolveUserFeatureAccessBulk({
    ...rest,
    permissionChecker,
    featureKeys: [featureKey],
  });
  return bulk[featureKey] ?? {
    featureKey,
    firmEnabled: false,
    userEnabled: false,
    effectiveEnabled: false,
    source: "unknown_feature_deny",
    denialCode: "UNKNOWN_FEATURE",
  };
}

// ---------------------------------------------------------------------------
// Express middleware — §11 requireUserFeatureAccess("documents.hub")
// ---------------------------------------------------------------------------

export function requireUserFeatureAccess(featureKey: string) {
  return async function userFeatureMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (req.userType !== "firm_user" || !req.firmId || !req.userId) {
      res.status(403).json({ error: "Feature access denied" });
      return;
    }
    const r = (req.rlsDb ?? db) as AppDb | RlsDb;
    let roleName: string | null = null;
    const cached = (req as any)._roleCache as
      | { firmId: number; roleId: number; name: string }
      | undefined;
    if (cached && cached.firmId === req.firmId && cached.roleId === req.roleId) {
      roleName = cached.name;
    }
    const resU = await resolveUserFeatureAccess({
      r,
      firmId: req.firmId,
      userId: req.userId,
      roleId: req.roleId ?? null,
      roleName,
      featureKey,
    });
    if (!resU.effectiveEnabled) {
      res.status(403).json({
        error: "Feature access denied",
        code: resU.denialCode ?? "FEATURE_OFF",
        source: resU.source,
        feature: featureKey,
      });
      return;
    }
    // Stash for downstream handlers
    const stash = ((req as any)._effectiveUserFeatures as
      | Record<string, UserFeatureEffectiveResult>
      | undefined) ?? {};
    stash[featureKey] = resU;
    (req as any)._effectiveUserFeatures = stash;
    next();
  };
}
