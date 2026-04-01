import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Mail, MessageCircle, Phone, FileText, Globe } from "lucide-react";

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

const TYPES = [
  { value: "email", label: "Email", icon: Mail, color: "text-blue-600 bg-blue-50" },
  { value: "whatsapp", label: "WhatsApp", icon: MessageCircle, color: "text-green-600 bg-green-50" },
  { value: "phone", label: "Phone Call", icon: Phone, color: "text-amber-600 bg-amber-50" },
  { value: "letter", label: "Letter", icon: FileText, color: "text-purple-600 bg-purple-50" },
  { value: "portal", label: "Portal", icon: Globe, color: "text-cyan-600 bg-cyan-50" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((t) => [t.value, t]));

export default function CaseCommunicationsTab({ caseId }: { caseId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({
    type: "email",
    direction: "outgoing",
    recipientName: "",
    recipientContact: "",
    subject: "",
    notes: "",
    sentAt: new Date().toISOString().slice(0, 16),
  });

  const { data: comms = [], isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ["case-communications", caseId],
    queryFn: () => apiFetch(`/cases/${caseId}/communications`),
  });

  const addMutation = useMutation({
    mutationFn: (data: object) => apiFetch(`/cases/${caseId}/communications`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case-communications", caseId] });
      qc.invalidateQueries({ queryKey: ["communications"] });
      setAddOpen(false);
      setForm({ type: "email", direction: "outgoing", recipientName: "", recipientContact: "", subject: "", notes: "", sentAt: new Date().toISOString().slice(0, 16) });
      toast({ title: "Communication logged" });
    },
    onError: (err) => toast({ title: "Error", description: String(err), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (commId: number) => apiFetch(`/cases/${caseId}/communications/${commId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case-communications", caseId] });
      qc.invalidateQueries({ queryKey: ["communications"] });
      toast({ title: "Record deleted" });
    },
  });

  function handleAdd() {
    addMutation.mutate({
      type: form.type,
      direction: form.direction,
      recipientName: form.recipientName || undefined,
      recipientContact: form.recipientContact || undefined,
      subject: form.subject || undefined,
      notes: form.notes || undefined,
      sentAt: form.sentAt ? new Date(form.sentAt).toISOString() : undefined,
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle>Communication Log</CardTitle>
          <Button size="sm" className="bg-amber-500 hover:bg-amber-600 gap-1.5" onClick={() => setAddOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            Log Communication
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-slate-500 py-8 text-center">Loading...</div>
          ) : comms.length === 0 ? (
            <div className="text-center py-10 text-slate-500">
              <MessageCircle className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="font-medium text-slate-600 mb-1">No communications logged</p>
              <p className="text-sm">Record emails, WhatsApp messages, phone calls, and letters sent for this case.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {comms.map((comm) => {
                const typeInfo = TYPE_MAP[comm.type as string] ?? TYPE_MAP.email;
                const Icon = typeInfo.icon;
                const sentAt = new Date(comm.sent_at as string ?? comm.created_at as string);
                return (
                  <div key={String(comm.id)} className="flex items-start gap-3 py-3 px-2 rounded-lg hover:bg-slate-50 group">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${typeInfo.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{typeInfo.label}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${comm.direction === "incoming" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
                          {comm.direction === "incoming" ? "Incoming" : "Outgoing"}
                        </span>
                        {comm.subject && <span className="text-sm font-medium text-slate-900">{String(comm.subject)}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-500 flex-wrap">
                        {comm.recipient_name && <span>{String(comm.recipient_name)}</span>}
                        {comm.recipient_contact && <span className="text-slate-400">{String(comm.recipient_contact)}</span>}
                        {comm.notes && <span className="italic truncate max-w-xs">"{String(comm.notes)}"</span>}
                      </div>
                      {comm.logged_by_name && (
                        <div className="text-xs text-slate-400 mt-0.5">Logged by {String(comm.logged_by_name)}</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-slate-600">{sentAt.toLocaleDateString("en-MY")}</div>
                      <div className="text-xs text-slate-400">{sentAt.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-slate-300 hover:text-red-500 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={() => deleteMutation.mutate(Number(comm.id))}
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

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Log Communication</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Channel</Label>
                <Select value={form.type} onValueChange={(v) => setForm(f => ({ ...f, type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Direction</Label>
                <Select value={form.direction} onValueChange={(v) => setForm(f => ({ ...f, direction: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="outgoing">Outgoing</SelectItem>
                    <SelectItem value="incoming">Incoming</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Subject / Purpose <span className="text-slate-400 text-xs">(optional)</span></Label>
              <Input placeholder="e.g. SPA Stamping Receipt Sent" value={form.subject} onChange={(e) => setForm(f => ({ ...f, subject: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Recipient Name <span className="text-slate-400 text-xs">(optional)</span></Label>
                <Input placeholder="e.g. Lee Chong Wei" value={form.recipientName} onChange={(e) => setForm(f => ({ ...f, recipientName: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Contact <span className="text-slate-400 text-xs">(optional)</span></Label>
                <Input placeholder="e.g. +6012-3456789" value={form.recipientContact} onChange={(e) => setForm(f => ({ ...f, recipientContact: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes <span className="text-slate-400 text-xs">(optional)</span></Label>
              <Textarea placeholder="Brief notes about this communication..." value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} className="resize-none text-sm" rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label>Date & Time</Label>
              <Input type="datetime-local" value={form.sentAt} onChange={(e) => setForm(f => ({ ...f, sentAt: e.target.value }))} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleAdd} disabled={addMutation.isPending}>
                {addMutation.isPending ? "Saving..." : "Log"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
