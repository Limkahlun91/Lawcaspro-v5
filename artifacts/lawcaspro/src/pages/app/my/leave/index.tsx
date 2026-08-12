import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

function MyLeave() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [type, setType] = useState("annual");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const me = useQuery({
    queryKey: ["my-leave-list"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: Array<{ id: number; leaveType: string; startDate: string; endDate: string; totalDays: string | number; status: string; reason: string | null }>; balances: Array<{ leaveType: string; balance: number; entitled: number; used: number }> }>(await apiFetchJson("/hr/leave/me")); }
      catch { return { items: [], balances: [] }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  const submit = useMutation({
    mutationFn: async () => unwrapApiData(await apiFetchJson("/hr/leave/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leaveType: type, startDate: from, endDate: to, reason }) })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["my-leave"] }); toast({ title: "Leave applied" }); setFrom(""); setTo(""); setReason(""); },
    onError: (e) => toastError(toast, e, "Apply failed"),
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>My Leave Balances</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(me.data?.balances ?? []).map((b) => (
              <Card key={b.leaveType}><CardContent className="p-4">
                <div className="text-xs uppercase text-slate-500">{b.leaveType}</div>
                <div className="text-2xl font-semibold mt-1">{b.balance}</div>
                <div className="text-xs text-slate-500">Used {b.used} / {b.entitled}</div>
              </CardContent></Card>
            ))}
            {(!me.data?.balances || me.data.balances.length === 0) && <div className="col-span-full text-sm text-slate-500">No balances loaded.</div>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Apply Leave</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-2"><Label>Type</Label><Select value={type} onValueChange={setType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="annual">Annual</SelectItem><SelectItem value="sick">Sick</SelectItem><SelectItem value="maternity">Maternity</SelectItem><SelectItem value="compassionate">Compassionate</SelectItem><SelectItem value="unpaid">Unpaid</SelectItem></SelectContent></Select></div>
          <div></div>
          <div className="space-y-2"><Label>From</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-2"><Label>To</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="space-y-2 md:col-span-2"><Label>Reason</Label><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="md:col-span-2"><Button size="sm" onClick={() => submit.mutate()} disabled={submit.isPending}>Submit</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>My Applications</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Type</th><th className="text-left py-2 px-2">From</th><th className="text-left py-2 px-2">To</th><th className="text-left py-2 px-2">Days</th><th className="text-left py-2 px-2">Status</th><th className="text-left py-2 px-2">Reason</th></tr>
            </thead>
            <tbody>
              {(me.data?.items ?? []).map((l) => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="py-2 px-2">{l.leaveType}</td>
                  <td className="py-2 px-2">{l.startDate}</td>
                  <td className="py-2 px-2">{l.endDate}</td>
                  <td className="py-2 px-2">{String(l.totalDays)}</td>
                  <td className="py-2 px-2"><Badge variant={l.status === "approved" ? "default" : l.status === "pending" ? "secondary" : "outline"}>{l.status}</Badge></td>
                  <td className="py-2 px-2 text-xs text-slate-600">{l.reason ?? "—"}</td>
                </tr>
              ))}
              {(!me.data?.items || me.data.items.length === 0) && <tr><td colSpan={6} className="py-10 text-center text-sm text-slate-500">No applications.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default MyLeave;
