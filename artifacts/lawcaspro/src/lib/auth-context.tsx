import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLogout } from "@workspace/api-client-react";
import type { AuthUser } from "@workspace/api-client-react";
import { apiUrl } from "./api-base";
import { fetchWithTimeout } from "./fetch-with-timeout";

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

  const { data: me, isLoading: isMeLoading } = useQuery<AuthUser | null>({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      const res = await fetchWithTimeout(apiUrl("/api/auth/me"), { credentials: "include", timeoutMs: 15000 });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const logoutMutation = useLogout();

  useEffect(() => {
    if (!isMeLoading) {
      setUser(me ?? null);
      setIsLoading(false);
    }
  }, [me, isMeLoading]);

  const login = (newUser: AuthUser) => {
    setUser(newUser);
  };

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        setUser(null);
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
