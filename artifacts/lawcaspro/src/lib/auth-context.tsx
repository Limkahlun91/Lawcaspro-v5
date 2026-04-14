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
  login: (user: AuthUser) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  const { data: me, isLoading: isMeLoading } = useQuery<AuthUser | null>({
    queryKey: ME_QUERY_KEY,
    retry: false,
    queryFn: async ({ signal }) => {
      const token = getStoredAuthToken();
      const res = await apiRequest("/api/auth/me", {
        allowStatuses: [401],
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal,
      });
      if (res.status === 401) return null;
      if (res.status === 204) return null;
      return (await res.json()) as AuthUser;
    },
  });

  const logoutMutation = useLogout();

  useEffect(() => {
    if (!isMeLoading) {
      setUser(me ?? null);
      setIsLoading(false);
    }
  }, [me, isMeLoading]);

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
    <AuthContext.Provider value={{ user, isLoading, login, logout: handleLogout }}>
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
