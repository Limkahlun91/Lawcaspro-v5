import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { getApiMeta, requestMetaMiddleware, sendError } from "./lib/api-response.js";

const app: Express = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(requestMetaMiddleware());
const requestLogger: express.RequestHandler = pinoHttp({ logger });
app.use(requestLogger);
app.use((req, res, next) => {
  const path = req.path ?? "";
  const shouldWrap = path.startsWith("/api/auth") || path.startsWith("/api/platform");
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
    const meta = getApiMeta(res);

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

const healthHandler: express.RequestHandler = (_req, res): void => {
  res.status(200).json({ ok: true });
};

const notFoundHandler: express.RequestHandler = (req, res): void => {
  logger.warn({ path: req.path, method: req.method, status: 404 }, "Route not found");
  sendError(res, null, { status: 404, code: "NOT_FOUND", message: "Not found" });
};

const errorHandler: express.ErrorRequestHandler = (err, req, res, next): void => {
  if (res.headersSent) {
    next(err);
    return;
  }

  logger.error({ err, path: req.path, method: req.method, status: 500 }, "Unhandled error");
  sendError(res, err, { status: 500, code: "INTERNAL_SERVER_ERROR", message: "Internal server error" });
};

app.get("/api/health", healthHandler);
app.use("/api", router);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
