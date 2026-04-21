import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttpModule from "pino-http";
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const pinoHttp = (pinoHttpModule as unknown as (opts?: unknown) => import("express").RequestHandler);

const app = express();

app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));

const healthHandler: RequestHandler = (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
};

const notFoundHandler: RequestHandler = (req: Request, res: Response) => {
  logger.warn({ path: req.path, method: req.method }, "Route not found");
  res.status(404).json({ error: "Not found" });
};

const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    return next(err);
  }

  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
};

app.use("/api/health", healthHandler);

app.use("/api", router);

app.use(notFoundHandler);

app.use(errorHandler);

export default app as ReturnType<typeof express>;
