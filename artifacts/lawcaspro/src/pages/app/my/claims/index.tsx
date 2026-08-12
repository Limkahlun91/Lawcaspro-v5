import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Badge } from "@/components/ui/badge";

function MyClaims() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const list = useQuery({
    queryKey: ["my-claims"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: Array<{ id: number; claimType: string; title: string | null; totalAmountCents: number; status: string; submittedAt: string | null }> }>(await apiFetchJson("/hr/claims/me")); }
      catch { return { items: [] }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  const submit = useMutation({
    mutationFn: async () => unwrapApiData(await apiFetchJson("/hr/claims/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, amountCents: Math.round(Number(amount || "0") * 100) }) })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["my-claims"] }); toast({ title: "Claim submitted" }); setTitle(""); setAmount(""); },
    onError: (e) => toastError(toast, e, "Submit failed"),
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>Submit Claim</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2"><Input placeholder="Title / description" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div><Input type="number" step="0.01" placeholder="Amount (MYR)" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="md:col-span-3"><Button size="sm" onClick={() => submit.mutate()} disabled={submit.isPending}>Submit Claim</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>My Claims</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Type</th><th className="text-left py-2 px-2">Title</th><th className="text-right py-2 px-2">Amount</th><th className="text-left py-2 px-2">Status</th><th className="text-left py-2 px-2">Submitted</th></tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((c) => (
                <tr key={c.id} className="border-b border-slate-100">
                  <td className="py-2 px-2">{c.claimType}</td>
                  <td className="py-2 px-2">{c.title ?? "—"}</td>
                  <td className="py-2 px-2 text-right font-medium">MYR {(c.totalAmountCents / 100).toFixed(2)}</td>
                  <td className="py-2 px-2"><Badge variant={c.status === "approved" ? "default" : c.status === "pending" ? "secondary" : "outline"}>{c.status}</Badge></td>
                  <td className="py-2 px-2 text-xs text-slate-500">{c.submittedAt ? new Date(c.submittedAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
              {(!list.data?.items || list.data.items.length === 0) && <tr><td colSpan={5} className="py-10 text-center text-sm text-slate-500">No claims.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default MyClaims;
