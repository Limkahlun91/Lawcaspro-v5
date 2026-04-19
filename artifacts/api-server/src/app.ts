import express from "express";
import type { Application } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import helmet from "helmet";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Application = express();

app.set("trust proxy", 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));

app.use(
  (pinoHttp as any)(),
);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not Found", code: "NOT_FOUND" });
});

app.use((err: unknown, req: any, res: any, next: any) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  logger.error({
    err,
    path: req.path,
    method: req.method,
  }, "[unhandled]");
  res.status(500).json({ error: "Internal Server Error" });
});

export default app;
