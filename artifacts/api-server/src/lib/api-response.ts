import type { Request, Response, NextFunction, RequestHandler } from "express";
import crypto from "crypto";
import { logger } from "./logger";

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
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers["x-request-id"];
    const existing = Array.isArray(header) ? header[0] : header;
    const requestId = (existing && String(existing).trim()) ? String(existing).trim() : crypto.randomUUID();
    res.setHeader("x-request-id", requestId);
    (req as Request & { requestId?: string }).requestId = requestId;
    res.locals.requestId = requestId;
    res.locals.startedAtMs = Date.now();
    next();
  };
}

export function getApiMeta(res: Response): ApiMeta {
  const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
  const startedAtMs = typeof res.locals.startedAtMs === "number" ? res.locals.startedAtMs : Date.now();
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  return {
    request_id: requestId,
    timestamp: new Date().toISOString(),
    duration_ms: durationMs,
  };
}

export function sendOk<T>(res: Response, data: T, opts?: { status?: number; warnings?: ApiWarning[] }): void {
  const body: ApiSuccess<T> = { ok: true, data, meta: getApiMeta(res) };
  if (opts?.warnings?.length) body.warnings = opts.warnings;
  res.status(opts?.status ?? 200).json(body);
}

export function sendError(res: Response, err: unknown, fallback?: { status?: number; code?: string; message?: string }): void {
  const meta = getApiMeta(res);
  if (err instanceof ApiError) {
    const body: ApiFailure = {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        ...(err.details !== undefined ? { details: err.details } : {}),
        ...(err.stage ? { stage: err.stage } : {}),
        ...(err.suggestion ? { suggestion: err.suggestion } : {}),
      },
      meta,
    };
    res.status(err.status).json(body);
    return;
  }

  const status = fallback?.status ?? 500;
  const code = fallback?.code ?? "INTERNAL_SERVER_ERROR";
  const message = fallback?.message ?? "Internal server error";

  const body: ApiFailure = {
    ok: false,
    error: { code, message, retryable: status >= 500 },
    meta,
  };

  res.status(status).json(body);
}

export function wrap(handler: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error(
        {
          err,
          requestId: res.locals.requestId,
          path: req.path,
          method: req.method,
          userId: (req as any)?.userId,
          firmId: (req as any)?.firmId,
        },
        "api.unhandled",
      );
      sendError(res, err);
    }
  };
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
      throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: `${name} is required`, retryable: false });
    }
    return null;
  }
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) {
    throw new ApiError({ status: 400, code: "INVALID_INPUT", message: `Invalid ${name}`, retryable: false, details: { name } });
  }
  if (opts?.min !== undefined && n < opts.min) {
    throw new ApiError({ status: 400, code: "INVALID_INPUT", message: `Invalid ${name}`, retryable: false, details: { name } });
  }
  return n;
}

