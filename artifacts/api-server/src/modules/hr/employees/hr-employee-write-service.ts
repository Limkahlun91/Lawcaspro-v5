import { createHRError, HR_ERROR_CODES } from "../../shared/errors/hr-error-codes.js";
import { logger } from "../../../lib/logger.js";

export const NRIC_MASK_CHAR = "*";

export function normalizeIcPassportNo(input: string | null | undefined): string {
  if (!input) return "";
  return String(input).trim();
}

export function malaysianNricMask(fullValue: string): string {
  const norm = normalizeIcPassportNo(fullValue);
  if (!norm) return "";
  const stripped = norm.replace(/[^A-Za-z0-9]/g, "");
  if (stripped.length < 6) return NRIC_MASK_CHAR.repeat(Math.max(0, stripped.length - 2)) + stripped.slice(-2);
  const last4 = stripped.slice(-4);
  return `******-**-${last4}`;
}

export function maskBankAccountNumber(accountNumber: string | null | undefined): string {
  const norm = normalizeIcPassportNo(accountNumber);
  if (!norm) return "";
  if (norm.length <= 4) return norm;
  const last4 = norm.slice(-4);
  return NRIC_MASK_CHAR.repeat(norm.length - 4) + last4;
}

export interface HrEmployeeCoreWrite {
  employeeNo: string;
  legalFullName: string;
  employmentStatus?: string;
  icPassportNoFull?: string;
  [key: string]: unknown;
}

export interface HrEmployeeIdentityRecordWrite {
  employeeId: number;
  identityType: string;
  identityNumber: string;
  issuedCountry?: string;
  issuedBy?: string;
  issuedDate?: string;
  expiryDate?: string;
}

export function enforceMaskOnWrite(fullIcPassportNo: string | undefined | null): {
  maskedValue: string | null;
  fullValue: string | null;
} {
  const raw = normalizeIcPassportNo(fullIcPassportNo);
  if (!raw) return { maskedValue: null, fullValue: null };
  const masked = malaysianNricMask(raw);
  if (!masked || masked === "") {
    throw createHRError(
      HR_ERROR_CODES.HR_REQUIRED_FIELD_MISSING,
      "enforceMaskOnWrite produced empty mask; never use empty-string mask per Decision E1+.",
    );
  }
  return { maskedValue: masked, fullValue: raw };
}

export const hrEmployeeWriteService = {
  enforceMaskOnWrite,
  malaysianNricMask,
  maskBankAccountNumber,
};

export default hrEmployeeWriteService;
