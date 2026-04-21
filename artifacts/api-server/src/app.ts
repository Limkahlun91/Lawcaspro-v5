import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttpModule from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const pinoHttp = pinoHttpModule as unknown as (opts?: unknown) => express.RequestHandler;

const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));

function healthHandler(
  _req: express.Request,
  res: express.Response,
): void {
  res.status(200).json({ ok: true });
}

function notFoundHandler(
  req: express.Request,
  res: express.Response,
): void {
  logger.warn({ path: req.path, method: req.method }, "Route not found");
  res.status(404).json({ error: "Not found" });
}

function errorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
}

app.get("/api/health", healthHandler);
app.use("/api", router);
app.use(notFoundHandler);
app.use(errorHandler);

export default app as ReturnType<typeof express>;
