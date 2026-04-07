const KEY = "auth_token";

export function getStoredAuthToken(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && v.trim() !== "" ? v : null;
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
  }
}

export function clearStoredAuthToken(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
  }
}

