import { useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useGetQuotation, getGetQuotationQueryKey, getListQuotationsQueryKey, useUpdateQuotation, useDeleteQuotation, useDuplicateQuotation } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Save, Copy, Trash2, Pencil, Download, Plus } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { BillToBlock } from "@/components/accounting/BillToBlock";
import { DocumentPrintStyles } from "@/components/accounting/DocumentPrintStyles";
import { exportElementToPdf } from "@/lib/pdf-export";

const DEFAULT_TAX_RATE = 8;

function calcTax(amount: number, taxCode: string, rate: number) {
  const code = String(taxCode || "").trim().toUpperCase();
  const effectiveRate = (code === "Z" || code === "ZR" || code === "O" || code === "NT" || amount === 0) ? 0 : rate;
  if (effectiveRate === 0) return { taxRate: 0, taxAmount: 0, amountInclTax: amount };
  const taxAmount = Math.round(amount * effectiveRate) / 100;
  return { taxRate: effectiveRate, taxAmount, amountInclTax: amount + taxAmount };
}

interface LocalItem {
  id: string;
  section: string;
  category: string;
  itemNo: string;
  subItemNo: string;
  description: string;
  taxCode: string;
  itemCategory: "fee" | "disbursement";
  amountExclTax: number;
  taxRate: number;
  taxAmount: number;
  amountInclTax: number;
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

type ClientDetailRow = { id: string; name: string; tin: string };

function genId(): string {
  return Math.random().toString(36).slice(2, 9) + "-" + Date.now().toString(36);
}

function normalizeClientDetails(v: unknown, fallbackName: string, fallbackTin: string): ClientDetailRow[] {
  const fromAny = (() => {
    if (!v) return null;
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  })();
  if (fromAny && Array.isArray(fromAny)) {
    const rows = fromAny
      .map((r: any) => ({ name: typeof r?.name === "string" ? r.name.trim() : "", tin: typeof r?.tin === "string" ? r.tin.trim() : "" }))
      .filter((r) => r.name)
      .map((r) => ({ id: genId(), ...r }));
    if (rows.length > 0) return rows;
  }
  const name = fallbackName.trim();
  if (!name) return [];
  return [{ id: genId(), name, tin: fallbackTin.trim() }];
}

export default function QuotationDetail() {
  const { id } = useParams<{ id: string }>();
  const quotationId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: quotation, isLoading, isError, error, refetch, isFetching } = useGetQuotation(quotationId, {
    query: { enabled: !!quotationId, queryKey: getGetQuotationQueryKey(quotationId) }
  });

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

  const updateMutation = useUpdateQuotation();
  const deleteMutation = useDeleteQuotation();
  const duplicateMutation = useDuplicateQuotation();

  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<any>(null);
  const [editItems, setEditItems] = useState<LocalItem[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const pdfRef = useRef<HTMLDivElement>(null);

  const startEditing = () => {
    if (!quotation) return;
    const currentTaxRate = Number((quotation as any)?.taxRate) || DEFAULT_TAX_RATE;
    const currentClientDetails = normalizeClientDetails(
      (quotation as any).clientDetails ?? (quotation as any).client_details,
      String((quotation as any).clientName ?? ""),
      String((quotation as any).clientTin ?? "")
    );
    setEditData({
      referenceNo: quotation.referenceNo,
      clientDetails: currentClientDetails,
      clientAddress: (quotation as any).clientAddress || "",
      propertyDescription: quotation.propertyDescription || "",
      purchasePrice: quotation.purchasePrice ? String(quotation.purchasePrice) : "",
      bankName: quotation.bankName || "",
      loanAmount: quotation.loanAmount || "",
      taxRate: currentTaxRate,
      status: quotation.status,
    });
    setEditItems(
      (quotation.items || []).map((item: any, idx: number) => ({
        id: String(item.id || idx),
        section: item.section,
        category: item.category || "",
        itemNo: item.itemNo || "",
        subItemNo: item.subItemNo || "",
        description: item.description,
        taxCode: item.taxCode,
        itemCategory: item.itemCategory === "disbursement" ? "disbursement" : (item.section === "fees" ? "fee" : "disbursement"),
        amountExclTax: item.amountExclTax,
        taxRate: currentTaxRate,
        taxAmount: item.taxAmount,
        amountInclTax: item.amountInclTax,
      }))
    );
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditData(null);
    setEditItems([]);
  };

  useEffect(() => {
    if (!isEditing) return;
    const rate = Number((editData as any)?.taxRate) || DEFAULT_TAX_RATE;
    setEditItems((prev) =>
      prev.map((item) => {
        const nextTax = calcTax(item.amountExclTax, item.taxCode, rate);
        return { ...item, taxRate: nextTax.taxRate, taxAmount: nextTax.taxAmount, amountInclTax: nextTax.amountInclTax };
      })
    );
  }, [isEditing, (editData as any)?.taxRate]);

  const updateItemAmount = (itemId: string, amount: number) => {
    setEditItems(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      const rate = Number((editData as any)?.taxRate) || DEFAULT_TAX_RATE;
      const nextTax = calcTax(amount, item.taxCode, rate);
      return { ...item, amountExclTax: amount, taxRate: nextTax.taxRate, taxAmount: nextTax.taxAmount, amountInclTax: nextTax.amountInclTax };
    }));
  };

  const updateItemTaxCode = (itemId: string, taxCode: string) => {
    setEditItems(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      const rate = Number((editData as any)?.taxRate) || DEFAULT_TAX_RATE;
      const nextTax = calcTax(item.amountExclTax, taxCode, rate);
      return { ...item, taxCode, taxRate: nextTax.taxRate, taxAmount: nextTax.taxAmount, amountInclTax: nextTax.amountInclTax };
    }));
  };

  const addAttachmentItem = () => {
    const attItems = editItems.filter(i => i.section === "attachment");
    const rate = Number((editData as any)?.taxRate) || DEFAULT_TAX_RATE;
    setEditItems(prev => [...prev, {
      id: `new-${Date.now()}`,
      section: "attachment",
      category: "attachment",
      itemNo: String(attItems.length + 1),
      subItemNo: "",
      description: "",
      taxCode: "T",
      amountExclTax: 0,
      taxRate: rate,
      taxAmount: 0,
      amountInclTax: 0,
    }]);
  };

  const removeItem = (itemId: string) => {
    setEditItems(prev => prev.filter(i => i.id !== itemId));
  };

  const saveEdits = () => {
    const items = editItems.filter((i) => i.amountExclTax > 0).map((item, idx) => ({
      section: item.section,
      category: item.category,
      itemNo: item.itemNo,
      subItemNo: item.subItemNo,
      description: item.description,
      taxCode: item.taxCode,
      itemCategory: item.itemCategory,
      amountExclTax: item.amountExclTax,
      taxRate: item.taxRate,
      taxAmount: item.taxAmount,
      amountInclTax: item.amountInclTax,
      sortOrder: idx,
    }));

    updateMutation.mutate(
      {
        id: quotationId,
        data: {
          ...editData,
          purchasePrice: editData.purchasePrice || undefined,
          items,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetQuotationQueryKey(quotationId) });
          queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey() });
          setIsEditing(false);
          toast({ title: "Quotation updated" });
        },
        onError: (e) => toastError(toast, e, "Update failed"),
      }
    );
  };

  const handleDelete = () => {
    if (!confirm("Are you sure you want to delete this quotation?")) return;
    deleteMutation.mutate(
      { id: quotationId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey() });
          toast({ title: "Quotation deleted" });
          setLocation("/app/accounting?tab=quotations");
        },
        onError: (e) => toastError(toast, e, "Delete failed"),
      }
    );
  };

  const handleDuplicate = () => {
    duplicateMutation.mutate(
      { id: quotationId },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey() });
          toast({ title: "Quotation duplicated" });
          setLocation(`/app/quotations/${data.id}`);
        },
        onError: (e) => toastError(toast, e, "Duplicate failed"),
      }
    );
  };

  const handleDownloadPdf = async () => {
    if (!pdfRef.current || isEditing) return;
    setIsExporting(true);
    try {
      const filename = `Quotation-${String((quotation as any)?.referenceNo ?? quotationId)}.pdf`;
      await exportElementToPdf({ element: pdfRef.current, filename });
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading) return <div className="py-10 text-sm text-slate-500">Loading quotation...</div>;
  if (isError) return <div className="py-10"><QueryFallback title="Quotation unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} /></div>;
  if (!quotation) return <div className="py-10 text-sm text-slate-500">Quotation not found</div>;

  const effectiveTaxRate = Number((isEditing ? (editData as any)?.taxRate : (quotation as any)?.taxRate)) || DEFAULT_TAX_RATE;
  const viewClientDetails = normalizeClientDetails(
    (quotation as any).clientDetails ?? (quotation as any).client_details,
    String((quotation as any).clientName ?? ""),
    String((quotation as any).clientTin ?? "")
  );

  const items = isEditing ? editItems : (quotation.items || []).map((item: any, idx: number) => ({
    id: String(item.id || idx),
    section: item.section,
    category: item.category || "",
    itemNo: item.itemNo || "",
    subItemNo: item.subItemNo || "",
    description: item.description,
    taxCode: item.taxCode,
    itemCategory: item.itemCategory === "disbursement" ? "disbursement" : (item.section === "fees" ? "fee" : "disbursement"),
    amountExclTax: Number(item.amountExclTax) || 0,
    taxRate: Number(item.taxRate) || effectiveTaxRate,
    taxAmount: Number(item.taxAmount) || 0,
    amountInclTax: Number(item.amountInclTax) || 0,
  }));

  const disbursementItems = items.filter((i: LocalItem) => i.section === "disbursement");
  const feesItems = items.filter((i: LocalItem) => i.section === "fees");
  const reimbursementItems = items.filter((i: LocalItem) => i.section === "reimbursement");
  const attachmentItems = items.filter((i: LocalItem) => i.section === "attachment");

  const calcSectionTotal = (sectionItems: LocalItem[]) => ({
    totalExclTax: sectionItems.reduce((s: number, i: LocalItem) => s + i.amountExclTax, 0),
    totalTax: sectionItems.reduce((s: number, i: LocalItem) => s + i.taxAmount, 0),
    totalInclTax: sectionItems.reduce((s: number, i: LocalItem) => s + i.amountInclTax, 0),
  });

  const disbTotals = calcSectionTotal(disbursementItems);
  const feesTotals = calcSectionTotal(feesItems);
  const reimbTotals = calcSectionTotal(reimbursementItems);
  const attTotals = calcSectionTotal(attachmentItems);

  const grandTotalExclTax = disbTotals.totalExclTax + feesTotals.totalExclTax + reimbTotals.totalExclTax + attTotals.totalExclTax;
  const grandTotalTax = disbTotals.totalTax + feesTotals.totalTax + reimbTotals.totalTax + attTotals.totalTax;
  const grandTotalInclTax = disbTotals.totalInclTax + feesTotals.totalInclTax + reimbTotals.totalInclTax + attTotals.totalInclTax;
  const roundingAdj = Math.round(grandTotalInclTax * 20) / 20 - grandTotalInclTax;
  const totalPayable = grandTotalInclTax + roundingAdj;

  const formatRM = (v: number) => `RM ${v.toFixed(2)}`;
  const data = isEditing ? editData : quotation;

  const statusColors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    sent: "bg-blue-100 text-blue-700",
    accepted: "bg-green-100 text-green-700",
    rejected: "bg-red-100 text-red-700",
  };

  const renderSectionTable = (sectionLabel: string, sectionItems: LocalItem[], totals: { totalExclTax: number; totalTax: number; totalInclTax: number }) => {
    if (sectionItems.length === 0) return null;
    const isHeaderRow = (item: LocalItem) =>
      !item.subItemNo && item.description === item.description.toUpperCase() && item.section !== "attachment";
    const visibleRows = sectionItems.filter((item) => {
      if (isEditing) return true;
      if (isHeaderRow(item)) return true;
      const excl = Number(item.amountExclTax) || 0;
      const incl = Number(item.amountInclTax) || 0;
      return excl > 0 || incl > 0;
    });
    const hasNonHeader = visibleRows.some((i) => !isHeaderRow(i));
    if (!hasNonHeader) return null;
    return (
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-800 mb-2 uppercase">{sectionLabel}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px] print:min-w-0 print:text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 print:bg-transparent print:border-black">
              <th className="text-left px-3 py-2 font-medium text-slate-600 w-10 print:px-2 print:py-1">No.</th>
              <th className="text-left px-3 py-2 font-medium text-slate-600 print:px-2 print:py-1">Description</th>
              <th className="text-center px-3 py-2 font-medium text-slate-600 w-20 print:px-2 print:py-1">Tax Code</th>
              <th className="text-right px-3 py-2 font-medium text-slate-600 w-32 print:px-2 print:py-1">Excl. ST (RM)</th>
              <th className="text-right px-3 py-2 font-medium text-slate-600 w-28 print:px-2 print:py-1">ST @ {effectiveTaxRate}%</th>
              <th className="text-right px-3 py-2 font-medium text-slate-600 w-32 print:px-2 print:py-1">Incl. ST (RM)</th>
              {isEditing && sectionLabel === "ATTACHMENT I" && <th className="w-10"></th>}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((item) => {
              const isHeader = isHeaderRow(item);
              return (
                <tr key={item.id} className={`border-b border-slate-100 print:border-black print:break-inside-avoid ${isHeader ? "bg-slate-50/50 print:bg-transparent" : ""}`}>
                  <td className="px-3 py-1.5 text-slate-500 text-xs print:px-2 print:py-1">{item.subItemNo || item.itemNo}</td>
                  <td className={`px-3 py-1.5 print:px-2 print:py-1 ${isHeader ? "font-semibold text-slate-800" : "text-slate-600"}`}>
                    {isEditing && sectionLabel === "ATTACHMENT I" ? (
                      <Input
                        value={item.description}
                        onChange={e => setEditItems(prev => prev.map(i => i.id === item.id ? { ...i, description: e.target.value } : i))}
                        className="h-7 text-xs"
                      />
                    ) : item.description}
                  </td>
                  <td className="px-3 py-1.5 text-center text-xs print:px-2 print:py-1">
                    {!isHeader ? (
                      isEditing ? (
                        <select
                          value={item.taxCode}
                          onChange={(e) => updateItemTaxCode(item.id, e.target.value)}
                          className="h-7 border border-slate-200 rounded-md px-2 text-xs bg-white print:hidden"
                        >
                          <option value="T">T</option>
                          <option value="Z">Z</option>
                        </select>
                      ) : (
                        <span className="text-xs text-slate-700">{item.taxCode}</span>
                      )
                    ) : ""}
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs print:px-2 print:py-1">
                    {isEditing && !isHeader ? (
                      <Input
                        type="number"
                        value={item.amountExclTax || ""}
                        onChange={e => updateItemAmount(item.id, parseFloat(e.target.value) || 0)}
                        className="h-7 text-right text-xs w-28 ml-auto"
                        placeholder="0.00"
                      />
                    ) : !isHeader ? item.amountExclTax.toFixed(2) : ""}
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs text-slate-500 print:px-2 print:py-1">
                    {!isHeader ? item.taxAmount.toFixed(2) : ""}
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs font-medium print:px-2 print:py-1">
                    {!isHeader ? item.amountInclTax.toFixed(2) : ""}
                  </td>
                  {isEditing && sectionLabel === "ATTACHMENT I" && (
                    <td className="px-1 py-1.5">
                      <Button variant="ghost" size="sm" onClick={() => removeItem(item.id)} className="text-red-500 h-6 w-6 p-0">
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-medium text-sm print:bg-transparent print:border-t print:border-black">
              <td colSpan={3} className="px-3 py-2 text-right print:px-2 print:py-1">Total {sectionLabel}</td>
              <td className="px-3 py-2 text-right print:px-2 print:py-1">{formatRM(totals.totalExclTax)}</td>
              <td className="px-3 py-2 text-right print:px-2 print:py-1">{formatRM(totals.totalTax)}</td>
              <td className="px-3 py-2 text-right print:px-2 print:py-1">{formatRM(totals.totalInclTax)}</td>
              {isEditing && sectionLabel === "ATTACHMENT I" && <td></td>}
            </tr>
          </tfoot>
          </table>
        </div>
        {isEditing && sectionLabel === "ATTACHMENT I" && (
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={addAttachmentItem}>
              <Plus className="w-3 h-3 mr-1" /> Add Item
            </Button>
          </div>
        )}
      </div>
    );
  };

  const billToDetails = isEditing ? (Array.isArray((editData as any)?.clientDetails) ? (editData as any).clientDetails : []) : viewClientDetails;
  const billToAddress = isEditing ? String((editData as any)?.clientAddress ?? "") : String((quotation as any).clientAddress ?? "");

  return (
    <div className="space-y-6 min-w-0">
      <DocumentPrintStyles />
      <div className="flex items-start justify-between gap-3 flex-wrap print:hidden pdf-hide">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/app/accounting?tab=quotations")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Quotation</h1>
            <p className="text-sm text-slate-500 mt-1">{data.clientName}</p>
          </div>
          <span className={`ml-3 inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${statusColors[data.status] || statusColors.draft}`}>
            {data.status}
          </span>
        </div>
        <div className="flex gap-2 flex-wrap">
          {isEditing ? (
            <>
              <Button variant="outline" onClick={cancelEditing}>Cancel</Button>
              <Button onClick={saveEdits} disabled={updateMutation.isPending} className="bg-amber-500 hover:bg-amber-600 text-white">
                <Save className="w-4 h-4 mr-2" />
                {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleDownloadPdf} disabled={isExporting}>
                <Download className="w-4 h-4 mr-1" /> {isExporting ? "Generating..." : "Download PDF"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleDuplicate} disabled={duplicateMutation.isPending || deleteMutation.isPending}>
                <Copy className="w-4 h-4 mr-1" /> {duplicateMutation.isPending ? "Duplicating..." : "Duplicate"}
              </Button>
              <Button variant="outline" size="sm" onClick={startEditing} disabled={duplicateMutation.isPending || deleteMutation.isPending}><Pencil className="w-4 h-4 mr-1" /> Edit</Button>
              <Button variant="outline" size="sm" onClick={handleDelete} disabled={deleteMutation.isPending || duplicateMutation.isPending} className="text-red-500 hover:text-red-700">
                <Trash2 className="w-4 h-4 mr-1" /> Delete
              </Button>
            </>
          )}
        </div>
      </div>

      <div ref={pdfRef} className="space-y-6 print-doc print:space-y-3 print:bg-white print:m-0 print:p-0 print:text-sm">
      <Card className="print:shadow-none print:border-none print:bg-white print:m-0 print:p-0 print:rounded-none">
        <CardContent className="pt-6 pb-6 print:pt-0 print:pb-2 print:px-0">
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
              <div className="text-xs text-slate-500">QUOTATION</div>
              <div className="text-2xl font-bold text-slate-900">{data.referenceNo}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="print:shadow-none print:border-none print:bg-transparent print:rounded-none">
        <CardContent className="pt-4 pb-4 print:pt-0 print:pb-0 print:px-0">
          <div className="grid grid-cols-2 gap-3">
            <BillToBlock
              clientName={data.clientName ?? null}
              clientTin={(quotation as any).clientTin ?? null}
              address={billToAddress || null}
              clientDetails={billToDetails}
            />
          <div className="text-right">
            <div className="grid gap-1 justify-end">
              <div className="flex justify-between gap-4 text-xs">
                <span className="text-slate-500">Quotation No</span>
                <span className="font-mono text-slate-900">{quotation.referenceNo}</span>
              </div>
              <div className="flex justify-between gap-4 text-xs">
                <span className="text-slate-500">ST Rate</span>
                <span className="font-mono text-slate-900">{effectiveTaxRate}%</span>
              </div>
              <div className="flex justify-between gap-4 text-xs">
                <span className="text-slate-500">Status</span>
                <span className="font-mono text-slate-900">{String(quotation.status ?? "") || "—"}</span>
              </div>
            </div>
          </div>
        </div>
        </CardContent>
      </Card>

      <Card className="mb-6 print:mb-2 print:shadow-none print:border-none print:bg-transparent print:rounded-none">
        <CardHeader className="pb-3 print:px-0 print:pb-1">
          <CardTitle className="text-base">Quotation Details</CardTitle>
        </CardHeader>
        <CardContent className="print:px-0">
          {isEditing ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label className="text-xs text-slate-500">Reference No.</Label>
                <Input value={editData.referenceNo} onChange={e => setEditData({ ...editData, referenceNo: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs text-slate-500">Service Tax Rate (%)</Label>
                <Input
                  type="number"
                  value={String(editData.taxRate ?? DEFAULT_TAX_RATE)}
                  onChange={e => setEditData({ ...editData, taxRate: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="md:col-span-3">
                <Label className="text-xs text-slate-500">Client Details (Name + TIN)</Label>
                <div className="space-y-2 mt-2">
                  {(Array.isArray(editData.clientDetails) ? editData.clientDetails : []).map((c: ClientDetailRow) => (
                    <div key={c.id} className="grid grid-cols-1 md:grid-cols-12 gap-2">
                      <div className="md:col-span-7">
                        <Input
                          value={c.name}
                          placeholder="Name"
                          onChange={(e) =>
                            setEditData({
                              ...editData,
                              clientDetails: (editData.clientDetails as ClientDetailRow[]).map((x) => x.id === c.id ? { ...x, name: e.target.value } : x),
                            })
                          }
                        />
                      </div>
                      <div className="md:col-span-4">
                        <Input
                          value={c.tin}
                          placeholder="TIN Number"
                          onChange={(e) =>
                            setEditData({
                              ...editData,
                              clientDetails: (editData.clientDetails as ClientDetailRow[]).map((x) => x.id === c.id ? { ...x, tin: e.target.value } : x),
                            })
                          }
                        />
                      </div>
                      <div className="md:col-span-1 flex md:justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() =>
                            setEditData({
                              ...editData,
                              clientDetails: (editData.clientDetails as ClientDetailRow[]).filter((x) => x.id !== c.id),
                            })
                          }
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditData({
                        ...editData,
                        clientDetails: [...(Array.isArray(editData.clientDetails) ? editData.clientDetails : []), { id: genId(), name: "", tin: "" }],
                      })
                    }
                  >
                    <Plus className="w-4 h-4 mr-2" /> Add Client
                  </Button>
                </div>
              </div>
              <div className="md:col-span-3">
                <Label className="text-xs text-slate-500">Client Address</Label>
                <Input value={editData.clientAddress} onChange={e => setEditData({ ...editData, clientAddress: e.target.value })} />
              </div>
              <div className="md:col-span-3">
                <Label className="text-xs text-slate-500">Property Description</Label>
                <Input value={editData.propertyDescription} onChange={e => setEditData({ ...editData, propertyDescription: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs text-slate-500">Purchase Price (RM)</Label>
                <Input value={editData.purchasePrice} onChange={e => setEditData({ ...editData, purchasePrice: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs text-slate-500">Bank</Label>
                <Input value={editData.bankName} onChange={e => setEditData({ ...editData, bankName: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs text-slate-500">Loan Amount</Label>
                <Input value={editData.loanAmount} onChange={e => setEditData({ ...editData, loanAmount: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs text-slate-500">Status</Label>
                <select
                  value={editData.status}
                  onChange={e => setEditData({ ...editData, status: e.target.value })}
                  className="w-full h-9 border rounded-md px-3 text-sm"
                >
                  <option value="draft">Draft</option>
                  <option value="sent">Sent</option>
                  <option value="accepted">Accepted</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label className="text-xs text-slate-500">Reference No.</Label>
                <p className="text-sm font-medium">{quotation.referenceNo}</p>
              </div>
              <div>
                <Label className="text-xs text-slate-500">Service Tax Rate (%)</Label>
                <p className="text-sm font-medium">{effectiveTaxRate}%</p>
              </div>
              <div className="md:col-span-3">
                <Label className="text-xs text-slate-500">Client Details</Label>
                {viewClientDetails.length > 0 ? (
                  <div className="mt-1 space-y-1">
                    {viewClientDetails.map((c) => (
                      <div key={c.id} className="text-sm font-medium">
                        {c.name}{c.tin ? ` — TIN: ${c.tin}` : ""}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm font-medium">{quotation.clientName}</p>
                )}
              </div>
              {(quotation as any).clientAddress ? (
                <div className="md:col-span-3">
                  <Label className="text-xs text-slate-500">Client Address</Label>
                  <p className="text-sm font-medium whitespace-pre-wrap">{(quotation as any).clientAddress}</p>
                </div>
              ) : null}
              {quotation.propertyDescription && (
                <div className="md:col-span-3">
                  <Label className="text-xs text-slate-500">Property</Label>
                  <p className="text-sm font-medium">{quotation.propertyDescription}</p>
                </div>
              )}
              {quotation.purchasePrice && (
                <div>
                  <Label className="text-xs text-slate-500">Purchase Price</Label>
                  <p className="text-sm font-medium">RM {Number(quotation.purchasePrice).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</p>
                </div>
              )}
              {quotation.bankName && (
                <div>
                  <Label className="text-xs text-slate-500">Bank</Label>
                  <p className="text-sm font-medium">{quotation.bankName}</p>
                </div>
              )}
              {quotation.loanAmount && (
                <div>
                  <Label className="text-xs text-slate-500">Loan Amount</Label>
                  <p className="text-sm font-medium">{quotation.loanAmount}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6 print:mb-2 print:shadow-none print:border-none print:bg-transparent print:rounded-none">
        <CardContent className="pt-4 print:px-0 print:pt-2">
          {renderSectionTable("PROFESSIONAL FEES", feesItems, feesTotals)}
          {renderSectionTable("REIMBURSEMENTS", reimbursementItems, reimbTotals)}
          {renderSectionTable("DISBURSEMENTS", disbursementItems, disbTotals)}
          {renderSectionTable("ATTACHMENT I", attachmentItems, attTotals)}

          <div className="max-w-md ml-auto space-y-2 mt-6 border-t border-slate-200 pt-4 print:mt-3 print:pt-2 print:border-black print:text-xs">
            <div className="flex justify-between text-sm print:text-xs">
              <span className="text-slate-500">Professional Fees</span>
              <span>{formatRM(feesTotals.totalInclTax)}</span>
            </div>
            <div className="flex justify-between text-sm print:text-xs">
              <span className="text-slate-500">Reimbursements</span>
              <span>{formatRM(reimbTotals.totalInclTax)}</span>
            </div>
            <div className="flex justify-between text-sm print:text-xs">
              <span className="text-slate-500">Disbursements</span>
              <span>{formatRM(disbTotals.totalInclTax)}</span>
            </div>
            {attTotals.totalInclTax > 0 && (
              <div className="flex justify-between text-sm print:text-xs">
                <span className="text-slate-500">Attachment I</span>
                <span>{formatRM(attTotals.totalInclTax)}</span>
              </div>
            )}
            <div className="border-t border-slate-200 pt-2 flex justify-between text-sm font-medium print:border-black print:pt-1 print:text-sm">
              <span>Total Amount Due</span>
              <span>{formatRM(grandTotalInclTax)}</span>
            </div>
            {roundingAdj !== 0 && (
              <div className="flex justify-between text-sm text-slate-500 print:text-xs">
                <span>Rounding Adj.</span>
                <span>{formatRM(roundingAdj)}</span>
              </div>
            )}
            <div className="border-t border-slate-900 pt-2 flex justify-between text-base font-bold print:border-black print:pt-1 print:text-sm">
              <span>Total Payable Incl. ST</span>
              <span>{formatRM(totalPayable)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

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
