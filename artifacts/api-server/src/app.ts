import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import type { ErrorRequestHandler, RequestHandler } from "express";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: ReturnType<typeof express> = express();

app.set("trust proxy", 1);

app.use(pinoHttp({ logger }));
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const healthHandler: RequestHandler = (_req, res) => {
  res.status(200).json({ ok: true });
};

const notFoundHandler: RequestHandler = (req, res) => {
  logger.warn({ path: req.path, method: req.method }, "Route not found");
  res.status(404).json({ error: "Not found" });
};

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
};

app.get("/api/healthz", healthHandler);

app.use("/api", router);

app.use("/api", notFoundHandler);

app.use(errorHandler);

export default app;
