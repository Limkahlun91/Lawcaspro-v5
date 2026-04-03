import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { AuthUser } from "@workspace/api-client-react/src/generated/api.schemas";
import { useGetMe, useLogout } from "@workspace/api-client-react";

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

  const { data: me, isLoading: isMeLoading } = useGetMe({
    query: {
      retry: false,
    }
  });

  const logoutMutation = useLogout();

  useEffect(() => {
    if (!isMeLoading) {
      if (me) setUser(me);
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
