// GATE 1 / G1-5 SCOPED: Single authority = HttpOnly auth_token cookie.
// These functions are preserved for import compatibility across the frontend
// codebase and existing test mocks (which import these symbols).
//
// Transition behaviour:
//   - getStoredAuthToken() always returns null (server never hands out the
//     token in the response body; Cookie is authoritative).
//   - setStoredAuthToken() is intentionally a no-op.
//   - clearStoredAuthToken() still removes any legacy `auth_token` key left
//     over from pre-GATE-1 deployments (hygiene, idempotent).

const LEGACY_KEY = "auth_token";

export function getStoredAuthToken(): string | null {
  return null;
}

export function setStoredAuthToken(_token: string): void {
  // Intentionally empty.
}

export function clearStoredAuthToken(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore secure-context / disabled-storage errors
  }
}
