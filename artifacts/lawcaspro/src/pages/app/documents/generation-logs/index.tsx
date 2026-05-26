import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { ScrollText, Search } from "lucide-react";

type LogItem = {
  id: number;
  userId: number;
  userName: string | null;
  actionType: string;
  caseId: number | null;
  caseIds: unknown;
  fileNames: unknown;
  generatedFiles: unknown;
  printCopies: number | null;
  createdAt: string;
};

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [];
}

function asNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === "number" ? x : (typeof x === "string" ? Number(x) : NaN);
    if (Number.isFinite(n)) out.push(Math.trunc(n));
  }
  return out;
}

function labelAction(actionType: string): string {
  if (actionType === "download" || actionType === "download_zip") return "Download";
  if (actionType === "print" || actionType === "system_print") return "Print";
  return actionType || "Unknown";
}

export default function DocumentGenerationLogsPage() {
  const [actionFilter, setActionFilter] = useState("all");
  const [search, setSearch] = useState("");

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "100");
    if (actionFilter !== "all") p.set("actionType", actionFilter);
    if (search.trim()) p.set("search", search.trim());
    return p;
  }, [actionFilter, search]);

  const logsQuery = useQuery<{ items: LogItem[]; total: number }>({
    queryKey: ["document-generation-logs", actionFilter, search],
    queryFn: () => apiFetchJson(`/document-generation-logs?${params.toString()}`),
    retry: false,
  });

  const items = logsQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Document Generation Logs</h1>
        <p className="text-slate-500 mt-1">Track downloads, batch exports, and system prints</p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search by user, action, or filename..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All Actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            <SelectItem value="download">Download</SelectItem>
            <SelectItem value="print">Print</SelectItem>
            <SelectItem value="download_zip">Download (Legacy)</SelectItem>
            <SelectItem value="system_print">Print (Legacy)</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-slate-500 shrink-0">
          {logsQuery.data?.total ?? 0} total events
        </span>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="w-4 h-4 text-slate-400" />
            Activity Log
          </CardTitle>
        </CardHeader>
        <CardContent>
          {logsQuery.isError ? (
            <QueryFallback title="Document generation logs unavailable" error={logsQuery.error} onRetry={() => logsQuery.refetch()} isRetrying={logsQuery.isFetching} />
          ) : logsQuery.isLoading ? (
            <div className="text-slate-500 py-8 text-center">Loading logs...</div>
          ) : items.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <ScrollText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="font-medium text-slate-600 mb-1">No generation events recorded yet</p>
              <p className="text-sm">Successful downloads and system prints will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {items.map((log) => {
                const createdAt = new Date(log.createdAt);
                const caseIds = asNumberArray(log.caseIds);
                const fileNames = asStringArray(log.fileNames);
                const displayFiles = fileNames.slice(0, 4);
                const extraCount = Math.max(0, fileNames.length - displayFiles.length);
                const actor = log.userName?.trim() ? log.userName.trim() : `User #${log.userId}`;

                return (
                  <div key={String(log.id)} className="py-3 flex items-start gap-3">
                    <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-slate-300 mt-2.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-slate-100 text-slate-700">
                          {labelAction(log.actionType)}
                        </span>
                        <span className="text-xs text-slate-500">
                          {caseIds.length ? `${caseIds.length} case(s)` : (log.caseId ? `case #${log.caseId}` : "no case")}
                        </span>
                        {typeof log.printCopies === "number" && log.printCopies > 0 ? (
                          <span className="text-xs text-slate-500">
                            {log.printCopies} copies
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400">
                        <span className="font-medium text-slate-600">{actor}</span>
                      </div>
                      {displayFiles.length ? (
                        <div className="mt-1 text-xs text-slate-500 break-words">
                          {displayFiles.join(" · ")}{extraCount ? ` · +${extraCount} more` : ""}
                        </div>
                      ) : null}
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

