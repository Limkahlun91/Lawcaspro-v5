import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation } from "wouter";
import { Mail, MessageCircle, Phone, FileText, Globe, ChevronRight, Trash2 } from "lucide-react";
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

const TYPE_ICONS: Record<string, React.ElementType> = {
  email: Mail,
  whatsapp: MessageCircle,
  phone: Phone,
  letter: FileText,
  portal: Globe,
};

const TYPE_COLORS: Record<string, string> = {
  email: "text-blue-600 bg-blue-50",
  whatsapp: "text-green-600 bg-green-50",
  phone: "text-amber-600 bg-amber-50",
  letter: "text-purple-600 bg-purple-50",
  portal: "text-cyan-600 bg-cyan-50",
};

const TYPE_LABELS: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  phone: "Phone",
  letter: "Letter",
  portal: "Portal",
};

export default function Communications() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState("all");

  const { data: comms = [], isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ["communications", typeFilter],
    queryFn: () => apiFetch(`/communications${typeFilter !== "all" ? `?type=${typeFilter}` : ""}`),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ caseId, commId }: { caseId: number; commId: number }) =>
      apiFetch(`/cases/${caseId}/communications/${commId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["communications"] });
      toast({ title: "Record deleted" });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Communications Hub</h1>
          <p className="text-slate-500 mt-1">Log of all client and third-party communications across cases</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
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
              <p className="font-medium text-slate-600 mb-1">No communications logged yet</p>
              <p className="text-sm">Open a case and go to the Communications tab to log emails, WhatsApp messages, phone calls, and letters.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {comms.map((comm) => {
                const Icon = TYPE_ICONS[comm.type as string] ?? Mail;
                const colorClass = TYPE_COLORS[comm.type as string] ?? "text-slate-600 bg-slate-100";
                const sentAt = comm.sent_at ? new Date(comm.sent_at as string) : new Date(comm.created_at as string);
                return (
                  <div key={String(comm.id)} className="flex items-start gap-3 py-3 px-2 rounded-lg hover:bg-slate-50 group">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${colorClass}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{TYPE_LABELS[comm.type as string] ?? comm.type}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 capitalize">{String(comm.direction)}</span>
                        {comm.subject && <span className="text-sm font-medium text-slate-900 truncate">{String(comm.subject)}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-500">
                        {comm.recipient_name && <span>To: {String(comm.recipient_name)}</span>}
                        {comm.recipient_contact && <span>{String(comm.recipient_contact)}</span>}
                        {comm.notes && <span className="truncate max-w-[300px] italic">"{String(comm.notes)}"</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-slate-500">{sentAt.toLocaleDateString("en-MY")}</div>
                      <div className="text-xs text-slate-400">{sentAt.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                    <div
                      className="shrink-0 cursor-pointer text-slate-400 hover:text-amber-600 flex items-center gap-1 text-xs"
                      onClick={() => setLocation(`/app/cases/${comm.case_id}`)}
                    >
                      <span className="hidden group-hover:inline">{String(comm.reference_no)}</span>
                      <ChevronRight className="w-4 h-4" />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-slate-300 hover:text-red-500 shrink-0"
                      onClick={() => deleteMutation.mutate({ caseId: Number(comm.case_id), commId: Number(comm.id) })}
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
