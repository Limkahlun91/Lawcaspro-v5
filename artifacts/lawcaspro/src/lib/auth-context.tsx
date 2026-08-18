import { createContext, useContext, useEffect, useState, ReactNode, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLogout } from "@workspace/api-client-react";
import type { AuthUser } from "@workspace/api-client-react";
import { apiRequest } from "./api-client";
import { clearStoredAuthToken } from "./auth-token";
import { onAuthUnauthorized } from "./auth-events";
import { ME_QUERY_KEY } from "./query-keys";
import { unwrapApiData } from "./api-contract";
import { extractAuthUser } from "./auth-response";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

type MeRefreshOutcome =
  | { kind: "success"; user: AuthUser | null }
  | { kind: "unauthorized" }
  | { kind: "preserve"; cause: "network" | "server" | "client" | "timeout"; status?: number; code?: string };

const classifyMeError = (err: unknown): { cause: "network" | "server" | "client" | "timeout"; status?: number; code?: string } => {
  if (!err || typeof err !== "object") return { cause: "server" };
  const rec = err as Record<string, unknown>;
  const status = typeof rec.status === "number" ? rec.status : undefined;
  const code = typeof rec.code === "string" ? rec.code : undefined;
  const name = typeof rec.name === "string" ? rec.name : undefined;
  if (name === "RequestTimeoutError" || name === "TimeoutError" || name === "AbortError") {
    return { cause: "timeout", status, code };
  }
  const msg = typeof (rec as { message?: unknown }).message === "string" ? String((rec as { message?: unknown }).message).toLowerCase() : "";
  if (
    msg.includes("networkerror") ||
    msg.includes("failed to fetch") ||
    msg.includes("network error") ||
    msg.includes("load failed") ||
    (typeof window !== "undefined" && !window.navigator.onLine)
  ) {
    return { cause: "network", status, code };
  }
  if (typeof status === "number") {
    if (status === 401) return { cause: "server", status, code };
    if (status === 403 || (status >= 400 && status < 500)) return { cause: "client", status, code };
    if (status >= 500) return { cause: "server", status, code };
  }
  if (code === "DB_BUSY" || code === "SERVICE_UNAVAILABLE") return { cause: "server", status, code };
  return { cause: "server", status, code };
};

const parsePermissionsPayload = (body: unknown): Array<{ module: string; action: string }> => {
  if (!isRecord(body)) return [];
  const perms = body.permissions;
  if (!Array.isArray(perms)) return [];
  return perms
    .filter((p): p is Record<string, unknown> => isRecord(p))
    .map((p) => ({
      module: typeof p.module === "string" ? p.module : "",
      action: typeof p.action === "string" ? p.action : "",
    }))
    .filter((p) => p.module && p.action);
};

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  authStatus: "loading" | "authenticated" | "unauthenticated" | "error";
  permissionsStatus?: "idle" | "loading" | "ready" | "unavailable" | "error";
  retryPermissions?: () => void;
  retryMe?: () => void;
  login: (user: AuthUser) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authStatus, setAuthStatus] = useState<"loading" | "authenticated" | "unauthenticated" | "error">("loading");
  const queryClient = useQueryClient();
  const firstHydrationDone = useRef<boolean>(false);
  const lastSuccessfulUserRef = useRef<AuthUser | null>(null);

  const meQuery = useQuery<AuthUser | null>({
    queryKey: ME_QUERY_KEY,
    retry: false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    placeholderData: (prev) => prev ?? undefined,
    queryFn: async ({ signal }): Promise<AuthUser | null> => {
      let res: Response;
      try {
        res = await apiRequest("/api/auth/me", {
          allowStatuses: [401, 403, 500, 503],
          signal,
          timeoutMs: 15000,
        });
      } catch (err) {
        const c = classifyMeError(err);
        if (lastSuccessfulUserRef.current) {
          return lastSuccessfulUserRef.current;
        }
        throw err;
      }
      if (res.status === 401) {
        lastSuccessfulUserRef.current = null;
        try { (globalThis as any).__lawcasproCachedEffectiveUser = null; } catch {}
        return null;
      }
      if (res.status === 200 || res.status === 204) {
        if (res.status === 204) return lastSuccessfulUserRef.current;
        const body = (await res.json()) as unknown;
        const unwrapped = unwrapApiData<unknown>(body);
        const extracted = extractAuthUser(unwrapped);
        if (extracted) lastSuccessfulUserRef.current = extracted;
        return extracted;
      }
      if (lastSuccessfulUserRef.current) {
        return lastSuccessfulUserRef.current;
      }
      const err = await apiRequest("/api/auth/me", {
        allowStatuses: [res.status],
        signal: new AbortController().signal,
        timeoutMs: 1,
      }).catch((e) => e);
      throw err instanceof Error ? err : new Error(`GET /api/auth/me failed with status ${res.status}`);
    },
  });
  const { data: me, isLoading: isMeLoading, isError: isMeError, isRefetching: isMeRefetching, failureCount } = meQuery;

  const logoutMutation = useLogout();

  useEffect(() => {
    if (isMeLoading && !firstHydrationDone.current) return;
    if (isMeError) {
      if (lastSuccessfulUserRef.current) {
        if (!firstHydrationDone.current) firstHydrationDone.current = true;
        return;
      }
      if (user) {
        setAuthStatus("authenticated");
        return;
      }
      if (!firstHydrationDone.current) {
        setAuthStatus("error");
      }
      return;
    }
    firstHydrationDone.current = true;
    if (me === null && !isMeRefetching) {
      lastSuccessfulUserRef.current = null;
      setUser(null);
      setAuthStatus("unauthenticated");
      return;
    }
    if (me) {
      lastSuccessfulUserRef.current = me;
      setUser(me);
      setAuthStatus("authenticated");
      return;
    }
    if (lastSuccessfulUserRef.current) {
      setUser(lastSuccessfulUserRef.current);
      setAuthStatus("authenticated");
      return;
    }
    if (!isMeRefetching) {
      setUser(null);
      setAuthStatus(user ? "authenticated" : "unauthenticated");
    }
  }, [isMeError, isMeLoading, isMeRefetching, me, user, failureCount]);

  const permissionsQuery = useQuery<{ permissions: Array<{ module: string; action: string }>; unavailable?: boolean }>({
    queryKey: ["auth-permissions", user?.roleId ?? null],
    enabled: Boolean(
      user &&
        user.userType === "firm_user" &&
        user.roleId &&
        !(Array.isArray((user as any)?.permissions) && (user as any).permissions.length > 0),
    ),
    retry: false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    placeholderData: (prev) => prev ?? undefined,
    queryFn: async ({ signal }) => {
      let res: Response;
      try {
        res = await apiRequest("/api/auth/permissions", {
          allowStatuses: [401, 403, 404, 500, 503],
          signal,
          timeoutMs: 8000,
        });
      } catch (err) {
        const c = classifyMeError(err);
        const currentCached = (user as { permissions?: unknown } | null)?.permissions;
        if (currentCached && Array.isArray(currentCached)) {
          return { permissions: parsePermissionsPayload(currentCached) };
        }
        throw err;
      }
      if (res.status === 401) return { permissions: [] };
      if (res.status === 404) return { permissions: [], unavailable: true };
      if (res.status === 200 || res.status === 204) {
        if (res.status === 204) {
          const currentCached = (user as { permissions?: unknown } | null)?.permissions;
          return { permissions: Array.isArray(currentCached) ? parsePermissionsPayload(currentCached) : [] };
        }
        const body = (await res.json()) as unknown;
        const data = unwrapApiData<{ permissions: Array<{ module: string; action: string }> }>(body);
        return { permissions: parsePermissionsPayload(data) };
      }
      const currentCached = (user as { permissions?: unknown } | null)?.permissions;
      if (currentCached && Array.isArray(currentCached)) {
        return { permissions: parsePermissionsPayload(currentCached) };
      }
      throw new Error(`GET /api/auth/permissions failed with status ${res.status}`);
    },
  });

  useEffect(() => {
    if (!user || user.userType !== "firm_user") return;
    if (!permissionsQuery.data) return;
    if (permissionsQuery.data.unavailable) return;
    const next = permissionsQuery.data.permissions ?? [];
    const current = (user as { permissions?: unknown } | null)?.permissions;
    if (Array.isArray(current)) {
      if (current.length === next.length) {
        const a = current
          .filter((p): p is Record<string, unknown> => isRecord(p))
          .map((p) => `${String(p.module ?? "")}:${String(p.action ?? "")}`)
          .sort()
          .join("|");
        const b = next.map((p) => `${p.module}:${p.action}`).sort().join("|");
        if (a === b) return;
      }
    }
    const merged = Object.assign({}, user, { permissions: next });
    lastSuccessfulUserRef.current = merged;
    setUser(merged);
    queryClient.setQueryData(ME_QUERY_KEY, merged);
  }, [permissionsQuery.data, queryClient, user]);

  useEffect(() => {
    return onAuthUnauthorized(() => {
      lastSuccessfulUserRef.current = null;
      clearStoredAuthToken();
      setUser(null);
      setAuthStatus("unauthenticated");
      queryClient.setQueryData(ME_QUERY_KEY, null);
    });
  }, [queryClient]);

  const login = (newUser: AuthUser) => {
    lastSuccessfulUserRef.current = newUser;
    try {
      (globalThis as any).__lawcasproCachedEffectiveUser = newUser;
    } catch {
    }
    setUser(newUser);
    setAuthStatus("authenticated");
    queryClient.setQueryData(ME_QUERY_KEY, newUser);
    void permissionsQuery.refetch();
  };

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        lastSuccessfulUserRef.current = null;
        try {
          (globalThis as any).__lawcasproCachedEffectiveUser = null;
        } catch {
        }
        clearStoredAuthToken();
        setUser(null);
        queryClient.setQueryData(ME_QUERY_KEY, null);
      }
    });
  };

  useEffect(() => {
    if (user) {
      try {
        (globalThis as any).__lawcasproCachedEffectiveUser = user;
      } catch {
      }
    }
  }, [user]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading: authStatus === "loading",
        authStatus,
        permissionsStatus: (() => {
          if (!user || user.userType !== "firm_user" || !user.roleId) return "idle";
          if (permissionsQuery.isError) {
            const currentCached = (user as { permissions?: unknown } | null)?.permissions;
            if (Array.isArray(currentCached) && currentCached.length > 0) return "ready";
            return "error";
          }
          if (permissionsQuery.isLoading || permissionsQuery.isFetching) {
            const currentCached = (user as { permissions?: unknown } | null)?.permissions;
            if (Array.isArray(currentCached) && currentCached.length > 0) return "ready";
            return "loading";
          }
          if (permissionsQuery.data?.unavailable) return "unavailable";
          return "ready";
        })(),
        retryPermissions: () => { void permissionsQuery.refetch(); },
        retryMe: () => { void meQuery.refetch(); },
        login,
        logout: handleLogout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
