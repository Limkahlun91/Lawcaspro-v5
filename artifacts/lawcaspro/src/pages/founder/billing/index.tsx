import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type BillingOverview = {
  billing_month: string;
  paid_total: number;
  unpaid_total: number;
  overdue_firms: number;
};

type LedgerRow = {
  firm_id: number;
  firm_name: string;
  plan_name: string;
  is_custom_plan: boolean;
  custom_price_monthly: string | null;
  invoice_id: number;
  billing_month: string;
  amount: string;
  status: "paid" | "unpaid" | "overdue" | string;
  paid_at: string | null;
  payment_method: string | null;
};

const rm = (v: number | string | null | undefined): string => {
  if (v == null) return "RM 0.00";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "RM 0.00";
  return `RM ${n.toFixed(2)}`;
};

export default function FounderBillingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [priceModal, setPriceModal] = useState<{ firmId: number; firmName: string; current: string | null } | null>(null);
  const [customPriceInput, setCustomPriceInput] = useState<string>("");

  const overviewQuery = useQuery({
    queryKey: ["founder-billing-overview"],
    queryFn: async () => unwrapApiData<BillingOverview>(await apiFetchJson("/founder/billing/overview")),
    retry: false,
  });

  const ledgerQuery = useQuery({
    queryKey: ["founder-billing-ledger"],
    queryFn: async () => unwrapApiData<{ billing_month: string; items: LedgerRow[] }>(await apiFetchJson("/founder/billing/ledger")),
    retry: false,
  });

  const items = useMemo(() => {
    const rows = ledgerQuery.data?.items ?? [];
    return Array.isArray(rows) ? rows : [];
  }, [ledgerQuery.data]);

  const markPaidMutation = useMutation({
    mutationFn: async (invoiceId: number) => {
      const res = await apiFetchJson(`/founder/billing/invoices/${invoiceId}/mark-paid`, {
        method: "PATCH",
        body: JSON.stringify({ paymentMethod: "Manual" }),
      });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["founder-billing-overview"] }),
        queryClient.invalidateQueries({ queryKey: ["founder-billing-ledger"] }),
      ]);
      toast({ title: "Marked as paid" });
    },
    onError: (error) => toastError(toast, error, "Failed to mark paid"),
  });

  const updateCustomPriceMutation = useMutation({
    mutationFn: async (params: { firmId: number; customPriceMonthly: string | null }) => {
      const res = await apiFetchJson(`/founder/firms/${params.firmId}/custom-price`, {
        method: "PATCH",
        body: JSON.stringify({ customPriceMonthly: params.customPriceMonthly, isCustomPlan: params.customPriceMonthly != null }),
      });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      setPriceModal(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["founder-billing-overview"] }),
        queryClient.invalidateQueries({ queryKey: ["founder-billing-ledger"] }),
      ]);
      toast({ title: "Custom price updated" });
    },
    onError: (error) => toastError(toast, error, "Failed to update custom price"),
  });

  const openPriceModal = (row: LedgerRow) => {
    setPriceModal({ firmId: row.firm_id, firmName: row.firm_name, current: row.custom_price_monthly });
    setCustomPriceInput(row.custom_price_monthly ?? "");
  };

  const submitCustomPrice = () => {
    if (!priceModal) return;
    const trimmed = customPriceInput.trim();
    const value = trimmed ? trimmed : null;
    updateCustomPriceMutation.mutate({ firmId: priceModal.firmId, customPriceMonthly: value });
  };

  const overview = overviewQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Founder Billing Ledger</h1>
        <p className="text-slate-500 mt-1">Platform-wide billing overview & collections</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">已收帳款 (RM)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-emerald-600">{rm(overview?.paid_total)}</div>
            <div className="text-xs text-slate-500 mt-1">帳單月份：{overview?.billing_month ?? "—"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">未收/欠款 (RM)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-rose-600">{rm(overview?.unpaid_total)}</div>
            <div className="text-xs text-slate-500 mt-1">逾期律師樓：{overview?.overdue_firms ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Master Ledger</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {ledgerQuery.isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading ledger...</div>
          ) : ledgerQuery.isError ? (
            <div className="p-8 text-center text-slate-500">Failed to load ledger</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Firm Name</th>
                    <th className="px-6 py-3 font-semibold">配套類型</th>
                    <th className="px-6 py-3 font-semibold text-right">本月費用 (RM)</th>
                    <th className="px-6 py-3 font-semibold">帳單月份</th>
                    <th className="px-6 py-3 font-semibold">狀態</th>
                    <th className="px-6 py-3 font-semibold text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((row) => {
                    const paid = row.status === "paid";
                    return (
                      <tr key={row.invoice_id} className="hover:bg-slate-50/50">
                        <td className="px-6 py-4">
                          <button
                            type="button"
                            className="font-medium text-slate-900 hover:text-amber-600 transition-colors"
                            onClick={() => openPriceModal(row)}
                          >
                            {row.firm_name}
                          </button>
                          <div className="text-slate-500 text-xs mt-0.5">{row.plan_name}</div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-slate-700">{row.is_custom_plan ? "特別指定" : "標準"}</span>
                        </td>
                        <td className="px-6 py-4 text-right font-semibold text-slate-900">{rm(row.amount)}</td>
                        <td className="px-6 py-4 text-slate-600">{row.billing_month}</td>
                        <td className="px-6 py-4">
                          {paid ? (
                            <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">PAID</Badge>
                          ) : (
                            <Badge variant="destructive">UNPAID</Badge>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          {paid ? (
                            <span className="text-xs text-slate-500">{row.paid_at ? new Date(row.paid_at).toLocaleString() : ""}</span>
                          ) : (
                            <Button
                              size="sm"
                              className="bg-amber-500 hover:bg-amber-600 text-white"
                              disabled={markPaidMutation.isPending}
                              onClick={() => markPaidMutation.mutate(row.invoice_id)}
                            >
                              Mark as Paid
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-10 text-center text-slate-500">No invoices found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!priceModal} onOpenChange={(open) => (!open ? setPriceModal(null) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Custom Monthly Price</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              {priceModal ? priceModal.firmName : ""}
            </div>
            <div className="space-y-2">
              <Label>Custom Price (RM)</Label>
              <Input value={customPriceInput} onChange={(e) => setCustomPriceInput(e.target.value)} placeholder="e.g. 399.00 (leave blank to clear)" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceModal(null)} disabled={updateCustomPriceMutation.isPending}>Cancel</Button>
            <Button className="bg-amber-500 hover:bg-amber-600 text-white" onClick={submitCustomPrice} disabled={updateCustomPriceMutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

