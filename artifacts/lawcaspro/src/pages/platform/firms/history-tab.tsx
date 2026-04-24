import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { RiskBadge, type RiskLevel } from "@/components/risk-badge";
import { useLocation } from "wouter";
import { getSupportSessionId } from "@/lib/support-session";

type HistoryItem = any;

function StatusBadge({ status }: { status: string }) {
  const cls = (() => {
    if (status === "completed") return "bg-green-50 text-green-700 border border-green-200";
    if (status === "failed") return "bg-red-50 text-red-700 border border-red-200";
    if (status === "running" || status === "snapshotting" || status === "queued") return "bg-amber-50 text-amber-700 border border-amber-200";
    return "bg-slate-100 text-slate-700 border border-slate-200";
  })();
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{status}</span>;
}

export function FirmActionHistoryTab({ firmId }: { firmId: number }) {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "maintenance" | "restore" | "approval">("all");
  const [status, setStatus] = useState("");
  const [moduleCode, setModuleCode] = useState("");
  const [actionCode, setActionCode] = useState("");
  const [operationCode, setOperationCode] = useState("");
  const [recordType, setRecordType] = useState("");
  const [recordId, setRecordId] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [approverUserId, setApproverUserId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [before, setBefore] = useState<string | null>(null);
  const [items, setItems] = useState<HistoryItem[]>([]);

  const historyQuery = useQuery({
    queryKey: ["platform-firm-history-v2", firmId, kind, status, moduleCode, actionCode, operationCode, recordType, recordId, requesterEmail, approverUserId, dateFrom, dateTo, before],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (kind !== "all") params.set("kind", kind);
      if (status.trim()) params.set("status", status.trim());
      if (moduleCode.trim()) params.set("module_code", moduleCode.trim());
      if (actionCode.trim()) params.set("action_code", actionCode.trim());
      if (operationCode.trim()) params.set("operation_code", operationCode.trim());
      if (recordType.trim()) params.set("record_type", recordType.trim());
      if (recordId.trim()) params.set("record_id", recordId.trim());
      if (requesterEmail.trim()) params.set("requester_email", requesterEmail.trim());
      if (approverUserId.trim()) params.set("approver_user_id", approverUserId.trim());
      if (dateFrom.trim()) params.set("date_from", dateFrom.trim());
      if (dateTo.trim()) params.set("date_to", dateTo.trim());
      if (before) params.set("before", before);
      return await apiFetchJson<{ items: HistoryItem[]; page_info: { limit: number; has_more: boolean; next_before: string | null } }>(`/platform/firms/${firmId}/history?${params.toString()}`);
    },
    retry: false,
  });

  const supportQuery = useQuery({
    queryKey: ["platform-firm-history-support-session", firmId],
    queryFn: async () => {
      return await apiFetchJson<{ items: any[] }>(`/support-sessions?firmId=${firmId}`);
    },
    enabled: !!firmId,
    retry: false,
  });

  useEffect(() => {
    if (!historyQuery.data) return;
    const next = historyQuery.data.items ?? [];
    setItems((prev) => {
      const base = before ? prev : [];
      const seen = new Set(base.map((it: any) => `${String(it.kind)}:${String(it.id)}`));
      const merged = [...base];
      for (const it of next) {
        const key = `${String((it as any).kind)}:${String((it as any).id)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(it);
      }
      return merged;
    });
  }, [before, historyQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (!q) return true;
      const hay = JSON.stringify(it).toLowerCase();
      return hay.includes(q);
    });
  }, [items, kind, search]);

  const pageInfo = historyQuery.data?.page_info ?? null;
  const storedSupportSessionId = getSupportSessionId();
  const latestSupport = (supportQuery.data?.items ?? [])[0] ?? null;
  const latestStatus = latestSupport?.status ? String(latestSupport.status) : "";
  const latestExpiresAt = latestSupport?.expiresAt ? String(latestSupport.expiresAt) : "";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Action History</CardTitle>
          <div className="flex gap-2 flex-wrap justify-end">
            <Select value={kind} onValueChange={(v) => setKind(v as any)}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="maintenance">Maintenance</SelectItem>
                <SelectItem value="restore">Restore</SelectItem>
                <SelectItem value="approval">Approvals</SelectItem>
              </SelectContent>
            </Select>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search (client-side)..." className="w-56" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-xs text-slate-600 mb-4">
            Support session: {storedSupportSessionId ? <span className="font-mono">#{storedSupportSessionId}</span> : "—"}
            {latestSupport ? (
              <>
                <span className="mx-2">·</span>
                <StatusBadge status={latestStatus || "unknown"} />
                {latestExpiresAt ? <span className="text-xs text-slate-500"> · expires {new Date(latestExpiresAt).toLocaleString()}</span> : null}
              </>
            ) : null}
          </div>
          <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-2">
            <Input value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Status (e.g. completed/failed/requested)" />
            <Input value={moduleCode} onChange={(e) => setModuleCode(e.target.value)} placeholder="Module (e.g. projects/settings)" />
            <Input value={actionCode} onChange={(e) => setActionCode(e.target.value)} placeholder="Action code (maintenance/approval)" />
            <Input value={operationCode} onChange={(e) => setOperationCode(e.target.value)} placeholder="Operation code (restore/rollback)" />
            <Input value={recordType} onChange={(e) => setRecordType(e.target.value)} placeholder="Record type (case/project/developer/settings)" />
            <Input value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="Record id" />
            <Input value={requesterEmail} onChange={(e) => setRequesterEmail(e.target.value)} placeholder="Requester email contains" />
            <Input value={approverUserId} onChange={(e) => setApproverUserId(e.target.value)} placeholder="Approver user id (approvals only)" />
            <Input value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="Date from (ISO)" />
            <Input value={dateTo} onChange={(e) => setDateTo(e.target.value)} placeholder="Date to (ISO)" />
          </div>
          <div className="flex items-center gap-2 mb-4">
            <Button
              variant="outline"
              onClick={() => {
                setBefore(null);
                setItems([]);
                historyQuery.refetch();
              }}
              disabled={historyQuery.isFetching}
            >
              Apply filters
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSearch("");
                setKind("all");
                setStatus("");
                setModuleCode("");
                setActionCode("");
                setOperationCode("");
                setRecordType("");
                setRecordId("");
                setRequesterEmail("");
                setApproverUserId("");
                setDateFrom("");
                setDateTo("");
                setBefore(null);
                setItems([]);
              }}
              disabled={historyQuery.isFetching}
            >
              Reset
            </Button>
          </div>
          {historyQuery.isError ? (
            <QueryFallback title="History unavailable" error={historyQuery.error} onRetry={() => historyQuery.refetch()} isRetrying={historyQuery.isFetching} />
          ) : historyQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading history...</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center">No actions found.</div>
          ) : (
            <div className="rounded border border-slate-200 divide-y">
              {filtered.map((it) => {
                const createdAt = new Date(String(it.createdAt ?? it.created_at ?? Date.now()));
                const risk = (it.riskLevel ?? it.risk_level ?? "low") as RiskLevel;
                const status = String(it.status ?? "");
                const actionType = it.kind === "approval"
                  ? "approval"
                  : it.kind === "restore"
                    ? String(it.operationCode ?? it.operation_code ?? "restore_snapshot")
                    : String(it.actionCode ?? it.action_code ?? "maintenance");
                const label = it.kind === "approval"
                  ? `Approval ${String(it.requestCode ?? it.request_code ?? String(it.id).slice(0, 8))}`
                  : String(it.targetLabel ?? it.target_label ?? it.moduleCode ?? it.module_code ?? actionType);
                const snapshotId = it.preActionSnapshotId ?? it.snapshotId ?? it.preRestoreSnapshotId ?? null;
                const reversible = (() => {
                  if (it.kind === "restore") return !!it.preRestoreSnapshotId || !!it.pre_restore_snapshot_id;
                  if (it.kind === "maintenance") return !!it.preActionSnapshotId || !!it.pre_action_snapshot_id || !!it.requiresSnapshot;
                  return false;
                })();
                const dangerCls = risk === "critical" ? "bg-red-50" : risk === "high" ? "bg-amber-50" : "";
                return (
                  <button
                    key={`${it.kind}:${it.id}`}
                    className={`w-full text-left p-3 hover:bg-slate-50 ${dangerCls}`}
                    onClick={() => setLocation(`/platform/firms/${firmId}/history/${String(it.kind)}/${String(it.id)}`)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900">{label}</span>
                          <RiskBadge level={risk} />
                          <StatusBadge status={status} />
                          <span className="text-xs px-2 py-0.5 rounded border border-slate-200 bg-white text-slate-700">{actionType}</span>
                          <span className={`text-xs px-2 py-0.5 rounded border ${reversible ? "border-green-200 bg-green-50 text-green-800" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
                            {reversible ? "reversible" : "irreversible"}
                          </span>
                          {snapshotId ? <span className="text-xs text-slate-500">snapshot: {String(snapshotId).slice(0, 8)}</span> : null}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {String(it.kind)} · id {String(it.id).slice(0, 8)}
                        </div>
                      </div>
                      <div className="text-xs text-slate-400 shrink-0 text-right">
                        <div>{createdAt.toLocaleDateString()}</div>
                        <div>{createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-4 flex items-center justify-center">
            <Button
              variant="outline"
              onClick={() => {
                const next = pageInfo?.next_before ?? null;
                if (next) setBefore(next);
              }}
              disabled={!pageInfo?.has_more || historyQuery.isFetching}
            >
              {historyQuery.isFetching ? "Loading..." : pageInfo?.has_more ? "Load more" : "No more"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
