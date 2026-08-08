import { logger } from "../../../lib/logger.js";
import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import crypto from "node:crypto";

export const HR_STORAGE_PATH_REGEX =
  /^firms\/(\d+)\/hr\/employees\/(\d+)\/([A-Za-z0-9_-]+)\/(\d{4})\/(\d{2})\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.([A-Za-z0-9]+)$/;

export interface BuildHrStoragePathInput {
  firmId: number;
  employeeId: number;
  category: string;
  ext: string;
  date?: Date;
  providedUuid?: string;
}

function safeCategory(cat: string): string {
  const safe = String(cat || "general").trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return safe || "general";
}

function safeExt(e: string): string {
  const s = String(e || "bin").trim().replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return s || "bin";
}

export function buildHrStoragePath(input: BuildHrStoragePathInput): string {
  if (!input.firmId || !Number.isFinite(input.firmId)) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "firmId required for HR storage path");
  }
  if (!input.employeeId || !Number.isFinite(input.employeeId)) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "employeeId required for HR storage path");
  }
  const d = input.date ? new Date(input.date) : new Date();
  if (Number.isNaN(d.getTime())) {
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "invalid date for HR storage path");
  }
  const year = String(d.getUTCFullYear()).padStart(4, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  let uuid = (input.providedUuid || "").trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) {
    uuid = crypto.randomUUID();
  }
  const category = safeCategory(input.category);
  const ext = safeExt(input.ext);
  const path = `firms/${input.firmId}/hr/employees/${input.employeeId}/${category}/${year}/${month}/${uuid}.${ext}`;
  if (!HR_STORAGE_PATH_REGEX.test(path)) {
    logger.error({ path, input }, "buildHrStoragePath produced output that fails regex — aborting");
    throw createHRError(HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING, "buildHrStoragePath output validation failed");
  }
  return path;
}

export function assertStoragePathMatchesFirmAndEmployee(
  path: string,
  firmId: number,
  employeeId: number,
): void {
  const m = HR_STORAGE_PATH_REGEX.exec(path);
  if (!m) {
    throw createHRError(HR_ERROR_CODES.HR_CROSS_FIRM_ACCESS_DENIED, "HR storage path does not match C1 convention");
  }
  const pathFirm = Number(m[1]);
  const pathEmp = Number(m[2]);
  if (pathFirm !== Number(firmId) || pathEmp !== Number(employeeId)) {
    throw createHRError(HR_ERROR_CODES.HR_CROSS_FIRM_ACCESS_DENIED, "HR storage path crosses firm/employee boundary");
  }
}

export const hrStoragePathService = {
  buildHrStoragePath,
  assertStoragePathMatchesFirmAndEmployee,
  HR_STORAGE_PATH_REGEX,
};

export default hrStoragePathService;
