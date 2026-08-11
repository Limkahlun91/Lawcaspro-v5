import express, { type Response, type Router as ExpressRouter } from "express";
import { z } from "zod";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { one } from "../lib/http.js";
import { assertFirmFeatureEnabled } from "../modules/platform/firm-feature-service.js";
import { publicCredentialStatus, encryptSecret, decryptSecret, isSecretEncryptionConfigured } from "../lib/security/secret-crypto.js";
import { ApiError } from "../lib/api-response.js";
import {
  getHimsConnections,
  createHimsConnection,
  patchHimsConnection,
  getHimsCaseStatus,
  checkHimsCase,
  getHimsCaseComparisons,
  compareHimsCase,
} from "../modules/hims/hims-tracker.service.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
};

const FEATURE_KEY = "module.hims";
const expressRouter: ExpressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const parseIntParam = (raw: unknown, field: string): number => {
  const v = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(v) || v <= 0) {
    throw new ApiError({ status: 400, code: `BAD_PARAM_${field.toUpperCase()}`, message: `Valid numeric ${field} required`, retryable: false });
  }
  return v;
};

const HimsCreateConnectionSchema = z.object({
  providerCode: z.enum(["HIMS_PORTAL", "HIMS_SANDBOX", "CUSTOM_OAUTH"]),
  displayName: z.string().trim().min(1).max(200),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().trim().min(1).max(5000).optional(),
  accessToken: z.string().trim().min(1).max(5000).optional(),
  refreshToken: z.string().trim().min(1).max(5000).optional(),
  endpointBaseUrl: z.string().trim().url(),
  mode: z.enum(["tracker_only", "full_write"]).default("tracker_only"),
});

router.get("/hims/connections", requireAuth, requireFirmUser, requirePermission("module.hims", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const wrapped = await getHimsConnections({ firmId: req.firmId! }, { tx: req.rlsDb });
    const rows = Array.isArray(wrapped) ? wrapped : (wrapped && typeof wrapped === "object" && "connections" in wrapped ? (wrapped.connections ?? []) : []);
    const sanitized = (rows as unknown[]).map((c: any) => ({
      id: c.connectionId ?? c.id,
      displayName: c.connectionName ?? c.displayName,
      providerCode: c.providerCode ?? (c.config as any)?.providerCode ?? null,
      mode: c.mode ?? "tracker_only",
      endpointBaseUrl: typeof c.endpointBaseUrl === "string" ? c.endpointBaseUrl : (c.config as any)?.apiEndpoint ?? null,
      status: c.status ?? "unknown",
      lastSyncAt: typeof c.lastSyncAt !== "undefined" ? c.lastSyncAt ?? null : c.lastHealthCheckAt ?? null,
      credential: publicCredentialStatus((c.secretEnvelope ?? c.encryptedAccessToken ?? (c.config as any)?.secretEnvelope ?? null) as any),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
    res.json({ connections: sanitized });
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.get_connections_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CONNECTION_LIST_FAILED", error: err?.message ?? "Failed" });
  }
});

router.post("/hims/connections", requireAuth, requireFirmUser, requirePermission("module.hims", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    if (!isSecretEncryptionConfigured()) {
      throw new ApiError({
        status: 503,
        code: "SECRET_ENCRYPTION_NOT_CONFIGURED",
        message: "Cannot store HIMS credentials because server SECRET_ENCRYPTION_KEY is not configured",
        retryable: false,
      });
    }
    const parsed = HimsCreateConnectionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ code: "HIMS_CONNECTION_VALIDATION_FAILED", error: "Validation failed", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    if (body.mode === "full_write") {
      throw new ApiError({
        status: 403,
        code: "HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY",
        message: "PART 2 expansion routes are intentionally tracker/compare/notification-only. HIMS write modes (CREATE eSPA / SUBMIT eSPA / EDIT CASE) are not exposed on this router.",
        retryable: false,
      });
    }
    const secretPayload: Record<string, string> = {};
    if (body.clientSecret) secretPayload.clientSecret = body.clientSecret;
    if (body.accessToken) secretPayload.accessToken = body.accessToken;
    if (body.refreshToken) secretPayload.refreshToken = body.refreshToken;
    const envelope = Object.keys(secretPayload).length > 0 ? await encryptSecret(JSON.stringify(secretPayload), { associate: `${req.firmId!}:hims:conn` }) : null;

    const created = await createHimsConnection(
      {
        firmId: req.firmId!,
        actorUserId: req.userId!,
        connectionName: body.displayName,
        config: {
          apiEndpoint: body.endpointBaseUrl,
          authMode: body.providerCode,
          clientKeyRef: body.clientId ?? null,
          secretEnvelope: envelope as any,
        } as any,
      },
      { tx: req.rlsDb },
    );
    res.status(201).json({
      id: (created as any).id ?? created,
      mode: "tracker_only",
      credential: publicCredentialStatus(envelope as any),
    });
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED" || err?.code === "HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY" || err?.code === "SECRET_ENCRYPTION_NOT_CONFIGURED") {
      res.status(err.status ?? 403).json({ code: err.code, error: err.message ?? "Denied", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.create_connection_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CONNECTION_CREATE_FAILED", error: err?.message ?? "Failed" });
  }
});

router.patch("/hims/connections/:id", requireAuth, requireFirmUser, requirePermission("module.hims", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const id = parseIntParam(one(req.params?.id), "connectionId");
    const body = req.body as { displayName?: unknown; endpointBaseUrl?: unknown; status?: unknown; secretRotation?: unknown } ?? {};
    let updatedSecrets = false;
    let updatedConfig: Record<string, unknown> | undefined = undefined;
    if (body.secretRotation && typeof body.secretRotation === "object") {
      if (!isSecretEncryptionConfigured()) {
        throw new ApiError({ status: 503, code: "SECRET_ENCRYPTION_NOT_CONFIGURED", message: "Cannot rotate secrets without configured SECRET_ENCRYPTION_KEY", retryable: false });
      }
      const rotation = body.secretRotation as Record<string, string>;
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(rotation)) {
        if (typeof v === "string" && ["clientSecret", "accessToken", "refreshToken"].includes(k) && v.trim().length > 0) {
          sanitized[k] = v;
        }
      }
      if (Object.keys(sanitized).length > 0) {
        updatedConfig = { secretEnvelope: await encryptSecret(JSON.stringify(sanitized), { associate: `${req.firmId!}:hims:conn:${id}` }) };
        updatedSecrets = true;
      }
    }
    const patchInput: any = {
      firmId: req.firmId!,
      actorUserId: req.userId!,
      connectionId: id,
    };
    if (typeof body.displayName === "string") patchInput.connectionName = body.displayName.trim();
    if (typeof body.status === "string") patchInput.status = body.status as any;
    if (typeof body.endpointBaseUrl === "string") {
      patchInput.config = { ...(updatedConfig ?? {}), apiEndpoint: body.endpointBaseUrl.trim() };
    } else if (updatedConfig) {
      patchInput.config = updatedConfig;
    }
    const result = await patchHimsConnection(patchInput, { tx: req.rlsDb });
    res.json({ result, credentialRotated: updatedSecrets, credential: { hasCredential: true } });
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED" || err?.code === "SECRET_ENCRYPTION_NOT_CONFIGURED") {
      res.status(err.status ?? 403).json({ code: err.code, error: err.message ?? "Denied", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.patch_connection_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CONNECTION_PATCH_FAILED", error: err?.message ?? "Failed" });
  }
});

router.get("/hims/cases/:caseId/status", requireAuth, requireFirmUser, requirePermission("module.hims", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const caseId = parseIntParam(one(req.params?.caseId), "caseId");
    const status = await getHimsCaseStatus({ firmId: req.firmId!, caseId }, { tx: req.rlsDb });
    res.json(status);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.get_case_status_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CASE_STATUS_FAILED", error: err?.message ?? "Failed" });
  }
});

router.post("/hims/cases/:caseId/check", requireAuth, requireFirmUser, requirePermission("module.hims", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const caseId = parseIntParam(one(req.params?.caseId), "caseId");
    const body = req.body as { connectionId?: unknown } ?? {};
    const connectionId = typeof body.connectionId === "number" || typeof body.connectionId === "string" ? parseInt(String(body.connectionId), 10) : null;
    const result = await checkHimsCase(
      {
        firmId: req.firmId!,
        actorUserId: req.userId!,
        caseId,
        connectionId: Number.isFinite(connectionId) ? connectionId : null,
      },
      { tx: req.rlsDb },
    );
    res.status(202).json(result);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.check_case_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CASE_CHECK_FAILED", error: err?.message ?? "Failed" });
  }
});

router.get("/hims/cases/:caseId/comparisons", requireAuth, requireFirmUser, requirePermission("module.hims", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const caseId = parseIntParam(one(req.params?.caseId), "caseId");
    const comparisons = await getHimsCaseComparisons({ firmId: req.firmId!, caseId }, { tx: req.rlsDb });
    res.json(comparisons);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.get_case_comparisons_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CASE_COMPARISONS_FAILED", error: err?.message ?? "Failed" });
  }
});

router.post("/hims/cases/:caseId/compare", requireAuth, requireFirmUser, requirePermission("module.hims", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await assertFirmFeatureEnabled(req.rlsDb!, req.firmId!, FEATURE_KEY);
    const caseId = parseIntParam(one(req.params?.caseId), "caseId");
    const body = req.body as { connectionId?: unknown; fields?: unknown; options?: unknown } ?? {};
    const connectionId = typeof body.connectionId === "number" || typeof body.connectionId === "string" ? parseInt(String(body.connectionId), 10) : null;
    const fields = Array.isArray(body.fields) ? (body.fields as string[]) : null;
    const options = body.options && typeof body.options === "object" ? (body.options as Record<string, unknown>) : {};
    const result = await compareHimsCase(
      {
        firmId: req.firmId!,
        actorUserId: req.userId!,
        caseId,
        connectionId: Number.isFinite(connectionId) ? connectionId : null,
        himsRecordOverride: fields ? { fields, ...options } : options,
      },
      { tx: req.rlsDb },
    );
    res.status(202).json(result);
  } catch (err: any) {
    if (err?.code === "FEATURE_DISABLED") {
      res.status(403).json({ code: err.code, error: err.message ?? "Feature disabled", details: err.details ?? null });
      return;
    }
    req.log?.error?.({ err, route: req.originalUrl, firmId: req.firmId, userId: req.userId }, "hims.compare_case_failed");
    res.status(err?.status ?? 500).json({ code: err?.code ?? "HIMS_CASE_COMPARE_FAILED", error: err?.message ?? "Failed" });
  }
});

export default expressRouter;
