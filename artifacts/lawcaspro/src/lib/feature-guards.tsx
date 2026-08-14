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

const USER_EFFECTIVE_QUERY_KEY = ["firm", "user", "effective-features"];

export function fetchUserEffectiveFeatures(): Promise<UserEffectiveFeatureBundle> {
  return apiFetchJson<any>("/users/_self/effective-features").then(
    (r) => (r?.data ?? r) as UserEffectiveFeatureBundle,
  );
}

export function useUserEffectiveFeatures(): {
  data?: UserEffectiveFeatureBundle;
  isLoading: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} {
  const res = useQuery<UserEffectiveFeatureBundle>({
    queryKey: USER_EFFECTIVE_QUERY_KEY,
    queryFn: fetchUserEffectiveFeatures,
    staleTime: 45_000,
    refetchOnWindowFocus: "always",
    retry: 2,
  });
  return {
    data: res.data,
    isLoading: res.isLoading,
    error: res.error,
    refetch: res.refetch,
  };
}

export function useInvalidateUserEffectiveFeatures(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: USER_EFFECTIVE_QUERY_KEY });
  }, [qc]);
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
  const { data, isLoading } = useUserEffectiveFeatures();
  const firm = useFeature(featureKey);
  return useMemo<EffectiveUseFeatureResult>(() => {
    if (!featureKey) return { isLoading: false, enabled: false, firmEnabled: false, userEnabled: false };
    const eff = data?.effective?.[featureKey];
    const loadingOrPending = isLoading || !data;
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
    if (loadingOrPending && !eff) {
      return {
        isLoading: true,
        enabled: !!firm.enabled,
        firmEnabled: !!firm.enabled,
        userEnabled: !!firm.enabled,
      };
    }
    return {
      isLoading: false,
      enabled: !!firm.enabled,
      firmEnabled: !!firm.enabled,
      userEnabled: !!firm.enabled,
      denialCode: firm.denialCode ?? null,
      source: (firm.source as any) ?? null,
    };
  }, [featureKey, data, isLoading, firm.enabled, firm.denialCode, firm.source]);
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

const EFFECTIVE_FEATURES_QUERY_KEY = ["firm", "user", "effective-features"];
const REGISTRY_QUERY_KEY = ["platform", "feature-registry"];
const INVALIDATION_POLL_INTERVAL_MS = 15_000; // Poll server-epoch every 15s for fast propagation; server invalidation also returns via headers.

// ---------------------------------------------------------------------------
// React hooks: fetch entitlements + registry once per user session
// ---------------------------------------------------------------------------

export function useFirmEntitlements<TFirmOverride = FirmOverrideLike>(): {
  data?: FirmEntitlementsBundle;
  isLoading: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
} {
  const res = useQuery<FirmEntitlementsBundle>({
    queryKey: EFFECTIVE_FEATURES_QUERY_KEY,
    queryFn: async () => {
      const r = await apiFetchJson<any>(`/users/_self/effective-features`);
      const raw = (r?.data ?? r) as any;
      // Shape-adapt into FirmEntitlementsBundle.items used downstream.
      const effective: Record<string, any> = raw?.effective ?? {};
      const items: Record<string, EntitlementLike> = {};
      for (const k of Object.keys(effective)) {
        const v = effective[k] as any;
        items[k] = {
          enabled: Boolean(v?.enabled),
          source: v?.source ?? "feature_default",
          value: v?.value ?? v?.enabled,
          valueType: v?.valueType ?? "boolean",
          denied: v?.denied ?? null,
          denialReason: v?.denialReason ?? null,
          usage: v?.usage ?? null,
        } as EntitlementLike;
      }
      const overrides: FirmOverrideLike[] = Array.isArray(raw?.explicitOverrides)
        ? raw.explicitOverrides.map((o: any, i: number) => ({
            id: i + 1,
            featureKey: o.featureKey,
            overrideMode: o.isEnabled ? "enabled" : "disabled",
            createdAt: new Date().toISOString(),
          }))
        : [];
      return {
        firm: raw?.firmId ? { id: raw.firmId, status: "active", subStatus: null, planId: null, isCustomPlan: false, customPriceMonthly: null } : null,
        plan: null,
        subscriptionPolicy: null,
        items,
        overrides,
      } as unknown as FirmEntitlementsBundle;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: "stale",
    retry: 1,
  });
  return { data: res.data, isLoading: res.isLoading, error: res.error, refetch: res.refetch };
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
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: EFFECTIVE_FEATURES_QUERY_KEY });
  }, [qc]);
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
} {
  const { data, isLoading } = useUserEffectiveFeatures();
  return useMemo(() => {
    const eff = data?.effective ?? {};
    return {
      enabled: (k) => Boolean(eff[k]?.effectiveEnabled),
      get: (k) => eff[k],
      loaded: !isLoading && Boolean(data),
    };
  }, [data, isLoading]);
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
