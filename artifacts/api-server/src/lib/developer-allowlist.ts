import type { IncomingMessage } from "node:http";
import type { AuthRequest } from "./auth.js";

type ReqLike = Pick<IncomingMessage, "headers"> & {
  path?: string;
  originalUrl?: string;
  url?: string;
  method?: string;
  userType?: unknown;
  firmId?: unknown;
  roleId?: unknown;
  developerId?: unknown;
  roleName?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

const NORMALIZE_ROLE = (v: unknown): string =>
  typeof v === "string" ? v.trim().toLowerCase() : "";

export function isDeveloperPortalUser(req: ReqLike | Pick<AuthRequest, "userType" | "roleName" | "roleId">): boolean {
  if (req.userType === "developer_user") return true;
  if (NORMALIZE_ROLE(req.roleName) === "developer_user") return true;
  return false;
}

const DEV_PORTAL_ALLOW_PREFIXES = [
  "/auth/me",
  "/auth/logout",
  "/auth/permissions",
  "/auth/sessions",
  "/auth/reauth-token",
  "/developer/portal/",
  "/developer/portal",
  "/developer/cases/",
  "/developer/dashboard",
  "/developer/inventory",
  "/developer/projects",
];

const DEV_PORTAL_ALLOW_EXACT = new Set([
  "/auth/me",
  "/auth/logout",
  "/auth/permissions",
  "/auth/sessions",
  "/auth/reauth-token",
]);

export function isDeveloperAllowedPath(pathname: string, method: string, req: ReqLike): { allowed: boolean; reason?: string } {
  const p = typeof pathname === "string" ? pathname.split("?")[0] : "";
  if (!p) return { allowed: false, reason: "empty_path" };
  if (DEV_PORTAL_ALLOW_EXACT.has(p)) return { allowed: true };
  for (const prefix of DEV_PORTAL_ALLOW_PREFIXES) {
    if (p.startsWith(prefix)) {
      if (p.startsWith("/developer/cases/")) {
        const tail = p.slice("/developer/cases/".length);
        const idSeg = tail.split("/")[0];
        const rest = tail.slice(idSeg.length);
        if (rest === "/messages" || rest.startsWith("/messages")) {
          const ch = String(method || req.method || "GET").toUpperCase();
          if (ch === "GET" || ch === "POST") return { allowed: true };
          return { allowed: false, reason: "dev_messages_method_denied" };
        }
        if (rest === "/progress" || rest.startsWith("/progress")) return { allowed: true };
        if (rest === "/status" || rest.startsWith("/status")) {
          return { allowed: false, reason: "dev_status_retired" };
        }
        return { allowed: false, reason: "dev_case_subpath_denied" };
      }
      return { allowed: true };
    }
  }
  return { allowed: false, reason: "not_in_allowlist" };
}

export function developerOnlyAllowlistMiddleware(req: ReqLike, res: { status: (n: number) => any; json: (b: unknown) => any }, next: (err?: unknown) => void): void {
  if (!isDeveloperPortalUser(req)) {
    next();
    return;
  }
  const path = (typeof req.originalUrl === "string" && req.originalUrl.length > 0 ? req.originalUrl : (req.path ?? req.url ?? "")) as string;
  const cleanPath = String(path || "").replace(/^\/?api(\/|$)/i, "/$1").replace(/^\/+/, "/").split("?")[0] || "/";
  const pathToCheck = cleanPath.startsWith("/") ? cleanPath : "/" + cleanPath;
  const check = isDeveloperAllowedPath(pathToCheck, String(req.method || "GET"), req);
  if (check.allowed) {
    next();
    return;
  }
  res.status(403)?.json?.({
    ok: false,
    error: {
      code: "DEVELOPER_PORTAL_OUTSIDE_ALLOWLIST",
      message: "This endpoint is not available for Developer Portal users.",
      meta: { reason: check.reason || null, path: pathToCheck },
    },
  });
}
