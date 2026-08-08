import { useMemo, useState } from "react";
import { hasPermission } from "@/lib/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Bell,
  AlertTriangle,
  Clock,
  CheckCircle,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import type { NotifRow } from "./mobile-dock";

function relativeTime(dateStr: string | Date | null | undefined): string {
  if (!dateStr) return "";
  const now = Date.now();
  const then = typeof dateStr === "string" ? new Date(dateStr).getTime() : dateStr.getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const wk = Math.floor(d / 7);
  if (wk < 8) return `${wk}w`;
  const mo = Math.floor(d / 30);
  if (mo < 24) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

function severityBadgeVariant(sev: string): "default" | "secondary" | "destructive" | "outline" {
  switch (sev) {
    case "critical": return "destructive";
    case "urgent": return "destructive";
    case "high": return "default";
    case "normal": return "secondary";
    case "info": return "outline";
    default: return "secondary";
  }
}

export function PartnerAlertSheet({ user }: { user: { roleName?: string } | null | undefined }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isPartner = useMemo(() => !!user?.roleName && String(user.roleName).trim().toLowerCase() === "partner", [user?.roleName]);
  const canResolve = isPartner || hasPermission(user as any, "case_monitor", "manage") || hasPermission(user as any, "accounting", "read");
  const [notifMobileFilter, setNotifMobileFilter] = useState<"escalated" | "overdue" | "urgent" | "all">("escalated");
  const [ackTarget, setAckTarget] = useState<{ id: number; title: string } | null>(null);
  const [resolveTarget, setResolveTarget] = useState<{ id: number; title: string; note: string } | null>(null);

  const notifListQuery = useQuery({
    queryKey: ["user-notifications", "escalation-feed-mobile", notifMobileFilter],
    queryFn: async () => {
      try {
        const p = new URLSearchParams();
        if (notifMobileFilter === "escalated") p.set("only_escalated", "1");
        if (notifMobileFilter === "overdue") { p.set("only_overdue", "1"); p.set("only_active", "1"); }
        if (notifMobileFilter === "urgent") { p.set("severity", "urgent"); p.set("only_active", "1"); }
        p.set("limit", "50");
        const base = await apiFetchJson<{ items: NotifRow[] }>(`/user-notifications?${p.toString()}`).catch(() => ({ items: [] as NotifRow[] }));
        const summary = await apiFetchJson<{ unread: number; urgent: number; escalated: number; overdue: number }>("/user-notifications/escalation-feed").catch(() => ({ unread: 0, urgent: 0, escalated: 0, overdue: 0 }));
        return { items: base.items as NotifRow[], stats: { critical: Number(summary.urgent ?? 0), overdue: Number(summary.overdue ?? 0), escalated: Number(summary.escalated ?? 0) } };
      } catch {
        return { items: [] as NotifRow[], stats: { critical: 0, overdue: 0, escalated: 0 } };
      }
    },
    staleTime: 20_000,
    refetchInterval: 45_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const ackMut = useMutation({
    mutationFn: (id: number) => fetch(`/api/user-notifications/${id}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: async (_, id) => { toast({ title: "Acknowledged", description: `#${id}` }); setAckTarget(null); await qc.invalidateQueries({ queryKey: ["user-notifications"] }); },
    onError: (e) => toast({ title: "Acknowledge failed", description: String(e), variant: "destructive" }),
  });
  const resolveMut = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => fetch(`/api/user-notifications/${id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ note }) }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: async (_, { id }) => { toast({ title: "Resolved", description: `#${id}` }); setResolveTarget(null); await qc.invalidateQueries({ queryKey: ["user-notifications"] }); },
    onError: (e) => toast({ title: "Resolve failed", description: String(e), variant: "destructive" }),
  });

  return (
    <section className="md:hidden border-b border-slate-200 bg-white" aria-label="Partner alerts feed">
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Bell className="w-4 h-4 text-slate-700" aria-hidden /> Escalation feed
            {isPartner ? <Badge variant="outline" className="text-[10px] text-blue-700 border-blue-300 bg-blue-50">PARTNER</Badge> : null}
          </h2>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Critical {notifListQuery.data?.stats.critical ?? "—"} · Overdue {notifListQuery.data?.stats.overdue ?? "—"} · Escalated {notifListQuery.data?.stats.escalated ?? "—"}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void qc.invalidateQueries({ queryKey: ["user-notifications"] })} aria-label="Refresh alerts">Refresh</Button>
      </div>
      <div role="tablist" aria-label="Alert filters" className="px-3 pb-2 flex flex-wrap gap-1.5">
        {(["escalated","overdue","urgent","all"] as const).map(k => {
          const map: Record<typeof k,string> = { escalated: "Escalated", overdue: "Overdue", urgent: "Urgent+", all: "All active" };
          const active = notifMobileFilter === k;
          return (
            <button key={k} type="button" role="tab" aria-selected={active} onClick={() => setNotifMobileFilter(k)}
                    id={`partner-filter-${k}`}
                    aria-controls={`partner-panel-${k}`}
                    className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold border ${active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}`}>
              {map[k]}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`partner-panel-${notifMobileFilter}`} aria-labelledby={`partner-filter-${notifMobileFilter}`} className="pb-3 px-3 space-y-2 max-h-[62vh] overflow-y-auto">
        {notifListQuery.isLoading ? <div className="text-xs text-slate-500 p-4 text-center">Loading…</div> :
          (notifListQuery.data?.items ?? []).length === 0 ? <div className="text-xs text-slate-500 p-6 text-center flex flex-col items-center gap-1.5"><CheckCircle className="w-7 h-7 text-emerald-600" aria-hidden /><span className="font-medium text-slate-700">All caught up</span><span>No items match the selected filter.</span></div> :
          (notifListQuery.data!.items.map((n) => {
            const terminal = n.status === "dismissed" || n.status === "resolved" || n.status === "auto_resolved";
            const bg = n.status === "escalated" ? "bg-rose-50/60 border-rose-200" : n.isOverdue ? "bg-orange-50/60 border-orange-200" : "bg-white border-slate-200";
            return (
              <article key={n.id} className={`rounded-xl border p-3 shadow-sm ${bg}`} aria-label={n.title}>
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 shrink-0" aria-hidden>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center ${n.severityRank >= 3 ? "bg-red-100 text-red-700" : n.severityRank >= 2 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                      {n.severityRank >= 3 ? <AlertTriangle className="w-3.5 h-3.5" /> : n.severityRank >= 2 ? <Clock className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className={`text-sm ${n.isRead ? "font-medium text-slate-800" : "font-semibold text-slate-900"}`}>{n.title}</div>
                        {n.message ? <div className="text-[11px] text-slate-600 mt-0.5 whitespace-pre-wrap break-words line-clamp-3">{n.message}</div> : null}
                        <div className="flex flex-wrap items-center gap-1 mt-1.5">
                          <Badge variant={severityBadgeVariant(n.severity) as "default"} className="text-[9px] uppercase">{n.severity}</Badge>
                          {n.status === "escalated" ? <Badge variant="destructive" className="text-[9px]">ESC</Badge> : null}
                          {n.isOverdue ? <Badge variant="default" className="bg-orange-600 text-white text-[9px]">OVERDUE</Badge> : null}
                          {!n.dismissible ? <Badge variant="outline" className="text-[9px] border-slate-400 text-slate-700">NON-DISMISS</Badge> : null}
                          {n.status === "acknowledged" ? <Badge variant="secondary" className="text-[9px]">ACK</Badge> : null}
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1">{relativeTime(n.createdAt)} ago · {n.notificationType.replace(/_/g, " ")}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button size="sm" variant="outline" disabled={ackMut.isPending || terminal || n.status === "acknowledged"} className="h-7 px-2.5 text-[11px]" onClick={() => setAckTarget({ id: n.id, title: n.title })}>
                        1-tap Acknowledge
                      </Button>
                      {canResolve ? (
                        <Button size="sm" variant="default" className="h-7 px-2.5 text-[11px] bg-slate-900 hover:bg-slate-800" disabled={resolveMut.isPending || terminal} onClick={() => setResolveTarget({ id: n.id, title: n.title, note: "" })}>
                          Resolve
                        </Button>
                      ) : null}
                      {(n.sourceType === "payment_voucher" && n.sourceId) ? (
                        <Link className="text-[11px] underline text-blue-700 px-1.5" href={`/app/accounting?tab=payment-vouchers&pv=${n.sourceId}`}>Open PV</Link>
                      ) : null}
                      {(n.sourceType === "case" && n.caseId) ? (
                        <Link className="text-[11px] underline text-blue-700 px-1.5" href={`/app/cases/${n.caseId}`}>Open Case</Link>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            );
          }))
        }
      </div>

      <Dialog open={ackTarget != null} onOpenChange={(v) => { if (!v) setAckTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Acknowledge notification</DialogTitle>
            <DialogDescription>
              {ackTarget?.title ? <span className="font-medium text-slate-700">{ackTarget.title}</span> : null}
            </DialogDescription>
          </DialogHeader>
          <div className="text-xs text-slate-500">Tap confirm to mark this item as acknowledged. This action is audited.</div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setAckTarget(null)}>Cancel</Button>
            <Button size="sm" disabled={ackTarget == null || ackMut.isPending} onClick={() => ackMut.mutate(ackTarget!.id)}>{ackMut.isPending ? "Saving…" : "Confirm acknowledge"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resolveTarget != null} onOpenChange={(v) => { if (!v) setResolveTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve escalation</DialogTitle>
            <DialogDescription>
              {resolveTarget?.title ? <span className="font-medium text-slate-700">{resolveTarget.title}</span> : null}
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="w-full min-h-[96px] rounded-md border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 mt-1"
            placeholder="Resolution note (3 - 1000 chars)…"
            maxLength={1000}
            value={resolveTarget?.note ?? ""}
            onChange={(e) => setResolveTarget((prev) => prev ? { ...prev, note: e.target.value } : prev)}
          />
          <div className="text-[11px] text-slate-500 mt-1">Partner-locked escalation (AUTO_ONLY) can only be resolved once the underlying payment voucher is paid or completed.</div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setResolveTarget(null)}>Cancel</Button>
            <Button
              size="sm"
              disabled={resolveTarget == null || resolveMut.isPending || (resolveTarget?.note.trim().length ?? 0) < 3}
              onClick={() => resolveTarget && resolveMut.mutate({ id: resolveTarget.id, note: resolveTarget.note.trim() })}
            >{resolveMut.isPending ? "Saving…" : "Confirm resolve"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
