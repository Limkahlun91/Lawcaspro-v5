import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { RlsDb } from "@workspace/db";
import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db/schema";

export type ApiRequest = IncomingMessage & {
  headers: IncomingMessage["headers"] & {
    "x-forwarded-for"?: string;
    "x-real-ip"?: string;
    origin?: string;
  };
};

export type ApiResponse = ServerResponse;

export const FOUNDER_EMAIL = "lun.6923@hotmail.com";

export function getUrl(req: ApiRequest): URL {
  const raw = req.url ?? "/";
  return new URL(raw, "http://localhost");
}

export function stripApiPrefix(pathname: string): string {
  if (pathname === "/api") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice("/api".length);
  return pathname;
}

export function getIp(req: ApiRequest): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw) return raw.split(",")[0]?.trim() || undefined;
  const xrip = req.headers["x-real-ip"];
  const xr = Array.isArray(xrip) ? xrip[0] : xrip;
  return xr || undefined;
}

export function setCors(req: ApiRequest, res: ApiResponse): void {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
}

export function sendJson(res: ApiResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(json);
}

export function sendEmpty(res: ApiResponse, status: number): void {
  res.statusCode = status;
  res.end();
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomTokenHex(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function parseCookies(req: ApiRequest): Record<string, string> {
  const header = req.headers.cookie;
  const raw = Array.isArray(header) ? header.join(";") : header;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getBearerToken(req: ApiRequest): string | undefined {
  const auth = req.headers.authorization;
  const raw = Array.isArray(auth) ? auth[0] : auth;
  if (!raw) return undefined;
  if (!raw.startsWith("Bearer ")) return undefined;
  return raw.slice("Bearer ".length);
}

export function setAuthCookie(res: ApiResponse, token: string): void {
  const secure = process.env.NODE_ENV === "production";
  const parts = [
    `auth_token=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearAuthCookie(res: ApiResponse): void {
  const secure = process.env.NODE_ENV === "production";
  const parts = [
    "auth_token=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export async function readJsonBody<T = unknown>(
  req: ApiRequest,
  opts?: { maxBytes?: number },
): Promise<T> {
  const maxBytes = opts?.maxBytes ?? 1024 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export async function writeAuditLog(
  params: {
    firmId?: number | null;
    actorId?: number | null;
    actorType?: string;
    action: string;
    entityType?: string;
    entityId?: number;
    detail?: string | null;
    ipAddress?: string;
    userAgent?: string;
  },
  options?: { db?: RlsDb; strict?: boolean },
): Promise<void> {
  const targetDb = options?.db ?? db;
  try {
    await targetDb.insert(auditLogsTable).values({
      firmId: params.firmId ?? null,
      actorId: params.actorId ?? null,
      actorType: params.actorType ?? "firm_user",
      action: params.action,
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      detail: params.detail ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    });
  } catch (err) {
    if (options?.strict) throw err;
  }
}
