import express, { type Router as ExpressRouter, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { Readable } from "stream";
import multer from "multer";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import {
  ObjectNotFoundError,
  ObjectStorageService,
  SupabaseStorageService,
  getSupabaseStorageConfigError,
} from "../lib/objectStorage.js";
import { requireAuth, requireFounder, type AuthRequest } from "../lib/auth.js";
import { ApiError, sendError, sendOk } from "../lib/api-response.js";
import { queryOne } from "../lib/http.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

type FetchObjectResponseLike = {
  status: number;
  headers: { forEach?: (callback: (value: string, key: string) => void) => void };
  body: unknown | null;
  ok?: boolean;
};

const asFetchObjectResponse = (value: unknown): FetchObjectResponseLike => value as FetchObjectResponseLike;

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;
const objectStorageService = new ObjectStorageService();
const supabaseStorage = new SupabaseStorageService();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post("/storage/uploads/request-url", requireAuth, async (req: AuthRequest, res: ExpressResponse) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(
      res as any,
      new ApiError({ status: 400, code: "INVALID_INPUT", message: "Missing or invalid required fields", retryable: false }),
    );
    return;
  }

  try {
    supabaseStorage.assertConfigured();
    const { randomUUID } = await import("crypto");
    const objectPath = `/objects/uploads/${randomUUID()}`;
    const host = req.get("host") || "";
    const proto = req.protocol || "https";
    const uploadURL = `${proto}://${host}/api/storage/upload?objectPath=${encodeURIComponent(objectPath)}`;

    sendOk(
      res as any,
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
      }),
    );
  } catch (error) {
    const configErr = getSupabaseStorageConfigError(error);
    if (configErr) {
      req.log.warn({ err: error }, configErr.error);
      sendError(
        res as any,
        new ApiError({
          status: 503,
          code: configErr.code,
          message: configErr.error,
          retryable: true,
          ...(configErr.missing?.length ? { details: { missing: configErr.missing } } : {}),
        }),
      );
      return;
    }
    req.log.error({ err: error }, "Error generating upload URL");
    sendError(res as any, new ApiError({ status: 503, code: "STORAGE_UPLOAD_URL_FAILED", message: "Upload service unavailable", retryable: true }));
  }
});

router.get("/storage/public-objects/*filePath", async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = asFetchObjectResponse(await objectStorageService.downloadObject(file));

    res.status(response.status);
    response.headers.forEach?.((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

router.get("/storage/objects/*path", requireAuth, requireFounder, async (req: AuthRequest, res: ExpressResponse) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const response = asFetchObjectResponse(await supabaseStorage.fetchPrivateObjectResponse(objectPath));

    res.status(response.status);
    response.headers.forEach?.((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    const configErr = getSupabaseStorageConfigError(error);
    if (configErr) {
      req.log.warn({ err: error }, configErr.error);
      res.status(configErr.statusCode).json({ error: configErr.error, code: configErr.code, missing: configErr.missing });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

router.post("/storage/upload", requireAuth, upload.single("file"), async (req: AuthRequest, res: ExpressResponse) => {
  try {
    if (!req.file) {
      sendError(res as any, new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "No file provided", retryable: false }));
      return;
    }

    const requestedObjectPath = queryOne(req.query, "objectPath");
    const { randomUUID } = await import("crypto");
    const objectPath = requestedObjectPath && requestedObjectPath.startsWith("/objects/")
      ? requestedObjectPath
      : `/objects/uploads/${randomUUID()}`;

    if (requestedObjectPath) {
      if (!requestedObjectPath.startsWith("/objects/")) {
        sendError(res as any, new ApiError({ status: 400, code: "INVALID_INPUT", message: "Invalid objectPath", retryable: false }));
        return;
      }
      if (req.userType === "firm_user") {
        if (!req.firmId) {
          sendError(res as any, new ApiError({ status: 403, code: "FORBIDDEN", message: "Firm context required", retryable: false }));
          return;
        }
        const allowedPrefix = `/objects/cases/${req.firmId}/`;
        if (!requestedObjectPath.startsWith(allowedPrefix)) {
          sendError(res as any, new ApiError({ status: 403, code: "FORBIDDEN", message: "Invalid objectPath", retryable: false }));
          return;
        }
      }
    }

    await supabaseStorage.uploadPrivateObject({
      objectPath,
      fileBytes: req.file.buffer,
      contentType: req.file.mimetype || "application/octet-stream",
    });

    sendOk(res as any, { objectPath });
  } catch (error) {
    const configErr = getSupabaseStorageConfigError(error);
    if (configErr) {
      req.log.warn({ err: error }, configErr.error);
      sendError(
        res as any,
        new ApiError({
          status: 503,
          code: configErr.code,
          message: configErr.error,
          retryable: true,
          ...(configErr.missing?.length ? { details: { missing: configErr.missing } } : {}),
        }),
      );
      return;
    }
    req.log.error({ err: error }, "Error uploading file");
    sendError(res as any, new ApiError({ status: 503, code: "STORAGE_UPLOAD_FAILED", message: "Upload failed", retryable: true }));
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
