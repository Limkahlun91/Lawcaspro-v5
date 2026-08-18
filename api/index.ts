(function registerDeprecationSuppressions() {
  try {
    const suppressCodes = new Set(["DEP0169"]);
    const suppressMessageContains = ["url.parse() behavior is not standardized"];
    process.on("warning", (warning) => {
      const w = warning as unknown as { code?: string; message?: unknown; name?: string };
      const code = w?.code;
      const msg = typeof w?.message === "string" ? w.message : "";
      if (
        code &&
        suppressCodes.has(code) &&
        suppressMessageContains.some((needle) => msg.includes(needle))
      ) {
        return;
      }
      if (w?.name && w?.message && w.name !== "DeprecationWarning") {
        console.warn(warning);
        return;
      }
      if (!code || !suppressCodes.has(code)) {
        console.warn(warning);
      }
    });
  } catch {
    // best-effort; ignore if process warning listener cannot be attached
  }
})();

type ExpressLikeHandler = (
  req: any,
  res: any,
  next?: (err?: unknown) => void,
) => unknown;

const isEnvDebug = process.env.DEBUG_VERCEL_BRIDGE === "1";
let cachedHandler: ExpressLikeHandler | null = null;

const one = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
};

const sendJsonError = (res: any, statusCode: number, payload: unknown) => {
  try {
    res.statusCode = statusCode;
    if (!res.headersSent) {
      res.setHeader("content-type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(payload));
  } catch {
    try {
      res.statusCode = statusCode;
      res.end("Internal Server Error");
    } catch {
    }
  }
};

type BridgeErrInfo = {
  status: number;
  code: string;
  message: string;
  isExpected: boolean;
};

const classifyBridgeError = (err: unknown): BridgeErrInfo => {
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const status = typeof rec.status === "number" && Number.isFinite(rec.status) && rec.status >= 100 && rec.status <= 599 ? rec.status : null;
    const code = typeof rec.code === "string" ? rec.code : null;
    const messageRaw = (rec as any)?.message;
    const message = typeof messageRaw === "string" ? messageRaw.slice(0, 300) : "";
    const dbErrCodes = new Set([
      "53300", "53400", "08000", "08003", "08006", "57P01", "57P02", "57P03",
      "etimedout", "econnrefused", "ehostunreach", "econnreset",
      "too_many_connections", "db_busy", "connection_timeout", "pool_timeout",
    ]);
    const dbCodeCheck = (c: string | null) =>
      c ? dbErrCodes.has(c.toLowerCase()) : false;
    const sqlstate = (rec as { sqlstate?: unknown; sqlState?: unknown }).sqlstate ?? (rec as { sqlstate?: unknown; sqlState?: unknown }).sqlState;
    if (dbCodeCheck(code) || dbCodeCheck(typeof sqlstate === "string" ? sqlstate : null)) {
      return { status: 503, code: "DB_BUSY", message: "資料庫繁忙，請稍後重試", isExpected: true };
    }
    const lowered = message.toLowerCase();
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
      return { status: 503, code: "DB_BUSY", message: "資料庫繁忙，請稍後重試", isExpected: true };
    }
    const isKnownCode =
      code === "FEATURE_DISABLED" ||
      code === "NOT_AUTHENTICATED" ||
      code === "NOT_AUTHORIZED" ||
      code === "PERMISSION_DENIED" ||
      code === "SESSION_EXPIRED";
    if (status !== null && (status >= 400 && status < 500)) {
      return { status, code: code || "BAD_REQUEST", message, isExpected: true };
    }
    if (isKnownCode) {
      return { status: 403, code, message, isExpected: true };
    }
    if (status !== null) {
      return { status, code: code || "REQUEST_FAILED", message, isExpected: status < 500 };
    }
    if (code) {
      return { status: 500, code, message, isExpected: false };
    }
    return { status: 500, code: "INTERNAL_SERVER_ERROR", message, isExpected: false };
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return { status: 500, code: "INTERNAL_SERVER_ERROR", message: msg.slice(0, 300), isExpected: false };
};

const shouldDebug = (req: any): boolean => {
  if (isEnvDebug) return true;

  const headers = req?.headers ?? {};
  const headerValue =
    headers["x-lawcaspro-debug"] ??
    headers["x-debug-bridge"] ??
    headers["x-debug"];
  if (headerValue === "1" || headerValue === 1) return true;
  if (Array.isArray(headerValue) && headerValue[0] === "1") return true;

  const url = typeof req?.url === "string" ? req.url : "";
  return /[?&]__debug=1(?:&|$)/.test(url);
};

const normalizeApiUrl = (rawUrl: unknown): string => {
  const url = typeof rawUrl === "string" ? rawUrl : "/";

  if (url === "/api" || url.startsWith("/api/")) return url;
  if (url === "/api/api") return "/api";
  if (url.startsWith("/api/api/")) return url.replace("/api/api/", "/api/");

  if (url.startsWith("/")) return `/api${url}`;
  return `/api/${url}`;
};

const getQueryString = (url: unknown): string => {
  const u = typeof url === "string" ? url : "";
  const idx = u.indexOf("?");
  return idx >= 0 ? u.slice(idx) : "";
};

const getHandler = async (): Promise<ExpressLikeHandler> => {
  if (cachedHandler) return cachedHandler;
  const modPath = "../artifacts/api-server/dist/" + "app.js";
  const mod = (await import(modPath)) as unknown as {
    default?: unknown;
  };
  const h = (mod as any)?.default ?? (mod as any);
  cachedHandler = h as ExpressLikeHandler;
  return cachedHandler;
};

export default async function vercelHandler(req: any, res: any): Promise<void> {
  const originalUrl = req?.url;
  const queryString = getQueryString(originalUrl);
  const pathFromRewrite = one(req?.query?.__path);
  const rewrittenUrl = pathFromRewrite ? `/api/${pathFromRewrite}` : "/api";
  const normalizedUrl = normalizeApiUrl(rewrittenUrl);
  const isDebug = shouldDebug(req);

  if (isDebug) {
    console.log("[vercel-bridge]", {
      method: req?.method,
      originalUrl: typeof originalUrl === "string" ? originalUrl : null,
      normalizedUrl,
    });
  }

  req.url = normalizedUrl + queryString;

  try {
    const handler = await getHandler();
    handler(req, res, (err?: unknown) => {
      if (!err) return;
      if (res && !res.headersSent) {
        const info = classifyBridgeError(err);
        if (info.isExpected) {
          console.info("[vercel-bridge] expected client error", { code: info.code, status: info.status });
        } else {
          console.error("[vercel-bridge] next(err)", err);
        }
        sendJsonError(res, info.status, {
          ok: false,
          error: {
            code: info.code,
            message: info.message || (info.status < 500 ? "Request failed" : "Internal server error"),
            retryable: info.status >= 500,
          },
          source: info.isExpected ? "vercel-bridge-expected" : "vercel-bridge-next",
        });
      }
    });
  } catch (err) {
    if (res && !res.headersSent) {
      const info = classifyBridgeError(err);
      if (info.isExpected) {
        console.info("[vercel-bridge] expected handler error", { code: info.code, status: info.status });
      } else if (isDebug) {
        console.error("[vercel-bridge] handler throw", err);
      } else {
        console.error("[vercel-bridge] handler throw", { code: info.code, status: info.status, message: info.message });
      }
      sendJsonError(res, info.status, {
        ok: false,
        error: {
          code: info.code,
          message: info.message || (info.status < 500 ? "Request failed" : "Internal server error"),
          retryable: info.status >= 500,
        },
        source: info.isExpected ? "vercel-bridge-expected" : "vercel-bridge",
      });
    }
  }
}
