import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Printer, CheckCircle, XCircle, Plus, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { useReAuth } from "@/components/re-auth-dialog";

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type InvoiceItem = {
  id: number;
  description: string;
  itemType: string;
  amountExclTax?: number | string;
  taxRate?: number | string;
  taxAmount?: number | string;
  amountInclTax?: number | string;
};

type InvoiceDetailResponse = {
  id: number;
  caseId?: number | null;
  invoiceNo: string;
  status: string;
  subtotal?: number | string;
  taxTotal?: number | string;
  grandTotal: number | string;
  amountPaid: number | string;
  amountDue: number | string;
  issuedDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  items?: InvoiceItem[];
};

type ReceiptRow = {
  id: number;
  receiptNo: string;
  receivedDate: string;
  amount: number | string;
  isReversed?: boolean;
  invoiceId?: number | null;
  caseId?: number | null;
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  issued: "bg-blue-100 text-blue-700",
  partially_paid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700",
  void: "bg-red-100 text-red-600",
};

const ITEM_TYPE_LABELS: Record<string, string> = {
  professional_fee: "Professional Fee",
  taxable_service: "Taxable Service",
  disbursement: "Disbursement",
  trust_amount: "Trust",
  pass_through: "Pass-through",
};

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { wrapWithReAuth } = useReAuth();
  const [showReceipt, setShowReceipt] = useState(false);
  const [receiptForm, setReceiptForm] = useState({
    amount: "", paymentMethod: "bank_transfer", receivedDate: new Date().toISOString().slice(0, 10), referenceNo: "",
  });

  const invQuery = useQuery<InvoiceDetailResponse>({
    queryKey: ["invoice", id],
    queryFn: () => apiFetchJson<InvoiceDetailResponse>(`/invoices/${id}`),
    retry: false,
  });
  const { data: inv, isLoading } = invQuery;

  const receiptsQuery = useQuery<ReceiptRow[]>({
    queryKey: ["receipts-for-invoice", id],
    queryFn: () => apiFetchJson<ReceiptRow[]>(`/receipts?caseId=${inv?.caseId}`),
    enabled: !!inv?.caseId,
    retry: false,
  });
  const { data: receiptsData } = receiptsQuery;

  const issueMut = useMutation({
    mutationFn: () => apiFetchJson(`/invoices/${id}/issue`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoice", id] }); toast({ title: "Invoice issued" }); },
    onError: (e) => toastError(toast, e, "Action failed"),
  });

  const voidMut = useMutation({
    mutationFn: () => wrapWithReAuth(
      (headers) => apiFetchJson(`/invoices/${id}/void`, { method: "POST", headers }),
      "Voiding an invoice is a sensitive action and may affect financial records. Continue?"
    ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoice", id] }); toast({ title: "Invoice voided" }); },
    onError: (e) => toastError(toast, e, "Action failed"),
  });

  const receiptMut = useMutation({
    mutationFn: () => apiFetchJson("/receipts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invoiceId: parseInt(id!), caseId: inv?.caseId,
        amount: parseFloat(receiptForm.amount),
        paymentMethod: receiptForm.paymentMethod,
        receivedDate: receiptForm.receivedDate,
        referenceNo: receiptForm.referenceNo || undefined,
        accountType: "client",
      }),
    }),
    onSuccess: (rec: ReceiptRow) => {
      qc.invalidateQueries({ queryKey: ["invoice", id] });
      qc.invalidateQueries({ queryKey: ["receipts-for-invoice", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setShowReceipt(false);
      setReceiptForm({ amount: "", paymentMethod: "bank_transfer", receivedDate: new Date().toISOString().slice(0, 10), referenceNo: "" });
      toast({ title: "Payment recorded", description: `${rec.receiptNo} saved` });
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  if (isLoading) return <div className="py-16 text-center text-slate-400">Loading invoice…</div>;
  if (invQuery.isError) return <div className="p-6"><QueryFallback title="Invoice unavailable" error={invQuery.error} onRetry={() => invQuery.refetch()} isRetrying={invQuery.isFetching} /></div>;
  if (!inv) return <div className="py-16 text-center text-slate-400">Invoice not found</div>;

  const items = inv.items ?? [];
  const profFees = items.filter((i) => i.itemType === "professional_fee" || i.itemType === "taxable_service");
  const disbursements = items.filter((i) => i.itemType === "disbursement");
  const trustItems = items.filter((i) => i.itemType === "trust_amount" || i.itemType === "pass_through");
  const otherItems = items.filter((i) => !profFees.includes(i) && !disbursements.includes(i) && !trustItems.includes(i));

  const issuable = inv.status === "draft";
  const voidable = inv.status !== "paid" && inv.status !== "void";
  const canRecord = inv.status === "issued" || inv.status === "partially_paid";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/app/accounting?tab=invoices")} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">{inv.invoiceNo}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", STATUS_COLORS[inv.status] ?? "bg-slate-100 text-slate-600")}>
              {inv.status?.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}
            </span>
            {inv.issuedDate && <span className="text-sm text-slate-400">Issued: {inv.issuedDate}</span>}
            {inv.dueDate && <span className="text-sm text-slate-400">Due: {inv.dueDate}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.print()}>
            <Printer className="w-4 h-4" /> Print
          </Button>
          {issuable && (
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5" onClick={() => issueMut.mutate()} disabled={issueMut.isPending || voidMut.isPending}>
              <CheckCircle className="w-4 h-4" /> Issue
            </Button>
          )}
          {canRecord && (
            <Button size="sm" className="bg-amber-500 hover:bg-amber-600 text-white gap-1.5" onClick={() => setShowReceipt(!showReceipt)}>
              <Plus className="w-4 h-4" /> Record Payment
            </Button>
          )}
          {voidable && (
            <Button size="sm" variant="outline" className="text-red-500 border-red-200 hover:bg-red-50 gap-1.5"
              onClick={() => voidMut.mutate()}
              disabled={voidMut.isPending || issueMut.isPending}
            >
              <XCircle className="w-4 h-4" /> Void
            </Button>
          )}
        </div>
      </div>

      {showReceipt && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader><CardTitle className="text-base">Record Payment for {inv.invoiceNo}</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Amount (RM) — Due: {fmt(inv.amountDue)}</label>
                <Input type="number" step="0.01" placeholder={String(Number(inv.amountDue))}
                  value={receiptForm.amount} onChange={(e) => setReceiptForm((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Payment Method</label>
                <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  value={receiptForm.paymentMethod} onChange={(e) => setReceiptForm((f) => ({ ...f, paymentMethod: e.target.value }))}>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="cheque">Cheque</option>
                  <option value="cash">Cash</option>
                  <option value="online">Online Banking</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Date Received</label>
                <Input type="date" value={receiptForm.receivedDate}
                  onChange={(e) => setReceiptForm((f) => ({ ...f, receivedDate: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Reference No</label>
                <Input placeholder="Bank ref / cheque no." value={receiptForm.referenceNo}
                  onChange={(e) => setReceiptForm((f) => ({ ...f, referenceNo: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <Button onClick={() => receiptMut.mutate()} disabled={!receiptForm.amount || receiptMut.isPending}
                className="bg-amber-500 hover:bg-amber-600 text-white">
                {receiptMut.isPending ? "Saving…" : "Record Payment"}
              </Button>
              <Button variant="outline" onClick={() => setShowReceipt(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Payment summary bar */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4 text-center">
            <div className="text-xs text-slate-500 mb-1">Invoice Total</div>
            <div className="text-xl font-bold text-slate-900">{fmt(inv.grandTotal)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 text-center">
            <div className="text-xs text-slate-500 mb-1">Amount Paid</div>
            <div className="text-xl font-bold text-green-600">{fmt(inv.amountPaid)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 text-center">
            <div className="text-xs text-slate-500 mb-1">Outstanding</div>
            <div className={cn("text-xl font-bold", Number(inv.amountDue) > 0 ? "text-red-500" : "text-green-600")}>
              {fmt(inv.amountDue)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Invoice line items */}
      <Card className="print:shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Invoice Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {[
            { label: "A — Professional Fees", items: profFees },
            { label: "B — Disbursements", items: disbursements },
            { label: "C — Trust / Pass-through", items: trustItems },
            { label: "Other", items: otherItems },
          ].filter(g => g.items.length > 0).map((group) => (
            <div key={group.label}>
              <div className="px-4 py-2 bg-slate-50 border-y text-xs font-semibold text-slate-500 uppercase tracking-wide">
                {group.label}
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-400 text-xs">
                    <th className="px-4 py-2 text-left font-medium">Description</th>
                    <th className="px-4 py-2 text-left font-medium">Type</th>
                    <th className="px-4 py-2 text-right font-medium">Excl. Tax</th>
                    <th className="px-4 py-2 text-right font-medium">Tax</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((item: InvoiceItem) => (
                    <tr key={item.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2.5 text-slate-800">{item.description}</td>
                      <td className="px-4 py-2.5">
                        <span className="text-xs text-slate-400">{ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600 font-mono text-xs">{fmt(item.amountExclTax)}</td>
                      <td className="px-4 py-2.5 text-right text-slate-400 font-mono text-xs">
                        {Number(item.taxAmount) > 0 ? `${fmt(item.taxAmount)} (${Number(item.taxRate).toFixed(0)}%)` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-800 font-mono text-xs">{fmt(item.amountInclTax)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <div className="border-t p-4">
            <div className="ml-auto max-w-xs space-y-1.5">
              <div className="flex justify-between text-sm text-slate-600">
                <span>Subtotal (excl. tax)</span><span className="font-mono">{fmt(inv.subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm text-slate-600">
                <span>SST / Tax</span><span className="font-mono">{fmt(inv.taxTotal)}</span>
              </div>
              <div className="flex justify-between text-base font-bold text-slate-900 border-t pt-2">
                <span>Grand Total</span><span className="font-mono">{fmt(inv.grandTotal)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {inv.notes && (
        <Card>
          <CardContent className="pt-4">
            <div className="flex gap-2 text-sm text-slate-600">
              <AlertCircle className="w-4 h-4 mt-0.5 text-slate-400 flex-shrink-0" />
              <p>{inv.notes}</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
