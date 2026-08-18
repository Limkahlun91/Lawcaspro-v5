import type { RequestHandler } from "express";
import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "./logger.js";
import { extractDbErrorInfo } from "./db-error.js";

type NextLike = (error?: unknown) => void;

type ReqLike = IncomingMessage & {
  headers: IncomingMessage["headers"];
  path?: string;
  method?: string;
  userId?: unknown;
  firmId?: unknown;
  requestId?: string;
};

export type ResLike = ServerResponse & {
  locals: Record<string, unknown>;
  status: (code: number) => ResLike;
  json: (body: unknown) => ResLike;
};

export type ApiMeta = {
  request_id: string;
  timestamp: string;
  duration_ms: number;
};

export type ApiWarning = {
  code: string;
  message: string;
};

export type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
  retryable: boolean;
  stage?: string;
  suggestion?: string;
};

export type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta: ApiMeta;
  warnings?: ApiWarning[];
};

export type ApiFailure = {
  ok: false;
  error: ApiErrorBody;
  meta: ApiMeta;
};

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly retryable: boolean;
  public readonly stage?: string;
  public readonly suggestion?: string;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
    stage?: string;
    suggestion?: string;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
    this.stage = opts.stage;
    this.suggestion = opts.suggestion;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export function requestMetaMiddleware(): RequestHandler {
  const middleware = (req: ReqLike, res: ResLike, next: NextLike): void => {
    const header = req.headers["x-request-id"];
    const existing = Array.isArray(header) ? header[0] : header;
    const requestId = (existing && String(existing).trim()) ? String(existing).trim() : crypto.randomUUID();
    res.setHeader("x-request-id", requestId);
    req.requestId = requestId;
    res.locals.requestId = requestId;
    res.locals.startedAtMs = Date.now();
    next();
  };
  return middleware as unknown as RequestHandler;
}

export function getApiMeta(res: ResLike): ApiMeta {
  const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
  const startedAtMs = typeof res.locals.startedAtMs === "number" ? res.locals.startedAtMs : Date.now();
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  return {
    request_id: requestId,
    timestamp: new Date().toISOString(),
    duration_ms: durationMs,
  };
}

type DbBusyResponse = { status: 503; code: "DB_BUSY"; message: string };

function isDbBusyErrorCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  const lowered = code.toLowerCase();
  return (
    lowered === "etimedout" ||
    lowered === "econnrefused" ||
    lowered === "ehostunreach" ||
    lowered === "econnreset" ||
    lowered === "53300" ||
    lowered === "53400" ||
    lowered === "08000" ||
    lowered === "08003" ||
    lowered === "08006" ||
    lowered === "57p01" ||
    lowered === "57p02" ||
    lowered === "57p03" ||
    lowered === "too_many_connections" ||
    lowered === "db_busy" ||
    lowered === "connection_timeout" ||
    lowered === "pool_timeout"
  );
}

function detectDbBusyResponse(err: unknown): DbBusyResponse | null {
  if (!err || typeof err !== "object") return null;
  const rec = err as Record<string, unknown>;
  const errCode = rec.code;
  const errStatus = rec.status;
  const dbErrCode =
    ((rec as { sqlState?: unknown; sqlstate?: unknown }).sqlState ?? (rec as { sqlState?: unknown; sqlstate?: unknown }).sqlstate) as unknown;
  if (isDbBusyErrorCode(errCode) || isDbBusyErrorCode(dbErrCode)) {
    return { status: 503, code: "DB_BUSY", message: "資料庫繁忙，請稍後重試" };
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const lowered = typeof msg === "string" ? msg.toLowerCase() : "";
  if (
    lowered.includes("timeout exceeded when trying to connect") ||
    (lowered.includes("pool") && lowered.includes("timeout")) ||
    lowered.includes("connection terminated due to connection timeout") ||
    lowered.includes("connection terminated unexpectedly") ||
    lowered.includes("server closed the connection unexpectedly") ||
    lowered.includes("too many connections") ||
    lowered.includes("database is busy") ||
    lowered.includes("db busy") ||
    lowered.includes("資料庫繁忙")
  ) {
    return { status: 503, code: "DB_BUSY", message: "資料庫繁忙，請稍後重試" };
  }
  if (
    typeof errStatus === "number" &&
    errStatus === 503 &&
    typeof errCode === "string" &&
    (errCode === "DB_BUSY" || errCode === "SERVICE_UNAVAILABLE")
  ) {
    return { status: 503, code: "DB_BUSY", message: "資料庫繁忙，請稍後重試" };
  }
  return null;
}

export function resolveDbBusyResponse(err: unknown): { status: number; code: string; message: string } | null {
  return detectDbBusyResponse(err);
}

export function sendOk<T>(res: ResLike, data: T, opts?: { status?: number; warnings?: ApiWarning[] }): void {
  const body: ApiSuccess<T> = { ok: true, data, meta: getApiMeta(res) };
  if (opts?.warnings?.length) body.warnings = opts.warnings;
  res.status(opts?.status ?? 200).json(body);
}

export function sendError(res: ResLike, err: unknown, fallback?: { status?: number; code?: string; message?: string }): void {
  const meta = getApiMeta(res);

  const dbBusy = detectDbBusyResponse(err);
  if (dbBusy) {
    const body: ApiFailure = {
      ok: false,
      error: {
        code: dbBusy.code,
        message: dbBusy.message,
        retryable: true,
        suggestion: "請等待數秒後重新整理頁面或重試操作",
      },
      meta,
    };
    res.status(dbBusy.status).json(body);
    return;
  }

  const isApiErrorLike = (value: unknown): value is {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
    stage?: string;
    suggestion?: string;
  } => {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    const status = v.status;
    const code = v.code;
    const message = (v as { message?: unknown }).message;
    return (
      typeof status === "number" &&
      Number.isFinite(status) &&
      status >= 100 &&
      status <= 599 &&
      typeof code === "string" &&
      code.length > 0 &&
      typeof message === "string" &&
      message.length > 0
    );
  };

  if (err instanceof ApiError || isApiErrorLike(err)) {
    const e = err as ApiError & { details?: unknown; stage?: string; suggestion?: string };
    const body: ApiFailure = {
      ok: false,
      error: {
        code: e.code,
        message: e.message,
        retryable: Boolean(e.retryable),
        ...(e.details !== undefined ? { details: e.details } : {}),
        ...(e.stage ? { stage: e.stage } : {}),
        ...(e.suggestion ? { suggestion: e.suggestion } : {}),
      },
      meta,
    };
    res.status(e.status).json(body);
    return;
  }

  const status = fallback?.status ?? 500;
  const code = fallback?.code ?? "INTERNAL_SERVER_ERROR";
  const message = fallback?.message ?? "Internal server error";
  const allowDetails =
    process.env.API_ERROR_DETAILS === "1" ||
    process.env.NODE_ENV !== "production" ||
    Boolean((res.locals as { allowErrorDetails?: boolean }).allowErrorDetails);
  const allowStack =
    allowDetails &&
    (process.env.API_ERROR_STACK === "1" || Boolean((res.locals as { allowErrorDetails?: boolean }).allowErrorDetails));
  const details =
    allowDetails && err instanceof Error
      ? {
          message: err.message,
          ...(allowStack && err.stack ? { stack: err.stack } : {}),
        }
      : undefined;

  const body: ApiFailure = {
    ok: false,
    error: {
      code,
      message,
      retryable: status >= 500,
      ...(details ? { details } : {}),
    },
    meta,
  };

  res.status(status).json(body);
}

type LogClassification = {
  level: "info" | "warn" | "error";
  event: "api.denied" | "api.client_error" | "api.db_busy" | "api.unhandled";
};

export function classifyErrorForLog(err: unknown): LogClassification & { retrySuggestion?: "DB_BUSY" | null } {
  const getStatus = (e: unknown): number | null => {
    if (!e || typeof e !== "object") return null;
    const rec = e as Record<string, unknown>;
    const status = rec.status;
    return typeof status === "number" && Number.isFinite(status) ? status : null;
  };
  const getCode = (e: unknown): string | null => {
    if (!e || typeof e !== "object") return null;
    const rec = e as Record<string, unknown>;
    const code = rec.code;
    return typeof code === "string" ? code : null;
  };
  const dbBusy = detectDbBusyResponse(err);
  if (dbBusy) {
    return { level: "warn", event: "api.db_busy", retrySuggestion: "DB_BUSY" };
  }
  const status = err instanceof ApiError ? err.status : getStatus(err);
  if (status !== null && status >= 400 && status < 500) {
    const code = err instanceof ApiError ? err.code : getCode(err);
    if (
      status === 401 ||
      status === 403 ||
      code === "FEATURE_DISABLED" ||
      code === "NOT_AUTHENTICATED" ||
      code === "NOT_AUTHORIZED" ||
      code === "PERMISSION_DENIED" ||
      code === "SESSION_EXPIRED"
    ) {
      return { level: "info", event: "api.denied" };
    }
    return { level: "warn", event: "api.client_error" };
  }
  return { level: "error", event: "api.unhandled" };
}

export function wrap(handler: (req: ReqLike, res: ResLike) => Promise<void> | void): RequestHandler {
  const wrapped = async (req: ReqLike, res: ResLike): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      const classification = classifyErrorForLog(err);
      const safeDbErr = extractDbErrorInfo(err);
      const hasDbInfo = Boolean(
        safeDbErr.sqlstate || safeDbErr.table || safeDbErr.column || safeDbErr.constraint || safeDbErr.schema,
      );
      const context: Record<string, unknown> = {
        requestId: res.locals.requestId,
        path: req.path,
        method: req.method,
        userId: req.userId,
        firmId: req.firmId,
      };
      if (hasDbInfo) {
        context.dbErr = {
          code: safeDbErr.sqlstate ?? safeDbErr.code,
          name: safeDbErr.name,
          sqlstate: safeDbErr.sqlstate,
          table: safeDbErr.table,
          column: safeDbErr.column,
          constraint: safeDbErr.constraint,
          schema: safeDbErr.schema,
          detailClass:
            safeDbErr.detail ? (typeof safeDbErr.detail === "string" ? "string" : typeof safeDbErr.detail) : undefined,
        };
      }
      if (classification.level === "error") {
        context.err = err;
      } else {
        if (err instanceof ApiError) {
          context.apiErr = { code: err.code, status: err.status, message: err.message, stage: err.stage };
        } else if (err instanceof Error) {
          context.apiErr = { name: err.name, message: err.message };
        } else {
          context.apiErr = { raw: typeof err };
        }
      }
      (logger[classification.level] as typeof logger.error)(context, classification.event);
      sendError(res, err);
    }
  };
  return wrapped as unknown as RequestHandler;
}

export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseIntParam(
  name: string,
  raw: string | string[] | undefined,
  opts?: { required?: boolean; min?: number },
): number | null {
  const v = one(raw);
  if (!v || !String(v).trim()) {
    if (opts?.required) {
      throw new ApiError({
        status: 400,
        code: "MISSING_REQUIRED_FIELD",
        message: `${name} is required`,
        retryable: false,
      });
    }
    return null;
  }
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) {
    throw new ApiError({
      status: 400,
      code: "INVALID_INPUT",
      message: `Invalid ${name}`,
      retryable: false,
      details: { name },
    });
  }
  if (opts?.min !== undefined && n < opts.min) {
    throw new ApiError({
      status: 400,
      code: "INVALID_INPUT",
      message: `Invalid ${name}`,
      retryable: false,
      details: { name },
    });
  }
  return n;
}
