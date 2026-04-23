import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { RiskBadge, type RiskLevel } from "@/components/risk-badge";
import { useAuth } from "@/lib/auth-context";
import { hasFounderPermission } from "@/lib/founder-permissions";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";

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
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "maintenance" | "restore" | "approval">("all");
  const [selected, setSelected] = useState<HistoryItem | null>(null);

  const historyQuery = useQuery({
    queryKey: ["platform-firm-history", firmId],
    queryFn: async () => {
      const res = await apiFetchJson(`/platform/firms/${firmId}/maintenance/history?limit=100`);
      return unwrapApiData<{ items: HistoryItem[] }>(res);
    },
    retry: false,
  });

  const items = historyQuery.data?.items ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (kind !== "all" && String(it.kind) !== kind) return false;
      if (!q) return true;
      const hay = JSON.stringify(it).toLowerCase();
      return hay.includes(q);
    });
  }, [items, kind, search]);

  const approveMutation = useMutation({
    mutationFn: async (payload: { id: string; note?: string }) => {
      const res = await apiFetchJson(`/platform/approvals/${payload.id}/approve`, { method: "POST", body: JSON.stringify({ note: payload.note ?? "" }) });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      toast({ title: "Approved" });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history", firmId] });
      if (selected?.id) setSelected({ ...selected });
    },
    onError: (e) => toastError(toast, e, "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: async (payload: { id: string; note?: string }) => {
      const res = await apiFetchJson(`/platform/approvals/${payload.id}/reject`, { method: "POST", body: JSON.stringify({ note: payload.note ?? "" }) });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      toast({ title: "Rejected" });
      await qc.invalidateQueries({ queryKey: ["platform-firm-history", firmId] });
      if (selected?.id) setSelected({ ...selected });
    },
    onError: (e) => toastError(toast, e, "Reject failed"),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Action History</CardTitle>
          <div className="flex gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as any)}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="maintenance">Maintenance</SelectItem>
                <SelectItem value="restore">Restore</SelectItem>
                <SelectItem value="approval">Approvals</SelectItem>
              </SelectContent>
            </Select>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." className="w-56" />
          </div>
        </CardHeader>
        <CardContent>
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
                const action = it.kind === "approval"
                  ? `Approval ${String(it.requestCode ?? it.request_code ?? String(it.id).slice(0, 8))}`
                  : String(it.actionCode ?? it.action_code ?? it.restoreScopeType ?? "action");
                const snapshotId = it.preActionSnapshotId ?? it.snapshotId ?? null;
                return (
                  <button key={`${it.kind}:${it.id}`} className="w-full text-left p-3 hover:bg-slate-50" onClick={() => setSelected(it)}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900">{action}</span>
                          <RiskBadge level={risk} />
                          <StatusBadge status={status} />
                          {snapshotId ? <span className="text-xs text-slate-500">snapshot: {String(snapshotId).slice(0, 8)}</span> : null}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {String(it.targetLabel ?? it.target_label ?? it.moduleCode ?? it.module_code ?? "")}
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
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Action Detail</DialogTitle>
          </DialogHeader>
          {selected?.kind === "approval" ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-slate-700">
                Status: <span className="font-medium">{String(selected.status)}</span>
              </div>
              {String(selected.status) === "requested" ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={!hasFounderPermission(user, "founder.approval.approve") || approveMutation.isPending}
                    onClick={() => approveMutation.mutate({ id: String(selected.id), note: "" })}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!hasFounderPermission(user, "founder.approval.reject") || rejectMutation.isPending}
                    onClick={() => rejectMutation.mutate({ id: String(selected.id), note: "" })}
                  >
                    Reject
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <pre className="text-xs whitespace-pre-wrap break-words text-slate-700">{JSON.stringify(selected, null, 2)}</pre>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
