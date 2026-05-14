import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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

type ReceiptAllocation = {
  id: number;
  invoiceId?: number | null;
  amount: number | string;
  notes?: string | null;
};

type ReceiptDetailResponse = {
  id: number;
  receiptNo: string;
  receivedDate: string;
  paymentMethod: string;
  accountType: string;
  amount: number | string;
  referenceNo?: string | null;
  notes?: string | null;
  isReversed?: boolean;
  allocations?: ReceiptAllocation[];
};

export default function ReceiptDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();

  const recQuery = useQuery<ReceiptDetailResponse>({
    queryKey: ["receipt", id],
    queryFn: () => apiFetchJson<ReceiptDetailResponse>(`/receipts/${id}`),
    retry: false,
  });

  const firmQuery = useQuery<FirmSettings>({
    queryKey: ["firm-settings"],
    queryFn: () => apiFetchJson<FirmSettings>("/firm-settings"),
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

  if (recQuery.isLoading) return <div className="py-16 text-center text-slate-400">Loading receipt…</div>;
  if (recQuery.isError) return <div className="py-10"><QueryFallback title="Receipt unavailable" error={recQuery.error} onRetry={() => recQuery.refetch()} isRetrying={recQuery.isFetching} /></div>;
  const rec = recQuery.data;
  if (!rec) return <div className="py-16 text-center text-slate-400">Receipt not found</div>;

  return (
    <div className="space-y-6 min-w-0 print-doc print:space-y-3">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/app/accounting?tab=receipts")} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.print()}>
          <Printer className="w-4 h-4" /> Print
        </Button>
      </div>

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
              <div className="text-xs text-slate-500">OFFICIAL RECEIPT</div>
              <div className="text-2xl font-bold text-slate-900">{rec.receiptNo}</div>
              {rec.isReversed ? <div className="text-xs text-red-600 mt-1">REVERSED</div> : null}
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-slate-500">Date Received</div>
              <div className="text-sm font-medium text-slate-900">{rec.receivedDate}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Amount</div>
              <div className="text-sm font-bold text-slate-900">{fmt(rec.amount)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Payment Method</div>
              <div className="text-sm font-medium text-slate-900">{rec.paymentMethod?.replace(/_/g, " ")}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Account</div>
              <div className="text-sm font-medium text-slate-900">{rec.accountType}</div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-xs text-slate-500">Reference No</div>
              <div className="text-sm text-slate-900">{rec.referenceNo || "—"}</div>
            </div>
            {rec.notes ? (
              <div className="sm:col-span-2">
                <div className="text-xs text-slate-500">Notes</div>
                <div className="text-sm text-slate-900 whitespace-pre-wrap">{rec.notes}</div>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {(rec.allocations ?? []).length > 0 ? (
        <Card className="print:shadow-none print:border-none print:bg-transparent print:rounded-none">
          <CardContent className="pt-4 pb-4 print:pt-2 print:pb-0 print:px-0">
            <div className="text-sm font-semibold text-slate-900 mb-2">Allocations</div>
            <div className="overflow-x-auto border rounded-lg print:border-black print:rounded-none">
              <table className="w-full text-sm print:text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide print:bg-transparent print:border-black print:text-black">
                    <th className="px-4 py-3 text-left font-medium">Invoice</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 text-left font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(rec.allocations ?? []).map((a) => (
                    <tr key={a.id} className="print:break-inside-avoid">
                      <td className="px-4 py-3">{a.invoiceId ? `Invoice #${a.invoiceId}` : "—"}</td>
                      <td className="px-4 py-3 text-right font-mono">{fmt(a.amount)}</td>
                      <td className="px-4 py-3 text-slate-600">{a.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="hidden print:block pt-8">
        <div className="ml-auto w-[280px]">
          <div className="border-t border-black pt-2 text-xs text-slate-900 text-center">
            Authorized Signature
          </div>
        </div>
      </div>
    </div>
  );
}
