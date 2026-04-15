import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLogout } from "@workspace/api-client-react";
import type { AuthUser } from "@workspace/api-client-react";
import { apiRequest } from "./api-client";
import { clearStoredAuthToken, getStoredAuthToken } from "./auth-token";
import { onAuthUnauthorized } from "./auth-events";
import { ME_QUERY_KEY } from "./query-keys";

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  hydrationError?: unknown;
  retryHydration?: () => void;
  isRetryingHydration?: boolean;
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
      const token = getStoredAuthToken();
      const res = await apiRequest("/api/auth/me", {
        allowStatuses: [401],
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal,
        timeoutMs: 25000,
      });
      if (res.status === 401) return null;
      if (res.status === 204) return null;
      return (await res.json()) as AuthUser;
    },
  });
  const { data: me, isLoading: isMeLoading, isError: isMeError, error: meError, refetch: refetchMe, isFetching: isMeFetching } = meQuery;

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

  const retryHydration = () => {
    setIsLoading(true);
    void refetchMe();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        hydrationError: isMeError ? meError : undefined,
        retryHydration,
        isRetryingHydration: isMeFetching,
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
