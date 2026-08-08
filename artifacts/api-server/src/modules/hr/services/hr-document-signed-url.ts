import { db, hrDocumentsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import { logger } from "../../../lib/logger.js";

export interface HrDocumentRow {
  id: number;
  firmId: number;
  employeeId: number | null;
  storagePath: string;
  storageBucket: string;
  fileName: string;
  fileSha256: string | null;
  fileSizeBytes: number | null;
}

export interface ComputedIntegrityResult {
  computedSha256: string | null;
  matches: boolean;
}

export function computeSha256FromBuffer(buf: Buffer | Uint8Array | ArrayBuffer | string): string {
  if (typeof buf === "string") {
    return crypto.createHash("sha256").update(buf, "utf8").digest("hex");
  }
  if (Buffer.isBuffer(buf)) {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }
  if (buf instanceof ArrayBuffer) {
    return crypto.createHash("sha256").update(Buffer.from(buf)).digest("hex");
  }
  return crypto.createHash("sha256").update(Buffer.from(buf as Uint8Array)).digest("hex");
}

export interface IssueHrSignedUrlInput {
  docRow: HrDocumentRow;
  actualBytesSha256Hex?: string;
  ttlSeconds?: number;
}

export interface HrSignedUrlIssueResult {
  path: string;
  issuedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  integrityValidated: boolean;
}

export function validateHrDocIntegrity(docRow: HrDocumentRow, actualSha256Hex?: string): ComputedIntegrityResult {
  const rowSha = (docRow.fileSha256 || "").trim().toLowerCase();
  if (!rowSha && !actualSha256Hex) {
    return { computedSha256: null, matches: true };
  }
  if (actualSha256Hex) {
    const actual = actualSha256Hex.trim().toLowerCase();
    if (!rowSha) {
      return { computedSha256: actual, matches: true };
    }
    return { computedSha256: actual, matches: actual === rowSha };
  }
  if (!rowSha) return { computedSha256: null, matches: true };
  return { computedSha256: rowSha, matches: true };
}

export async function issueHrSignedUrl(input: IssueHrSignedUrlInput): Promise<HrSignedUrlIssueResult> {
  const { docRow, actualBytesSha256Hex } = input;
  if (!docRow || !docRow.id) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "docRow required to issue HR signed URL");
  }
  if (!docRow.storagePath) {
    throw createHRError(HR_ERROR_CODES.HR_DOCUMENT_PERMISSION_DENIED, "document has no storage_path");
  }
  const integrity = validateHrDocIntegrity(docRow, actualBytesSha256Hex);
  if (!integrity.matches) {
    logger.error(
      {
        docId: docRow.id,
        path: docRow.storagePath,
        rowSha256: docRow.fileSha256,
        computedSha256: integrity.computedSha256,
      },
      "[hrSignedUrl] file_sha256 mismatch; refusing to issue signed URL (possible tamper or corruption)",
    );
    throw createHRError(
      HR_ERROR_CODES.HR_DOCUMENT_PERMISSION_DENIED,
      "HR document integrity check failed: stored sha256 does not match actual bytes. Signed URL not issued.",
      {
        details: {
          docId: docRow.id,
          rowSha256: docRow.fileSha256,
          computedSha256: integrity.computedSha256,
        },
      },
    );
  }
  const ttlSeconds = Number.isFinite(input.ttlSeconds) && (input.ttlSeconds as number) > 0
    ? (input.ttlSeconds as number)
    : 900;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
  await db
    .update(hrDocumentsTable)
    .set({ updatedAt: issuedAt })
    .where(and(eq(hrDocumentsTable.firmId, docRow.firmId), eq(hrDocumentsTable.id, docRow.id)));
  return {
    path: docRow.storagePath,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlSeconds,
    integrityValidated: true,
  };
}

export const hrDocumentSignedUrlService = {
  issueHrSignedUrl,
  validateHrDocIntegrity,
  computeSha256FromBuffer,
};

export default hrDocumentSignedUrlService;
