import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { getSupportSessionId } from "@/lib/support-session";

function asString(v: unknown): string {
  return v == null ? "" : String(v);
}

function fmtDateTime(v: unknown): string {
  const s = asString(v);
  if (!s) return "—";
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  const cls = (() => {
    if (status === "completed" || status === "approved" || status === "executed") return "bg-green-50 text-green-700 border border-green-200";
    if (status === "failed" || status === "rejected") return "bg-red-50 text-red-700 border border-red-200";
    if (status === "running" || status === "snapshotting" || status === "queued" || status === "requested") return "bg-amber-50 text-amber-800 border border-amber-200";
    return "bg-slate-100 text-slate-700 border border-slate-200";
  })();
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{status || "—"}</span>;
}

export default function FirmHistoryDetailPage() {
  const params = useParams();
  const [, setLocation] = useLocation();

  const firmId = Number(params?.id);
  const kind = String((params as any)?.kind ?? "");
  const historyId = String((params as any)?.historyId ?? "");

  const supportQuery = useQuery({
    queryKey: ["platform-firm-history-detail-support-session", firmId],
    queryFn: async () => {
      return await apiFetchJson<{ items: any[] }>(`/support-sessions?firmId=${firmId}`);
    },
    enabled: Number.isFinite(firmId) && firmId > 0,
    retry: false,
  });

  const detailQuery = useQuery({
    queryKey: ["platform-firm-history-detail-page", firmId, kind, historyId],
    queryFn: async () => {
      if (!firmId || !kind || !historyId) throw new Error("Missing params");
      if (kind === "maintenance") {
        return { kind, data: await apiFetchJson(`/platform/firms/${firmId}/maintenance/actions/${historyId}`) };
      }
      if (kind === "restore") {
        return { kind, data: await apiFetchJson(`/platform/firms/${firmId}/restore/actions/${historyId}`) };
      }
      if (kind === "approval") {
        return { kind, data: await apiFetchJson(`/platform/approvals/${historyId}`) };
      }
      throw new Error(`Unsupported kind: ${kind}`);
    },
    retry: false,
    enabled: Number.isFinite(firmId) && firmId > 0 && !!kind && !!historyId,
  });

  const payload = detailQuery.data?.data as any;
  const data = payload?.data ?? payload;

  const title = kind === "maintenance" ? "Maintenance Action" : kind === "restore" ? "Restore / Rollback" : kind === "approval" ? "Approval Request" : "History Detail";

  const storedSupportSessionId = getSupportSessionId();
  const latestSupport = (supportQuery.data?.items ?? [])[0] ?? null;
  const latestStatus = latestSupport?.status ? String(latestSupport.status) : "";
  const latestExpiresAt = latestSupport?.expiresAt ? String(latestSupport.expiresAt) : "";

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="text-sm text-slate-500">Firm #{firmId}</div>
          <div className="text-xl font-semibold text-slate-900">{title}</div>
          <div className="text-xs text-slate-600">
            Support session: {storedSupportSessionId ? <span className="font-mono">#{storedSupportSessionId}</span> : "—"}
            {latestSupport ? (
              <>
                <span className="mx-2">·</span>
                <StatusBadge status={latestStatus || "unknown"} />
                {latestExpiresAt ? <span className="text-xs text-slate-500"> · expires {fmtDateTime(latestExpiresAt)}</span> : null}
              </>
            ) : null}
          </div>
        </div>
        <Button variant="outline" onClick={() => setLocation(`/platform/firms/${firmId}?tab=history`)}>
          Back to history
        </Button>
      </div>

      {detailQuery.isError ? (
        <QueryFallback title="History detail unavailable" error={detailQuery.error} onRetry={() => detailQuery.refetch()} isRetrying={detailQuery.isFetching} />
      ) : detailQuery.isLoading ? (
        <div className="text-sm text-slate-500 py-10 text-center">Loading...</div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Summary</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-700">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="font-mono text-xs">{kind}:{historyId}</div>
                <div className="flex items-center gap-2">
                  {kind !== "approval" ? <Badge variant="outline" className="text-xs">{asString(data?.action?.actionCode ?? data?.action?.operationCode ?? data?.action?.restoreScopeType ?? "") || "action"}</Badge> : null}
                  <StatusBadge status={asString(data?.action?.status ?? data?.item?.status ?? "")} />
                  {data?.action?.riskLevel ? <Badge variant="outline" className="text-xs">risk:{asString(data.action.riskLevel)}</Badge> : null}
                </div>
              </div>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-600">
                <div>Requested: {fmtDateTime(data?.action?.createdAt ?? data?.item?.requestedAt ?? data?.item?.createdAt ?? null)}</div>
                <div>Requester: {asString(data?.action?.requestedByEmail ?? data?.item?.requestedByEmail ?? "") || "—"}</div>
                <div>Target: {asString(data?.action?.targetLabel ?? data?.item?.targetLabel ?? data?.action?.moduleCode ?? data?.item?.moduleCode ?? "") || "—"}</div>
                <div>Snapshot: {asString(data?.action?.snapshotId ?? data?.item?.snapshotId ?? data?.action?.preActionSnapshotId ?? "") ? <span className="font-mono">{asString(data?.action?.snapshotId ?? data?.item?.snapshotId ?? data?.action?.preActionSnapshotId)}</span> : "—"}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Request</CardTitle>
            </CardHeader>
            <CardContent>
              {kind === "approval" ? (
                <div className="space-y-3 text-sm text-slate-700">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div>Request code: <span className="font-mono">{asString(data?.item?.requestCode ?? "") || "—"}</span></div>
                    <div>Action code: <span className="font-mono">{asString(data?.item?.actionCode ?? "") || "—"}</span></div>
                    <div>Policy: <span className="font-mono">{asString(data?.item?.approvalPolicyCode ?? "") || "—"}</span></div>
                    <div>Required approvals: {asString(data?.item?.requiredApprovals ?? "") || "—"} · Current: {asString(data?.item?.currentApprovals ?? "") || "—"}</div>
                    <div>Emergency: {String(!!data?.item?.emergencyFlag)}</div>
                    <div>Impersonation: {String(!!data?.item?.impersonationFlag)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Reason</div>
                    <div className="whitespace-pre-wrap break-words">{asString(data?.item?.reason ?? "") || "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Events</div>
                    {(data?.events ?? []).length ? (
                      <div className="rounded border border-slate-200 divide-y">
                        {(data?.events ?? []).map((e: any) => (
                          <div key={asString(e.id)} className="p-2 text-xs flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-mono text-slate-900">{asString(e.action)}</div>
                              <div className="text-slate-500">by user #{asString(e.actorUserId)} · {fmtDateTime(e.createdAt)}</div>
                              {e.note ? <div className="text-slate-600 whitespace-pre-wrap break-words mt-1">{asString(e.note)}</div> : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">No events</div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3 text-sm text-slate-700">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div>Created: {fmtDateTime(data?.action?.createdAt)}</div>
                    <div>Updated: {fmtDateTime(data?.action?.updatedAt)}</div>
                    <div>Started: {fmtDateTime(data?.action?.startedAt)}</div>
                    <div>Completed: {fmtDateTime(data?.action?.completedAt ?? data?.action?.failedAt)}</div>
                    <div>Typed confirmation: {asString(data?.action?.typedConfirmation ?? "") || "—"}</div>
                    <div>Step-up: {asString(data?.action?.stepUpConfirmation ?? "") || "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Reason</div>
                    <div className="whitespace-pre-wrap break-words">{asString(data?.action?.reason ?? "") || "—"}</div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {kind !== "approval" ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Execution</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-700">
                  <div>Status: <StatusBadge status={asString(data?.action?.status ?? "")} /></div>
                  <div>Scope: <Badge variant="outline" className="text-xs">{asString(data?.action?.scopeType ?? data?.action?.restoreScopeType ?? "") || "—"}</Badge></div>
                  <div>Module: <Badge variant="outline" className="text-xs">{asString(data?.action?.moduleCode ?? "") || "—"}</Badge></div>
                  <div>Operation: <Badge variant="outline" className="text-xs">{asString(data?.action?.operationCode ?? data?.action?.actionCode ?? "") || "—"}</Badge></div>
                </div>
                {data?.action?.errorMessage || data?.action?.errorCode ? (
                  <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                    <div className="font-medium">Error</div>
                    <div className="font-mono mt-1">{asString(data?.action?.errorCode ?? "")}</div>
                    <div className="mt-1 whitespace-pre-wrap break-words">{asString(data?.action?.errorMessage ?? "")}</div>
                  </div>
                ) : null}
                <div>
                  <div className="text-xs text-slate-500 mb-1">Steps</div>
                  {(data?.steps ?? []).length ? (
                    <div className="rounded border border-slate-200 divide-y">
                      {(data?.steps ?? []).map((s: any) => (
                        <div key={asString(s.id)} className="p-2 text-xs flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-mono text-slate-900">{asString(s.stepCode ?? s.step_code)}</div>
                            <div className="text-slate-500">started {fmtDateTime(s.startedAt)} · done {fmtDateTime(s.completedAt)}</div>
                            {s.errorMessage || s.error_message ? <div className="text-red-700 whitespace-pre-wrap break-words mt-1">{asString(s.errorMessage ?? s.error_message)}</div> : null}
                          </div>
                          <StatusBadge status={asString(s.status ?? "")} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">No steps</div>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {data?.approval ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Approval</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-700">
                  <div>Request code: <span className="font-mono">{asString(data.approval.requestCode ?? "") || "—"}</span></div>
                  <div>Status: <StatusBadge status={asString(data.approval.status ?? "")} /></div>
                  <div>Requested: {fmtDateTime(data.approval.requestedAt)}</div>
                  <div>Expires: {fmtDateTime(data.approval.expiresAt)}</div>
                  <div>Policy: <span className="font-mono">{asString(data.approval.approvalPolicyCode ?? "") || "—"}</span></div>
                  <div>Required: {asString(data.approval.requiredApprovals ?? "")} · Current: {asString(data.approval.currentApprovals ?? "")}</div>
                </div>
                <div className="mt-3">
                  <div className="text-xs text-slate-500 mb-1">Reason</div>
                  <div className="text-sm whitespace-pre-wrap break-words text-slate-700">{asString(data.approval.reason ?? "") || "—"}</div>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {(data?.audit ?? []).length ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Audit Trail</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded border border-slate-200 divide-y">
                  {(data?.audit ?? []).map((a: any) => (
                    <div key={asString(a.id)} className="p-2 text-xs flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-slate-900">{asString(a.action ?? "")}</div>
                        <div className="text-slate-500">by {asString(a.actorId ?? a.actor_id ?? "—")} · {fmtDateTime(a.createdAt)}</div>
                        {a.detail ? <div className="mt-1 whitespace-pre-wrap break-words text-slate-700">{asString(a.detail)}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
