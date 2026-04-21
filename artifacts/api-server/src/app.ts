import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import helmet from "helmet";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app = express();

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

app.use("/api", (_req: Request, res: Response) => {
  res.status(404).json({ error: "Not Found", code: "NOT_FOUND" });
});

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
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

const exportedApp: ReturnType<typeof express> = app;
export default exportedApp;
