import type { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../../../lib/auth.js";
import { createHRError, HR_ERROR_CODES, serializeHRError } from "../../shared/errors/hr-error-codes.js";
import { logger } from "../../../lib/logger.js";

export type EssUserIdSource = "auth.user.id" | "auth.employeeId";

export function essEnsureCurrentUserOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const anyReq = req as unknown as Record<string, unknown>;
  const params = (req.params ?? {}) as Record<string, unknown>;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const attackerIdents: Array<{ key: string; value: unknown; source: string }> = [];
  const forbiddenParams = ["userId", "user_id", "linked_user_id", "linkedUserId", "employeeId", "employee_id", "targetUserId", "target_user_id"];
  for (const k of forbiddenParams) {
    if (params[k] !== undefined) attackerIdents.push({ key: k, value: params[k], source: "params" });
    if (query[k] !== undefined) attackerIdents.push({ key: k, value: query[k], source: "query" });
    if (body[k] !== undefined) attackerIdents.push({ key: k, value: body[k], source: "body" });
  }
  const authUserId =
    (anyReq.auth && typeof anyReq.auth === "object" && typeof (anyReq.auth as any).user?.id !== "undefined")
      ? (anyReq.auth as any).user.id as unknown as number | undefined
      : (anyReq.userId as number | undefined);
  if (authUserId === undefined || authUserId === null) {
    res.status(403).json(serializeHRError(createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "ESS endpoint requires authenticated user")));
    return;
  }
  for (const bad of attackerIdents) {
    logger.warn(
      { key: bad.key, source: bad.source, value: bad.value, authUserId, path: req.path },
      "[hrESS] IDOR attempt: ESS endpoint received explicit user identifier; endpoint MUST derive user from req.auth.user.id ONLY",
    );
    res.status(403).json(serializeHRError(createHRError(
      HR_ERROR_CODES.HR_PERMISSION_DENIED,
      `ESS endpoint /hr/me/* does not accept ${bad.key} parameter. User context is derived exclusively from req.auth.user.id to prevent IDOR.`,
      { details: { rejectedSource: bad.source, rejectedKey: bad.key } },
    )));
    return;
  }
  next();
}

export interface ESSDerivedContext {
  userId: number;
  firmId: number;
}

export function deriveEssContext(req: Request): ESSDerivedContext {
  const anyReq = req as unknown as Record<string, unknown>;
  const authUserId =
    (anyReq.auth && typeof anyReq.auth === "object" && typeof (anyReq.auth as any).user?.id !== "undefined")
      ? (anyReq.auth as any).user.id
      : (anyReq.userId as unknown);
  const firmId = anyReq.firmId ?? (anyReq as any).firm_id;
  if (!authUserId || !Number.isFinite(Number(authUserId))) {
    throw createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "ESS context missing authenticated userId");
  }
  if (!firmId || !Number.isFinite(Number(firmId))) {
    throw createHRError(HR_ERROR_CODES.HR_PERMISSION_DENIED, "ESS context missing firm context");
  }
  return { userId: Number(authUserId), firmId: Number(firmId) };
}

export const hrEssService = {
  essEnsureCurrentUserOnly,
  deriveEssContext,
};

export default hrEssService;
