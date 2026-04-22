import apiServerApp from "@workspace/api-server/app";

type ExpressLikeHandler = (
  req: any,
  res: any,
  next?: (err?: unknown) => void,
) => unknown;

const handler = apiServerApp as unknown as ExpressLikeHandler;
const isDebug = process.env.DEBUG_VERCEL_BRIDGE === "1";

const normalizeApiUrl = (rawUrl: unknown): string => {
  const url = typeof rawUrl === "string" ? rawUrl : "/";

  if (url === "/api" || url.startsWith("/api/")) return url;
  if (url === "/api/api") return "/api";
  if (url.startsWith("/api/api/")) return url.replace("/api/api/", "/api/");

  if (url.startsWith("/")) return `/api${url}`;
  return `/api/${url}`;
};

export default function vercelHandler(req: any, res: any): void {
  const originalUrl = req?.url;
  const normalizedUrl = normalizeApiUrl(originalUrl);

  if (isDebug) {
    console.log("[vercel-bridge]", {
      method: req?.method,
      originalUrl: typeof originalUrl === "string" ? originalUrl : null,
      normalizedUrl,
    });
  }

  req.url = normalizedUrl;

  try {
    handler(req, res, (err?: unknown) => {
      if (!err) return;
      if (isDebug) console.error("[vercel-bridge] next(err)", err);
      if (res && !res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
  } catch (err) {
    if (isDebug) console.error("[vercel-bridge] handler throw", err);
    if (res && !res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
}

