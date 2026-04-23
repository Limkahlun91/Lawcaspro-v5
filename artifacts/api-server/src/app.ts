import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { getApiMeta, requestMetaMiddleware, sendError } from "./lib/api-response.js";

const app: ReturnType<typeof express> = express();

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
    return originalJson({ ok: true, data: body ?? null, meta });
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
