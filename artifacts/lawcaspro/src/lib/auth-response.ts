import type { AuthUser } from "@workspace/api-client-react";

type RecordLike = Record<string, unknown>;

const isRecord = (v: unknown): v is RecordLike => typeof v === "object" && v !== null;

export function isAuthUserLike(value: unknown): value is AuthUser {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.email === "string" &&
    typeof value.name === "string" &&
    typeof value.userType === "string" &&
    typeof value.status === "string"
  );
}

export function extractAuthUser(value: unknown): AuthUser | null {
  if (isAuthUserLike(value)) return value;
  if (isRecord(value) && isAuthUserLike(value.user)) return value.user;
  if (isRecord(value) && isRecord(value.data) && isAuthUserLike(value.data)) return value.data;
  if (isRecord(value) && isRecord(value.data) && isAuthUserLike(value.data.user)) return (value.data.user as AuthUser);
  return null;
}

export function extractToken(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.token === "string" && value.token.trim()) return value.token.trim();
  if (isRecord(value.user) && typeof value.user.token === "string" && value.user.token.trim()) return value.user.token.trim();
  if (isRecord(value.data) && typeof value.data.token === "string" && value.data.token.trim()) return value.data.token.trim();
  if (isRecord(value.data) && isRecord(value.data.user) && typeof value.data.user.token === "string" && value.data.user.token.trim()) {
    return value.data.user.token.trim();
  }
  return null;
}

export function requiresTotp(value: unknown): boolean {
  return isRecord(value) && value.needsTotp === true;
}

