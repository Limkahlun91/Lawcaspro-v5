import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation, useSearch } from "wouter";
import { MessageCircle, ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

const TYPE_LABELS: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  phone: "Phone",
  letter: "Letter",
  portal: "Portal",
  message: "Message",
};

export default function Communications() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const searchString = useSearch();
  const params = useMemo(() => new URLSearchParams(searchString), [searchString]);
  const since = params.get("since") ?? undefined;
  const typeFromUrl = params.get("type") ?? undefined;
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    const next = typeFromUrl && Object.keys(TYPE_LABELS).includes(typeFromUrl) ? typeFromUrl : "all";
    setTypeFilter(next);
  }, [typeFromUrl]);

  const { data: unread } = useQuery<{ count: number }>({
    queryKey: ["communications-unread-count"],
    queryFn: () => apiFetch("/communications/unread-count"),
    retry: false,
  });

  const { data: comms = [], isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ["communications", typeFilter, since],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (typeFilter !== "all") qs.set("type", typeFilter);
      if (since) qs.set("since", since);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiFetch(`/communications${suffix}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ caseId, threadId }: { caseId: number; threadId: number }) =>
      apiFetch(`/cases/${caseId}/threads/${threadId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communications"] });
      toast({ title: "Record deleted" });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: String(e?.message ?? e), variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Communications Hub</h1>
          <p className="text-slate-500 mt-1">Thread list across cases</p>
          <p className="text-xs text-slate-400 mt-1">
            Unread threads: {unread?.count ?? 0}{since === "this_month" ? " · Filter: This month" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={(v) => {
            setTypeFilter(v);
            const next = new URLSearchParams(searchString);
            if (v === "all") next.delete("type"); else next.set("type", v);
            setLocation(`/app/communications${next.toString() ? `?${next.toString()}` : ""}`);
          }}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Channels</SelectItem>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="text-slate-500 py-8 text-center">Loading...</div>
          ) : comms.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <MessageCircle className="w-10 h-10 text-slate-300 mx-auto mb-3" />
              <p className="font-medium text-slate-600 mb-1">No threads found</p>
              <p className="text-sm">Open a case and create a communication thread to start logging messages.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {comms.map((t) => {
                const lastAtRaw = (t.last_message_at ?? t.updated_at ?? t.created_at) as string | undefined;
                const lastAt = lastAtRaw ? new Date(lastAtRaw) : null;
                const unreadCount = Number(t.unread_count ?? 0);
                const messageCount = Number(t.message_count ?? 0);
                return (
                  <div
                    key={String(t.id)}
                    className="flex items-start gap-3 py-3 px-2 rounded-lg hover:bg-slate-50 group cursor-pointer"
                    onClick={() => setLocation(`/app/communications/${t.id}`)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-900 truncate">{String(t.subject ?? "Untitled thread")}</span>
                        {String(t.reference_no ?? "").trim() ? (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{String(t.reference_no)}</span>
                        ) : null}
                        {unreadCount > 0 ? (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{unreadCount} unread</span>
                        ) : (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">read</span>
                        )}
                        <span className="text-xs text-slate-400">{messageCount} msg</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-500">
                        {t.last_message ? <span className="truncate max-w-[520px] italic">"{String(t.last_message)}"</span> : <span className="text-slate-400">No messages yet</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-slate-500">{lastAt ? lastAt.toLocaleDateString("en-MY") : "—"}</div>
                      <div className="text-xs text-slate-400">{lastAt ? lastAt.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" }) : ""}</div>
                    </div>
                    <div
                      className="shrink-0 cursor-pointer text-slate-400 hover:text-amber-600 flex items-center gap-1 text-xs"
                      onClick={(e) => { e.stopPropagation(); setLocation(`/app/cases/${t.case_id}`); }}
                    >
                      <span className="hidden group-hover:inline">Open case</span>
                      <ChevronRight className="w-4 h-4" />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-slate-300 hover:text-red-500 shrink-0"
                      onClick={(e) => { e.stopPropagation(); deleteMutation.mutate({ caseId: Number(t.case_id), threadId: Number(t.id) }); }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
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
