/**
 * Entitlement Resolver — Centralized service for Firm entitlements.
 *
 * Resolution order (any DENY wins; any layer can return undefined to fall through):
 *   1. Platform feature global status (emergency_disabled / inactive)
 *   2. Emergency kill switch (global override)
 *   3. Firm subscription status policy (suspended/past_due → denials)
 *   4. Base plan entitlement (plan_entitlements)
 *   5. Firm permanent entitlement override (firm_entitlement_overrides, expires_at NULL or future)
 *   6. Temporary override (within effective_from / expires_at)
 *   7. Parent feature check (chain up to root; if parent DENY → child DENY)
 *   8. Dependency check (all dependencies enabled)
 *   9. Result
 *
 * To avoid N+1, the resolver supports bulk resolution: getEffectiveEntitlements(firmId, featureKeys[])
 * which pre-loads all features, plan entitlements, and firm overrides in single queries.
 */

import { and, eq, isNull, or, gte, lte, sql, inArray } from "drizzle-orm";
import {
  db,
  firmsTable,
  subscriptionPlansTable,
  platformFeaturesTable,
  planEntitlementsTable,
  firmEntitlementOverridesTable,
  type AppDb,
  type RlsDb,
  FEATURE_REGISTRY_MAP,
  isFeatureRegistered,
  getFeatureDefinition,
  childrenOf,
  descendantsOf,
  type FeatureDefinition,
} from "@workspace/db";
import { ApiError } from "../lib/api-response.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// In-memory entitlement cache + dirty-tracking invalidation (Part 2 §8 §9)
// ---------------------------------------------------------------------------
//
// Strategy:
//   - Cache is per (firmId, actingAsFounderFlag) → result + resolvedAt ms.
//   - TTL = DEFAULT_TTL_MS; on mutation (override upsert/delete) caller calls
//     setFirmEntitlementsCacheDirty(firmId) or setGlobalCacheDirty() so the
//     NEXT navigation/API call sees new state immediately (no logout needed).
//
// Emergency kill switches:
//   - Global emergency sets feature.status via routes; resolver reads DB.
//   - Invalidation is guaranteed by calling setGlobalCacheDirty() on emergency toggle.

const DEFAULT_TTL_MS = 60_000; // 1 min
const MAX_CACHE_ENTRY_BYTES = 2_000_000; // ~2MB per firm entry guard; soft.

interface CacheEntry {
  firmId: number;
  actingAsFounder: boolean;
  keysFingerprint: string; // "all" for bulk load of registry keys
  data: Record<string, EntitlementResult>;
  resolvedAt: number;
  ttlMs: number;
}

const FIRM_CACHE = new Map<string, CacheEntry>();
const GLOBALLY_DIRTY_ATOMIC = { v: 0 };
const FIRM_DIRTY_ATOMIC = new Map<number, number>(); // firmId → dirty epoch

function cacheKey(firmId: number, actingAsFounder: boolean, fp: string): string {
  return `${firmId}::${actingAsFounder ? 1 : 0}::${fp}`;
}

export function setGlobalCacheDirty(): void {
  GLOBALLY_DIRTY_ATOMIC.v += 1;
  FIRM_CACHE.clear();
  FIRM_DIRTY_ATOMIC.clear();
  logger.info({ epoch: GLOBALLY_DIRTY_ATOMIC.v }, "entitlement.cache.global_dirty");
}

export function setFirmEntitlementsCacheDirty(firmId: number): void {
  const next = (FIRM_DIRTY_ATOMIC.get(firmId) ?? 0) + 1;
  FIRM_DIRTY_ATOMIC.set(firmId, next);
  // Remove any entry for the firm across actingAsFounder variants
  for (const k of Array.from(FIRM_CACHE.keys())) {
    if (k.startsWith(`${firmId}::`)) FIRM_CACHE.delete(k);
  }
  logger.debug({ firmId, epoch: next }, "entitlement.cache.firm_dirty");
}

export function _resetEntitlementCacheForTests(): void {
  FIRM_CACHE.clear();
  FIRM_DIRTY_ATOMIC.clear();
  GLOBALLY_DIRTY_ATOMIC.v = 0;
}

let _registryAllKeysFingerprint: string | undefined;
function allRegistryKeysFingerprint(): string {
  if (_registryAllKeysFingerprint) return _registryAllKeysFingerprint;
  const nRegistry = Array.from(FEATURE_REGISTRY_MAP.keys()).slice().sort().join("|");
  let hash = 0;
  for (let i = 0; i < nRegistry.length; i++) hash = (hash * 31 + nRegistry.charCodeAt(i)) | 0;
  _registryAllKeysFingerprint = `r${FEATURE_REGISTRY_MAP.size}#${hash}`;
  return _registryAllKeysFingerprint;
}


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DenialCode =
  | "feature_not_found"
  | "feature_inactive"
  | "global_emergency_disabled"
  | "subscription_trial"
  | "subscription_past_due"
  | "subscription_suspended"
  | "subscription_cancelled"
  | "subscription_expired"
  | "subscription_unknown_policy"
  | "plan_entitlement_denied"
  | "firm_override_disabled"
  | "parent_disabled"
  | "dependency_not_met"
  | "founder_only_denied"
  | "read_only_mode";

export interface EntitlementResult {
  featureKey: string;
  enabled: boolean;
  /**
   * Resolved raw value (after override application):
   *   boolean | number | string | null | { [k]: string } | undefined
   */
  value: unknown;
  valueType: "boolean" | "integer" | "decimal" | "string" | "config" | "unlimited";
  /**
   * If limit-type feature, the numeric cap (or Infinity for unlimited).
   */
  limit?: number;
  /**
   * Billing classification for the effective entitlement.
   */
  billingType?: "included" | "paid_addon" | "complimentary" | "trial";
  priceOverride?: string | null;
  /**
   * Source of the winning result (for debugging / audit).
   */
  source:
    | "feature_default"
    | "plan_entitlement"
    | "firm_override_permanent"
    | "firm_override_temporary"
    | "denial";
  denied?: DenialCode;
  denialReason?: string;
  /**
   * Chain of parent feature keys that were consulted.
   */
  parentChain?: string[];
}

export interface SubscriptionPolicyDecision {
  status: "trial" | "active" | "past_due" | "suspended" | "cancelled" | "expired";
  readonly: boolean;
  paidFeaturesDisabled: boolean;
  allowWrite: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const isDefined = (v: unknown): boolean => v !== undefined && v !== null;

const coerceBoolean = (v: unknown): boolean | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled"].includes(s)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(s)) return false;
  }
  return undefined;
};

const coerceNumber = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    if (v === "unlimited" || v === "∞" || v === "inf") return Infinity;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

interface PlanEntitlementRow {
  featureKey: string;
  valueJson: unknown;
}

interface OverrideRow {
  featureKey: string;
  overrideKind: string;        // 'permanent' | 'temporary'
  overrideMode: string;
  valueJson: unknown;
  effectiveFrom: Date | null;
  expiresAt: Date | null;
  billingType: string;
  priceOverride: string | null;
}

interface FirmContext {
  firmId: number;
  subscriptionStatus: string;
  planId: number;
  isCustomPlan: boolean;
  customPriceMonthly: string | null;
}

async function loadFirmContext(firmId: number, conn: AppDb | RlsDb): Promise<FirmContext> {
  const rows = await conn
    .select({
      id: firmsTable.id,
      subscriptionStatus: firmsTable.subscriptionStatus,
      planId: firmsTable.subscriptionPlanId,
      isCustomPlan: firmsTable.isCustomPlan,
      customPriceMonthly: firmsTable.customPriceMonthly,
    })
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiError({ status: 404, code: "FIRM_NOT_FOUND", message: `Firm ${firmId} not found`, retryable: false });
  return {
    firmId: row.id,
    subscriptionStatus: String(row.subscriptionStatus ?? "active"),
    planId: Number(row.planId),
    isCustomPlan: !!row.isCustomPlan,
    customPriceMonthly: row.customPriceMonthly ? String(row.customPriceMonthly) : null,
  };
}

// ---------------------------------------------------------------------------
// Subscription access policy (layer 3)
// ---------------------------------------------------------------------------

export function resolveSubscriptionPolicy(firmContext: FirmContext): SubscriptionPolicyDecision {
  const s = (firmContext.subscriptionStatus || "active").toLowerCase();
  switch (s) {
    case "trial":
      return { status: "trial", readonly: false, paidFeaturesDisabled: true, allowWrite: true };
    case "active":
      return { status: "active", readonly: false, paidFeaturesDisabled: false, allowWrite: true };
    case "past_due":
      return { status: "past_due", readonly: false, paidFeaturesDisabled: true, allowWrite: true };
    case "suspended":
      return { status: "suspended", readonly: true, paidFeaturesDisabled: true, allowWrite: false };
    case "cancelled":
      return { status: "cancelled", readonly: true, paidFeaturesDisabled: true, allowWrite: false };
    case "expired":
      return { status: "expired", readonly: true, paidFeaturesDisabled: true, allowWrite: false };
    default:
      // Unknown → treat as suspended (fail-closed)
      logger.warn({ subscriptionStatus: s, firmId: firmContext.firmId }, "entitlement.unknown_subscription_status");
      return { status: "suspended", readonly: true, paidFeaturesDisabled: true, allowWrite: false };
  }
}

// ---------------------------------------------------------------------------
// Bulk resolver
// ---------------------------------------------------------------------------

export interface ResolveBulkOptions {
  conn?: AppDb | RlsDb;
  actingAsFounder?: boolean;
}

export async function resolveEntitlementsBulk(
  firmId: number,
  featureKeys: readonly string[],
  opts: ResolveBulkOptions = {},
): Promise<Record<string, EntitlementResult>> {
  const conn = opts.conn ?? db;

  if (featureKeys.length === 0) return {};

  // ── Pre-filter: unknown/unregistered configurable features = DENY BY DEFAULT (Part 2 §11)
  const known: string[] = [];
  const unknownResults: Record<string, EntitlementResult> = {};
  for (const k of featureKeys) {
    if (isFeatureRegistered(k)) known.push(k);
    else unknownResults[k] = deny(k, "feature_not_found", `Feature not registered in global feature registry (deny by default): ${k}`);
  }
  if (known.length === 0) return unknownResults;

  // ── Cache lookup (short-circuit if all keys = fingerprint all-registry)
  const fingerprintAll = allRegistryKeysFingerprint();
  const fp =
    featureKeys.length === FEATURE_REGISTRY_MAP.size ? fingerprintAll : `s${featureKeys.length}#${featureKeys.slice().sort().join("|")}`;
  const ck = cacheKey(firmId, !!opts.actingAsFounder, fp);
  const existing = FIRM_CACHE.get(ck);
  const nowMs = Date.now();
  if (existing && nowMs - existing.resolvedAt < existing.ttlMs) {
    // Prune requested subset (if existing stored ALL, return subset)
    if (featureKeys.length === FEATURE_REGISTRY_MAP.size) {
      return { ...existing.data, ...unknownResults };
    }
    const out: Record<string, EntitlementResult> = { ...unknownResults };
    for (const k of featureKeys) if (existing.data[k]) out[k] = existing.data[k];
    return out;
  }

  const firm = await loadFirmContext(firmId, conn);
  const policy = resolveSubscriptionPolicy(firm);

  // (1) load features (including parents reachable from input keys)
  const featuresById = new Map<string, typeof platformFeaturesTable.$inferSelect>();
  {
    // For known keys, also walk registry to add all ancestors + dependencies to DB fetch set
    const need = new Set<string>(known);
    for (const k of known) {
      const def = getFeatureDefinition(k);
      if (!def) continue;
      // ancestors
      let cur: typeof def | undefined = def;
      while (cur?.parentFeatureKey) {
        need.add(cur.parentFeatureKey);
        cur = getFeatureDefinition(cur.parentFeatureKey);
      }
      for (const d of def.dependencies ?? []) need.add(d);
    }
    const q = conn
      .select()
      .from(platformFeaturesTable)
      .where(inArray(platformFeaturesTable.featureKey, Array.from(need)));
    const rows = await q;
    for (const r of rows) featuresById.set(r.featureKey, r);
    // ── If a row is missing in DB (registry has it, DB not seeded yet), fabricate from registry so resolver works.
    for (const k of need) {
      if (!featuresById.has(k)) {
        const def = getFeatureDefinition(k);
        if (def) {
          featuresById.set(k, {
            id: -1,
            featureKey: def.featureKey,
            name: def.name,
            module: def.module,
            parentFeatureKey: def.parentFeatureKey ?? null,
            valueType: def.valueType as any,
            defaultValue: JSON.stringify({ v: def.defaultValue }) as any,
            configurable: def.configurable !== false,
            founderOnly: !!def.founderOnly,
            dependencyJson: (def.dependencies && def.dependencies.length > 0 ? def.dependencies : null) as any,
            routeHint: def.routeHint ?? null,
            description: def.description ?? null,
            sortOrder: def.sortOrder ?? 0,
            status: def.status ?? "active",
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
    }
  }

  // (2) base plan entitlements
  const planByFeature = new Map<string, PlanEntitlementRow>();
  {
    const rows = await conn
      .select({
        featureKey: planEntitlementsTable.featureKey,
        valueJson: planEntitlementsTable.valueJson,
      })
      .from(planEntitlementsTable)
      .where(eq(planEntitlementsTable.planId, firm.planId));
    for (const r of rows) planByFeature.set(r.featureKey, r);
  }

  // (3) ALL firm overrides (permanent + temporary) — we filter at resolve-time.
  //   Permanent = override_kind='permanent' (always considered, never time-filtered).
  //   Temporary = override_kind='temporary' — active only when now() in [effectiveFrom, expiresAt).
  //   Historical expired rows are loaded here but filtered in selectActiveOverride (for audit/debug we keep them).
  const overridesByFeature = new Map<string, OverrideRow[]>();
  {
    const rows = await conn
      .select({
        featureKey: firmEntitlementOverridesTable.featureKey,
        overrideKind: firmEntitlementOverridesTable.overrideKind,
        overrideMode: firmEntitlementOverridesTable.overrideMode,
        valueJson: firmEntitlementOverridesTable.valueJson,
        effectiveFrom: firmEntitlementOverridesTable.effectiveFrom,
        expiresAt: firmEntitlementOverridesTable.expiresAt,
        billingType: firmEntitlementOverridesTable.billingType,
        priceOverride: firmEntitlementOverridesTable.priceOverride,
      })
      .from(firmEntitlementOverridesTable)
      .where(eq(firmEntitlementOverridesTable.firmId, firmId))
      .orderBy(firmEntitlementOverridesTable.createdAt);
    for (const r of rows) {
      const arr = overridesByFeature.get(r.featureKey) ?? [];
      arr.push({
        featureKey: r.featureKey,
        overrideKind: String(r.overrideKind ?? "temporary"),
        overrideMode: String(r.overrideMode),
        valueJson: r.valueJson,
        effectiveFrom: r.effectiveFrom ?? null,
        expiresAt: r.expiresAt ?? null,
        billingType: String(r.billingType ?? "included"),
        priceOverride: r.priceOverride ? String(r.priceOverride) : null,
      });
      overridesByFeature.set(r.featureKey, arr);
    }
  }

  // (4) resolve each requested key
  const results: Record<string, EntitlementResult> = {};
  const visitedParents = new Set<string>();

  for (const key of known) {
    if (!unknownResults[key]) {
      results[key] = resolveOne({
        key,
        conn,
        firm,
        policy,
        actingAsFounder: !!opts.actingAsFounder,
        featuresById,
        planByFeature,
        overridesByFeature,
        visitedParents,
        stack: [],
      });
    }
  }
  const merged: Record<string, EntitlementResult> = { ...unknownResults, ...results };

  // Cache the merged result
  try {
    FIRM_CACHE.set(ck, {
      firmId,
      actingAsFounder: !!opts.actingAsFounder,
      keysFingerprint: fp,
      data: merged,
      resolvedAt: Date.now(),
      ttlMs: DEFAULT_TTL_MS,
    });
    // Bound cache size to ~200 firms soft
    if (FIRM_CACHE.size > 200) {
      const keysToEvict = Array.from(FIRM_CACHE.keys()).slice(0, 50);
      for (const x of keysToEvict) FIRM_CACHE.delete(x);
    }
  } catch {
    // ignore cache set errors
  }

  return merged;
}

// ---------------------------------------------------------------------------
// requireFirmFeature: backend guard (Part 2 §6)
// ---------------------------------------------------------------------------
//
// Usage (Express / Fastify / middleware) router-level guard pattern:
//
//   router.get('/something', requireFirmFeature('accounting.payment_voucher'), (req, res) => { ... })
//
// For tRPC-style / procedure wrappers: use requireFeatureProcedure below.
//
// Throws ApiError with status 403, code = FEATURE_NOT_ENABLED.
//
// ── IMPORTANT: middleware order must be:
//     requireAuth → requireFirmUser → requireFirmFeature → requirePermission(role)
//   → handler
//
// Because: if Founder turns Accounting OFF, all roles are denied TOTAL even with role allow list match (Part 2 §7).

export type AuthContextLike = {
  auth: {
    firmId?: number | string | null | undefined;
    userId?: number | string | null | undefined;
    actingAsFounder?: boolean | null | undefined;
  };
  db?: AppDb | RlsDb;
};

export async function requireFirmFeatureInContext(
  ctx: AuthContextLike,
  featureKey: string,
): Promise<EntitlementResult> {
  if (!featureKey) throw new ApiError({ status: 400, code: "BAD_REQUEST", message: "featureKey is required", retryable: false });
  const firmId = Number(ctx.auth?.firmId);
  if (!firmId || !Number.isFinite(firmId)) {
    throw new ApiError({ status: 401, code: "UNAUTHORIZED", message: "No firm context", retryable: false });
  }
  if (!isFeatureRegistered(featureKey)) {
    // Unknown/unregistered configurable feature = DENY BY DEFAULT (Part 2 §11)
    throw new ApiError({
      status: 403,
      code: "FEATURE_NOT_ENABLED",
      message: `FEATURE_NOT_ENABLED: ${featureKey} (unknown, deny by default)`,
      retryable: false,
      details: { featureKey, denialCode: "feature_not_found" },
    });
  }
  const res = await getEffectiveEntitlement(firmId, featureKey, {
    conn: (ctx as any)?.db,
    actingAsFounder: !!ctx.auth?.actingAsFounder,
  });
  if (!res.enabled) {
    throw new ApiError({
      status: 403,
      code: "FEATURE_NOT_ENABLED",
      message: `FEATURE_NOT_ENABLED: ${featureKey} (${res.denialReason ?? res.denied})`,
      retryable: false,
      details: { featureKey, denialCode: res.denied, source: res.source },
    });
  }
  return res;
}

/**
 * Express-style middleware factory. Usage:
 *   router.use('/pv', requireFirmFeature('accounting.payment_voucher'), pvRouter);
 */
import type { Request, Response, NextFunction } from "express";
export function requireFirmFeature(featureKey: string) {
  return async function requireFirmFeatureMiddleware(req: Request, _res: Response, next: NextFunction) {
    try {
      await requireFirmFeatureInContext({
        auth: {
          firmId: (req as any)?.auth?.firmId ?? (req as any)?.firmId ?? (req as any)?.session?.firmId ?? null,
          userId: (req as any)?.auth?.userId ?? (req as any)?.userId ?? (req as any)?.session?.userId ?? null,
          actingAsFounder: (req as any)?.auth?.actingAsFounder ?? (req as any)?.actingAsFounder ?? false,
        },
        db: (req as any)?.db,
      } as any, featureKey);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Background job guard (Part 2 §13)
// ---------------------------------------------------------------------------
//
// If a firm's module/feature is OFF, do NOT produce NEW notifications,
// escalation jobs, scheduled alerts, SLA warnings, HR events, or PV
// escalations. Existing historical data is never deleted.
//
// Usage pattern inside a worker per-firm loop:
//
//   for (const firmId of firmIds) {
//     if (!await canFirmRunJobsFor(firmId, 'payment_voucher_sla')) continue;
//     // run work and emit notifications for the firm
//   }

import { collectJobGuardToFeatureMap, type FEATURE_REGISTRY } from "@workspace/db";

let _jobGuardMapCache: Map<string, readonly string[]> | null = null;
function getJobGuardMap(): Map<string, readonly string[]> {
  if (_jobGuardMapCache) return _jobGuardMapCache;
  const m = collectJobGuardToFeatureMap();
  _jobGuardMapCache = new Map(Object.entries(m));
  return _jobGuardMapCache;
}

/**
 * For a named job/scheduled worker, return the list of firms for which the
 * job should actually run. All disabled features for the firm will skip it.
 */
export async function filterFirmsForJob<T extends { id: number | string }>(
  jobGuardKey: string,
  firms: readonly T[],
  conn: AppDb | RlsDb = db,
): Promise<T[]> {
  const guardKeys = getJobGuardMap().get(jobGuardKey);
  if (!guardKeys || guardKeys.length === 0) return Array.from(firms);
  const out: T[] = [];
  for (const f of firms) {
    const fid = Number(f.id);
    if (!Number.isFinite(fid) || fid <= 0) continue;
    const results = await resolveEntitlementsBulk(fid, guardKeys, { conn });
    const ok = guardKeys.every((k) => results[k]?.enabled);
    if (ok) out.push(f);
  }
  return out;
}

export async function canFirmRunJobsFor(
  firmId: number,
  jobGuardKey: string,
  conn: AppDb | RlsDb = db,
): Promise<boolean> {
  const guardKeys = getJobGuardMap().get(jobGuardKey);
  if (!guardKeys || guardKeys.length === 0) return true;
  const results = await resolveEntitlementsBulk(firmId, guardKeys, { conn });
  return guardKeys.every((k) => results[k]?.enabled);
}

// ---------------------------------------------------------------------------
// Single-key resolver (with parent/dependency chain)
// ---------------------------------------------------------------------------

interface ResolveOneCtx {
  key: string;
  conn: AppDb | RlsDb;
  firm: FirmContext;
  policy: SubscriptionPolicyDecision;
  actingAsFounder: boolean;
  featuresById: Map<string, typeof platformFeaturesTable.$inferSelect>;
  planByFeature: Map<string, PlanEntitlementRow>;
  overridesByFeature: Map<string, OverrideRow[]>;
  visitedParents: Set<string>;
  stack: string[];
}

function selectActiveOverride(
  rows: OverrideRow[] | undefined,
): { override: OverrideRow; isTemporary: boolean } | undefined {
  if (!rows || rows.length === 0) return undefined;
  const now = Date.now();
  // PRECEDENCE:
  //   Layer 5 (permanent) wins unconditionally over Layer 6 (temporary)
  //   because per spec: permanent override has higher resolver precedence.
  // Temporary = override_kind='temporary' AND now ∈ [effectiveFrom, expiresAt)
  // Permanent = override_kind='permanent' (always active, no time check)
  let tempActive: OverrideRow | undefined;
  let permActive: OverrideRow | undefined;
  for (const r of rows) {
    const kind = String(r.overrideKind ?? "temporary");
    if (kind === "permanent") {
      // First permanent wins (uq_firm_entitlement_permanent enforces at most 1)
      if (!permActive) permActive = r;
    } else {
      // temporary: activate only if now in range
      const from = r.effectiveFrom ? r.effectiveFrom.getTime() : -Infinity;
      const to = r.expiresAt ? r.expiresAt.getTime() : Infinity;
      const inRange = now >= from && now < to;
      if (inRange && (!tempActive || (r.effectiveFrom?.getTime() ?? 0) > (tempActive.effectiveFrom?.getTime() ?? 0))) {
        tempActive = r;
      }
    }
  }
  // Layer 5 (permanent) > Layer 6 (temporary) per resolver precedence order
  if (permActive) return { override: permActive, isTemporary: false };
  if (tempActive) return { override: tempActive, isTemporary: true };
  return undefined;
}

function applyOverrideToValue(
  baseValue: unknown,
  override: OverrideRow,
): { value: unknown; enabled: boolean } {
  switch (override.overrideMode) {
    case "enabled":
      return { value: true, enabled: true };
    case "disabled":
      return { value: false, enabled: false };
    case "plan_default":
      return { value: baseValue, enabled: !!coerceBoolean(baseValue) };
    case "custom":
    default: {
      const v = override.valueJson !== undefined && override.valueJson !== null
        ? override.valueJson
        : baseValue;
      return { value: v, enabled: coerceBoolean(v) ?? false };
    }
  }
}

function resolveOne(ctx: ResolveOneCtx): EntitlementResult {
  const { key, stack } = ctx;
  if (stack.includes(key)) {
    // Cycle in feature graph → deny
    return deny(key, "parent_disabled", "Circular parent feature chain detected");
  }
  const stackNext = [...stack, key];

  const feature = ctx.featuresById.get(key);

  // --- Layer 1: feature exists and is globally active ---
  if (!feature) return deny(key, "feature_not_found", "Feature not registered in platform_features");
  if (feature.status === "deprecated") {
    // Fall through, but log warning
    logger.warn({ featureKey: key }, "entitlement.feature_deprecated");
  }
  if (feature.status === "inactive") return deny(key, "feature_inactive", "Feature globally inactive");
  if (feature.status === "emergency_disabled") {
    return deny(key, "global_emergency_disabled", "Feature disabled by platform emergency");
  }
  if (feature.founderOnly && !ctx.actingAsFounder) {
    return deny(key, "founder_only_denied", "Feature is founder-only");
  }

  // --- Layer 2: global emergency switch (status already captured above) ---

  // --- Layer 3: subscription policy ---
  if (ctx.policy.readonly) {
    // read-only mode blocks writes but read-only-typed modules still show.
    // Express at the decision layer; entitlement itself remains "enabled" for read.
    // We mark value unchanged but note read_only_mode in denial only for write-sensitive gates.
  }
  if (ctx.policy.status === "suspended" || ctx.policy.status === "cancelled" || ctx.policy.status === "expired") {
    return deny(key, `subscription_${ctx.policy.status}` as DenialCode, `Subscription status: ${ctx.policy.status}`);
  }
  if (ctx.policy.paidFeaturesDisabled) {
    // For paid-type billing addon features: block. For included plan features: allow.
    // We don't know yet billing type at this layer, so we flag in the result.
  }

  // --- Layer 4: plan entitlement ---
  const planRow = ctx.planByFeature.get(key);
  let effectiveValue: unknown = feature.defaultValue;
  let source: EntitlementResult["source"] = "feature_default";
  if (planRow) {
    effectiveValue = planRow.valueJson;
    source = "plan_entitlement";
  }

  // --- Layers 5 & 6: permanent + temporary overrides ---
  const overridePick = selectActiveOverride(ctx.overridesByFeature.get(key));
  let billingType: EntitlementResult["billingType"] = "included";
  let priceOverride: string | null = null;
  let enabled: boolean;

  if (overridePick) {
    const applied = applyOverrideToValue(effectiveValue, overridePick.override);
    effectiveValue = applied.value;
    enabled = applied.enabled;
    source = overridePick.isTemporary ? "firm_override_temporary" : "firm_override_permanent";
    if (overridePick.override.billingType) {
      billingType = overridePick.override.billingType as EntitlementResult["billingType"];
    }
    priceOverride = overridePick.override.priceOverride ?? null;
    if (overridePick.override.overrideMode === "disabled") {
      return {
        featureKey: key,
        enabled: false,
        value: effectiveValue,
        valueType: feature.valueType as EntitlementResult["valueType"],
        source,
        denied: "firm_override_disabled",
        denialReason: `Firm override (${overridePick.isTemporary ? "temporary" : "permanent"}) disabled`,
        billingType,
        priceOverride,
      };
    }
  } else {
    enabled = coerceBoolean(effectiveValue) ?? false;
    if (!enabled && source === "plan_entitlement") {
      // explicit plan-level disabled
      return {
        featureKey: key,
        enabled: false,
        value: effectiveValue,
        valueType: feature.valueType as EntitlementResult["valueType"],
        source: "plan_entitlement",
        denied: "plan_entitlement_denied",
        denialReason: "Plan entitlement disables this feature",
      };
    }
  }

  // --- Layer 7: parent feature check ---
  const parentChain: string[] = [];
  if (feature.parentFeatureKey && !ctx.visitedParents.has(feature.parentFeatureKey)) {
    ctx.visitedParents.add(feature.parentFeatureKey);
    const parentRes = resolveOne({ ...ctx, key: feature.parentFeatureKey, stack: stackNext });
    parentChain.push(feature.parentFeatureKey, ...(parentRes.parentChain ?? []));
    if (!parentRes.enabled) {
      return {
        featureKey: key,
        enabled: false,
        value: effectiveValue,
        valueType: feature.valueType as EntitlementResult["valueType"],
        source: "denial",
        denied: "parent_disabled",
        denialReason: `Parent feature disabled: ${feature.parentFeatureKey} (${parentRes.denialReason ?? parentRes.denied ?? ""})`,
        parentChain,
      };
    }
  }

  // --- Layer 8: dependency check ---
  const deps: unknown[] = Array.isArray(feature.dependencyJson) ? (feature.dependencyJson as unknown[]) : [];
  for (const depRaw of deps) {
    const depKey = typeof depRaw === "string" ? depRaw : (depRaw as any)?.key as string | undefined;
    if (!depKey) continue;
    if (ctx.visitedParents.has(depKey)) continue;
    ctx.visitedParents.add(depKey);
    const depRes = resolveOne({ ...ctx, key: depKey, stack: stackNext });
    if (!depRes.enabled) {
      return {
        featureKey: key,
        enabled: false,
        value: effectiveValue,
        valueType: feature.valueType as EntitlementResult["valueType"],
        source: "denial",
        denied: "dependency_not_met",
        denialReason: `Dependency not met: ${depKey} (${depRes.denialReason ?? depRes.denied ?? ""})`,
        parentChain,
      };
    }
  }

  // --- subscription paid addon gating ---
  if (ctx.policy.paidFeaturesDisabled && billingType === "paid_addon") {
    return {
      featureKey: key,
      enabled: false,
      value: effectiveValue,
      valueType: feature.valueType as EntitlementResult["valueType"],
      source: "denial",
      denied: `subscription_${ctx.policy.status}` as DenialCode,
      denialReason: `Subscription ${ctx.policy.status}: paid add-ons disabled`,
      billingType,
      priceOverride,
      parentChain,
    };
  }

  // --- Coerce limit ---
  let limit: number | undefined;
  const vt = feature.valueType as EntitlementResult["valueType"];
  if (vt === "integer" || vt === "decimal") {
    const n = coerceNumber(effectiveValue);
    if (n !== undefined) limit = n;
  } else if (vt === "unlimited") {
    limit = Infinity;
  }

  return {
    featureKey: key,
    enabled,
    value: effectiveValue,
    valueType: vt,
    limit,
    billingType,
    priceOverride,
    source,
    parentChain,
  };
}

function deny(featureKey: string, code: DenialCode, reason: string): EntitlementResult {
  return {
    featureKey,
    enabled: false,
    value: null,
    valueType: "boolean",
    source: "denial",
    denied: code,
    denialReason: reason,
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers (single-key)
// ---------------------------------------------------------------------------

export async function getEffectiveEntitlement(
  firmId: number,
  featureKey: string,
  opts: ResolveBulkOptions = {},
): Promise<EntitlementResult> {
  const res = await resolveEntitlementsBulk(firmId, [featureKey], opts);
  return res[featureKey] ?? deny(featureKey, "feature_not_found", "");
}

export async function canUseFeature(
  firmId: number,
  featureKey: string,
  opts: ResolveBulkOptions = {},
): Promise<boolean> {
  return (await getEffectiveEntitlement(firmId, featureKey, opts)).enabled;
}

export async function getFeatureLimit(
  firmId: number,
  featureKey: string,
  opts: ResolveBulkOptions = {},
): Promise<number | null> {
  const r = await getEffectiveEntitlement(firmId, featureKey, opts);
  if (!r.enabled) return null;
  if (r.limit === undefined) return null;
  return r.limit;
}

// ---------------------------------------------------------------------------
// Legacy quota integration: back-compat for checkFirmQuota usage
// ---------------------------------------------------------------------------

const QUOTA_RESOURCE_TO_FEATURE: Record<string, string> = {
  users: "limit.users.max",
  cases: "limit.cases.monthly_new",
};

export async function checkFirmQuotaViaEntitlements(
  conn: AppDb | RlsDb,
  firmId: number,
  resourceType: string,
): Promise<void> {
  const featureKey = QUOTA_RESOURCE_TO_FEATURE[resourceType] ?? resourceType;
  const r = await getEffectiveEntitlement(firmId, featureKey, { conn });
  if (!r.enabled) {
    throw new ApiError({ status: 403, code: "FEATURE_DISABLED", message: `Feature disabled: ${featureKey} (${r.denialReason ?? r.denied})`, retryable: false });
  }
  if (r.limit !== undefined && Number.isFinite(r.limit)) {
    // Delegate to counter lookup — done by caller since resources differ
    // We expose limit via getFeatureLimit for explicit use.
  }
}

// ---------------------------------------------------------------------------
// List all feature catalog + current plan entitlements (for platform UI)
// ---------------------------------------------------------------------------

export async function listAllFeatures(conn: AppDb | RlsDb = db) {
  return conn.select().from(platformFeaturesTable).orderBy(platformFeaturesTable.module, platformFeaturesTable.featureKey);
}

export async function listPlanEntitlements(planId: number, conn: AppDb | RlsDb = db) {
  return conn
    .select()
    .from(planEntitlementsTable)
    .where(eq(planEntitlementsTable.planId, planId))
    .orderBy(planEntitlementsTable.featureKey);
}

export async function listFirmOverrides(firmId: number, conn: AppDb | RlsDb = db) {
  return conn
    .select()
    .from(firmEntitlementOverridesTable)
    .where(eq(firmEntitlementOverridesTable.firmId, firmId))
    .orderBy(firmEntitlementOverridesTable.featureKey, firmEntitlementOverridesTable.createdAt);
}
