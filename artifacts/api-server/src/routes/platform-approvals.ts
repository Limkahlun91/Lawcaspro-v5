import { Router, type IRouter } from "express";
import { withAuthSafeDb } from "../lib/auth-safe-db";
import { requireAuth, requireFounder, type AuthRequest, writeAuditLog } from "../lib/auth";
import { ApiError, parseIntParam, sendError, sendOk } from "../lib/api-response";
import { assertFounderPermission, getApprovalRequest, listApprovalRequests, loadFounderGovernanceContext, rejectRequest, approveRequest } from "../services/founder-governance";

const router: IRouter = Router();

router.get("/platform/firms/:firmId/approvals", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const firmId = parseIntParam("firmId", req.params.firmId, { required: true, min: 1 })!;
    const status = (() => {
      const raw = typeof req.query.status === "string" ? req.query.status : Array.isArray(req.query.status) ? req.query.status[0] : undefined;
      return raw ? String(raw) : null;
    })();
    const limit = (() => {
      const v = req.query.limit;
      const raw = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
      const n = raw ? Number.parseInt(raw, 10) : 50;
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 50;
    })();

    const items = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.approval.review");
      return await listApprovalRequests(authDb, { firmId, status, limit });
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/firms/:firmId/approvals", firmId } });

    sendOk(res, { items });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/platform/approvals/:id", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "id is required", retryable: false });

    const data = await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.approval.review");
      return await getApprovalRequest(authDb, id);
    }, { retry: true, allowUnsafe: true, ctx: { route: "GET /platform/approvals/:id" } });

    sendOk(res, { item: data.request, events: data.events });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/approvals/:id/approve", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "id is required", retryable: false });
    const body = req.body as { note?: string };

    await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.approval.approve");
      await approveRequest(authDb, { requestId: id, actorUserId: ctx.actorUserId, note: body?.note ?? null, allowSelfApproval: ctx.permissions.has("founder.approval.override") });
      const { request } = await getApprovalRequest(authDb, id);
      await writeAuditLog({ firmId: request.firmId, actorId: ctx.actorUserId, actorType: "founder", action: "founder.approval.approved", entityType: "platform_approval", detail: JSON.stringify({ approvalId: id, requestCode: request.requestCode, status: request.status }), ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: false });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/approvals/:id/approve" } });

    sendOk(res, { result: { id, approved: true } });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/platform/approvals/:id/reject", requireAuth, requireFounder, async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new ApiError({ status: 400, code: "MISSING_REQUIRED_FIELD", message: "id is required", retryable: false });
    const body = req.body as { note?: string };

    await withAuthSafeDb(async (authDb) => {
      const ctx = await loadFounderGovernanceContext(authDb, req);
      assertFounderPermission(ctx, "founder.approval.reject");
      await rejectRequest(authDb, { requestId: id, actorUserId: ctx.actorUserId, note: body?.note ?? null, allowSelfApproval: ctx.permissions.has("founder.approval.override") });
      const { request } = await getApprovalRequest(authDb, id);
      await writeAuditLog({ firmId: request.firmId, actorId: ctx.actorUserId, actorType: "founder", action: "founder.approval.rejected", entityType: "platform_approval", detail: JSON.stringify({ approvalId: id, requestCode: request.requestCode, status: request.status }), ipAddress: req.ip, userAgent: req.headers["user-agent"] }, { db: authDb, strict: false });
    }, { retry: true, allowUnsafe: true, ctx: { route: "POST /platform/approvals/:id/reject" } });

    sendOk(res, { result: { id, rejected: true } });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;

