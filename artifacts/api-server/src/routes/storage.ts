import { Router, type IRouter, type Request, type Response } from "express";
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
} from "../lib/objectStorage";
import { requireAuth, type AuthRequest } from "../lib/auth";

const one = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
};

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const supabaseStorage = new SupabaseStorageService();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post("/storage/uploads/request-url", requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    supabaseStorage.assertConfigured();
    const { randomUUID } = await import("crypto");
    const objectPath = `/objects/uploads/${randomUUID()}`;
    const host = req.get("host") || "";
    const proto = req.protocol || "https";
    const uploadURL = `${proto}://${host}/api/storage/upload?objectPath=${encodeURIComponent(objectPath)}`;

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
      }),
    );
  } catch (error) {
    const configErr = getSupabaseStorageConfigError(error);
    if (configErr) {
      req.log.warn({ err: error }, configErr.error);
      res.status(configErr.statusCode).json({ error: configErr.error });
      return;
    }
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

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

router.get("/storage/objects/*path", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const response = await supabaseStorage.fetchPrivateObjectResponse(objectPath);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

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
      res.status(configErr.statusCode).json({ error: configErr.error });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

router.post("/storage/upload", requireAuth, upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    const requestedObjectPath = one((req.query as Record<string, unknown>).objectPath);
    const { randomUUID } = await import("crypto");
    const objectPath = requestedObjectPath && requestedObjectPath.startsWith("/objects/")
      ? requestedObjectPath
      : `/objects/uploads/${randomUUID()}`;

    await supabaseStorage.uploadPrivateObject({
      objectPath,
      fileBytes: req.file.buffer,
      contentType: req.file.mimetype || "application/octet-stream",
    });

    res.json({ objectPath });
  } catch (error) {
    const configErr = getSupabaseStorageConfigError(error);
    if (configErr) {
      req.log.warn({ err: error }, configErr.error);
      res.status(configErr.statusCode).json({ error: configErr.error });
      return;
    }
    req.log.error({ err: error }, "Error uploading file");
    res.status(500).json({ error: "Failed to upload file" });
  }
});

export default router;
