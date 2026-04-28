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

const sendJsonError = (res: any, statusCode: number, code: string, message: string) => {
  try {
    res.statusCode = statusCode;
    if (!res.headersSent) {
      res.setHeader("content-type", "application/json; charset=utf-8");
    }
    res.end(
      JSON.stringify({
        ok: false,
        error: { code, message },
      }),
    );
  } catch {
    try {
      res.statusCode = statusCode;
      res.end("Internal Server Error");
    } catch {
    }
  }
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

const normalizeApiPath = (rawPath: string): string => {
  if (rawPath === "/api" || rawPath.startsWith("/api/")) return rawPath;
  if (rawPath === "/api/api") return "/api";
  if (rawPath.startsWith("/api/api/")) return rawPath.replace("/api/api/", "/api/");
  if (rawPath.startsWith("/")) return `/api${rawPath}`;
  return `/api/${rawPath}`;
};

const getPathParam = (req: any): string | undefined => {
  const v = req?.query?.path ?? req?.query?.__path;
  if (typeof v === "string" && v.trim()) return v;
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (parts.length > 0) return parts.join("/");
  }
  return undefined;
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
  const isDebug = shouldDebug(req);
  const originalUrl = typeof req?.url === "string" ? req.url : "/";
  const queryString = getQueryString(originalUrl);

  const pathParam = getPathParam(req);
  const rewritten = pathParam ? `/api/${pathParam}` : originalUrl.replace(queryString, "");
  const normalizedPath = normalizeApiPath(rewritten);

  if (isDebug) {
    console.log("[vercel-bridge]", {
      method: req?.method,
      originalUrl,
      normalizedPath,
      hasCookieHeader: Boolean(req?.headers?.cookie),
    });
  }

  req.url = normalizedPath + queryString;

  try {
    const handler = await getHandler();
    handler(req, res, (err?: unknown) => {
      if (!err) return;
      if (isDebug) console.error("[vercel-bridge] next(err)", err);
      if (res && !res.headersSent) {
        sendJsonError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
      }
    });
  } catch (err) {
    if (isDebug) console.error("[vercel-bridge] handler throw", err);
    if (res && !res.headersSent) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      sendJsonError(res, 500, "INTERNAL_SERVER_ERROR", msg.slice(0, 300) || "Internal server error");
    }
  }
}

