import { Storage, File } from "@google-cloud/storage";
import { StorageClient } from "@supabase/storage-js";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = process.env.REPLIT_SIDECAR_ENDPOINT || "http://127.0.0.1:1106";

function stripWrappingQuotes(value: string): string {
  const v = value.trim();
  if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function decodeMaybeBase64(value: string): string {
  const v = stripWrappingQuotes(value);
  if (v.startsWith("{")) return v;
  try {
    const decoded = Buffer.from(v, "base64").toString("utf8").trim();
    return decoded.startsWith("{") ? decoded : v;
  } catch {
    return v;
  }
}

function normalizeServiceAccountCreds(creds: Record<string, unknown>): Record<string, unknown> {
  const privateKey = creds.private_key;
  if (typeof privateKey === "string" && privateKey.includes("\\n")) {
    creds.private_key = privateKey.replace(/\\n/g, "\n");
  }
  return creds;
}

function createStorageClient(): Storage {
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCP_PROJECT_ID
    || process.env.GCLOUD_PROJECT
    || undefined;

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (saJson) {
    try {
      const decoded = decodeMaybeBase64(saJson);
      const creds = normalizeServiceAccountCreds(JSON.parse(decoded) as Record<string, unknown>) as { project_id?: string };
      return new Storage({ credentials: creds as any, projectId: creds.project_id || projectId });
    } catch {
      return new Storage({ projectId });
    }
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || projectId) {
    return new Storage({ projectId });
  }

  return new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      type: "external_account",
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: {
          type: "json",
          subject_token_field_name: "access_token",
        },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  });
}

export const objectStorageClient = createStorageClient();

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

type SupabaseStorageConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  bucketPrivate: string;
  storageUrl: string;
};

function getSupabaseStorageConfig(): SupabaseStorageConfig {
  const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
  if (!supabaseUrl) throw new Error("SUPABASE_URL not set");

  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

  const bucketPrivate = (process.env.SUPABASE_STORAGE_BUCKET_PRIVATE || "").trim();
  if (!bucketPrivate) throw new Error("SUPABASE_STORAGE_BUCKET_PRIVATE not set");

  const normalized = supabaseUrl.replace(/\/+$/, "");
  const storageUrl = `${normalized}/storage/v1`;

  return { supabaseUrl: normalized, serviceRoleKey, bucketPrivate, storageUrl };
}

export function getSupabaseStorageConfigError(
  err: unknown
): { statusCode: number; error: string } | null {
  const message = err instanceof Error ? err.message : "";
  if (!message) return null;

  if (message.includes("SUPABASE_URL not set")) {
    return { statusCode: 503, error: "Supabase storage not configured: SUPABASE_URL not set" };
  }
  if (message.includes("SUPABASE_SERVICE_ROLE_KEY not set")) {
    return { statusCode: 503, error: "Supabase storage not configured: SUPABASE_SERVICE_ROLE_KEY not set" };
  }
  if (message.includes("SUPABASE_STORAGE_BUCKET_PRIVATE not set")) {
    return { statusCode: 503, error: "Supabase storage not configured: SUPABASE_STORAGE_BUCKET_PRIVATE not set" };
  }
  return null;
}

function normalizeObjectKeyFromPath(objectPath: string): string {
  const p = objectPath.trim();
  if (!p) throw new Error("Invalid objectPath");
  if (p.startsWith("gs://") || p.startsWith("https://storage.googleapis.com/")) {
    throw new Error("Invalid objectPath: GCS URL not supported for Supabase storage");
  }
  const stripped = p.replace(/^\/+/, "");
  if (stripped.startsWith("objects/")) return stripped.slice("objects/".length);
  return stripped;
}

function createSupabaseStorageClient(): StorageClient {
  const cfg = getSupabaseStorageConfig();
  return new StorageClient(cfg.storageUrl, {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
  });
}

export class SupabaseStorageService {
  private cached:
    | { cacheKey: string; client: StorageClient; bucketPrivate: string }
    | undefined;

  assertConfigured(): void {
    this.getClient();
  }

  private getClient(): { client: StorageClient; bucketPrivate: string } {
    const cfg = getSupabaseStorageConfig();
    const cacheKey = `${cfg.storageUrl}|${cfg.serviceRoleKey}|${cfg.bucketPrivate}`;
    if (this.cached?.cacheKey === cacheKey) return this.cached;
    const client = createSupabaseStorageClient();
    this.cached = { cacheKey, client, bucketPrivate: cfg.bucketPrivate };
    return this.cached;
  }

  async uploadPrivateObject({
    objectPath,
    fileBytes,
    contentType,
  }: {
    objectPath: string;
    fileBytes: Uint8Array;
    contentType: string;
  }): Promise<void> {
    const key = normalizeObjectKeyFromPath(objectPath);
    const { client, bucketPrivate } = this.getClient();
    const body = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);
    const { error } = await client.from(bucketPrivate).upload(key, body, {
      contentType,
      upsert: false,
    });
    if (error) throw new Error(error.message);
  }

  async deletePrivateObject(objectPath: string): Promise<void> {
    const key = normalizeObjectKeyFromPath(objectPath);
    const { client, bucketPrivate } = this.getClient();
    const { error } = await client.from(bucketPrivate).remove([key]);
    if (error) {
      const message = error.message || "";
      if (message.toLowerCase().includes("not found")) throw new ObjectNotFoundError();
      throw new Error(message);
    }
  }

  async createSignedDownloadUrl(objectPath: string, ttlSec: number): Promise<string> {
    const key = normalizeObjectKeyFromPath(objectPath);
    const { client, bucketPrivate } = this.getClient();
    const { data, error } = await client.from(bucketPrivate).createSignedUrl(key, ttlSec);
    if (error) {
      const message = error.message || "";
      if (message.toLowerCase().includes("not found")) throw new ObjectNotFoundError();
      throw new Error(message);
    }
    const signedUrl = data?.signedUrl;
    if (!signedUrl) throw new Error("Failed to create signed download URL");
    return signedUrl;
  }

  async fetchPrivateObjectResponse(objectPath: string): Promise<Response> {
    const cfg = getSupabaseStorageConfig();
    const key = normalizeObjectKeyFromPath(objectPath);
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const url = `${cfg.storageUrl}/object/${encodeURIComponent(cfg.bucketPrivate)}/${encodedKey}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        apikey: cfg.serviceRoleKey,
      },
    });
    if (response.status === 404) throw new ObjectNotFoundError();
    if (!response.ok) {
      throw new Error(`Supabase storage download failed (${response.status})`);
    }
    return response;
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    const rawObjectPath = (() => {
      if (rawPath.startsWith("https://storage.googleapis.com/")) return new URL(rawPath).pathname;
      if (rawPath.startsWith("gs://")) return normalizeObjectPath(rawPath);
      if (rawPath.startsWith("/")) return rawPath;
      return rawPath;
    })();

    if (!rawObjectPath.startsWith("/")) return rawObjectPath;

    let objectEntityDir = normalizeObjectPath(this.getPrivateObjectDir());
    if (!objectEntityDir.endsWith("/")) objectEntityDir = `${objectEntityDir}/`;

    if (!rawObjectPath.startsWith(objectEntityDir)) return rawObjectPath;

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  path = normalizeObjectPath(path);
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

function normalizeObjectPath(path: string): string {
  const p = path.trim();
  if (p.startsWith("gs://")) return `/${p.slice("gs://".length).replace(/^\/+/, "")}`;
  if (p.startsWith("https://storage.googleapis.com/")) return new URL(p).pathname;
  if (!p.startsWith("/")) return `/${p}`;
  return p;
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };

  try {
    const response = await fetch(
      `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(2_000),
      }
    );
    if (response.ok) {
      const data = (await response.json()) as { signed_url?: string };
      const signedURL = data.signed_url;
      if (signedURL) return signedURL;
    }
  } catch {}

  const action = method === "GET" || method === "HEAD"
    ? "read"
    : method === "PUT"
      ? "write"
      : method === "DELETE"
        ? "delete"
        : "read";

  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [signedURL] = await file.getSignedUrl({
    version: "v4",
    action: action as any,
    expires: Date.now() + ttlSec * 1000,
  });
  return signedURL;
}
