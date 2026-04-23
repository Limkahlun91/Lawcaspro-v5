import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useContext, useEffect, useState } from "react";
import { setToken } from "@/lib/api";

export interface User {
  id: number;
  email: string;
  name: string;
  userType: string;
  firmId: number | null;
  firmName: string | null;
  roleId: number | null;
  roleName: string | null;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = "lawcaspro_auth_token";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(TOKEN_KEY);
        if (!stored) return;
        setToken(stored);
        const domain = process.env.EXPO_PUBLIC_DOMAIN;
        const res = await fetch(`https://${domain}/api/auth/me`, {
          headers: { Authorization: `Bearer ${stored}` },
        });
        if (res.ok) {
          const data = await res.json();
          const user = (data && typeof data === "object" && "ok" in data) ? (data as any).data : data;
          setUser(user ?? null);
        } else {
          await AsyncStorage.removeItem(TOKEN_KEY);
          setToken(null);
        }
      } catch {
        /* ignore */
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    const res = await fetch(`https://${domain}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const message =
        err && typeof err === "object" && "ok" in (err as any) && (err as any).ok === false
          ? String((err as any).error?.message ?? "Login failed")
          : String((err as any)?.error ?? "Login failed");
      throw new Error(message);
    }
    const raw = await res.json();
    const data = raw && typeof raw === "object" && "ok" in (raw as any) ? (raw as any).data : raw;
    await AsyncStorage.setItem(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser({
      id: data.id,
      email: data.email,
      name: data.name,
      userType: data.userType,
      firmId: data.firmId,
      firmName: data.firmName,
      roleId: data.roleId,
      roleName: data.roleName,
    });
  };

  const logout = async () => {
    try {
      const stored = await AsyncStorage.getItem(TOKEN_KEY);
      if (stored) {
        const domain = process.env.EXPO_PUBLIC_DOMAIN;
        await fetch(`https://${domain}/api/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${stored}` },
        });
      }
    } catch {
      /* ignore */
    }
    await AsyncStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
