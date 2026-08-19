import {
  useMemo,
  createContext,
  useContext,
  useEffect,
  type ReactNode,
  type ReactElement,
  useCallback,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api-client";
import { PermissionGuard } from "@/components/permission-guard";
import { useAuth } from "@/lib/auth-context";
import { effectiveFeaturesQueryKey } from "@/lib/query-keys";
import {
  classifyPermissionError,
  isTransientErrorCategory,
} from "@/lib/permissions";

// Part 2 §9 §10: Per-user effective feature access (Firm entitlement + user explicit row OR role fallback)
// Unified API so sidebar === route === button visibility share one computation.

export type UserEffectiveFeature = {
  featureKey: string;
  firmEnabled: boolean;
  userEnabled: boolean;
  effectiveEnabled: boolean;
  source:
    | "firm_entitlement_denied"
    | "partner_allow"
    | "user_row_true"
    | "user_row_false"
    | "role_permission_allow"
    | "role_permission_denied"
    | "unknown_feature_deny";
  denialCode?:
    | "FIRM_ENTITLEMENT_OFF"
    | "USER_OVERRIDE_OFF"
    | "ROLE_DENIED"
    | "UNKNOWN_FEATURE"
    | "PARENT_OFF"
    | null;
  denialReason?: string | null;
  parentKey?: string | null;
};

export type UserEffectiveFeatureBundle = {
  userId: number | null;
  firmId: number | null;
  effective: Record<string, UserEffectiveFeature>;
  explicitOverrides: Array<{ featureKey: string; isEnabled: boolean }>;
};

export function fetchUserEffectiveFeatures(): Promise<UserEffectiveFeatureBundle> {
  return apiFetchJson<any>("/users/_self/effective-features").then(
    (r) => (r?.data ?? r) as UserEffectiveFeatureBundle,
  );
}

function clearCachedEffectiveFeaturesForIdentity(fid: unknown, uid: unknown) {
  if (typeof window === "undefined") return;
  try {
    const cachedWrap = (window as any).__lawcasproCachedEffectiveFeatures as {
      firmId: unknown; userId: unknown; data: unknown;
    } | undefined;
    if (!cachedWrap || typeof cachedWrap !== "object") return;
    const sameFirm =
      (fid === null && cachedWrap.firmId === null) ||
      (fid !== null && String(cachedWrap.firmId) === String(fid));
    const sameUser =
      (uid === null && cachedWrap.userId === null) ||
      (uid !== null && String(cachedWrap.userId) === String(uid));
    if (sameFirm && sameUser) {
      (window as any).__lawcasproCachedEffectiveFeatures = null;
    }
  } catch {
  }
}

export function useUserEffectiveFeatures(): {
  data?: UserEffectiveFeatureBundle;
  isLoading: boolean;
  error: unknown;
  errorCategory: ReturnType<typeof classifyPermissionError> | null;
  refetch: () => Promise<unknown>;
  isRefetching: boolean;
  isFetching: boolean;
} {
  const { user } = useAuth();
  const uid = (user as any)?.id ?? null;
  const fid = (user as any)?.firmId ?? null;
  const qKey = effectiveFeaturesQueryKey(fid, uid);
  const res = useQuery<UserEffectiveFeatureBundle, Error, UserEffectiveFeatureBundle>({
    queryKey: qKey,
    queryFn: async () => {
      try {
        const result = await fetchUserEffectiveFeatures();
        if (typeof window !== "undefined") {
          try {
            (window as any).__lawcasproCachedEffectiveFeatures = {
              firmId: fid,
              userId: uid,
              fetchedAt: Date.now(),
              data: result,
            };
          } catch {
          }
        }
        return result;
      } catch (err) {
        const cat = classifyPermissionError(err);
        if (cat === "EXPLICIT_DENY_403") {
          clearCachedEffectiveFeaturesForIdentity(fid, uid);
          throw err;
        }
        if (cat === "UNAUTHORIZED_401" || cat === "NOT_FOUND_404" || cat === "CLIENT_OTHER") {
          clearCachedEffectiveFeaturesForIdentity(fid, uid);
          throw err;
        }
        if (isTransientErrorCategory(cat)) {
          if (typeof window !== "undefined") {
            try {
              const cached = (window as any).__lawcasproCachedEffectiveFeatures as {
                firmId: unknown; userId: unknown; fetchedAt: number; data: UserEffectiveFeatureBundle;
              } | undefined;
              if (cached && cached.data && typeof cached === "object") {
                const sameFirm = (fid === null && cached.firmId === null) ||
                  (fid !== null && String(cached.firmId) === String(fid));
                const sameUser = (uid === null && cached.userId === null) ||
                  (uid !== null && String(cached.userId) === String(uid));
                if (sameFirm && sameUser && cached.data.userId && cached.data.effective) return cached.data;
              }
            } catch {
            }
          }
          throw err;
        }
        clearCachedEffectiveFeaturesForIdentity(fid, uid);
        throw err;
      }
    },
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: true,
    retry: 0,
    enabled: Boolean(user && user.userType === "firm_user"),
  });
  const errorCategory = res.error ? classifyPermissionError(res.error) : null;
  return {
    data: res.data,
    isLoading: res.isLoading,
    error: res.error,
    errorCategory,
    refetch: res.refetch,
    isRefetching: res.isRefetching,
    isFetching: res.isFetching,
  };
}

export function useInvalidateUserEffectiveFeatures(): () => Promise<void> {
  const qc = useQueryClient();
  const { user } = useAuth();
  const uid = (user as any)?.id ?? null;
  const fid = (user as any)?.firmId ?? null;
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: effectiveFeaturesQueryKey(fid, uid) });
  }, [qc, fid, uid]);
}

// ---------------------------------------------------------------------------
// useEffectiveUserFeature(featureKey) — single key unified guard
// §10 sidebar/route identical — one single authority
// ---------------------------------------------------------------------------

export interface EffectiveUseFeatureResult {
  isLoading: boolean;
  enabled: boolean;
  /** Firm-level entitlement on/off (ignores user override) */
  firmEnabled: boolean;
  /** User-level on/off (ignores firm gate) */
  userEnabled: boolean;
  denialCode?: string | null;
  source?: UserEffectiveFeature["source"] | null;
}

export function useEffectiveUserFeature(
  featureKey: string | undefined | null,
): EffectiveUseFeatureResult {
  const { data, isLoading, error, errorCategory } = useUserEffectiveFeatures();
  const { user } = useAuth();
  const uid = (user as any)?.id ?? null;
  const fid = (user as any)?.firmId ?? null;
  const firm = useFeature(featureKey);
  return useMemo<EffectiveUseFeatureResult>(() => {
    if (!featureKey) return { isLoading: false, enabled: false, firmEnabled: false, userEnabled: false };
    const eff = data?.effective?.[featureKey];
    if (eff) {
      return {
        isLoading: false,
        enabled: !!eff.effectiveEnabled,
        firmEnabled: !!eff.firmEnabled,
        userEnabled: !!eff.userEnabled,
        denialCode: eff.denialCode ?? null,
        source: eff.source ?? null,
      };
    }
    const transientError = Boolean(error) && Boolean(errorCategory) && isTransientErrorCategory(errorCategory!);
    const loadingButKnown = data !== undefined;
    if (isLoading || !loadingButKnown) {
      if (transientError) {
        let fallbackData: UserEffectiveFeatureBundle | undefined;
        if (typeof window !== "undefined") {
          try {
            const cached = (window as any).__lawcasproCachedEffectiveFeatures as {
              firmId: unknown; userId: unknown; fetchedAt: number; data: UserEffectiveFeatureBundle;
            } | undefined;
            if (cached && cached.data && typeof cached === "object") {
              const sameFirm = (fid === null && cached.firmId === null) ||
                (fid !== null && String(cached.firmId) === String(fid));
              const sameUser = (uid === null && cached.userId === null) ||
                (uid !== null && String(cached.userId) === String(uid));
              if (sameFirm && sameUser) fallbackData = cached.data;
            }
          } catch {
          }
        }
        const fallbackEff = fallbackData?.effective?.[featureKey];
        if (fallbackEff) {
          return {
            isLoading: true,
            enabled: !!fallbackEff.effectiveEnabled,
            firmEnabled: !!fallbackEff.firmEnabled,
            userEnabled: !!fallbackEff.userEnabled,
            denialCode: fallbackEff.denialCode ?? null,
            source: fallbackEff.source ?? null,
          };
        }
      }
      if (loadingButKnown) {
        return {
          isLoading: false,
          enabled: false,
          firmEnabled: !!firm.enabled,
          userEnabled: false,
          denialCode: "USER_FEATURE_MISSING",
          source: null,
        };
      }
      return {
        isLoading: true,
        enabled: false,
        firmEnabled: !!firm.enabled,
        userEnabled: false,
      };
    }
    return {
      isLoading: false,
      enabled: false,
      firmEnabled: !!firm.enabled,
      userEnabled: false,
      denialCode: "USER_FEATURE_MISSING",
      source: null,
    };
  }, [featureKey, data, isLoading, error, errorCategory, uid, fid, firm.enabled, firm.denialCode, firm.source]);
}

// ---------------------------------------------------------------------------
// <UserFeatureGuard feature="documents.hub"> — §10 route/sidebar wrapper
// ---------------------------------------------------------------------------

export interface UserFeatureGuardProps {
  feature: string;
  allOf?: readonly string[];
  anyOf?: readonly string[];
  children:
    | ReactNode
    | ((args: EffectiveUseFeatureResult) => ReactNode);
  fallback?: ReactNode;
  hideDisabled?: boolean;
}

export function UserFeatureGuard(props: UserFeatureGuardProps): ReactNode {
  const {
    feature,
    allOf,
    anyOf,
    children,
    fallback = null,
    hideDisabled = true,
  } = props;
  const primary = useEffectiveUserFeature(feature);
  const extraAll = (allOf ?? []).map((k) => useEffectiveUserFeature(k));
  const extraAny = (anyOf ?? []).map((k) => useEffectiveUserFeature(k));
  const loading =
    primary.isLoading ||
    extraAll.some((r) => r.isLoading) ||
    extraAny.some((r) => r.isLoading);
  if (loading) return hideDisabled ? null : fallback;
  const okAll = extraAll.every((r) => r.enabled);
  const okAny = extraAny.length === 0 || extraAny.some((r) => r.enabled);
  const ok = primary.enabled && okAll && okAny;
  if (!ok) return hideDisabled ? null : fallback;
  if (typeof children === "function") {
    return children(primary) as ReactNode;
  }
  return children;
}

// ---------------------------------------------------------------------------
// UserFeatureNotEnabledPage — explicit denial page (matches firm-level one)
// for when Partner disabled user-only from feature
// ---------------------------------------------------------------------------

export function UserFeatureNotEnabledPage(props: {
  featureKey?: string | null;
  message?: string;
}): ReactElement {
  return (
    <div style={{
      minHeight: "calc(100vh - 80px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
    }}>
      <div style={{
        maxWidth: 520,
        width: "100%",
        borderRadius: 12,
        padding: 32,
        textAlign: "center",
        background: "white",
        border: "1px solid #e5e7eb",
        boxShadow: "0 4px 12px rgba(0,0,0,0.04)",
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: "50%",
          background: "#FFF7ED", color: "#C2410C",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontWeight: 600, fontSize: 22, marginBottom: 16,
        }}>
          🔒
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px 0" }}>
          This feature is not available to you
        </h2>
        <p style={{ color: "#4B5563", margin: "0 0 4px 0", fontSize: 14, lineHeight: 1.6 }}>
          {props.message ??
            "Your firm Partner has not granted you access to this feature. Please contact them to request access."}
        </p>
        {props.featureKey ? (
          <p style={{
            marginTop: 12,
            color: "#6B7280",
            fontSize: 12,
            background: "#F9FAFB",
            borderRadius: 8,
            padding: "6px 10px",
            display: "inline-block",
          }}>
            Feature key: <code style={{ fontWeight: 600 }}>{props.featureKey}</code>
          </p>
        ) : null}
        <div style={{ marginTop: 20 }}>
          <a href="/app/dashboard" style={{
            display: "inline-block",
            padding: "10px 16px",
            borderRadius: 8,
            background: "#111827",
            color: "white",
            textDecoration: "none",
            fontSize: 14,
            fontWeight: 500,
          }}>
            Return to Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}

export type FeatureDefinitionLike = {
  featureKey: string;
  name: string;
  module: string;
  parentFeatureKey: string | null;
  valueType: "boolean" | "integer" | "decimal" | "string" | "config" | "unlimited";
  defaultValue: unknown | null;
  dependencies: readonly string[];
  configurable: boolean;
  founderOnly: boolean;
  planControlled: boolean;
  firmControlledOverride: boolean;
  routeHint: string | null;
  backendGuardKey: string | null;
  status: string;
  sortOrder: number;
  description: string | null;
  jobGuards: readonly string[];
};

export type EntitlementLike = {
  featureKey: string;
  enabled: boolean;
  value: unknown;
  valueType: "boolean" | "integer" | "decimal" | "string" | "config" | "unlimited";
  limit?: number | null;
  billingType?: "included" | "paid_addon" | "complimentary" | "trial";
  source: "feature_default" | "plan_entitlement" | "firm_override_permanent" | "firm_override_temporary" | "denial";
  denied?: string | null;
  denialReason?: string | null;
  usage?: number | null;
};

export type FirmOverrideLike = {
  id: number;
  featureKey: string;
  overrideMode: "plan_default" | "enabled" | "disabled" | "custom";
  valueJson?: unknown;
  effectiveFrom?: string | null;
  expiresAt?: string | null;
  billingType?: string | null;
  priceOverride?: string | null;
  reason?: string | null;
  createdAt: string;
  updatedAt?: string | null;
};

export type FirmEntitlementsBundle = {
  firm: { id: number; status: string; subStatus: string | null; planId: number | null; isCustomPlan: boolean; customPriceMonthly: string | null } | null;
  plan: { id: number; name: string; priceMonthly: string | null } | null;
  subscriptionPolicy: { status: string; readonly: boolean; paidFeaturesDisabled: boolean; allowWrite: boolean } | null;
  items: Record<string, EntitlementLike>;
  overrides: FirmOverrideLike[];
};

export type FeatureRegistryBundle = {
  registry: FeatureDefinitionLike[];
  jobGuardMap: Record<string, readonly string[]>;
};

const REGISTRY_QUERY_KEY = ["platform", "feature-registry"];
const INVALIDATION_POLL_INTERVAL_MS = 15_000; // Poll server-epoch every 15s for fast propagation; server invalidation also returns via headers.

const ACCEPTED_ENTITLEMENT_SOURCES: EntitlementLike["source"][] = [
  "feature_default",
  "plan_entitlement",
  "firm_override_permanent",
  "firm_override_temporary",
  "denial",
];

function mapEntitlementSource(
  src: UserEffectiveFeature["source"] | null | undefined,
): EntitlementLike["source"] {
  if (typeof src === "string" && (ACCEPTED_ENTITLEMENT_SOURCES as string[]).includes(src)) {
    return src as EntitlementLike["source"];
  }
  switch (src) {
    case "firm_entitlement_denied":
      return "denial";
    case "partner_allow":
    case "role_permission_allow":
    case "role_permission_denied":
    case "user_row_true":
    case "user_row_false":
      return "firm_override_permanent";
    case "unknown_feature_deny":
      return "denial";
    default:
      return "feature_default";
  }
}

function mapOverrideMode(isEnabled: boolean): FirmOverrideLike["overrideMode"] {
  return isEnabled ? "enabled" : "disabled";
}

// ---------------------------------------------------------------------------
// React hooks: fetch entitlements + registry once per user session
// useFirmEntitlements() is a DERIVED projection from the single canonical
// UserEffectiveFeatureBundle cached under effectiveFeaturesQueryKey(firmId, userId).
// One HTTP request, one identity-scoped query cache — no cross-user collision.
// ---------------------------------------------------------------------------

export function useFirmEntitlements<TFirmOverride = FirmOverrideLike>(): {
  data?: FirmEntitlementsBundle;
  isLoading: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} {
  const raw = useUserEffectiveFeatures();
  const data = useMemo<FirmEntitlementsBundle | undefined>(() => {
    if (!raw.data) return undefined;
    const eff = raw.data.effective ?? {};
    const items: Record<string, EntitlementLike> = {};
    for (const [key, value] of Object.entries(eff)) {
      const firmOn = Boolean(value.firmEnabled);
      items[key] = {
        featureKey: key,
        enabled: firmOn,
        value: firmOn,
        valueType: "boolean",
        source: mapEntitlementSource(value.source),
        denied: firmOn ? null : value.denialCode ?? null,
        denialReason: value.denialReason ?? null,
        usage: null,
      };
    }
    const overrides: FirmOverrideLike[] = Array.isArray(raw.data.explicitOverrides)
      ? raw.data.explicitOverrides.map((o, i) => ({
          id: i + 1,
          featureKey: o.featureKey,
          overrideMode: mapOverrideMode(Boolean(o.isEnabled)),
          createdAt: new Date().toISOString(),
        }))
      : [];
    return {
      firm: raw.data.firmId
        ? {
            id: raw.data.firmId,
            status: "active",
            subStatus: null,
            planId: null,
            isCustomPlan: false,
            customPriceMonthly: null,
          }
        : null,
      plan: null,
      subscriptionPolicy: null,
      items,
      overrides,
    } as FirmEntitlementsBundle;
  }, [raw.data]);

  return { data, isLoading: raw.isLoading, error: raw.error, refetch: raw.refetch };
}

export function useFeatureRegistry(): {
  data?: FeatureRegistryBundle;
  isLoading: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} {
  const res = useQuery<FeatureRegistryBundle>({
    queryKey: REGISTRY_QUERY_KEY,
    queryFn: async () => {
      const r = await apiFetchJson<any>("/entitlements/platform/feature-registry");
      return (r?.data ?? r) as FeatureRegistryBundle;
    },
    staleTime: 300_000,
    retry: 1,
  });
  return { data: res.data, isLoading: res.isLoading, error: res.error, refetch: res.refetch };
}

export function useInvalidateFirmEntitlements(): () => Promise<void> {
  const qc = useQueryClient();
  const { user } = useAuth();
  const uid = (user as any)?.id ?? null;
  const fid = (user as any)?.firmId ?? null;
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: effectiveFeaturesQueryKey(fid, uid) });
  }, [qc, fid, uid]);
}

// ---------------------------------------------------------------------------
// useFeature(featureKey): primary frontend guard (Part 2 §5 §6)
// ---------------------------------------------------------------------------
//
// Returns { enabled, entitlement, isLoading, limit, canUse }.
// Unknown feature key → enabled=false (deny by default).

export interface UseFeatureResult {
  isLoading: boolean;
  enabled: boolean;
  entitlement: EntitlementLike | undefined;
  limit: number | undefined;
  /** Denial code: feature_not_found / global_emergency_disabled / parent_disabled / dependency_not_met etc */
  denialCode?: string | null;
  denialReason?: string | null;
  source?: EntitlementLike["source"];
}

export function useFeature(featureKey: string | undefined | null): UseFeatureResult {
  const { data, isLoading } = useFirmEntitlements();
  return useMemo<UseFeatureResult>(() => {
    if (!featureKey) return { isLoading, enabled: false, entitlement: undefined, limit: undefined };
    const item = data?.items?.[featureKey];
    if (isLoading && !item) return { isLoading: true, enabled: false, entitlement: undefined, limit: undefined };
    if (!item) {
      // Unknown/unregistered feature key → deny by default (Part 2 §11)
      return {
        isLoading: false,
        enabled: false,
        entitlement: undefined,
        limit: undefined,
        denialCode: "feature_not_found",
        denialReason: `Feature not found in entitlements (deny by default): ${featureKey}`,
      };
    }
    return {
      isLoading: false,
      enabled: !!item.enabled,
      entitlement: item,
      limit: item.limit ?? undefined,
      denialCode: item.denied ?? null,
      denialReason: item.denialReason ?? null,
      source: item.source,
    };
  }, [featureKey, data, isLoading]);
}

// ---------------------------------------------------------------------------
// <FeatureGuard feature="..." /> — conditional render (Part 2 §5 §6)
// ---------------------------------------------------------------------------
//
// Hides children if the feature is disabled. Optional fallback / render-prop.

export interface FeatureGuardProps {
  feature: string;
  children: ReactNode | ((args: UseFeatureResult) => ReactNode);
  fallback?: ReactNode;
  /** If true, hides the feature but mounts nothing (null). If false, renders fallback. Default true. */
  hideDisabled?: boolean;
  /** Requires ALL of the listed features. */
  allOf?: readonly string[];
  /** Requires ANY of the listed features (in addition to `feature`). */
  anyOf?: readonly string[];
}

export function FeatureGuard(props: FeatureGuardProps): ReactNode {
  const { feature, children, fallback = null, hideDisabled = true, allOf, anyOf } = props;

  const primary = useFeature(feature);
  const extraAll = (allOf ?? []).map((k) => useFeature(k));
  const extraAny = (anyOf ?? []).map((k) => useFeature(k));

  const loading = primary.isLoading || extraAll.some((r) => r.isLoading) || extraAny.some((r) => r.isLoading);
  if (loading) return hideDisabled ? null : fallback;

  const allOk = extraAll.every((r) => r.enabled);
  const anyOk = extraAny.length === 0 || extraAny.some((r) => r.enabled);
  const ok = primary.enabled && allOk && anyOk;

  if (!ok) return hideDisabled ? null : fallback;

  if (typeof children === "function") {
    return children(primary) as ReactNode;
  }
  return children;
}

// ---------------------------------------------------------------------------
// Route-Level Feature Not-Enabled Page (Part 2 §5 — not blank screen)
// ---------------------------------------------------------------------------

export function FeatureNotEnabledPage(props: { featureKey?: string | null; message?: string; action?: ReactNode }): ReactElement {
  return (
    <div style={{
      minHeight: "calc(100vh - 80px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
    }}>
      <div style={{
        maxWidth: 520,
        width: "100%",
        borderRadius: 12,
        padding: 32,
        textAlign: "center",
        background: "white",
        border: "1px solid #e5e7eb",
        boxShadow: "0 4px 12px rgba(0,0,0,0.04)",
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: "50%",
          background: "#FEF2F2", color: "#DC2626",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontWeight: 600, fontSize: 22, marginBottom: 16,
        }}>
          !
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px 0" }}>
          This feature is not enabled for your firm
        </h2>
        <p style={{ color: "#4B5563", margin: "0 0 4px 0", fontSize: 14, lineHeight: 1.6 }}>
          {props.message ??
            "The requested feature is currently not included in your subscription plan or has been temporarily disabled."}
        </p>
        {props.featureKey ? (
          <p style={{
            marginTop: 12, color: "#6B7280", fontSize: 12,
            background: "#F9FAFB", borderRadius: 8, padding: "6px 10px",
            display: "inline-block",
          }}>
            Feature key: <code style={{ fontWeight: 600 }}>{props.featureKey}</code>
          </p>
        ) : null}
        <div style={{ marginTop: 20 }}>
          {props.action ?? (
            <a href="/app/dashboard" style={{
              display: "inline-block",
              padding: "10px 16px", borderRadius: 8,
              background: "#111827", color: "white", textDecoration: "none",
              fontSize: 14, fontWeight: 500,
            }}>
              Return to Dashboard
            </a>
          )}
        </div>
        <p style={{
          marginTop: 16, color: "#6B7280", fontSize: 12,
        }}>
          Please contact your firm administrator or Lawcaspro support if you believe you should have access.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EntitlementsProvider — wires up background polling + startup load
// ---------------------------------------------------------------------------

interface EntitlementsProviderProps {
  children: ReactNode;
}

const EntitlementsCtx = createContext<{ loaded: boolean; invalidated: number }>({ loaded: false, invalidated: 0 });

export function useEntitlementsReady() {
  return useContext(EntitlementsCtx);
}

export function EntitlementsProvider(props: EntitlementsProviderProps): ReactElement {
  const { refetch } = useFirmEntitlements();
  // Short-poll interval refresh so when founder toggles entitlement, next nav / 15s sees new state.
  useEffect(() => {
    const t = window.setInterval(() => {
      void refetch().catch(() => { /* swallow */ });
    }, INVALIDATION_POLL_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [refetch]);
  return <>{props.children}</>;
}

// ---------------------------------------------------------------------------
// Feature-aware sidebar helper (Part 2 §5 sidebar guard) — now unifies
// entitlement + user explicit/role fallback so sidebar === routes.
// ---------------------------------------------------------------------------

export function useFeatureMap(): Record<string, EntitlementLike> {
  const { data } = useFirmEntitlements();
  return data?.items ?? {};
}

// ---------------------------------------------------------------------------
// useEffectiveUserFeaturesMap() — §9 sidebar replacement use of user
// effective access. Returns Record<featureKey, { enabled, source }>
// so sidebar item gating doesn't need to know about the backend bundle.
// ---------------------------------------------------------------------------

export function useEffectiveUserFeaturesMap(): {
  enabled: (featureKey: string) => boolean;
  get: (featureKey: string) => UserEffectiveFeature | undefined;
  loaded: boolean;
  loadingOrRefetching: boolean;
  transientError: boolean;
} {
  const { data, isLoading, isRefetching, isFetching, error, errorCategory } = useUserEffectiveFeatures();
  const { user } = useAuth();
  const uid = (user as any)?.id ?? null;
  const fid = (user as any)?.firmId ?? null;
  return useMemo(() => {
    let fallbackData: UserEffectiveFeatureBundle | undefined;
    if (data === undefined && typeof window !== "undefined") {
      try {
        const cached = (window as any).__lawcasproCachedEffectiveFeatures as {
          firmId: unknown; userId: unknown; fetchedAt: number; data: UserEffectiveFeatureBundle;
        } | undefined;
        if (cached && cached.data && typeof cached === "object") {
          const sameFirm = (fid === null && cached.firmId === null) ||
            (fid !== null && String(cached.firmId) === String(fid));
          const sameUser = (uid === null && cached.userId === null) ||
            (uid !== null && String(cached.userId) === String(uid));
          if (sameFirm && sameUser) fallbackData = cached.data;
        }
      } catch {
      }
    }
    const resolvedEffective: Record<string, UserEffectiveFeature> =
      data !== undefined ? (data.effective ?? {}) : (fallbackData?.effective ?? {});
    const enabled = (k: string) => Boolean(resolvedEffective[k]?.effectiveEnabled);
    const get = (k: string) => resolvedEffective[k];
    const hasAny =
      data !== undefined
        ? Object.keys(resolvedEffective).length > 0 || Object.keys(data?.effective ?? {}).length >= 0
        : Object.keys(resolvedEffective).length > 0 || Boolean(fallbackData?.effective);
    const loaded = !isLoading && (hasAny || (data === undefined && Boolean(fallbackData?.effective)));
    const loadingOrRefetching = isLoading || isRefetching || isFetching;
    const transientError = Boolean(error) && Boolean(errorCategory) && isTransientErrorCategory(errorCategory!);
    return { enabled, get, loaded, loadingOrRefetching, transientError };
  }, [data, isLoading, isRefetching, isFetching, error, errorCategory, fid, uid]);
}

// ---------------------------------------------------------------------------
// Route guard wrapper: `wrapRouteWithFeature(featureKey, Component)` — returns
// a new component that renders FeatureNotEnabledPage if the feature is disabled.
//
// Intended usage (example):
//   const HRPage = wrapRouteWithFeature('module.hr', HRInnerPage);
//   route('/app/hr', HRPage)

export function wrapRouteWithFeature<P extends object = {}>(
  featureKey: string,
  Component: (props: P) => ReactElement,
): (props: P) => ReactElement {
  return function FeatureGuardedRoute(props: P): ReactElement {
    const res = useFeature(featureKey);
    if (res.isLoading) return <div aria-busy="true" />;
    if (!res.enabled) return <FeatureNotEnabledPage featureKey={featureKey} />;
    return <Component {...props} />;
  };
}

// ---------------------------------------------------------------------------
// Route-level feature guard helpers — never return null as full page.
// These are used exclusively for route-level gating of entire pages.
// ---------------------------------------------------------------------------

export function RouteFeatureLoading(): ReactElement {
  return (
    <div
      style={{
        minHeight: "calc(100vh - 80px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        background: "transparent",
      }}
      data-testid="route-feature-loading"
    >
      <div
        style={{
          borderRadius: 12,
          padding: "28px 36px",
          background: "#ffffff",
          border: "1px solid #e5e7eb",
          boxShadow: "0 4px 12px rgba(0,0,0,0.04)",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "3px solid #d1d5db",
            borderTopColor: "#111827",
            animation: "spin 0.9s linear infinite",
          }}
        />
        <div style={{ fontSize: 14, color: "#374151", fontWeight: 500 }}>
          Loading access…
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export function RouteFeatureError(props: {
  error: unknown;
  onRetry: () => void;
}): ReactElement {
  const errId = useMemo(() => {
    const rand = Math.floor(100000 + Math.random() * 900000);
    return `ACCESS-${rand}`;
  }, []);
  return (
    <div
      style={{
        minHeight: "calc(100vh - 80px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
      data-testid="route-feature-error"
    >
      <div
        style={{
          maxWidth: 520,
          width: "100%",
          borderRadius: 12,
          padding: 32,
          textAlign: "center",
          background: "white",
          border: "1px solid #fee2e2",
          boxShadow: "0 4px 12px rgba(0,0,0,0.04)",
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: "#FEF2F2",
            color: "#DC2626",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: 22,
            marginBottom: 16,
          }}
        >
          !
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px 0" }}>
          Unable to load your access settings
        </h2>
        <p style={{ color: "#4B5563", margin: "0 0 16px 0", fontSize: 14, lineHeight: 1.6 }}>
          We could not verify your entitlements. Please try again or contact
          your firm administrator if the problem persists.
        </p>
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={props.onRetry}
            type="button"
            style={{
              display: "inline-block",
              padding: "10px 18px",
              borderRadius: 8,
              background: "#111827",
              color: "white",
              border: "none",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
            }}
            data-testid="route-feature-retry"
          >
            Retry
          </button>
        </div>
        <p style={{ margin: 0, color: "#6B7280", fontSize: 12 }}>
          Error ID: <code style={{ fontWeight: 600 }}>{errId}</code>
        </p>
      </div>
    </div>
  );
}

export interface RouteFeatureAccessGuardProps {
  feature: string;
  permission?: { module: string; action: string };
  children: ReactNode;
}

export function RouteFeatureAccessGuard(
  props: RouteFeatureAccessGuardProps,
): ReactElement {
  const { feature, permission, children } = props;
  const raw = useUserEffectiveFeatures();
  const eff = useEffectiveUserFeature(feature);

  if (raw.isLoading || eff.isLoading) {
    return <RouteFeatureLoading />;
  }
  if (raw.error) {
    return (
      <RouteFeatureError
        error={raw.error}
        onRetry={() => {
          void raw.refetch();
        }}
      />
    );
  }
  // Distinguish firm vs user denial using real truth (firmEnabled/userEnabled)
  if (!eff.firmEnabled) {
    return <FeatureNotEnabledPage featureKey={feature} />;
  }
  if (!eff.userEnabled || !eff.enabled) {
    return <UserFeatureNotEnabledPage featureKey={feature} />;
  }
  if (permission) {
    return (
      <PermissionGuard module={permission.module} action={permission.action}>
        {children}
      </PermissionGuard>
    );
  }
  if (typeof children === "function") {
    return (children as any)(eff);
  }
  return <>{children}</>;
}
