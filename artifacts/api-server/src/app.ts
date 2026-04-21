import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app = express();

app.set("trust proxy", 1);
app.use(pinoHttp({ logger, autoLogging: false }));
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});
app.use("/api", router);
app.use((req: Request, res: Response) => {
  req.log.warn({ method: req.method, path: req.path }, "Route not found");
  res.status(404).json({ error: "Not found" });
});
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err, method: req.method, path: req.path }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
