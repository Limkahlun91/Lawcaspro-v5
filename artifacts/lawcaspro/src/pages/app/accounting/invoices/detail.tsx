import { useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, CheckCircle, XCircle, Plus, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateOnlyInput } from "@/components/date-only-input";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { useReAuth } from "@/components/re-auth-dialog";
import { BillToBlock } from "@/components/accounting/BillToBlock";
import { DocumentPrintStyles } from "@/components/accounting/DocumentPrintStyles";
import { exportElementToPdf } from "@/lib/pdf-export";

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type InvoiceItem = {
  id: number;
  description: string;
  itemType: string;
  itemCategory?: string;
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
  billToName?: string | null;
  billToAddress?: string | null;
  clientDetails?: Array<{ name: string; tin?: string }>;
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

type FirmSettings = {
  logoUrl?: string | null;
  name?: string | null;
  address?: string | null;
  stNumber?: string | null;
  tinNumber?: string | null;
  registrationNo?: string | null;
  sstNo?: string | null;
  phone?: string | null;
  email?: string | null;
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
  const [isExporting, setIsExporting] = useState(false);
  const pdfRef = useRef<HTMLDivElement>(null);
  const [receiptForm, setReceiptForm] = useState({
    amount: "", paymentMethod: "bank_transfer", receivedDate: new Date().toISOString().slice(0, 10), referenceNo: "",
  });

  const invQuery = useQuery<InvoiceDetailResponse>({
    queryKey: ["invoice", id],
    queryFn: () => apiFetchJson<InvoiceDetailResponse>(`/invoices/${id}`),
    retry: false,
  });
  const { data: inv, isLoading } = invQuery;

  const firmQuery = useQuery<FirmSettings>({
    queryKey: ["firm-settings"],
    queryFn: async ({ signal }) => {
      const res = await apiFetchJson<any>("/firm-settings", { signal, timeoutMs: 8000 });
      return res && typeof res === "object" && "data" in res ? (res as any).data : res;
    },
    retry: false,
  });
  const firm = firmQuery.data;
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!firm?.logoUrl) { setLogoPreviewUrl(null); return; }
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const blob = await apiFetchBlob("/firm-settings/logo");
        url = URL.createObjectURL(blob);
        if (!cancelled) setLogoPreviewUrl(url);
      } catch {
        if (!cancelled) setLogoPreviewUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [firm?.logoUrl]);

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
  if (invQuery.isError) return <div className="py-10"><QueryFallback title="Invoice unavailable" error={invQuery.error} onRetry={() => invQuery.refetch()} isRetrying={invQuery.isFetching} /></div>;
  if (!inv) return <div className="py-16 text-center text-slate-400">Invoice not found</div>;

  const items = (inv.items ?? []).filter((i) => {
    const excl = Number((i as any).amountExclTax) || 0;
    const incl = Number((i as any).amountInclTax) || 0;
    return excl > 0 || incl > 0;
  });
  const getCategory = (i: InvoiceItem): "fee" | "disbursement" => {
    const c = String(i.itemCategory ?? "").toLowerCase();
    if (c === "fee" || c === "disbursement") return c;
    if (i.itemType === "disbursement" || i.itemType === "trust_amount" || i.itemType === "pass_through") return "disbursement";
    return "fee";
  };
  const feeItems = items.filter((i) => getCategory(i) === "fee");
  const disbursementItems = items.filter((i) => getCategory(i) === "disbursement");

  const issuable = inv.status === "draft";
  const voidable = inv.status !== "paid" && inv.status !== "void";
  const canRecord = inv.status === "issued" || inv.status === "partially_paid";

  const handleDownloadPdf = async () => {
    if (!pdfRef.current) return;
    setIsExporting(true);
    try {
      await exportElementToPdf({ element: pdfRef.current, filename: `Invoice-${inv.invoiceNo}.pdf` });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6 min-w-0">
      <DocumentPrintStyles />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between print:hidden pdf-hide">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/app/accounting?tab=invoices")} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">Invoice</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", STATUS_COLORS[inv.status] ?? "bg-slate-100 text-slate-600")}>
              {inv.status?.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}
            </span>
            {inv.issuedDate && <span className="text-sm text-slate-400">Issued: {inv.issuedDate}</span>}
            {inv.dueDate && <span className="text-sm text-slate-400">Due: {inv.dueDate}</span>}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleDownloadPdf} disabled={isExporting}>
            <Download className="w-4 h-4" /> {isExporting ? "Generating..." : "Download PDF"}
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
        <Card className="border-amber-200 bg-amber-50 pdf-hide">
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
                <DateOnlyInput valueYmd={receiptForm.receivedDate} onChangeYmd={(v) => setReceiptForm((f) => ({ ...f, receivedDate: v }))} />
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
      <div className="grid grid-cols-3 gap-4 print:hidden pdf-hide">
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

      <div ref={pdfRef} className="space-y-6 print-doc print:space-y-3">
      <Card className="print:shadow-none print:border-none print:bg-transparent print:rounded-none">
        <CardContent className="pt-6 pb-6 print:pt-0 print:pb-2">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              {logoPreviewUrl ? (
                <img src={logoPreviewUrl} alt="Firm logo" className="max-h-12 max-w-[200px] object-contain mb-2" />
              ) : null}
              <div className="text-lg font-bold text-slate-900">{firm?.name ?? "—"}</div>
              {firm?.registrationNo ? <div className="text-xs text-slate-500 mt-0.5">Registration No: {firm.registrationNo}</div> : null}
              {firm?.sstNo || firm?.stNumber ? <div className="text-xs text-slate-500">SST No: {firm?.sstNo ?? firm?.stNumber}</div> : null}
              {firm?.tinNumber ? <div className="text-xs text-slate-500">TIN: {firm.tinNumber}</div> : null}
              {firm?.address ? <div className="text-xs text-slate-600 mt-2 whitespace-pre-wrap">{firm.address}</div> : null}
              {(firm?.phone || firm?.email) ? (
                <div className="text-xs text-slate-600 mt-1">
                  {firm?.phone ? `Tel: ${firm.phone}` : ""}
                  {firm?.phone && firm?.email ? " · " : ""}
                  {firm?.email ? `Email: ${firm.email}` : ""}
                </div>
              ) : null}
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500">TAX INVOICE</div>
              <div className="text-2xl font-bold text-slate-900">{inv.invoiceNo}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="print:shadow-none print:border-none print:bg-transparent print:rounded-none">
        <CardContent className="pt-4 pb-4 print:pt-0 print:pb-0 print:px-0">
          <div className="grid grid-cols-2 gap-3">
            <BillToBlock
              clientName={inv.billToName ?? null}
              address={inv.billToAddress ?? null}
              clientDetails={Array.isArray(inv.clientDetails) ? inv.clientDetails : []}
            />
          <div className="text-right">
            <div className="grid gap-1 justify-end">
              <div className="flex justify-between gap-4 text-xs">
                <span className="text-slate-500">Invoice No</span>
                <span className="font-mono text-slate-900">{inv.invoiceNo}</span>
              </div>
              <div className="flex justify-between gap-4 text-xs">
                <span className="text-slate-500">Issued</span>
                <span className="font-mono text-slate-900">{inv.issuedDate ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-4 text-xs">
                <span className="text-slate-500">Due</span>
                <span className="font-mono text-slate-900">{inv.dueDate ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-4 text-xs">
                <span className="text-slate-500">Status</span>
                <span className="font-mono text-slate-900">{String(inv.status ?? "").replace(/_/g, " ") || "—"}</span>
              </div>
            </div>
          </div>
          </div>
        </CardContent>
      </Card>

      {/* Invoice line items */}
      <Card className="print:shadow-none print:border-none print:bg-transparent print:rounded-none">
        <CardHeader className="pb-2 print:pb-1 print:px-0">
          <CardTitle className="text-base font-semibold">Invoice Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0 print:px-0">
          {[
            { label: "A — Professional Fees (E-invoice)", items: feeItems },
            { label: "B — Disbursements (Trust / Pass-through)", items: disbursementItems },
          ].filter(g => g.items.length > 0).map((group) => (
            <div key={group.label}>
              <div className="px-4 py-2 bg-slate-50 border-y text-xs font-semibold text-slate-500 uppercase tracking-wide print:px-0 print:py-1 print:bg-transparent print:border-black print:text-black">
                {group.label}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px] print:min-w-0 print:text-xs">
                  <thead>
                    <tr className="text-slate-400 text-xs print:text-black print:border-b print:border-black">
                      <th className="px-4 py-2 text-left font-medium print:px-0">Description</th>
                      <th className="px-4 py-2 text-left font-medium">Type</th>
                      <th className="px-4 py-2 text-right font-medium">Excl. Tax</th>
                      <th className="px-4 py-2 text-right font-medium">SST</th>
                      <th className="px-4 py-2 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item: InvoiceItem) => (
                      <tr key={item.id} className="border-t border-slate-100 hover:bg-slate-50 print:hover:bg-transparent print:border-black print:break-inside-avoid">
                        <td className="px-4 py-2.5 text-slate-800 print:px-0">{item.description}</td>
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
            </div>
          ))}

          <div className="border-t p-4 print:p-0 print:pt-2 print:border-black">
            <div className="ml-auto max-w-xs space-y-1.5 print:text-xs">
              <div className="flex justify-between text-sm text-slate-600 print:text-xs print:text-black">
                <span>Subtotal (excl. tax)</span><span className="font-mono">{fmt(inv.subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm text-slate-600 print:text-xs print:text-black">
                <span>SST / Tax</span><span className="font-mono">{fmt(inv.taxTotal)}</span>
              </div>
              <div className="flex justify-between text-base font-bold text-slate-900 border-t pt-2 print:text-sm print:pt-1 print:border-black">
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

      <div className="hidden print:block pdf-show pt-8">
        <div className="ml-auto w-[280px]">
          <div className="border-t border-black pt-2 text-xs text-slate-900 text-center">
            Authorized Signature
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
