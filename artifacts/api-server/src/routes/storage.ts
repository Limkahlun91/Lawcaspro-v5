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
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const TEMPLATE_ALLOWED_MIME_TYPES = new Set([
  ...DEFAULT_ALLOWED_MIME_TYPES,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const requestedObjectPath = queryOne((req as any).query, "objectPath");
    const allowTemplateTypes = typeof requestedObjectPath === "string" && requestedObjectPath.startsWith("/objects/templates/");
    const allowed = allowTemplateTypes ? TEMPLATE_ALLOWED_MIME_TYPES : DEFAULT_ALLOWED_MIME_TYPES;
    const originalName = typeof file.originalname === "string" ? file.originalname : "";
    const lower = originalName.toLowerCase();
    const ext =
      lower.endsWith(".docx") ? "docx"
      : lower.endsWith(".doc") ? "doc"
      : lower.endsWith(".pdf") ? "pdf"
      : lower.endsWith(".jpeg") ? "jpeg"
      : lower.endsWith(".jpg") ? "jpg"
      : lower.endsWith(".png") ? "png"
      : lower.endsWith(".webp") ? "webp"
      : "";
    const extAllowed = allowTemplateTypes
      ? ext === "docx" || ext === "doc" || ext === "pdf" || ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp"
      : ext === "pdf" || ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp";
    if (!allowed.has(file.mimetype) && !extAllowed) {
      const err = new Error("UNSUPPORTED_FILE_TYPE");
      (err as any).code = "UNSUPPORTED_FILE_TYPE";
      cb(err);
      return;
    }
    cb(null, true);
  },
});

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
    const { size, contentType } = parsed.data as { size?: number; contentType?: string };
    if (typeof size === "number" && size > MAX_UPLOAD_BYTES) {
      sendError(res as any, new ApiError({ status: 413, code: "FILE_TOO_LARGE", message: "File size must be under 10MB", retryable: false }));
      return;
    }
    if (typeof contentType === "string" && contentType && !DEFAULT_ALLOWED_MIME_TYPES.has(contentType)) {
      sendError(res as any, new ApiError({ status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Only PDF, JPG, PNG, or WebP files are allowed", retryable: false }));
      return;
    }
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

router.post(
  "/storage/upload",
  requireAuth,
  (req: AuthRequest, res: ExpressResponse, next: any) => {
    upload.single("file")(req as any, res as any, (err: any) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        sendError(res as any, new ApiError({ status: 413, code: "FILE_TOO_LARGE", message: "File size must be under 10MB", retryable: false }));
        return;
      }
      if (err && typeof err === "object" && (err as any).code === "UNSUPPORTED_FILE_TYPE") {
        const requestedObjectPath = queryOne((req as any).query, "objectPath");
        const allowTemplateTypes = typeof requestedObjectPath === "string" && requestedObjectPath.startsWith("/objects/templates/");
        const message = allowTemplateTypes ? "Only DOCX, PDF, JPG, PNG, or WebP files are allowed" : "Only PDF, JPG, PNG, or WebP files are allowed";
        sendError(res as any, new ApiError({ status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message, retryable: false }));
        return;
      }
      sendError(res as any, new ApiError({ status: 400, code: "INVALID_UPLOAD", message: "Invalid upload", retryable: false }));
    });
  },
  async (req: AuthRequest, res: ExpressResponse) => {
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
        const allowedPrefixes = [
          `/objects/cases/${req.firmId}/`,
          `/objects/templates/firms/${req.firmId}/`,
        ];
        if (!allowedPrefixes.some((p) => requestedObjectPath.startsWith(p))) {
          sendError(res as any, new ApiError({ status: 403, code: "FORBIDDEN", message: "Invalid objectPath", retryable: false }));
          return;
        }
      }
    }

    await supabaseStorage.uploadPrivateObject({
      objectPath,
      fileBytes: req.file.buffer,
      contentType: req.file.mimetype || "application/octet-stream",
      upsert: objectPath.startsWith("/objects/templates/"),
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
