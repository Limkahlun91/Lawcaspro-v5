import { type NextFunction, type Request, type Response } from "express";
import { db, hrFirmFeatureFlagsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { AuthRequest } from "../../../lib/auth";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../../shared/errors/hr-error-codes";

export function isHRGlobalEnvEnabled(): boolean {
  return String(process.env.ENABLE_HRMS_MODULE ?? "").trim().toLowerCase() === "true";
}

export async function requireHRModuleEnabled(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authReq = req as AuthRequest;
  if (!isHRGlobalEnvEnabled()) {
    res.status(503).json(serializeHRError(createHRError(
      HR_ERROR_CODES.HR_MODULE_DISABLED,
      "HRMS module is not enabled in this environment.",
    )));
    return;
  }
  const firmId = authReq.firmId;
  if (!firmId) {
    res.status(403).json(serializeHRError(createHRError(
      HR_ERROR_CODES.HR_PERMISSION_DENIED,
      "Firm context is required to access HR module.",
    )));
    return;
  }
  try {
    const rows = await db
      .select()
      .from(hrFirmFeatureFlagsTable)
      .where(and(eq(hrFirmFeatureFlagsTable.firmId, firmId)))
      .limit(1)
      .execute();
    const flagRow = rows[0];
    const enabled = Boolean(flagRow?.hrEnabled);
    if (!enabled) {
      res.status(503).json(serializeHRError(createHRError(
        HR_ERROR_CODES.HR_MODULE_DISABLED,
        "HRMS module is not enabled for this firm. Contact your firm administrator to enable HR.",
      )));
      return;
    }
    next();
  } catch (err) {
    res.status(503).json(serializeHRError(createHRError(
      HR_ERROR_CODES.HR_MODULE_DISABLED,
      `HR feature flag lookup failed: ${err instanceof Error ? err.message : "unknown"}`,
    )));
  }
}
