import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

export function createRateLimit(options: Parameters<typeof rateLimit>[0]): RequestHandler {
  const limiter = rateLimit(options);
  return (req, res, next) => (limiter as any)(req, res, next);
}

