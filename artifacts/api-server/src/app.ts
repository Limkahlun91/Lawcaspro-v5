/// <reference types="express" />
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

type App = {
  set: (setting: string, value: unknown) => unknown;
  use: (...handlers: unknown[]) => unknown;
  get: (path: string, handler: unknown) => unknown;
  listen: (port: number, cb: () => void) => {
    on: (event: "error", listener: (err: unknown) => void) => unknown;
  };
};

const app: App = express() as unknown as App;

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

function healthHandler(
  _req: unknown,
  res: { json: (body: unknown) => unknown },
): void {
  res.json({ ok: true });
}

function notFoundHandler(
  _req: unknown,
  res: { json: (body: unknown) => unknown },
): void {
  logger.warn("Route not found");
  res.json({ error: "Not found" });
}

function errorHandler(
  err: unknown,
  _req: unknown,
  res: { json: (body: unknown) => unknown },
  _next: unknown,
): void {
  logger.error({ err }, "Unhandled error");
  res.json({ error: "Internal server error" });
}

app.get("/api/health", healthHandler);
app.use("/api", router);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
