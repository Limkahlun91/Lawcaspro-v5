import express, { type Express as ExpressApplication } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { getApiMeta, requestMetaMiddleware, sendError } from "./lib/api-response.js";
import type { IncomingMessage, ServerResponse } from "node:http";

type Next = (error?: unknown) => void;

type ReqLike = IncomingMessage & {
  url?: string;
  originalUrl?: string;
  path?: string;
  method?: string;
  ip?: string;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  headers: IncomingMessage["headers"];
  log?: {
    error?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
  };
};

type ResLike = ServerResponse & {
  locals: Record<string, unknown>;
  status: (code: number) => ResLike;
  json: (body: unknown) => ResLike;
  send: (body?: unknown) => ResLike;
};

type MiddlewareLike = (req: ReqLike, res: ResLike, next: Next) => void | Promise<void>;
type ErrorMiddlewareLike = (err: unknown, req: ReqLike, res: ResLike, next: Next) => void | Promise<void>;

type ExpressAppLike = {
  set: (...args: unknown[]) => unknown;
  use: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
};

const expressApp = express();
const app = expressApp as unknown as ExpressAppLike;

const getApiMetaUnsafe = getApiMeta as unknown as (res: ResLike) => ReturnType<typeof getApiMeta>;
const sendErrorUnsafe = sendError as unknown as (res: ResLike, err: unknown, fallback?: { status?: number; code?: string; message?: string }) => void;

export const mergeVaryHeader = (existing: unknown): string => {
  const existingStr = Array.isArray(existing)
    ? existing.map(String).join(",")
    : existing != null
      ? String(existing)
      : "";
  const rawParts = existingStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const result: string[] = [];
  const set = new Set<string>();
  for (const part of rawParts) {
    const key = part.toLowerCase();
    if (set.has(key)) continue;
    set.add(key);
    result.push(part);
  }

  if (!set.has("cookie")) result.push("Cookie");
  if (!set.has("authorization")) result.push("Authorization");
  return result.join(", ");
};

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(cookieParser());
app.use(requestMetaMiddleware() as unknown as MiddlewareLike);
app.use(((req: ReqLike, res: ResLike, next: Next) => {
  const path = String(req.url ?? "");
  const authHeader = req.headers?.["authorization"];
  const cookieHeader = req.headers?.["cookie"];
  const hasAuth = typeof authHeader === "string" && authHeader.trim().length > 0;
  const hasCookieAuth = typeof cookieHeader === "string" && cookieHeader.includes("auth_token=");
  const isApi = path.startsWith("/api/");
  const isHealth = path === "/api/health" || path.startsWith("/api/health?");
  if (isApi && !isHealth && (hasAuth || hasCookieAuth)) {
    res.setHeader("Cache-Control", "private, no-store");
    const existing = (res as any).getHeader?.("Vary");
    res.setHeader("Vary", mergeVaryHeader(existing));
  }
  next();
}) as unknown as MiddlewareLike);
app.use(((req: ReqLike, res: ResLike, next: Next) => {
  const token = process.env.API_DEBUG_TOKEN;
  if (!token) {
    next();
    return;
  }
  const rawHeader = req.headers?.["x-debug-token"];
  const provided = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof provided === "string" && provided && provided === token) {
    (res.locals as any).allowErrorDetails = true;
  }
  next();
}) as unknown as MiddlewareLike);

const createPinoHttpMiddleware = pinoHttp as unknown as (options: unknown) => MiddlewareLike;
app.use(createPinoHttpMiddleware({ logger }));

app.use(((req: ReqLike, res: ResLike, next: Next) => {
  const contentType = req.headers?.["content-type"];
  const isJson = typeof contentType === "string" && contentType.toLowerCase().includes("application/json");
  if (!isJson) {
    next();
    return;
  }

  const existing = (req as any)?.body;
  if (existing != null) {
    if (typeof existing === "string") {
      try {
        (req as any).body = JSON.parse(existing);
      } catch {
      }
    } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(existing)) {
      try {
        (req as any).body = JSON.parse(existing.toString("utf8"));
      } catch {
      }
    }
    next();
    return;
  }

  let raw = "";
  let size = 0;
  const limit = 10 * 1024 * 1024;
  if (typeof (req as any).setEncoding === "function") (req as any).setEncoding("utf8");

  (req as any).on("data", (chunk: string) => {
    size += chunk.length;
    if (size > limit) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }
    raw += chunk;
  });

  (req as any).on("end", () => {
    if (res.headersSent) return;
    if (raw) {
      try {
        (req as any).body = JSON.parse(raw);
      } catch {
      }
    }
    next();
  });

  (req as any).on("error", (err: unknown) => {
    if (res.headersSent) return;
    next(err);
  });
}) as unknown as MiddlewareLike);

app.use(express.urlencoded({ extended: true }));

app.use((req: ReqLike, res: ResLike, next: Next) => {
  const path = req.path ?? "";
  const shouldWrap =
    path.startsWith("/api/auth") ||
    path.startsWith("/api/founder") ||
    path.startsWith("/api/platform") ||
    path.startsWith("/api/support-sessions") ||
    path.startsWith("/api/subscription-plans") ||
    path.startsWith("/api/audit-logs");
  if (!shouldWrap) {
    next();
    return;
  }

  const toNumber = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  const normalizeOkBody = (body: unknown): unknown => {
    if (Array.isArray(body)) return { items: body };
    if (!body || typeof body !== "object") return body ?? null;

    const o = body as Record<string, unknown>;
    if ("items" in o || "item" in o || "result" in o || "page_info" in o) return o;

    const data = (o as any).data;
    const total = (o as any).total;
    const page = (o as any).page;
    const limit = (o as any).limit;
    if (Array.isArray(data) && (total != null || page != null || limit != null)) {
      const pageInfo = {
        total: toNumber(total),
        page: toNumber(page),
        limit: toNumber(limit),
      };
      const rest: Record<string, unknown> = { ...o };
      delete (rest as any).data;
      delete (rest as any).total;
      delete (rest as any).page;
      delete (rest as any).limit;
      return { items: data, page_info: pageInfo, ...rest };
    }

    if ((o as any).success === true && Object.keys(o).length === 1) return { result: { success: true } };

    return o;
  };

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (body && typeof body === "object" && "ok" in (body as any) && typeof (body as any).ok === "boolean") {
      return originalJson(body);
    }

    const status = res.statusCode;
    const meta = getApiMetaUnsafe(res);

    if (status >= 400) {
      const message =
        typeof (body as any)?.error === "string"
          ? String((body as any).error)
          : typeof (body as any)?.message === "string"
            ? String((body as any).message)
            : typeof body === "string"
              ? body
              : res.statusMessage || "Request failed";
      const code =
        typeof (body as any)?.code === "string"
          ? String((body as any).code)
          : status === 400
            ? "BAD_REQUEST"
            : status === 401
              ? "UNAUTHORIZED"
              : status === 403
                ? "FORBIDDEN"
                : status === 404
                  ? "NOT_FOUND"
                  : status === 409
                    ? "CONFLICT"
                    : status === 422
                      ? "VALIDATION_ERROR"
                      : status === 429
                        ? "RATE_LIMITED"
                        : status === 503
                          ? "SERVICE_UNAVAILABLE"
                          : "REQUEST_FAILED";
      return originalJson({
        ok: false,
        error: { code, message, retryable: status >= 500 },
        meta,
      });
    }

    if (status === 204) res.status(200);
    return originalJson({ ok: true, data: normalizeOkBody(body), meta });
  }) as typeof res.json;

  next();
});

const healthHandler: MiddlewareLike = (_req: ReqLike, res: ResLike): void => {
  res.status(200).json({ ok: true });
};

const notFoundHandler: MiddlewareLike = (req: ReqLike, res: ResLike): void => {
  logger.warn({ path: req.path, method: req.method, status: 404 }, "Route not found");
  sendErrorUnsafe(res, null, { status: 404, code: "NOT_FOUND", message: "Not found" });
};

const errorHandler: ErrorMiddlewareLike = (err: unknown, req: ReqLike, res: ResLike, next: Next): void => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const stack = err instanceof Error ? err.stack : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const requestId = typeof (res.locals as any)?.requestId === "string" ? String((res.locals as any).requestId) : "unknown";
  console.error("[api.unhandled]", { requestId, method: req.method, path: req.path, message, stack });
  logger.error({ err, path: req.path, method: req.method, status: 500, requestId }, "Unhandled error");
  sendErrorUnsafe(res, err, { status: 500, code: "INTERNAL_SERVER_ERROR", message: "Internal server error" });
};

app.get("/api/health", healthHandler);
app.use("/api", router);
app.use(notFoundHandler);
app.use(errorHandler);

const exportedApp = expressApp as unknown as ExpressApplication;
export { exportedApp as app };
export default exportedApp;
