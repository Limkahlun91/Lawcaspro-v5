import type { QueryClient } from "@tanstack/react-query";

export const ME_QUERY_KEY = ["me"] as const;

export type IdentityKey = readonly [
  "firm", string | null,
  "user", string | null,
  ...string[]
];

function str(v: number | string | null | undefined): string | null {
  return typeof v === "number" || typeof v === "string" ? String(v) : null;
}

export function effectiveFeaturesQueryKey(
  firmId: number | string | null | undefined,
  userId: number | string | null | undefined,
): readonly ["firm", string | null, "user", string | null, "effective-features"] {
  return ["firm", str(firmId), "user", str(userId), "effective-features"];
}

export function userPermissionsQueryKey(
  firmId: number | string | null | undefined,
  userId: number | string | null | undefined,
): readonly ["firm", string | null, "user", string | null, "auth-permissions"] {
  return ["firm", str(firmId), "user", str(userId), "auth-permissions"];
}

export function userUnreadCountQueryKey(
  firmId: number | string | null | undefined,
  userId: number | string | null | undefined,
  scope?: string,
): readonly string[] {
  const base: string[] = [
    "firm",
    str(firmId) as any,
    "user",
    str(userId) as any,
    "unread-count",
  ];
  return scope ? [...base, scope] : base;
}

export function caseNotificationsUnreadCountQueryKey(
  firmId: number | string | null | undefined,
  userId: number | string | null | undefined,
  scope?: string,
): readonly string[] {
  const base: string[] = [
    "firm",
    str(firmId) as any,
    "user",
    str(userId) as any,
    "case-notifications",
    "unread-counts",
  ];
  return scope ? [...base, scope] : base;
}

export function userNotificationsQueryKey(
  firmId: number | string | null | undefined,
  userId: number | string | null | undefined,
  ...rest: string[]
): readonly string[] {
  const base: string[] = [
    "firm",
    str(firmId) as any,
    "user",
    str(userId) as any,
    "user-notifications",
    ...rest,
  ];
  return base;
}

export function userNotificationSummaryQueryKey(
  firmId: number | string | null | undefined,
  userId: number | string | null | undefined,
  scope?: string,
): readonly string[] {
  const base: string[] = [
    "firm",
    str(firmId) as any,
    "user",
    str(userId) as any,
    "user-notifications",
    "summary",
  ];
  return scope ? [...base, scope] : base;
}

export interface ClearIdentityScopedQueriesOptions {
  queryClient: QueryClient;
  firmId: number | string | null | undefined;
  userId: number | string | null | undefined;
}

export async function clearIdentityScopedQueries(
  opts: ClearIdentityScopedQueriesOptions,
): Promise<void> {
  const { queryClient, firmId, userId } = opts;
  const f = str(firmId);
  const u = str(userId);
  const prefix = ["firm", f, "user", u] as const;

  await queryClient.cancelQueries({
    queryKey: prefix,
    exact: false,
  });

  queryClient.removeQueries({
    queryKey: prefix,
    exact: false,
  });

  if (typeof window !== "undefined") {
    try {
      const gw = window as any;
      const efCache = gw.__lawcasproCachedEffectiveFeatures;
      if (efCache && typeof efCache === "object") {
        const cachedFirm = efCache.firmId;
        const cachedUser = efCache.userId;
        const match =
          ((f === null && cachedFirm === null) || (f !== null && String(cachedFirm) === String(f))) &&
          ((u === null && cachedUser === null) || (u !== null && String(cachedUser) === String(u)));
        if (match) {
          gw.__lawcasproCachedEffectiveFeatures = null;
        }
      }
      const userCache = gw.__lawcasproCachedEffectiveUser;
      if (userCache && typeof userCache === "object") {
        const cachedFirm = (userCache as any).firmId;
        const cachedUser = (userCache as any).id ?? (userCache as any).userId;
        const match =
          ((f === null && cachedFirm === null) || (f !== null && String(cachedFirm) === String(f))) &&
          ((u === null && cachedUser === null) || (u !== null && String(cachedUser) === String(u)));
        if (match) {
          gw.__lawcasproCachedEffectiveUser = null;
        }
      }
    } catch {
    }
  }
}
