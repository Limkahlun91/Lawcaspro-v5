import pino, { type LoggerOptions } from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers['x-vercel-oidc-token']",
    "req.headers['x-vercel-proxy-signature']",
    "req.headers['x-vercel-proxy-signature-ts']",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
};

export const logger = pino(loggerOptions);
