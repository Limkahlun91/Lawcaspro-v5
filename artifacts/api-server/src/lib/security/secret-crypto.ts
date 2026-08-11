/**
 * PART 2 E - Secret envelope encryption (AES-256-GCM).
 *
 * Fail-closed:
 *   - If SECRET_ENCRYPTION_KEY (32-byte base64 / utf8) is missing → 503 SECRET_ENCRYPTION_NOT_CONFIGURED
 *   - Never plaintext fallback, never logs plaintext or envelope components
 *   - Never returns ciphertext / iv / authTag via API response; caller should return only { hasCredential: true }
 *
 * Usage:
 *   const encrypted = await encryptSecret(cleartext, { associate: `${firmId}:${label}` })
 *   const plaintext = await decryptSecret(encrypted, { associate: `${firmId}:${label}` })
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "../api-response.js";
import { logger } from "../logger.js";

const KEY_ENV_NAME = "SECRET_ENCRYPTION_KEY";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
const VERSION = "aes-256-gcm.v1";

export interface EncryptedSecretEnvelope {
  v: typeof VERSION;
  ivB64: string;
  ciphertextB64: string;
  tagB64: string;
}

let cachedKey: Buffer | null = null;
let keyLoadError: Error | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (keyLoadError) throw keyLoadError;
  try {
    const raw = process.env[KEY_ENV_NAME];
    if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
      const err = new Error(
        `SECRET_ENCRYPTION_KEY env variable is required for credential storage. Configure a 32-byte (256-bit) random secret, base64-encoded or raw.`,
      );
      keyLoadError = err;
      throw err;
    }
    const trimmed = raw.trim();
    let buf: Buffer;
    if (trimmed.length === 44 && trimmed.endsWith("=")) {
      try {
        buf = Buffer.from(trimmed, "base64");
      } catch {
        buf = Buffer.from(trimmed, "utf8");
      }
    } else {
      buf = Buffer.from(trimmed, "utf8");
    }
    if (buf.length !== KEY_LENGTH_BYTES) {
      const err = new Error(
        `SECRET_ENCRYPTION_KEY must be exactly ${KEY_LENGTH_BYTES} bytes (256-bit). Got ${buf.length} bytes. Prefer a 44-char base64 string of 32 random bytes.`,
      );
      keyLoadError = err;
      throw err;
    }
    cachedKey = buf;
    return cachedKey;
  } catch (err) {
    keyLoadError = err instanceof Error ? err : new Error(String(err));
    throw keyLoadError;
  }
}

function ensureKeyConfigured(): Buffer {
  try {
    return loadKey();
  } catch (err) {
    logger.warn({ event: "security.secret_encryption_not_configured", hint: "Set SECRET_ENCRYPTION_KEY to a 32-byte (256-bit) random secret, base64-encoded." });
    throw new ApiError({
      status: 503,
      code: "SECRET_ENCRYPTION_NOT_CONFIGURED",
      message: "Server secret encryption is not configured; cannot store or retrieve integration credentials",
      retryable: false,
      details: { envKey: KEY_ENV_NAME, required: "32-byte random secret (base64-encoded recommended)" },
    });
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function encryptSecret(plaintext: string, opts?: { associate?: string }): Promise<EncryptedSecretEnvelope> {
  const key = ensureKeyConfigured();
  if (typeof plaintext !== "string") {
    throw new ApiError({ status: 400, code: "SECRET_INVALID_TYPE", message: "Secret must be a string", retryable: false });
  }
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (opts?.associate) cipher.setAAD(Buffer.from(String(opts.associate), "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (!constantTimeEqual(tag, tag.slice(0, TAG_LENGTH_BYTES))) {
    throw new ApiError({ status: 500, code: "SECRET_ENCRYPT_FAILED", message: "Auth tag size incorrect", retryable: false });
  }
  const envelope: EncryptedSecretEnvelope = {
    v: VERSION,
    ivB64: iv.toString("base64"),
    ciphertextB64: ct.toString("base64"),
    tagB64: tag.toString("base64"),
  };
  return envelope;
}

export async function decryptSecret(envelope: EncryptedSecretEnvelope, opts?: { associate?: string }): Promise<string> {
  const key = ensureKeyConfigured();
  if (!envelope || envelope.v !== VERSION || !envelope.ivB64 || !envelope.ciphertextB64 || !envelope.tagB64) {
    throw new ApiError({
      status: 400,
      code: "SECRET_INVALID_ENVELOPE",
      message: "Stored credential envelope is malformed; it may have been migrated or tampered",
      retryable: false,
    });
  }
  let iv: Buffer;
  let ct: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.from(envelope.ivB64, "base64");
    ct = Buffer.from(envelope.ciphertextB64, "base64");
    tag = Buffer.from(envelope.tagB64, "base64");
  } catch (e: any) {
    throw new ApiError({ status: 400, code: "SECRET_INVALID_ENVELOPE", message: "Credential envelope base64 decode failed", retryable: false });
  }
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new ApiError({ status: 400, code: "SECRET_INVALID_IV", message: "Credential envelope has invalid IV size", retryable: false });
  }
  if (tag.length !== TAG_LENGTH_BYTES) {
    throw new ApiError({ status: 400, code: "SECRET_INVALID_TAG", message: "Credential envelope has invalid auth tag size", retryable: false });
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    if (opts?.associate) decipher.setAAD(Buffer.from(String(opts.associate), "utf8"));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString("utf8");
  } catch (e: any) {
    throw new ApiError({
      status: 400,
      code: "SECRET_AUTH_TAG_FAILED",
      message: "Credential decryption failed; auth tag did not match (associate label mismatch, key rotation, or tamper)",
      retryable: false,
      details: { hasAssociate: Boolean(opts?.associate) },
    });
  }
}

export function hasCredential(envelope: EncryptedSecretEnvelope | null | undefined): boolean {
  if (!envelope) return false;
  return Boolean(envelope.v === VERSION && envelope.ciphertextB64 && envelope.ivB64 && envelope.tagB64);
}

export function publicCredentialStatus(envelope: EncryptedSecretEnvelope | null | undefined): { hasCredential: boolean } {
  return { hasCredential: hasCredential(envelope) };
}

export function isSecretEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

export function serialiseEnvelope(env: EncryptedSecretEnvelope): string {
  return JSON.stringify(env);
}

export function deserialiseEnvelope(raw: string | null | undefined): EncryptedSecretEnvelope | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as EncryptedSecretEnvelope;
    return parsed && parsed.v === VERSION ? parsed : null;
  } catch {
    return null;
  }
}
