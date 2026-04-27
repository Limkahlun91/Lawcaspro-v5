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

  req.url = normalizedUrl;

  try {
    const handler = await getHandler();
    handler(req, res, (err?: unknown) => {
      if (!err) return;
      if (isDebug) console.error("[vercel-bridge] next(err)", err);
      if (res && !res.headersSent) {
        sendJsonError(res, 500, {
          ok: false,
          error: "internal_error",
          source: "vercel-bridge-next",
        });
      }
    });
  } catch (err) {
    if (isDebug) console.error("[vercel-bridge] handler throw", err);
    if (res && !res.headersSent) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      sendJsonError(res, 500, {
        ok: false,
        error: "internal_error",
        source: "vercel-bridge",
        message: msg.slice(0, 300),
      });
    }
  }
}
