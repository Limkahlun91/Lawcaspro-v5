import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";
import { logger } from "./logger.js";

export function createRateLimit(options: Parameters<typeof rateLimit>[0]): RequestHandler {
  const limiter = rateLimit(options);
  return (req, res, next) =>
    (limiter as any)(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }

      const e = err as { name?: unknown; message?: unknown; code?: unknown };
      logger.error(
        {
          errName: typeof e?.name === "string" ? e.name : null,
          errMessage: typeof e?.message === "string" ? e.message.slice(0, 240) : null,
          errCode: typeof e?.code === "string" ? e.code : null,
          route: typeof (req as any)?.path === "string" ? (req as any).path : typeof (req as any)?.url === "string" ? (req as any).url : null,
          method: typeof (req as any)?.method === "string" ? (req as any).method : null,
        },
        "rate_limit.degraded",
      );

      next();
    });
}
