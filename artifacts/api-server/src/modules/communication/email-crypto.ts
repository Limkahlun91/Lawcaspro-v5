import crypto from "node:crypto";
import { ApiError } from "../../lib/api-response.js";

const EMAIL_ENCRYPTION_ENV_KEY = "EMAIL_TOKEN_ENCRYPTION_KEY";
const IV_LENGTH = 12;

function readKeyMaterial(): Buffer | null {
  const raw = String(process.env[EMAIL_ENCRYPTION_ENV_KEY] ?? "").trim();
  if (!raw) return null;

  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const candidates = [
    () => Buffer.from(normalized, "base64"),
    () => Buffer.from(raw, "hex"),
    () => Buffer.from(raw, "utf8"),
  ];

  for (const parse of candidates) {
    try {
      const buf = parse();
      if (buf.length === 32) return buf;
      if (buf.length > 0) return crypto.createHash("sha256").update(buf).digest();
    } catch {
      // Try the next representation.
    }
  }

  return null;
}

function requireKeyMaterial(): Buffer {
  const key = readKeyMaterial();
  if (key) return key;
  throw new ApiError({
    status: 400,
    code: "EMAIL_ENCRYPTION_NOT_CONFIGURED",
    message: "Email credential encryption is not configured.",
    suggestion: `Set ${EMAIL_ENCRYPTION_ENV_KEY} before connecting a mailbox.`,
  });
}

export function isEmailEncryptionConfigured(): boolean {
  return readKeyMaterial() != null;
}

export function ensureEmailEncryptionConfigured(): void {
  void requireKeyMaterial();
}

export function encryptEmailSecret(value: string): string {
  const plaintext = String(value ?? "");
  const key = requireKeyMaterial();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptEmailSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = requireKeyMaterial();
  const parts = String(value).split(".");
  if (parts.length !== 3) {
    throw new ApiError({
      status: 500,
      code: "EMAIL_ENCRYPTION_INVALID_PAYLOAD",
      message: "Stored email credential payload is invalid.",
    });
  }
  const [ivRaw, tagRaw, cipherRaw] = parts;
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  const encrypted = Buffer.from(cipherRaw, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

export function signEmailState(payload: Record<string, unknown>): string {
  const key = requireKeyMaterial();
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", key).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyEmailState<T extends Record<string, unknown>>(token: string): T {
  const key = requireKeyMaterial();
  const [encodedPayload, signature] = String(token ?? "").split(".");
  if (!encodedPayload || !signature) {
    throw new ApiError({
      status: 400,
      code: "EMAIL_OAUTH_STATE_INVALID",
      message: "Mailbox connection state is invalid.",
    });
  }

  const expected = crypto.createHmac("sha256", key).update(encodedPayload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new ApiError({
      status: 400,
      code: "EMAIL_OAUTH_STATE_INVALID",
      message: "Mailbox connection state verification failed.",
    });
  }

  const raw = Buffer.from(encodedPayload, "base64url").toString("utf8");
  return JSON.parse(raw) as T;
}

export function maskEmailCredential(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length <= 4) return "*".repeat(raw.length);
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}
