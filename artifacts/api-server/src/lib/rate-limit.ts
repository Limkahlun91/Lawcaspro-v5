import type { RequestHandler } from "express";
import { createRateLimit } from "./express-rate-limit-compat";

export const authRateLimiter: RequestHandler = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait 15 minutes before trying again." },
  skip: () => process.env.NODE_ENV === "test",
});

export const sensitiveRateLimiter: RequestHandler = createRateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: () => process.env.NODE_ENV === "test",
});
