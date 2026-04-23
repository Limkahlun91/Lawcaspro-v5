import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollText, Search } from "lucide-react";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";

const ACTION_LABELS: Record<string, string> = {
  case_created: "Case Created",
  case_updated: "Case Updated",
  workflow_step_completed: "Workflow Step Completed",
  document_generated: "Document Generated",
  document_uploaded: "Document Uploaded",
  note_added: "Note Added",
  login: "Login",
  logout: "Logout",
};

const ACTION_COLORS: Record<string, string> = {
  case_created: "bg-green-50 text-green-700",
  case_updated: "bg-blue-50 text-blue-700",
  workflow_step_completed: "bg-amber-50 text-amber-700",
  document_generated: "bg-purple-50 text-purple-700",
  document_uploaded: "bg-purple-50 text-purple-700",
  note_added: "bg-slate-100 text-slate-600",
  login: "bg-teal-50 text-teal-700",
  logout: "bg-slate-100 text-slate-500",
};

export default function PlatformAuditLogs() {
  const [search, setSearch] = useState("");
  const [firmFilter, setFirmFilter] = useState("all");

  const firmsQuery = useQuery<{ data: Record<string, unknown>[] }>({
    queryKey: ["platform-firms-audit"],
    queryFn: () => apiFetchJson("/platform/firms?limit=100"),
    retry: false,
  });
  const firms = firmsQuery.data?.data ?? [];

  const params = new URLSearchParams({ limit: "150", includeTotal: "0" });
  if (firmFilter !== "all") params.set("firmId", firmFilter);

  const logsQuery = useQuery<{ items: Record<string, unknown>[]; total?: number; pagination?: { limit: number; has_more: boolean; next_cursor: string | null } } | { data: Record<string, unknown>[]; total: number }>({
    queryKey: ["platform-audit-logs", firmFilter],
    queryFn: async () => {
      const res = await apiFetchJson(`/platform/audit-logs?${params.toString()}`);
      return unwrapApiData(res);
    },
    retry: false,
  });
  const { data, isLoading } = logsQuery;

  const rawLogs = (data as any)?.items ?? (data as any)?.data ?? [];
  const logs = (rawLogs as Record<string, unknown>[]).filter((log) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      String(log.actor_name ?? "").toLowerCase().includes(q) ||
      String(log.firm_name ?? "").toLowerCase().includes(q) ||
      String(log.action ?? "").toLowerCase().includes(q) ||
      String(log.entity_id ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Platform Audit Logs</h1>
        <p className="text-slate-500 mt-1">Cross-tenant security and activity events across all firms</p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search by user, firm, or action..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={firmFilter} onValueChange={setFirmFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All Firms" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Firms</SelectItem>
            {firms.map((f) => (
              <SelectItem key={String(f.id)} value={String(f.id)}>{String(f.name)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-slate-500 shrink-0">{(data as any)?.total ?? "—"} total events</span>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="w-4 h-4 text-slate-400" />
            Global Activity Log
          </CardTitle>
        </CardHeader>
        <CardContent>
          {logsQuery.isError ? (
            <QueryFallback title="Audit logs unavailable" error={logsQuery.error} onRetry={() => logsQuery.refetch()} isRetrying={logsQuery.isFetching} />
          ) : isLoading ? (
            <div className="text-slate-500 py-8 text-center">Loading audit logs...</div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <ScrollText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="font-medium text-slate-600 mb-1">No activity recorded yet</p>
              <p className="text-sm">User actions within firm workspaces (case creation, workflow updates, document generation) will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {logs.map((log: any) => {
                const action = String(log.action ?? "");
                const createdAt = new Date(log.created_at as string);
                let detail: Record<string, unknown> = {};
                try {
                  detail = typeof log.detail === "string" ? JSON.parse(log.detail) : ((log.detail as Record<string, unknown>) ?? {});
                } catch { detail = {}; }

                return (
                  <div key={String(log.id)} className="py-3 flex items-start gap-3">
                    <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-slate-300 mt-2.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ACTION_COLORS[action] ?? "bg-slate-100 text-slate-600"}`}>
                          {ACTION_LABELS[action] ?? action}
                        </span>
                        {log.firm_name && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                            {String(log.firm_name)}
                          </span>
                        )}
                        {log.entity_type && (
                          <span className="text-xs text-slate-500">
                            {String(log.entity_type)} {log.entity_id ? `#${log.entity_id}` : ""}
                          </span>
                        )}
                        {detail.referenceNo && (
                          <span className="text-xs font-medium text-amber-600">{String(detail.referenceNo)}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400">
                        <span className="font-medium text-slate-600">{String(log.actor_name ?? "System")}</span>
                        {log.actor_email && <span>{String(log.actor_email)}</span>}
                        {log.ip_address && <span>from {String(log.ip_address)}</span>}
                      </div>
                    </div>
                    <div className="text-right text-xs text-slate-400 shrink-0">
                      <div>{createdAt.toLocaleDateString("en-MY")}</div>
                      <div>{createdAt.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
