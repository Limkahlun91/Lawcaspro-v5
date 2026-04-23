const KEY = "lawcaspro_support_session_id";

export function getSupportSessionId(): string | null {
  try {
    const v = window.localStorage.getItem(KEY);
    const s = v ? String(v).trim() : "";
    return s ? s : null;
  } catch {
    return null;
  }
}

export function setSupportSessionId(id: string | number | null): void {
  try {
    if (id == null) {
      window.localStorage.removeItem(KEY);
      return;
    }
    const s = String(id).trim();
    if (!s) {
      window.localStorage.removeItem(KEY);
      return;
    }
    window.localStorage.setItem(KEY, s);
  } catch {
  }
}

export function clearSupportSessionId(): void {
  setSupportSessionId(null);
}

