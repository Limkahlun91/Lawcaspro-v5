import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ChevronRight, FileText, Plus } from "lucide-react";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { formatRMAmount } from "@/lib/money";
import { toastError } from "@/lib/toast-error";
import { useAuth } from "@/lib/auth-context";

function fmt(val: unknown) {
  return formatRMAmount(val);
}

export default function CaseBillingTab({ caseId }: { caseId: number }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const roleName = String((user as any)?.roleName ?? "").trim().toLowerCase();
  const canCreateInvoices = roleName.includes("partner") || roleName === "account" || roleName === "accounts" || roleName === "accountant" || roleName === "finance";
  const [search, setSearch] = useState("");

  const quotationsQuery = useQuery<any[]>({
    queryKey: ["case-quotations", caseId],
    queryFn: () => apiFetchJson(`/quotations?caseId=${caseId}`),
    retry: false,
  });
  const quotations = Array.isArray(quotationsQuery.data) ? quotationsQuery.data : [];

  const invoicesQuery = useQuery<any[]>({
    queryKey: ["case-invoices", caseId],
    queryFn: () => apiFetchJson(`/invoices?caseId=${caseId}`),
    retry: false,
  });
  const invoices = Array.isArray(invoicesQuery.data) ? invoicesQuery.data : [];

  const createInvoiceMut = useMutation({
    mutationFn: async (quotationId: number) => apiFetchJson(`/invoices/from-quotation/${quotationId}`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: async (inv: any) => {
      await qc.invalidateQueries({ queryKey: ["case-invoices", caseId] });
      await qc.invalidateQueries({ queryKey: ["invoices"] });
      toast({ title: "Invoice created", description: `${inv.invoiceNo ?? ""} created as draft` });
      if (inv?.id) setLocation(`/app/accounting/invoices/${inv.id}`);
    },
    onError: (err) => toastError(toast, err, "Create invoice failed"),
  });

  const filteredQuotations = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return quotations;
    return quotations.filter((q: any) => {
      const ref = String(q.referenceNo ?? "").toLowerCase();
      const name = String(q.clientName ?? "").toLowerCase();
      return ref.includes(needle) || name.includes(needle);
    });
  }, [quotations, search]);

  const filteredInvoices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return invoices;
    return invoices.filter((i: any) => String(i.invoiceNo ?? "").toLowerCase().includes(needle));
  }, [invoices, search]);

  const quotationExpected = quotations.reduce((s: number, q: any) => s + Number(q.totalInclTax ?? 0), 0);
  const invoiceTotal = invoices.reduce((s: number, i: any) => s + Number(i.grandTotal ?? 0), 0);
  const invoiceOutstanding = invoices.reduce((s: number, i: any) => s + Number(i.amountDue ?? 0), 0);

  const invoiceByQuotationId = new Map<number, any>();
  for (const inv of invoices) {
    const qid = Number((inv as any).quotationId ?? NaN);
    if (Number.isFinite(qid) && qid > 0 && !invoiceByQuotationId.has(qid)) invoiceByQuotationId.set(qid, inv);
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "Expected (Quotations)", value: fmt(quotationExpected), color: "text-slate-900" },
          { label: "Total Invoiced", value: fmt(invoiceTotal), color: "text-amber-600" },
          { label: "Outstanding (Invoices)", value: fmt(invoiceOutstanding), color: "text-red-600" },
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
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-4">
          <CardTitle>Quotations & Invoices</CardTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setLocation(`/app/quotations/new?caseId=${caseId}`)} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              New Quotation
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {quotationsQuery.isError || invoicesQuery.isError ? (
            <QueryFallback
              title="Billing unavailable"
              error={quotationsQuery.error ?? invoicesQuery.error}
              onRetry={() => {
                quotationsQuery.refetch();
                invoicesQuery.refetch();
              }}
              isRetrying={quotationsQuery.isFetching || invoicesQuery.isFetching}
            />
          ) : quotationsQuery.isLoading || invoicesQuery.isLoading ? (
            <div className="text-slate-500 py-8 text-center">Loading...</div>
          ) : (
            <div className="space-y-4">
              <div className="relative max-w-md">
                <Input placeholder="Search quotation/invoice…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card className="border-slate-200">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <span>Quotations</span>
                      <Badge variant="outline">{filteredQuotations.length}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {filteredQuotations.length === 0 ? (
                      <div className="text-sm text-slate-500 py-6 text-center">No quotations.</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[560px]">
                          <thead>
                            <tr className="border-b border-slate-100 text-slate-500 text-left">
                              <th className="py-2 font-medium">Ref</th>
                              <th className="py-2 font-medium">Client</th>
                              <th className="py-2 font-medium">Status</th>
                              <th className="py-2 font-medium text-right">Total</th>
                              <th className="py-2" />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {filteredQuotations.map((q: any) => {
                              const linkedInv = Number.isFinite(Number(q.id)) ? invoiceByQuotationId.get(Number(q.id)) : null;
                              return (
                                <tr key={q.id} className="hover:bg-slate-50">
                                  <td className="py-2 font-medium text-slate-900">{q.referenceNo}</td>
                                  <td className="py-2 text-slate-700 truncate max-w-[220px]" title={q.clientName}>{q.clientName}</td>
                                  <td className="py-2 text-slate-600">{String(q.status ?? "").replace(/_/g, " ")}</td>
                                  <td className="py-2 text-right font-semibold text-slate-900">{fmt(q.totalInclTax)}</td>
                                  <td className="py-2 text-right">
                                    <div className="inline-flex items-center gap-2">
                                      {linkedInv ? (
                                        <Badge variant="outline" className="text-[10px]">Invoiced</Badge>
                                      ) : canCreateInvoices ? (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-7 text-xs"
                                          onClick={() => createInvoiceMut.mutate(Number(q.id))}
                                          disabled={createInvoiceMut.isPending}
                                        >
                                          Create Invoice
                                        </Button>
                                      ) : null}
                                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setLocation(`/app/quotations/${q.id}`)}>
                                        <ChevronRight className="w-4 h-4" />
                                      </Button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-slate-200">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <span>Invoices</span>
                      <Badge variant="outline">{filteredInvoices.length}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {filteredInvoices.length === 0 ? (
                      <div className="text-sm text-slate-500 py-6 text-center">No invoices.</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[560px]">
                          <thead>
                            <tr className="border-b border-slate-100 text-slate-500 text-left">
                              <th className="py-2 font-medium">Invoice No</th>
                              <th className="py-2 font-medium">Status</th>
                              <th className="py-2 font-medium text-right">Total</th>
                              <th className="py-2 font-medium text-right">Due</th>
                              <th className="py-2" />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {filteredInvoices.map((inv: any) => (
                              <tr key={inv.id} className="hover:bg-slate-50">
                                <td className="py-2 font-medium text-slate-900">{inv.invoiceNo}</td>
                                <td className="py-2 text-slate-600">{String(inv.status ?? "").replace(/_/g, " ")}</td>
                                <td className="py-2 text-right font-semibold text-slate-900">{fmt(inv.grandTotal)}</td>
                                <td className="py-2 text-right text-red-600">{fmt(inv.amountDue)}</td>
                                <td className="py-2 text-right">
                                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setLocation(`/app/accounting/invoices/${inv.id}`)}>
                                    <ChevronRight className="w-4 h-4" />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {!canCreateInvoices ? (
                <div className="text-xs text-slate-500 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Only Partner/Account can create invoices. Everyone can create quotations.
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
