export const AUTH_UNAUTHORIZED_EVENT = "lawcaspro:auth-unauthorized";

export function emitAuthUnauthorized(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
}

export function onAuthUnauthorized(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = () => handler();
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, h);
  return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, h);
}

