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

export class StorageRequestTimeoutError extends Error {
  constructor() {
    super("Storage request timed out");
    this.name = "StorageRequestTimeoutError";
    Object.setPrototypeOf(this, StorageRequestTimeoutError.prototype);
  }
}

type SupabaseStorageConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  bucketPrivate: string;
  storageUrl: string;
};

export class StorageConfigurationError extends Error {
  override name = "StorageConfigurationError";
  constructor(
    readonly configurationErrorCode: string,
    readonly variableName: string,
    readonly protocol?: string,
    message?: string,
  ) {
    super(message ?? `Storage configuration error (${configurationErrorCode}) for ${variableName}`);
    Object.setPrototypeOf(this, StorageConfigurationError.prototype);
  }
}

const CONFIG_INVALID_SUPABASE_HTTP_URL = "CONFIG_INVALID_SUPABASE_HTTP_URL";

const APPROVED_SUPABASE_HOST_SUFFIXES: ReadonlyArray<string> = [
  ".supabase.co",
  ".supabase.com",
];

function isApprovedSupabaseHost(rawHost: string): boolean {
  const host = String(rawHost || "").trim().toLowerCase();
  if (!host) return false;
  if (APPROVED_SUPABASE_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx))) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development";
  }
  return false;
}

function extractHostnameFromBare(bareCandidate: string): string {
  const stripped = bareCandidate.replace(/^\/+/, "");
  const authEnd = stripped.indexOf("@");
  const afterAuth = authEnd >= 0 ? stripped.slice(authEnd + 1) : stripped;
  const endIdx = afterAuth.search(/[\/?:#]/);
  const hostAndPort = endIdx >= 0 ? afterAuth.slice(0, endIdx) : afterAuth;
  const colonIdx = hostAndPort.lastIndexOf(":");
  if (colonIdx >= 0 && hostAndPort.indexOf("]:") < 0 && !/^\[[0-9a-fA-F:]+\]$/.test(hostAndPort)) {
    return hostAndPort.slice(0, colonIdx);
  }
  return hostAndPort;
}

function pickFirstNonEmpty(...values: Array<string | undefined | null>): string | "" {
  for (const v of values) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return "";
}

function sanitizeSupabaseHttpUrl(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^postgres(ql)?:\/\//i.test(trimmed)) return trimmed;
  const bare = trimmed.replace(/^\/+/, "");
  const candidateHost = extractHostnameFromBare(bare);
  if (isApprovedSupabaseHost(candidateHost)) {
    return `https://${bare}`;
  }
  return trimmed;
}

function assertSupabaseHttpUrl(rawValue: string, variableName: string): string {
  const sanitized = sanitizeSupabaseHttpUrl(rawValue);
  try {
    const parsed = new URL(sanitized);
    const protocol = parsed.protocol;
    if (protocol === "https:") {
      const host = parsed.hostname;
      if (isApprovedSupabaseHost(host)) return sanitized;
      try {
        console.error("[supabase_storage_config]", {
          event: "storage_config_url_invalid_host",
          variableName,
          protocol,
          configurationErrorCode: CONFIG_INVALID_SUPABASE_HTTP_URL,
        });
      } catch {
        // ignore secondary logging failure
      }
      throw new StorageConfigurationError(
        CONFIG_INVALID_SUPABASE_HTTP_URL,
        variableName,
        protocol,
        `${variableName} does not resolve to an approved Supabase host for HTTP/Storage`,
      );
    }
    if (protocol === "postgres:" || protocol === "postgresql:") {
      try {
        console.error("[supabase_storage_config]", {
          event: "storage_config_url_invalid",
          variableName,
          protocol,
          configurationErrorCode: CONFIG_INVALID_SUPABASE_HTTP_URL,
        });
      } catch {
        // ignore secondary logging failure
      }
      throw new StorageConfigurationError(
        CONFIG_INVALID_SUPABASE_HTTP_URL,
        variableName,
        protocol,
        `${variableName} uses postgres protocol; Supabase HTTP/Storage URL must be https:`,
      );
    }
    try {
      console.error("[supabase_storage_config]", {
        event: "storage_config_url_invalid",
        variableName,
        protocol,
        configurationErrorCode: CONFIG_INVALID_SUPABASE_HTTP_URL,
      });
    } catch {
      // ignore secondary logging failure
    }
    throw new StorageConfigurationError(
      CONFIG_INVALID_SUPABASE_HTTP_URL,
      variableName,
      protocol,
      `${variableName} must use https: protocol for Supabase HTTP/Storage`,
    );
  } catch (err) {
    if (err instanceof StorageConfigurationError) throw err;
    try {
      console.error("[supabase_storage_config]", {
        event: "storage_config_url_invalid",
        variableName,
        protocol: "",
        configurationErrorCode: CONFIG_INVALID_SUPABASE_HTTP_URL,
      });
    } catch {
      // ignore secondary logging failure
    }
    throw new StorageConfigurationError(
      CONFIG_INVALID_SUPABASE_HTTP_URL,
      variableName,
      undefined,
      `${variableName} could not be parsed as a valid URL for Supabase HTTP/Storage`,
    );
  }
}

function getSupabaseStorageConfig(): SupabaseStorageConfig {
  const supabaseUrlRaw = pickFirstNonEmpty(
    process.env.SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const supabaseUrlVariable =
    !!process.env.SUPABASE_URL?.trim()
      ? "SUPABASE_URL"
      : !!process.env.VITE_SUPABASE_URL?.trim()
        ? "VITE_SUPABASE_URL"
        : !!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
          ? "NEXT_PUBLIC_SUPABASE_URL"
          : "SUPABASE_URL";

  const serviceRoleKey = pickFirstNonEmpty(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY,
    process.env.SUPABASE_SERVICE_ROLE,
    process.env.SUPABASE_SERVICE_ROLE_TOKEN,
  );

  const bucketPrivate = pickFirstNonEmpty(
    process.env.SUPABASE_STORAGE_BUCKET_PRIVATE,
    process.env.SUPABASE_BUCKET_PRIVATE,
    process.env.SUPABASE_PRIVATE_BUCKET,
    process.env.SUPABASE_STORAGE_BUCKET,
    process.env.SUPABASE_STORAGE_BUCKET,
  );

  const missing: string[] = [];
  if (!supabaseUrlRaw) missing.push("SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    throw new Error(`Supabase storage not configured: missing ${missing.join(", ")}`);
  }

  const validatedUrl = assertSupabaseHttpUrl(supabaseUrlRaw, supabaseUrlVariable);

  const effectiveBucketPrivate = bucketPrivate || "lawcaspro-private";
  const normalized = validatedUrl.replace(/\/+$/, "");
  const storageUrl = `${normalized}/storage/v1`;

  return { supabaseUrl: normalized, serviceRoleKey, bucketPrivate: effectiveBucketPrivate, storageUrl };
}

export function getSupabaseStorageConfigError(
  err: unknown
): { statusCode: number; code: string; error: string; missing?: string[]; variableName?: string; protocol?: string; configurationErrorCode?: string } | null {
  if (err instanceof StorageConfigurationError) {
    return {
      statusCode: 503,
      code: err.configurationErrorCode ?? "STORAGE_BASE_URL_INVALID",
      configurationErrorCode: err.configurationErrorCode,
      variableName: err.variableName,
      protocol: err.protocol,
      error: err.message,
    };
  }
  const message = err instanceof Error ? err.message : "";
  if (!message) return null;

  const missingFromMessage = (): string[] | undefined => {
    const m = message.match(/missing\s+(.+)$/i);
    if (m?.[1]) {
      const parts = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts;
    }
    const vars = Array.from(new Set(message.match(/SUPABASE_[A-Z0-9_]+/g) ?? []));
    if (vars.length && /not set|missing/i.test(message)) return vars;
    return undefined;
  };

  if (message.toLowerCase().includes("private storage bucket unavailable")) {
    return {
      statusCode: 503,
      code: "STORAGE_BUCKET_UNAVAILABLE",
      error: message,
    };
  }

  if (message.toLowerCase().includes("supabase storage not configured") || /SUPABASE_[A-Z0-9_]+/.test(message)) {
    const missing = (() => {
      const vars = missingFromMessage();
      return vars?.length ? vars : undefined;
    })();
    if (missing?.includes("SUPABASE_URL") || missing?.includes("SUPABASE_SERVICE_ROLE_KEY")) {
      return { statusCode: 503, code: "STORAGE_SERVICE_NOT_CONFIGURED", error: "Storage service not configured", missing };
    }
    const code = missing?.includes("SUPABASE_STORAGE_BUCKET_PRIVATE") ? "STORAGE_BUCKET_MISSING" : "STORAGE_CONFIG_MISSING";
    return { statusCode: 503, code, error: message, missing };
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
    upsert,
  }: {
    objectPath: string;
    fileBytes: Uint8Array;
    contentType: string;
    upsert?: boolean;
  }): Promise<void> {
    const key = normalizeObjectKeyFromPath(objectPath);
    const { client, bucketPrivate } = this.getClient();
    const body = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes);
    const { error } = await client.from(bucketPrivate).upload(key, body, {
      contentType,
      upsert: upsert ?? false,
    });
    if (error) {
      const msg = String(error.message || "");
      if (/bucket/i.test(msg) && /not found|missing/i.test(msg)) {
        throw new Error("Private storage bucket unavailable. Please create bucket lawcaspro-private or set SUPABASE_STORAGE_BUCKET_PRIVATE.");
      }
      throw new Error(msg || "Upload failed");
    }
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

  async fetchPrivateObjectResponse(objectPath: string, opts?: { timeoutMs?: number }): Promise<globalThis.Response> {
    const cfg = getSupabaseStorageConfig();
    const key = normalizeObjectKeyFromPath(objectPath);
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const url = `${cfg.storageUrl}/object/${encodeURIComponent(cfg.bucketPrivate)}/${encodedKey}`;
    const timeoutMs = typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
          apikey: cfg.serviceRoleKey,
        },
        signal: controller.signal,
      });
    } catch (err) {
      const name = err && typeof err === "object" && "name" in err ? String((err as any).name) : "";
      if (name === "AbortError") throw new StorageRequestTimeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) throw new ObjectNotFoundError();
    if (!response.ok) {
      throw new Error(`Supabase storage download failed (${response.status})`);
    }
    return response;
  }

  async privateObjectExists(objectPath: string, opts?: { timeoutMs?: number }): Promise<boolean> {
    const cfg = getSupabaseStorageConfig();
    const key = normalizeObjectKeyFromPath(objectPath);
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const url = `${cfg.storageUrl}/object/${encodeURIComponent(cfg.bucketPrivate)}/${encodedKey}`;
    const timeoutMs = typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 2_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: "HEAD",
        headers: {
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
          apikey: cfg.serviceRoleKey,
        },
        signal: controller.signal,
      });
    } catch (err) {
      const name = err && typeof err === "object" && "name" in err ? String((err as any).name) : "";
      if (name === "AbortError") throw new StorageRequestTimeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`Supabase storage HEAD failed (${response.status})`);
    }
    return true;
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
