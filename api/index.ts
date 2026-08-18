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

const DB_BUSY_SQLSTATES = new Set(["53300"]);
const DB_BUSY_SYSCODES = new Set([
  "err_pool_timed_out", "pool_timeout", "too_many_connections", "db_busy",
]);
const DB_BUSY_MSG_TOKENS = [
  "too many connections", "too_many_connections", "pool timed out", "pool_timeout",
  "remaining connection slots are reserved", "connection acquisition", "saturation",
  "database is busy", "db busy", "資料庫繁忙",
];
const DB_RESOURCE_EXHAUSTED_SQLSTATES = new Set(["53000", "53100", "53200", "53400"]);
const DB_RESOURCE_EXHAUSTED_SYSCODES = new Set<string>([]);
const DB_RESOURCE_EXHAUSTED_MSG_TOKENS = [
  "insufficient_resources", "insufficient resources",
  "disk_full", "disk full",
  "out_of_memory", "out of memory",
  "configuration_limit_exceeded", "configuration limit exceeded",
];
const DB_UNAVAILABLE_SQLSTATES = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007",
  "57P01", "57P02", "57P03", "57P04", "58000", "58030",
]);
const DB_UNAVAILABLE_SYSCODES = new Set([
  "protocol_connection_lost",
  "econnrefused", "econnreset", "ehostunreach", "enetunreach", "etimedout",
  "eai_again", "enoent", "err_socket_closed", "connection_closed",
]);
const DB_UNAVAILABLE_MSG_TOKENS = [
  "connection refused", "connection reset", "no route to host", "host unreachable",
  "network is unreachable", "connection timed out", "socket hang up",
  "the database system is starting up", "the database system is shutting down",
  "aborting any active transactions", "terminating connection due to administrator command",
  "could not translate host name", "name or service not known", "getaddrinfo",
  "server closed the connection unexpectedly", "connection terminated unexpectedly",
  "timeout exceeded when trying to connect", "connection terminated due to connection timeout",
];

const classifyBridgeError = (err: unknown): BridgeErrInfo => {
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const status = typeof rec.status === "number" && Number.isFinite(rec.status) && rec.status >= 100 && rec.status <= 599 ? rec.status : null;
    const code = typeof rec.code === "string" ? rec.code : null;
    const messageRaw = (rec as any)?.message;
    const message = typeof messageRaw === "string" ? messageRaw.slice(0, 300) : "";
    const sqlstateRaw = (rec as { sqlstate?: unknown; sqlState?: unknown }).sqlstate ?? (rec as { sqlstate?: unknown; sqlState?: unknown }).sqlState;
    const sqlstate = typeof sqlstateRaw === "string" ? sqlstateRaw.toUpperCase() : "";
    const loweredCode = code ? code.toLowerCase() : "";
    const loweredMsg = message.toLowerCase();

    const busyByState = sqlstate && DB_BUSY_SQLSTATES.has(sqlstate);
    const busyByCode = loweredCode && DB_BUSY_SYSCODES.has(loweredCode);
    const busyByMsg = DB_BUSY_MSG_TOKENS.some((t) => loweredMsg.includes(t));
    if (busyByState || busyByCode || busyByMsg) {
      return { status: 503, code: "DB_BUSY", message: "Our database is currently under heavy load. Please try again in a few moments.", isExpected: true };
    }

    const resourceByState = sqlstate && DB_RESOURCE_EXHAUSTED_SQLSTATES.has(sqlstate);
    const resourceByCode = loweredCode && DB_RESOURCE_EXHAUSTED_SYSCODES.has(loweredCode);
    const resourceByMsg = DB_RESOURCE_EXHAUSTED_MSG_TOKENS.some((t) => loweredMsg.includes(t));
    if (resourceByState || resourceByCode || resourceByMsg) {
      return { status: 503, code: "DB_RESOURCE_EXHAUSTED", message: "Our database service is experiencing resource constraints. Please try again shortly or contact support if the issue persists.", isExpected: true };
    }

    const unavailByState = sqlstate && DB_UNAVAILABLE_SQLSTATES.has(sqlstate);
    const unavailByCode = loweredCode && DB_UNAVAILABLE_SYSCODES.has(loweredCode);
    const unavailByMsg = DB_UNAVAILABLE_MSG_TOKENS.some((t) => loweredMsg.includes(t));
    if (unavailByState || unavailByCode || unavailByMsg) {
      return { status: 503, code: "DB_UNAVAILABLE", message: "Our database service is temporarily unavailable. Please try again shortly or contact support if the issue persists.", isExpected: true };
    }

    if (loweredMsg.includes("pool") && loweredMsg.includes("timeout")) {
      return { status: 503, code: "DB_BUSY", message: "Our database is currently under heavy load. Please try again in a few moments.", isExpected: true };
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
