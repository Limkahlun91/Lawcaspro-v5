import { createContext, useContext, useEffect, useState, ReactNode, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLogout } from "@workspace/api-client-react";
import type { AuthUser } from "@workspace/api-client-react";
import { apiRequest } from "./api-client";
import { clearStoredAuthToken } from "./auth-token";
import { onAuthUnauthorized } from "./auth-events";
import { ME_QUERY_KEY, clearIdentityScopedQueries, userPermissionsQueryKey } from "./query-keys";
import { unwrapApiData } from "./api-contract";
import { extractAuthUser } from "./auth-response";
import {
  classifyPermissionError,
  isTransientErrorCategory,
} from "./permissions";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

type PermissionItem = { module: string; action: string };

function normalizePermissions(input: unknown): PermissionItem[] {
  const raw =
    Array.isArray(input)
      ? input
      : isRecord(input) && Array.isArray(input.permissions)
        ? input.permissions
        : [];
  return raw
    .filter((p): p is Record<string, unknown> => isRecord(p))
    .map((p) => ({
      module: typeof p.module === "string" ? p.module : "",
      action: typeof p.action === "string" ? p.action : "",
    }))
    .filter((p) => Boolean(p.module) && Boolean(p.action));
}

type MeRefreshOutcome =
  | { kind: "success"; user: AuthUser | null }
  | { kind: "unauthorized" }
  | { kind: "preserve"; cause: "network" | "server" | "client" | "timeout"; status?: number; code?: string };

export interface AuthTypedError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
}

function makeAuthTypedError(message: string, opts?: { status?: number; code?: string; requestId?: string }): AuthTypedError {
  const e = new Error(message) as AuthTypedError;
  if (opts?.status !== undefined) e.status = opts.status;
  if (opts?.code !== undefined) e.code = opts.code;
  if (opts?.requestId !== undefined) e.requestId = opts.requestId;
  e.name = "AuthTypedError";
  return e;
}

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

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  authStatus: "loading" | "authenticated" | "unauthenticated" | "error";
  permissionsStatus?: "idle" | "loading" | "ready" | "unavailable" | "error";
  retryPermissions?: () => void;
  retryMe?: () => void;
  login: (user: AuthUser) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authStatus, setAuthStatus] = useState<"loading" | "authenticated" | "unauthenticated" | "error">("loading");
  const queryClient = useQueryClient();
  const firstHydrationDone = useRef<boolean>(false);
  const lastSuccessfulUserRef = useRef<AuthUser | null>(null);
  const previousIdentityRef = useRef<{ firmId: unknown; userId: unknown } | null>(null);

  useEffect(() => {
    if (!user) {
      if (previousIdentityRef.current) {
        const id = previousIdentityRef.current;
        previousIdentityRef.current = null;
        void clearIdentityScopedQueries({
          queryClient,
          firmId: id.firmId as any,
          userId: id.userId as any,
        }).catch(() => {
        });
      }
      return;
    }
    const currentFirm = (user as any).firmId ?? null;
    const currentUserId = (user as any).id ?? null;
    const prev = previousIdentityRef.current;
    if (!prev) {
      previousIdentityRef.current = { firmId: currentFirm, userId: currentUserId };
      return;
    }
    const sameFirm =
      (prev.firmId === null && currentFirm === null) ||
      (prev.firmId !== null && currentFirm !== null && String(prev.firmId) === String(currentFirm));
    const sameUser =
      (prev.userId === null && currentUserId === null) ||
      (prev.userId !== null && currentUserId !== null && String(prev.userId) === String(currentUserId));
    if (!sameFirm || !sameUser) {
      const oldId = prev;
      previousIdentityRef.current = { firmId: currentFirm, userId: currentUserId };
      void clearIdentityScopedQueries({
        queryClient,
        firmId: oldId.firmId as any,
        userId: oldId.userId as any,
      }).catch(() => {
      });
    }
  }, [user ? ((user as any).id ?? null) : null, user ? ((user as any).firmId ?? null) : null, queryClient]);

  const meQuery = useQuery<AuthUser | null>({
    queryKey: ME_QUERY_KEY,
    retry: false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    queryFn: async ({ signal }): Promise<AuthUser | null> => {
      let res: Response;
      let requestId: string | undefined;
      try {
        res = await apiRequest("/api/auth/me", {
          allowStatuses: [401, 403, 500, 503],
          signal,
          timeoutMs: 15000,
        });
        const gotRid = res.headers.get("x-request-id") || res.headers.get("request-id");
        if (gotRid) requestId = gotRid;
      } catch (err) {
        if (lastSuccessfulUserRef.current) {
          return lastSuccessfulUserRef.current;
        }
        throw err;
      }
      if (res.status === 401) {
        lastSuccessfulUserRef.current = null;
        if (typeof window !== "undefined") {
          try {
            const wrap = (window as any).__lawcasproCachedEffectiveUser as { firmId: unknown; userId: unknown; data: AuthUser } | undefined;
            if (wrap && typeof wrap === "object" && "data" in wrap) {
              (window as any).__lawcasproCachedEffectiveUser = null;
            } else {
              (window as any).__lawcasproCachedEffectiveUser = null;
            }
          } catch {
          }
        }
        return null;
      }
      if (res.status === 200 || res.status === 204) {
        if (res.status === 204) return lastSuccessfulUserRef.current;
        const body = (await res.json()) as unknown;
        const unwrapped = unwrapApiData<unknown>(body);
        if (unwrapped === null || unwrapped === undefined) {
          lastSuccessfulUserRef.current = null;
          if (typeof window !== "undefined") {
            try { (window as any).__lawcasproCachedEffectiveUser = null; } catch {}
          }
          return null;
        }
        const extracted = extractAuthUser(unwrapped);
        if (extracted) {
          lastSuccessfulUserRef.current = extracted;
          if (typeof window !== "undefined") {
            try {
              (window as any).__lawcasproCachedEffectiveUser = {
                firmId: (extracted as any).firmId ?? null,
                userId: (extracted as any).id ?? null,
                fetchedAt: Date.now(),
                data: extracted,
              };
            } catch {
            }
          }
        }
        return extracted;
      }
      if (lastSuccessfulUserRef.current) {
        return lastSuccessfulUserRef.current;
      }
      let bodyCode: string | undefined;
      let bodyMessage: string | undefined;
      try {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const b = (await res.clone().json()) as Record<string, unknown> | null;
          if (b && typeof b === "object") {
            bodyCode = typeof (b as any).code === "string" ? (b as any).code : undefined;
            if (typeof (b as any).data?.code === "string") bodyCode = (b as any).data.code;
            if (typeof (b as any).error?.code === "string") bodyCode = (b as any).error.code;
            bodyMessage = typeof (b as any).message === "string" ? (b as any).message : undefined;
            if (typeof (b as any).data?.message === "string") bodyMessage = (b as any).data.message;
          }
        }
      } catch {
      }
      throw makeAuthTypedError(
        bodyMessage || `GET /api/auth/me failed with status ${res.status}`,
        { status: res.status, code: bodyCode, requestId }
      );
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

  const permissionsQuery = useQuery<{ permissions: PermissionItem[]; unavailable?: boolean }>({
    queryKey: userPermissionsQueryKey((user as any)?.firmId ?? null, (user as any)?.id ?? null),
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
    queryFn: async ({ signal }) => {
      const currentCached = (user as { permissions?: unknown } | null)?.permissions;
      const transientLkg: PermissionItem[] | undefined =
        currentCached && Array.isArray(currentCached) ? normalizePermissions(currentCached) : undefined;

      try {
        const res = await apiRequest("/api/auth/permissions", {
          allowStatuses: [401, 403, 404, 500, 503],
          signal,
          timeoutMs: 8000,
        });
        if (res.status === 401) return { permissions: [] };
        if (res.status === 403) return { permissions: [], unavailable: false };
        if (res.status === 404) {
          if (transientLkg && transientLkg.length > 0) {
            return { permissions: transientLkg, unavailable: true };
          }
          return { permissions: [], unavailable: true };
        }
        if (res.status === 204) {
          if (transientLkg && transientLkg.length > 0) {
            return { permissions: transientLkg };
          }
          return { permissions: [] };
        }
        if (res.status === 200) {
          const body = (await res.json()) as unknown;
          const data = unwrapApiData<unknown>(body);
          const perms = normalizePermissions(data);
          return { permissions: perms };
        }
        const cat = classifyPermissionError({ status: res.status });
        if (isTransientErrorCategory(cat)) {
          if (transientLkg && transientLkg.length > 0) {
            return { permissions: transientLkg, unavailable: true };
          }
          return { permissions: [], unavailable: true };
        }
        return { permissions: [] };
      } catch (err) {
        const cat = classifyPermissionError(err);
        if (isTransientErrorCategory(cat)) {
          if (transientLkg && transientLkg.length > 0) {
            return { permissions: transientLkg, unavailable: true };
          }
          return { permissions: [], unavailable: true };
        }
        throw err;
      }
    },
  });

  useEffect(() => {
    if (!user || user.userType !== "firm_user") return;
    if (!permissionsQuery.data) return;
    if (permissionsQuery.isFetching) return;
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
  }, [permissionsQuery.data, permissionsQuery.isFetching, queryClient, user]);

  useEffect(() => {
    return onAuthUnauthorized(() => {
      const oldFirmId = user ? (user as any).firmId ?? null : null;
      const oldUserId = user ? (user as any).id ?? null : null;
      lastSuccessfulUserRef.current = null;
      previousIdentityRef.current = null;
      clearStoredAuthToken();
      setUser(null);
      setAuthStatus("unauthenticated");
      queryClient.setQueryData(ME_QUERY_KEY, null);
      void clearIdentityScopedQueries({
        queryClient,
        firmId: oldFirmId,
        userId: oldUserId,
      }).catch(() => {
      });
    });
  }, [queryClient, user]);

  const login = async (newUser: AuthUser): Promise<void> => {
    const previous =
      previousIdentityRef.current ??
      (user
        ? {
            firmId: (user as any).firmId ?? null,
            userId: (user as any).id ?? null,
          }
        : null);

    const next = {
      firmId: (newUser as any).firmId ?? null,
      userId: (newUser as any).id ?? null,
    };

    const changed =
      previous &&
      (
        String(previous.firmId ?? "") !== String(next.firmId ?? "")
        ||
        String(previous.userId ?? "") !== String(next.userId ?? "")
      );

    if (changed) {
      await clearIdentityScopedQueries({
        queryClient,
        firmId: previous.firmId,
        userId: previous.userId,
      });
    }

    previousIdentityRef.current = next;
    lastSuccessfulUserRef.current = newUser;

    if (typeof window !== "undefined") {
      try {
        (window as any).__lawcasproCachedEffectiveUser = {
          firmId: next.firmId,
          userId: next.userId,
          fetchedAt: Date.now(),
          data: newUser,
        };
      } catch {
      }
    }

    queryClient.setQueryData(ME_QUERY_KEY, newUser);
    setUser(newUser);
    setAuthStatus("authenticated");
  };

  const handleLogout = () => {
    const oldFirmId = user ? (user as any).firmId ?? null : null;
    const oldUserId = user ? (user as any).id ?? null : null;
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        lastSuccessfulUserRef.current = null;
        previousIdentityRef.current = null;
        if (typeof window !== "undefined") {
          try { (window as any).__lawcasproCachedEffectiveUser = null; } catch {}
          try { (window as any).__lawcasproCachedEffectiveFeatures = null; } catch {}
        }
        clearStoredAuthToken();
        setUser(null);
        queryClient.setQueryData(ME_QUERY_KEY, null);
        void clearIdentityScopedQueries({
          queryClient,
          firmId: oldFirmId,
          userId: oldUserId,
        }).catch(() => {
        });
      },
    });
  };

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
