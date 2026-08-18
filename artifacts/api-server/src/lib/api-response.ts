import type { RequestHandler } from "express";
import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "./logger.js";
import {
  extractDbErrorInfo,
  classifyDatabaseError,
  databaseErrorHttpStatus,
  databaseErrorCode,
  databaseErrorSafeMessage,
  databaseErrorRetryable,
  databaseErrorLogToken,
} from "./db-error.js";

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
  requestId?: string;
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

type CategorizedDatabaseResponse = {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  logToken: string;
  suggestion?: string;
};

function detectCategorizedDatabaseResponse(err: unknown): CategorizedDatabaseResponse | null {
  const category = classifyDatabaseError(err);
  if (category === "UNKNOWN") return null;
  const status = databaseErrorHttpStatus(category);
  const code = databaseErrorCode(category);
  const message = databaseErrorSafeMessage(category);
  const retryable = databaseErrorRetryable(category);
  const logToken = databaseErrorLogToken(category);
  const suggestion = category === "DB_BUSY"
    ? "Please wait a few seconds and try again."
    : category === "DB_RESOURCE_EXHAUSTED"
    ? "Please try again in a minute or contact support if this persists."
    : category === "DB_UNAVAILABLE"
    ? "Please try again in a minute or contact support if this persists."
    : undefined;
  return { status, code, message, retryable, logToken, suggestion };
}

export function resolveDbBusyResponse(err: unknown): { status: number; code: string; message: string } | null {
  const r = detectCategorizedDatabaseResponse(err);
  if (!r) return null;
  return { status: r.status, code: r.code, message: r.message };
}

const SENITIVE_VALUE_MARKERS = [
  "eyJhbGci",
  "sk_",
  "service_role",
  "postgres://",
  "postgresql://",
  "password",
  "NRIC",
  "nric",
  "TIN",
  "tin",
  "bank account",
  "account_number",
  "accNo",
  "iban",
];

function containsSensitivePayload(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    const s = value;
    for (const m of SENITIVE_VALUE_MARKERS) if (s.includes(m)) return true;
    if (/^\d{6}-\d{2}-\d{4}$/.test(s)) return true;
    if (/\d{12,}/.test(s) && /(tin|bank|account)/i.test(s)) return true;
  }
  if (typeof value === "object") {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      const lower = String(k).toLowerCase();
      if (
        lower.includes("password") ||
        lower.includes("secret") ||
        lower.includes("token") ||
        lower.includes("nric") ||
        lower.includes("tin") ||
        lower.includes("bank") ||
        lower.includes("account") ||
        lower.includes("iban")
      )
        return true;
    }
  }
  return false;
}

export function sendOk<T>(res: ResLike, data: T, opts?: { status?: number; warnings?: ApiWarning[] }): void {
  const body: ApiSuccess<T> = { ok: true, data, meta: getApiMeta(res) };
  if (opts?.warnings?.length) body.warnings = opts.warnings;
  res.status(opts?.status ?? 200).json(body);
}

export function sendError(res: ResLike, err: unknown, fallback?: { status?: number; code?: string; message?: string }): void {
  const meta = getApiMeta(res);
  const requestId = meta.request_id;

  const categorized = detectCategorizedDatabaseResponse(err);
  if (categorized) {
    const body: ApiFailure = {
      ok: false,
      error: {
        code: categorized.code,
        message: categorized.message,
        retryable: categorized.retryable,
        requestId,
        ...(categorized.suggestion ? { suggestion: categorized.suggestion } : {}),
      },
      meta,
    };
    res.status(categorized.status).json(body);
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
        requestId,
        ...(e.details !== undefined ? { details: containsSensitivePayload(e.details) ? null : e.details } : {}),
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
  const rawFallbackMsg = fallback?.message ?? "Internal server error";
  const message = containsSensitivePayload(rawFallbackMsg)
    ? "An unexpected error occurred while processing your request."
    : rawFallbackMsg;
  const allowDetails =
    process.env.API_ERROR_DETAILS === "1" ||
    process.env.NODE_ENV !== "production" ||
    Boolean((res.locals as { allowErrorDetails?: boolean }).allowErrorDetails);
  const allowStack =
    allowDetails &&
    (process.env.API_ERROR_STACK === "1" || Boolean((res.locals as { allowErrorDetails?: boolean }).allowErrorDetails));

  let details: unknown;
  if (allowDetails && err instanceof Error) {
    if (containsSensitivePayload(err.message) || containsSensitivePayload(err.stack)) {
      details = undefined;
    } else {
      details = {
        message: err.message,
        ...(allowStack && err.stack ? { stack: err.stack } : {}),
      };
    }
  } else {
    details = undefined;
  }

  const body: ApiFailure = {
    ok: false,
    error: {
      code,
      message,
      retryable: status >= 500,
      requestId,
      ...(details ? { details } : {}),
    },
    meta,
  };

  res.status(status).json(body);
}

type LogClassification = {
  level: "info" | "warn" | "error";
  event:
    | "api.denied"
    | "api.client_error"
    | "api.db_busy"
    | "api.db_resource_exhausted"
    | "api.db_unavailable"
    | "api.unhandled";
};

export function classifyErrorForLog(err: unknown): LogClassification & { retrySuggestion?: "DB_BUSY" | "DB_RESOURCE_EXHAUSTED" | "DB_UNAVAILABLE" | null } {
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
  const categorized = detectCategorizedDatabaseResponse(err);
  if (categorized) {
    const ev = (categorized.logToken === "api.db_busy"
      ? "api.db_busy"
      : categorized.logToken === "api.db_resource_exhausted"
      ? "api.db_resource_exhausted"
      : categorized.logToken === "api.db_unavailable"
      ? "api.db_unavailable"
      : "api.unhandled") as LogClassification["event"];
    const level: LogClassification["level"] =
      categorized.logToken === "api.db_unavailable" ||
      categorized.logToken === "api.db_resource_exhausted" ||
      categorized.logToken === "api.db_busy"
        ? "warn"
        : "error";
    const retrySuggestion: "DB_BUSY" | "DB_RESOURCE_EXHAUSTED" | "DB_UNAVAILABLE" | null =
      categorized.code === "DB_BUSY"
        ? "DB_BUSY"
        : categorized.code === "DB_RESOURCE_EXHAUSTED"
        ? "DB_RESOURCE_EXHAUSTED"
        : categorized.code === "DB_UNAVAILABLE"
        ? "DB_UNAVAILABLE"
        : null;
    return { level, event: ev, retrySuggestion };
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

const SENSITIVE_FIELDS = new Set([
  "query",
  "sql",
  "sqlText",
  "statement",
  "params",
  "bindings",
  "values",
  "host",
  "hostname",
  "user",
  "username",
  "password",
  "database",
  "connectionString",
  "secret",
  "token",
  "serviceRoleKey",
  "service_role_key",
  "nric",
  "NRIC",
  "myKad",
  "mykad",
  "tin",
  "TIN",
  "bankAccount",
  "bank_account",
  "accountNo",
  "account_number",
  "iban",
]);

function redactSensitiveFields(obj: unknown, depth: number = 0): unknown {
  if (depth > 4) return "[redacted-depth]";
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map((o) => redactSensitiveFields(o, depth + 1));
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (SENSITIVE_FIELDS.has(k) || SENSITIVE_FIELDS.has(key)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactSensitiveFields(v, depth + 1);
    }
    return out;
  }
  return obj;
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
        };
      }
      if (classification.level === "error") {
        context.err = redactSensitiveFields(err);
      } else {
        if (err instanceof ApiError) {
          context.apiErr = { code: err.code, status: err.status, message: err.message, stage: err.stage };
        } else if (err instanceof Error) {
          context.apiErr = { name: err.name, message: containsSensitivePayload(err.message) ? "[redacted]" : err.message };
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
