import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, CheckCircle2, Circle, DollarSign } from "lucide-react";

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

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  legal_fee: "Legal Fees",
  disbursement: "Disbursements",
  stamp_duty: "Stamp Duty",
  professional_fee: "Professional Fees",
  other: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  legal_fee: "bg-amber-100 text-amber-800",
  disbursement: "bg-blue-100 text-blue-800",
  stamp_duty: "bg-green-100 text-green-800",
  professional_fee: "bg-purple-100 text-purple-800",
  other: "bg-slate-100 text-slate-600",
};

export default function CaseBillingTab({ caseId }: { caseId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ category: "disbursement", description: "", amount: "", quantity: "1" });

  const { data: entries = [], isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ["case-billing", caseId],
    queryFn: () => apiFetch(`/cases/${caseId}/billing`),
  });

  const { data: summary } = useQuery<{ byCategory: Record<string, unknown>[]; overall: Record<string, unknown> }>({
    queryKey: ["case-billing-summary", caseId],
    queryFn: () => apiFetch(`/cases/${caseId}/billing/summary`),
  });

  const addMutation = useMutation({
    mutationFn: (data: object) => apiFetch(`/cases/${caseId}/billing`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case-billing", caseId] });
      qc.invalidateQueries({ queryKey: ["case-billing-summary", caseId] });
      qc.invalidateQueries({ queryKey: ["accounting-summary"] });
      setAddOpen(false);
      setForm({ category: "disbursement", description: "", amount: "", quantity: "1" });
      toast({ title: "Billing entry added" });
    },
    onError: (err) => toast({ title: "Error", description: String(err), variant: "destructive" }),
  });

  const togglePaidMutation = useMutation({
    mutationFn: ({ entryId, isPaid }: { entryId: number; isPaid: boolean }) =>
      apiFetch(`/cases/${caseId}/billing/${entryId}`, { method: "PATCH", body: JSON.stringify({ isPaid }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case-billing", caseId] });
      qc.invalidateQueries({ queryKey: ["case-billing-summary", caseId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entryId: number) => apiFetch(`/cases/${caseId}/billing/${entryId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case-billing", caseId] });
      qc.invalidateQueries({ queryKey: ["case-billing-summary", caseId] });
      qc.invalidateQueries({ queryKey: ["accounting-summary"] });
      toast({ title: "Entry deleted" });
    },
  });

  const overall = summary?.overall ?? {};

  function handleAdd() {
    if (!form.description || !form.amount) return;
    addMutation.mutate({
      category: form.category,
      description: form.description,
      amount: Number(form.amount),
      quantity: Number(form.quantity) || 1,
    });
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Billed", value: fmt(Number(overall.total ?? 0)), color: "text-slate-900" },
          { label: "Paid", value: fmt(Number(overall.paid ?? 0)), color: "text-green-600" },
          { label: "Outstanding", value: fmt(Number(overall.outstanding ?? 0)), color: "text-red-600" },
        ].map((item) => (
          <Card key={item.label}>
            <CardContent className="pt-5 pb-4">
              <div className="text-xs text-slate-500 mb-1">{item.label}</div>
              <div className={`text-xl font-bold ${item.color}`}>{item.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle>Billing Entries</CardTitle>
          <Button size="sm" className="bg-amber-500 hover:bg-amber-600 gap-1.5" onClick={() => setAddOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            Add Entry
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-slate-500 py-8 text-center">Loading...</div>
          ) : entries.length === 0 ? (
            <div className="text-center py-10 text-slate-500">
              <DollarSign className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="font-medium text-slate-600 mb-1">No billing entries yet</p>
              <p className="text-sm">Add legal fees, disbursements, stamp duty, and other charges.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500 text-left">
                  <th className="py-2 font-medium">Description</th>
                  <th className="py-2 font-medium">Category</th>
                  <th className="py-2 font-medium text-right">Qty</th>
                  <th className="py-2 font-medium text-right">Amount</th>
                  <th className="py-2 font-medium text-right">Total</th>
                  <th className="py-2 font-medium text-center">Paid</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const total = Number(entry.amount ?? 0) * Number(entry.quantity ?? 1);
                  const isPaid = Boolean(entry.is_paid);
                  return (
                    <tr key={String(entry.id)} className={`border-b border-slate-50 ${isPaid ? "opacity-60" : ""}`}>
                      <td className="py-3">
                        <div className={`font-medium text-slate-900 ${isPaid ? "line-through" : ""}`}>{String(entry.description)}</div>
                        {entry.created_by_name && <div className="text-xs text-slate-400">{String(entry.created_by_name)}</div>}
                      </td>
                      <td className="py-3">
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${CATEGORY_COLORS[entry.category as string] ?? "bg-slate-100 text-slate-600"}`}>
                          {CATEGORY_LABELS[entry.category as string] ?? String(entry.category)}
                        </span>
                      </td>
                      <td className="py-3 text-right text-slate-600">{String(entry.quantity)}</td>
                      <td className="py-3 text-right text-slate-700">{fmt(entry.amount)}</td>
                      <td className="py-3 text-right font-semibold text-slate-900">{fmt(total)}</td>
                      <td className="py-3 text-center">
                        <button onClick={() => togglePaidMutation.mutate({ entryId: Number(entry.id), isPaid: !isPaid })}>
                          {isPaid
                            ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                            : <Circle className="w-5 h-5 text-slate-300 hover:text-green-400" />
                          }
                        </button>
                      </td>
                      <td className="py-3">
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-300 hover:text-red-500" onClick={() => deleteMutation.mutate(Number(entry.id))}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200">
                  <td colSpan={4} className="py-3 font-semibold text-slate-600 text-right">Grand Total</td>
                  <td className="py-3 text-right font-bold text-slate-900">{fmt(overall.total ?? 0)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add Billing Entry</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="e.g. SPA Stamp Duty" value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Amount (RM)</Label>
                <Input type="number" placeholder="0.00" value={form.amount} onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Quantity</Label>
                <Input type="number" min="1" value={form.quantity} onChange={(e) => setForm(f => ({ ...f, quantity: e.target.value }))} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button className="bg-amber-500 hover:bg-amber-600" onClick={handleAdd} disabled={!form.description || !form.amount || addMutation.isPending}>
                {addMutation.isPending ? "Adding..." : "Add Entry"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
