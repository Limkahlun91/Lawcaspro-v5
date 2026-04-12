import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Clock, DollarSign, TrendingUp } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function CaseTimeTab({ caseId }: { caseId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    entryDate: new Date().toISOString().slice(0, 10),
    description: "",
    hours: "",
    ratePerHour: "500",
    isBillable: true,
  });

  const entriesQuery = useQuery({
    queryKey: ["time-entries", caseId],
    queryFn: () => apiFetchJson(`/time-entries?caseId=${caseId}`),
    retry: false,
  });
  const entries = (entriesQuery.data ?? []) as any[];

  const summaryQuery = useQuery({
    queryKey: ["time-summary", caseId],
    queryFn: () => apiFetchJson(`/time-entries/summary?caseId=${caseId}`),
    retry: false,
  });
  const summary = summaryQuery.data as any;

  const createEntry = useMutation({
    mutationFn: async (body: any) =>
      apiFetchJson(`/time-entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, caseId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["time-entries", caseId] });
      qc.invalidateQueries({ queryKey: ["time-summary", caseId] });
      setShowAdd(false);
      setForm({ entryDate: new Date().toISOString().slice(0, 10), description: "", hours: "", ratePerHour: "500", isBillable: true });
      toast({ title: "Time entry recorded" });
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  const deleteEntry = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/time-entries/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["time-entries", caseId] });
      qc.invalidateQueries({ queryKey: ["time-summary", caseId] });
      toast({ title: "Entry deleted" });
    },
    onError: (e) => toastError(toast, e, "Delete failed"),
  });

  const amount = (Number(form.hours) || 0) * (Number(form.ratePerHour) || 0);

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Hours", value: `${Number(summary?.totalHours ?? 0).toFixed(1)} hrs`, icon: Clock, color: "text-blue-600" },
          { label: "Billable Hours", value: `${Number(summary?.billableHours ?? 0).toFixed(1)} hrs`, icon: TrendingUp, color: "text-green-600" },
          { label: "Total Value", value: fmt(summary?.totalAmount), icon: DollarSign, color: "text-amber-600" },
          { label: "Unbilled", value: fmt(summary?.unbilledAmount), icon: DollarSign, color: "text-red-600" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="border-slate-200">
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-2 mb-1">
                <Icon className={`h-4 w-4 ${color}`} />
                <span className="text-xs text-slate-500">{label}</span>
              </div>
              <p className={`text-lg font-bold ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex justify-end">
        <Button size="sm" className="bg-[#f5a623] hover:bg-amber-500 text-white h-8" onClick={() => setShowAdd(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Log Time
        </Button>
      </div>

      {entriesQuery.isError ? (
        <QueryFallback title="Time entries unavailable" error={entriesQuery.error} onRetry={() => { entriesQuery.refetch(); summaryQuery.refetch(); }} isRetrying={entriesQuery.isFetching || summaryQuery.isFetching} />
      ) : entriesQuery.isLoading ? (
        <div className="text-sm text-slate-400 py-8 text-center">Loading time entries...</div>
      ) : entries.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-slate-400 text-sm">
          <Clock className="h-8 w-8 mx-auto mb-2 text-slate-300" />
          No time entries. Start logging billable hours for this matter.
        </CardContent></Card>
      ) : (
        <Card className="border-slate-200">
          <CardHeader className="py-3 px-4 border-b"><CardTitle className="text-sm font-medium text-slate-700">Time Entries</CardTitle></CardHeader>
          <div className="divide-y divide-slate-100">
            {entries.map((e: any) => (
              <div key={e.id} className="flex items-start gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs text-slate-500">{e.entryDate}</span>
                    <Badge variant="outline" className={`text-xs border-0 ${e.isBillable ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
                      {e.isBillable ? "Billable" : "Non-billable"}
                    </Badge>
                    {e.isBilled && <Badge variant="outline" className="text-xs border-0 bg-blue-100 text-blue-700">Billed</Badge>}
                  </div>
                  <p className="text-sm text-slate-800">{e.description}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-medium text-slate-800">{Number(e.hours).toFixed(1)} hrs</p>
                  <p className="text-xs text-slate-500">{fmt(Number(e.hours) * Number(e.ratePerHour))}</p>
                  <p className="text-xs text-slate-400">@ RM {Number(e.ratePerHour).toFixed(0)}/hr</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-slate-400 hover:text-red-500 flex-shrink-0"
                  onClick={() => { if (!confirm("Delete this time entry?")) return; deleteEntry.mutate(e.id); }}
                  disabled={deleteEntry.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Log Time</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Date *</Label>
              <Input type="date" value={form.entryDate} onChange={e => setForm(f => ({ ...f, entryDate: e.target.value }))} className="mt-1 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Description *</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} className="mt-1 text-sm" placeholder="e.g. Review of SPA and loan documents" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Hours *</Label>
                <Input type="number" min="0.1" step="0.25" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} className="mt-1 text-sm" placeholder="1.5" />
              </div>
              <div>
                <Label className="text-xs">Rate / hr (RM)</Label>
                <Input type="number" min="0" step="50" value={form.ratePerHour} onChange={e => setForm(f => ({ ...f, ratePerHour: e.target.value }))} className="mt-1 text-sm" />
              </div>
            </div>
            {form.hours && Number(form.hours) > 0 && (
              <p className="text-xs text-slate-500">Amount: <span className="font-medium text-slate-800">{fmt(amount)}</span></p>
            )}
            <div className="flex items-center gap-2">
              <Switch checked={form.isBillable} onCheckedChange={v => setForm(f => ({ ...f, isBillable: v }))} />
              <Label className="text-sm">Billable</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button className="bg-[#f5a623] hover:bg-amber-500 text-white" onClick={() => createEntry.mutate(form)} disabled={!form.description || !form.hours || createEntry.isPending}>
              {createEntry.isPending ? "Saving..." : "Log Time"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
