import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLogout } from "@workspace/api-client-react";
import type { AuthUser } from "@workspace/api-client-react";
import { apiRequest } from "./api-client";
import { clearStoredAuthToken } from "./auth-token";
import { onAuthUnauthorized } from "./auth-events";
import { ME_QUERY_KEY } from "./query-keys";
import { unwrapApiData } from "./api-contract";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

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
  permissionsStatus?: "idle" | "loading" | "ready" | "unavailable" | "error";
  retryPermissions?: () => void;
  login: (user: AuthUser) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  const meQuery = useQuery<AuthUser | null>({
    queryKey: ME_QUERY_KEY,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await apiRequest("/api/auth/me", {
        allowStatuses: [401],
        signal,
        timeoutMs: 8000,
      });
      if (res.status === 401) return null;
      const body = (await res.json()) as unknown;
      const unwrapped = unwrapApiData<AuthUser | null>(body);
      return unwrapped ?? null;
    },
  });
  const { data: me, isLoading: isMeLoading, isError: isMeError } = meQuery;

  const logoutMutation = useLogout();

  useEffect(() => {
    if (isMeLoading) return;
    if (isMeError) {
      setIsLoading(false);
      return;
    }
    setUser(me ?? null);
    setIsLoading(false);
  }, [me, isMeLoading, isMeError]);

  const permissionsQuery = useQuery<{ permissions: Array<{ module: string; action: string }>; unavailable?: boolean }>({
    queryKey: ["auth-permissions", user?.roleId ?? null],
    enabled: Boolean(user && user.userType === "firm_user" && user.roleId),
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await apiRequest("/api/auth/permissions", {
        allowStatuses: [401, 404],
        signal,
        timeoutMs: 8000,
      });
      if (res.status === 401) return { permissions: [] };
      if (res.status === 404) return { permissions: [], unavailable: true };
      const body = (await res.json()) as unknown;
      const data = unwrapApiData<{ permissions: Array<{ module: string; action: string }> }>(body);
      return { permissions: parsePermissionsPayload(data) };
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
    setUser(merged);
    queryClient.setQueryData(ME_QUERY_KEY, merged);
  }, [permissionsQuery.data, queryClient, user]);

  useEffect(() => {
    return onAuthUnauthorized(() => {
      clearStoredAuthToken();
      setUser(null);
      queryClient.setQueryData(ME_QUERY_KEY, null);
    });
  }, [queryClient]);

  const login = (newUser: AuthUser) => {
    setUser(newUser);
    queryClient.setQueryData(ME_QUERY_KEY, newUser);
  };

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        clearStoredAuthToken();
        setUser(null);
        queryClient.setQueryData(ME_QUERY_KEY, null);
      }
    });
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        permissionsStatus: (() => {
          if (!user || user.userType !== "firm_user" || !user.roleId) return "idle";
          if (permissionsQuery.isError) return "error";
          if (permissionsQuery.isLoading || permissionsQuery.isFetching) return "loading";
          if (permissionsQuery.data?.unavailable) return "unavailable";
          return "ready";
        })(),
        retryPermissions: () => { void permissionsQuery.refetch(); },
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
