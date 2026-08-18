import express, { type Express as ExpressApplication } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { ApiError, classifyErrorForLog, getApiMeta, requestMetaMiddleware, resolveDbBusyResponse, sendError } from "./lib/api-response.js";
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
  timing?: { startAt: number; sections: Record<string, number> };
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

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(cookieParser());
app.use(requestMetaMiddleware() as unknown as MiddlewareLike);
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
  const rawSlowMs = process.env.API_SLOW_REQUEST_MS;
  const slowMs =
    typeof rawSlowMs === "string" && rawSlowMs.trim() && Number.isFinite(Number(rawSlowMs))
      ? Number(rawSlowMs)
      : 2_000;
  const startedAtMs = typeof (res.locals as any)?.startedAtMs === "number" ? Number((res.locals as any).startedAtMs) : Date.now();
  req.timing = { startAt: startedAtMs, sections: {} };

  res.on("finish", () => {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    if (durationMs < slowMs) return;
    const requestId = typeof (res.locals as any)?.requestId === "string" ? String((res.locals as any).requestId) : "unknown";
    logger.warn(
      {
        requestId,
        method: req.method ?? null,
        path: req.path ?? req.originalUrl ?? req.url ?? null,
        status: res.statusCode,
        durationMs,
        sections: req.timing?.sections ?? null,
      },
      "api.slow_request",
    );
  });

  next();
}) as unknown as MiddlewareLike);

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

  const requestId = typeof (res.locals as any)?.requestId === "string" ? String((res.locals as any).requestId) : "unknown";
  const classification = classifyErrorForLog(err);
  const dbBusy = resolveDbBusyResponse(err);
  const dbCategory = classification.retrySuggestion ?? null;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const safeMessage = String(rawMessage ?? "")
    .replace(/\binsert\s+into\s+"[^"]*"(\s*\([^)]*\))?\s*values[\s\S]*$/gi, "[REDACTED_SQL_VALUES]")
    .replace(/\bfailed\s+query:[\s\S]*$/gi, "[REDACTED_FAILED_QUERY]")
    .replace(/\bselect\s+[\s\S]*?\bfrom\b[\s\S]*$/gi, "[REDACTED_SELECT_SQL]")
    .replace(/\bupdate\s+"[^"]*"\s+set[\s\S]*$/gi, "[REDACTED_UPDATE_SQL]")
    .replace(/\bdelete\s+from\s+"[^"]*"[\s\S]*$/gi, "[REDACTED_DELETE_SQL]")
    .replace(/\$\d+/g, "?")
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[REDACTED_DB_URL]")
    .replace(/\bhost(?:name)?\s*[=:]\s*[^\s,;]+/gi, "host=[REDACTED]")
    .replace(/\b(?:user|username|password|passwd)\s*[=:]\s*[^\s,;]+/gi, "credentials=[REDACTED]")
    .replace(/\b(?:eyJhbGci|sk_|service_role)[A-Za-z0-9_\-\.]+/g, "[REDACTED_TOKEN]")
    .replace(/\b\d{6}-\d{2}-\d{4}\b/g, "[REDACTED_NRIC]")
    .slice(0, 300);

  const isApiError = err instanceof ApiError;
  const errStatus = dbBusy
    ? dbBusy.status
    : isApiError
      ? err.status
      : (err && typeof err === "object" && typeof (err as Record<string, unknown>).status === "number"
        ? ((err as Record<string, unknown>).status as number)
        : null);
  const errCode = dbBusy
    ? dbBusy.code
    : isApiError
      ? err.code
      : (err && typeof err === "object" && typeof (err as Record<string, unknown>).code === "string"
        ? ((err as Record<string, unknown>).code as string)
        : null);

  const safeErrMeta = {
    name: err instanceof Error ? err.name : typeof err,
    code: errCode || String((err as any)?.code ?? "").slice(0, 32),
    sqlstate: String((err as any)?.sqlstate ?? (err as any)?.sqlState ?? "").slice(0, 16),
    constraint: String((err as any)?.constraint ?? "").slice(0, 120),
    column: String((err as any)?.column ?? "").slice(0, 120),
    table: String((err as any)?.table ?? "").slice(0, 120),
  };
  const context: Record<string, unknown> = {
    requestId,
    method: req.method,
    path: req.path,
    message: safeMessage,
    ...(dbBusy
      ? { apiErr: { code: errCode, status: errStatus } }
      : classification.event === "api.denied" || classification.level !== "error"
        ? { apiErr: { code: errCode, status: errStatus } }
        : { safeErrMeta }),
  };

  if (dbBusy) {
    const dbLogToken =
      dbCategory === "DB_UNAVAILABLE"
        ? "[api.db_unavailable]"
        : dbCategory === "DB_RESOURCE_EXHAUSTED"
        ? "[api.db_resource_exhausted]"
        : "[api.db_busy]";
    const dbEvent =
      dbCategory === "DB_UNAVAILABLE"
        ? "api.db_unavailable"
        : dbCategory === "DB_RESOURCE_EXHAUSTED"
        ? "api.db_resource_exhausted"
        : classification.event;
    console.warn(dbLogToken, context);
    logger.warn(
      { ...context, status: errStatus, retryable: true, dbCategory: dbCategory ?? "DB_BUSY" },
      dbEvent,
    );
    sendErrorUnsafe(res, err);
    return;
  }

  if (classification.level === "error") {
    console.error("[api.unhandled]", context);
    logger.error({ ...context, safeErrMeta, status: errStatus ?? 500 }, "Unhandled error");
    sendErrorUnsafe(res, err, { status: 500, code: "INTERNAL_SERVER_ERROR", message: "Internal server error" });
    return;
  }

  if (classification.level === "warn") {
    console.warn("[api.client_error]", context);
    logger.warn({ ...context, status: errStatus ?? 400 }, classification.event);
  } else {
    console.info("[api.denied]", context);
    logger.info({ ...context, status: errStatus ?? 403 }, classification.event);
  }

  if (isApiError) {
    sendErrorUnsafe(res, err);
    return;
  }
  if (errStatus !== null && errCode) {
    sendErrorUnsafe(res, err, { status: errStatus, code: errCode, message: safeMessage || "Request failed" });
    return;
  }
  if (errStatus !== null) {
    sendErrorUnsafe(res, err, { status: errStatus, code: classification.event === "api.denied" ? "ACCESS_DENIED" : "BAD_REQUEST", message: safeMessage || "Request failed" });
    return;
  }
  sendErrorUnsafe(res, err, { status: 400, code: "BAD_REQUEST", message: safeMessage || "Request failed" });
};

app.get("/api/health", healthHandler);
app.use("/api", router);
app.use(notFoundHandler);
app.use(errorHandler);

const exportedApp = expressApp as unknown as ExpressApplication;
export { exportedApp as app };
export default exportedApp;
