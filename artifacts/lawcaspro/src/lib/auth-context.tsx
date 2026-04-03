import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { AuthUser } from "@workspace/api-client-react/src/generated/api.schemas";
import { useGetMe, useLogout } from "@workspace/api-client-react";

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  login: (user: AuthUser, token?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const { data: me, isLoading: isMeLoading } = useGetMe({
    query: {
      retry: false,
    }
  });

  const logoutMutation = useLogout();

  useEffect(() => {
    if (!isMeLoading) {
      if (me) {
        setUser(me);
        const stored = sessionStorage.getItem("_lcp_tok");
        if (stored) setToken(stored);
      }
      setIsLoading(false);
    }
  }, [me, isMeLoading]);

  const login = (newUser: AuthUser, newToken?: string) => {
    setUser(newUser);
    if (newToken) {
      setToken(newToken);
      sessionStorage.setItem("_lcp_tok", newToken);
    }
  };

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        setUser(null);
        setToken(null);
        sessionStorage.removeItem("_lcp_tok");
      }
    });
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout: handleLogout }}>
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
