import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: ReturnType<typeof express> = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
const requestLogger: express.RequestHandler = pinoHttp({ logger });
app.use(requestLogger);

const healthHandler: express.RequestHandler = (_req, res): void => {
  res.status(200).json({ ok: true });
};

const notFoundHandler: express.RequestHandler = (req, res): void => {
  logger.warn({ path: req.path, method: req.method, status: 404 }, "Route not found");
  res.status(404).json({ error: "Not found" });
};

const errorHandler: express.ErrorRequestHandler = (err, req, res, next): void => {
  if (res.headersSent) {
    next(err);
    return;
  }

  logger.error({ err, path: req.path, method: req.method, status: 500 }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
};

app.get("/api/health", healthHandler);
app.use("/api", router);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
