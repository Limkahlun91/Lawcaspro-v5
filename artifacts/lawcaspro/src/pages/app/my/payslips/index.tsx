import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type PayslipRow = { id: number; periodLabel: string | null; netCents: number; grossCents: number; status: string; payDate: string | null };

function MyPayslips() {
  const list = useQuery({
    queryKey: ["my-payslips"],
    queryFn: async () => {
      try { return unwrapApiData<{ items: PayslipRow[] }>(await apiFetchJson("/hr/payroll/me/payslips")); }
      catch { return { items: [] as PayslipRow[] }; }
    },
    staleTime: 30_000,
    retry: false,
  });
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>My Payslips</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr><th className="text-left py-2 px-2">Period</th><th className="text-right py-2 px-2">Gross</th><th className="text-right py-2 px-2">Net</th><th className="text-left py-2 px-2">Pay Date</th><th className="text-left py-2 px-2">Status</th><th className="text-left py-2 px-2">Actions</th></tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((p) => (
                <tr key={p.id} className="border-b border-slate-100">
                  <td className="py-2 px-2 font-medium">{p.periodLabel ?? `#${p.id}`}</td>
                  <td className="py-2 px-2 text-right">MYR {(p.grossCents / 100).toFixed(2)}</td>
                  <td className="py-2 px-2 text-right font-semibold">MYR {(p.netCents / 100).toFixed(2)}</td>
                  <td className="py-2 px-2 text-xs text-slate-500">{p.payDate ? new Date(p.payDate).toLocaleDateString() : "—"}</td>
                  <td className="py-2 px-2"><Badge variant={p.status === "paid" ? "default" : "secondary"}>{p.status}</Badge></td>
                  <td className="py-2 px-2"><Button size="sm" variant="outline">Download</Button></td>
                </tr>
              ))}
              {(!list.data?.items || list.data.items.length === 0) && <tr><td colSpan={6} className="py-10 text-center text-sm text-slate-500">No payslips yet.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
export default MyPayslips;
