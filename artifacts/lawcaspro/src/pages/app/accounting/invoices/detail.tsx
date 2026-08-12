import { useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, CheckCircle, XCircle, Plus, AlertCircle, FileText, RefreshCw, Send, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DateOnlyInput } from "@/components/date-only-input";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { getApiFailureCodeFromError } from "@/lib/api-failure";
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
  einvoiceStatus?: string | null;
  einvoiceExternalSubmissionId?: string | null;
  einvoiceSubmittedAt?: string | null;
  einvoiceLastCheckedAt?: string | null;
  einvoiceErrorCode?: string | null;
  einvoiceErrorMessage?: string | null;
  einvoiceRetryCount?: number;
  einvoiceClassification?: string | null;
  einvoiceSourceInvoiceId?: number | null;
};

type EInvoiceStatusResponse = {
  invoice: {
    einvoiceStatus: string | null;
    einvoiceExternalSubmissionId: string | null;
    einvoiceSubmittedAt: string | null;
    einvoiceLastCheckedAt: string | null;
    einvoiceErrorCode: string | null;
    einvoiceErrorMessage: string | null;
    einvoiceRetryCount: number;
    einvoiceClassification: string | null;
    einvoiceSourceInvoiceId: number | null;
  };
  submissions: Array<{
    id: number;
    status: string;
    externalSubmissionId?: string | null;
    submittedAt?: string | null;
    lastCheckedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryCount: number;
    createdAt: string | null;
  }>;
};

const EINVOICE_STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-600",
  READY: "bg-sky-100 text-sky-700",
  SUBMITTING: "bg-amber-100 text-amber-700",
  SUBMITTED: "bg-blue-100 text-blue-700",
  VALID: "bg-green-100 text-green-700",
  INVALID: "bg-red-100 text-red-700",
  CANCELLED: "bg-slate-200 text-slate-600",
  ERROR: "bg-red-100 text-red-600",
  RETRY_PENDING: "bg-orange-100 text-orange-700",
};

const EINVOICE_CLASS_LABELS: Record<string, string> = {
  OFFICE_INCOME: "Office Income (Professional Fee)",
  TAXABLE_TRAVEL_MISC: "Taxable Travelling / Misc",
  CLIENT_STAKEHOLDER_MONEY: "Stakeholder Money (Stamp / Reg, NOT firm income)",
  REIMBURSEMENT: "Reimbursement",
  DISBURSEMENT: "Disbursement",
  OVERCOLLECT_TRANSFER: "Overcollect Transfer",
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
  const [integrationNotConfigured, setIntegrationNotConfigured] = useState(false);
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

  const einvQuery = useQuery<EInvoiceStatusResponse>({
    queryKey: ["einvoice-status", id],
    queryFn: () => apiFetchJson<EInvoiceStatusResponse>(`/invoices/${id}/einvoice`),
    enabled: !!id,
    retry: false,
    staleTime: 15_000,
    refetchInterval: (q) => {
      const s = String(q.state.data?.invoice.einvoiceStatus ?? "");
      return s === "SUBMITTING" || s === "SUBMITTED" ? 5000 : false;
    },
  });

  const einvPrepareMut = useMutation({
    mutationFn: () => apiFetchJson(`/invoices/${id}/einvoice/prepare`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["einvoice-status", id] }); qc.invalidateQueries({ queryKey: ["invoice", id] }); toast({ title: "e-Invoice prepared", description: "Classification computed. Ready to submit." }); },
    onError: (e) => toastError(toast, e, "Prepare failed"),
  });

  const einvSubmitMut = useMutation({
    mutationFn: async () => {
      const idempotencyKey = crypto.randomUUID();
      return apiFetchJson(`/invoices/${id}/einvoice/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey }),
      });
    },
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["einvoice-status", id] });
      qc.invalidateQueries({ queryKey: ["invoice", id] });
      setIntegrationNotConfigured(false);
      if (r?.skippedDueToDuplicateSourceLink) {
        toast({ title: "Submit skipped (double invoice guard)", description: r?.errorMessage ?? "Source already linked to VALID submission." });
      } else if (r?.status === "VALID" || r?.status === "SUBMITTED") {
        toast({ title: "e-Invoice submitted", description: `Status: ${r?.status}${r?.externalSubmissionId ? " · " + r.externalSubmissionId : ""}` });
      } else {
        toast({ title: "Submit finished", description: `Status: ${r?.status ?? "unknown"}` });
      }
    },
    onError: (e: any) => {
      const code = getApiFailureCodeFromError(e);
      if (code === "EINVOICE_INTEGRATION_NOT_CONFIGURED") {
        setIntegrationNotConfigured(true);
        toast({ variant: "destructive", title: "Integration Not Configured", description: "Setup required before submitting to MyInvois portal." });
        return;
      }
      const detail = e?.responseJson ?? (typeof e?.message === "string" ? e.message : undefined);
      if (detail === "EINVOICE_SANDBOX_DISABLED" || code === "EINVOICE_SANDBOX_DISABLED") toast({ variant: "destructive", title: "Sandbox disabled", description: "Set EINVOICE_SANDBOX=1 on server to enable test-mode submit. Production submit is NOT allowed." });
      else toastError(toast, e, "Submit failed");
    },
  });

  const einvRetryMut = useMutation({
    mutationFn: () => apiFetchJson(`/invoices/${id}/einvoice/retry`, { method: "POST" }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["einvoice-status", id] }); qc.invalidateQueries({ queryKey: ["invoice", id] }); toast({ title: "e-Invoice retried", description: `Status: ${r?.status ?? "unknown"}` }); },
    onError: (e) => toastError(toast, e, "Retry failed"),
  });

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

      {integrationNotConfigured && (
        <Card className="print:hidden pdf-hide border-amber-200 bg-amber-50">
          <CardContent className="pt-4 pb-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold text-amber-800">Integration Not Configured — Setup Required</div>
              <div className="text-sm text-amber-700 mt-0.5">e-Invoice (MyInvois) portal credentials have not been configured for this firm. Configure them in Firm Settings before submitting.</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* e-Invoice Status card */}
      <Card className="print:hidden pdf-hide border-indigo-100 bg-indigo-50/40">
        <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-indigo-600" /> e-Invoice Status (MyInvois · Sandbox)
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Sandbox mode only. Production submit is NOT enabled. Set <code className="bg-slate-100 px-1 rounded">EINVOICE_SANDBOX=1</code> server-side to submit.
            </CardDescription>
          </div>
          {(einvQuery.data || inv.einvoiceStatus) ? (
            <Badge className={cn("text-xs font-medium", EINVOICE_STATUS_COLORS[String(einvQuery.data?.invoice.einvoiceStatus ?? inv.einvoiceStatus ?? "DRAFT")] ?? "bg-slate-100 text-slate-600")}>
              {String(einvQuery.data?.invoice.einvoiceStatus ?? inv.einvoiceStatus ?? "DRAFT")}
            </Badge>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {einvQuery.isLoading ? (
            <div className="text-slate-400 text-xs">Loading status…</div>
          ) : einvQuery.isError ? (
            <div className="text-xs text-red-500">Failed to load e-Invoice status</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <div className="text-slate-500">Classification</div>
                  <div className="font-medium text-slate-800 mt-0.5">
                    {EINVOICE_CLASS_LABELS[String(einvQuery.data?.invoice.einvoiceClassification ?? inv.einvoiceClassification ?? "")] ??
                      (einvQuery.data?.invoice.einvoiceClassification ?? inv.einvoiceClassification) ??
                      <span className="text-slate-400">—</span>}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Last Submitted</div>
                  <div className="font-mono text-slate-800 mt-0.5">
                    {String(einvQuery.data?.invoice.einvoiceSubmittedAt ?? inv.einvoiceSubmittedAt ?? "").slice(0, 16).replace("T", " ") || <span className="text-slate-400">—</span>}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Retry Count</div>
                  <div className="font-medium text-slate-800 mt-0.5">{Number(einvQuery.data?.invoice.einvoiceRetryCount ?? inv.einvoiceRetryCount ?? 0)}</div>
                </div>
                <div>
                  <div className="text-slate-500">External Submission ID</div>
                  <div className="font-mono text-xs text-slate-800 mt-0.5 break-all">
                    {einvQuery.data?.invoice.einvoiceExternalSubmissionId ?? inv.einvoiceExternalSubmissionId ?? <span className="text-slate-400">—</span>}
                  </div>
                </div>
              </div>

              {(einvQuery.data?.invoice.einvoiceErrorMessage ?? inv.einvoiceErrorMessage) && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs space-y-1">
                  <div className="font-medium text-red-700 flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5" /> Error
                    {einvQuery.data?.invoice.einvoiceErrorCode ?? inv.einvoiceErrorCode ? (
                      <code className="ml-2 bg-white px-1 rounded">{einvQuery.data?.invoice.einvoiceErrorCode ?? inv.einvoiceErrorCode}</code>
                    ) : null}
                  </div>
                  <div className="text-red-600 whitespace-pre-wrap">{einvQuery.data?.invoice.einvoiceErrorMessage ?? inv.einvoiceErrorMessage}</div>
                </div>
              )}

              {Array.isArray(einvQuery.data?.submissions) && einvQuery.data!.submissions.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 select-none">
                    Submission history ({einvQuery.data!.submissions.length})
                  </summary>
                  <div className="mt-2 space-y-2 max-h-64 overflow-auto rounded-md border border-slate-200 bg-white p-2">
                    {einvQuery.data!.submissions.map((s) => (
                      <div key={s.id} className="border-b border-slate-100 last:border-b-0 py-1.5 grid grid-cols-4 gap-2">
                        <div className="col-span-1"><Badge className="text-[10px]">{s.status}</Badge></div>
                        <div className="col-span-1 text-slate-500 font-mono text-[10px]">{String(s.createdAt ?? "").slice(0,16).replace("T"," ") || "—"}</div>
                        <div className="col-span-1 text-slate-500 text-[10px]">retries: {s.retryCount}</div>
                        <div className="col-span-1 text-[10px] font-mono text-slate-600 truncate" title={s.externalSubmissionId ?? undefined}>
                          {s.externalSubmissionId ?? "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs h-8"
              onClick={() => einvPrepareMut.mutate()}
              disabled={einvPrepareMut.isPending || einvSubmitMut.isPending || einvRetryMut.isPending}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", einvPrepareMut.isPending ? "animate-spin" : "")} />
              Prepare / Classify
            </Button>
            <Button
              size="sm"
              className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700 text-white"
              onClick={() => einvSubmitMut.mutate()}
              disabled={integrationNotConfigured || einvPrepareMut.isPending || einvSubmitMut.isPending || einvRetryMut.isPending}
              title={integrationNotConfigured ? "Integration not configured — setup required" : undefined}
            >
              <Send className="w-3.5 h-3.5" />
              {einvSubmitMut.isPending ? "Submitting…" : "Submit (Sandbox)"}
            </Button>
            {(() => {
              const st = String(einvQuery.data?.invoice.einvoiceStatus ?? inv.einvoiceStatus ?? "DRAFT");
              const canRetry = st === "ERROR" || st === "RETRY_PENDING" || st === "INVALID";
              return (
                <Button
                  size="sm"
                  variant="outline"
                  className={cn("gap-1.5 text-xs h-8", canRetry ? "text-amber-700 border-amber-200 hover:bg-amber-50" : "opacity-50 cursor-not-allowed")}
                  onClick={() => canRetry && einvRetryMut.mutate()}
                  disabled={!canRetry || einvPrepareMut.isPending || einvSubmitMut.isPending || einvRetryMut.isPending}
                  title={canRetry ? "Retry submission" : "Retry only allowed for ERROR / RETRY_PENDING / INVALID"}
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", einvRetryMut.isPending ? "animate-spin" : "")} />
                  Retry
                </Button>
              );
            })()}
          </div>
        </CardContent>
      </Card>

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
