import { useState, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useGetQuotation, getGetQuotationQueryKey, useUpdateQuotation, useDeleteQuotation, useDuplicateQuotation } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Save, Copy, Trash2, Pencil, Printer, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const TAX_RATE = 8;

function calcTax(amount: number, taxCode: string, rate: number = TAX_RATE) {
  if (taxCode === "NT" || taxCode === "ZR" || amount === 0) return { taxAmount: 0, amountInclTax: amount };
  const taxAmount = Math.round(amount * rate) / 100;
  return { taxAmount, amountInclTax: amount + taxAmount };
}

interface LocalItem {
  id: string;
  section: string;
  category: string;
  itemNo: string;
  subItemNo: string;
  description: string;
  taxCode: string;
  amountExclTax: number;
  taxRate: number;
  taxAmount: number;
  amountInclTax: number;
}

export default function QuotationDetail() {
  const { id } = useParams<{ id: string }>();
  const quotationId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: quotation, isLoading } = useGetQuotation(quotationId, {
    query: { enabled: !!quotationId, queryKey: getGetQuotationQueryKey(quotationId) }
  });

  const updateMutation = useUpdateQuotation();
  const deleteMutation = useDeleteQuotation();
  const duplicateMutation = useDuplicateQuotation();

  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<any>(null);
  const [editItems, setEditItems] = useState<LocalItem[]>([]);

  const startEditing = () => {
    if (!quotation) return;
    setEditData({
      referenceNo: quotation.referenceNo,
      stNo: quotation.stNo || "",
      clientName: quotation.clientName,
      propertyDescription: quotation.propertyDescription || "",
      purchasePrice: quotation.purchasePrice ? String(quotation.purchasePrice) : "",
      bankName: quotation.bankName || "",
      loanAmount: quotation.loanAmount || "",
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
        amountExclTax: item.amountExclTax,
        taxRate: item.taxRate || TAX_RATE,
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

  const updateItemAmount = (itemId: string, amount: number) => {
    setEditItems(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      const { taxAmount, amountInclTax } = calcTax(amount, item.taxCode, item.taxRate);
      return { ...item, amountExclTax: amount, taxAmount, amountInclTax };
    }));
  };

  const updateItemTaxCode = (itemId: string, taxCode: string) => {
    setEditItems(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      const { taxAmount, amountInclTax } = calcTax(item.amountExclTax, taxCode, item.taxRate);
      return { ...item, taxCode, taxAmount, amountInclTax };
    }));
  };

  const addAttachmentItem = () => {
    const attItems = editItems.filter(i => i.section === "attachment");
    setEditItems(prev => [...prev, {
      id: `new-${Date.now()}`,
      section: "attachment",
      category: "attachment",
      itemNo: String(attItems.length + 1),
      subItemNo: "",
      description: "",
      taxCode: "T",
      amountExclTax: 0,
      taxRate: TAX_RATE,
      taxAmount: 0,
      amountInclTax: 0,
    }]);
  };

  const removeItem = (itemId: string) => {
    setEditItems(prev => prev.filter(i => i.id !== itemId));
  };

  const saveEdits = () => {
    const items = editItems.map((item, idx) => ({
      section: item.section,
      category: item.category,
      itemNo: item.itemNo,
      subItemNo: item.subItemNo,
      description: item.description,
      taxCode: item.taxCode,
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
          setIsEditing(false);
          toast({ title: "Quotation updated" });
        },
        onError: () => {
          toast({ title: "Failed to update quotation", variant: "destructive" });
        },
      }
    );
  };

  const handleDelete = () => {
    if (!confirm("Are you sure you want to delete this quotation?")) return;
    deleteMutation.mutate(
      { id: quotationId },
      {
        onSuccess: () => {
          toast({ title: "Quotation deleted" });
          setLocation("/app/accounting?tab=quotations");
        },
      }
    );
  };

  const handleDuplicate = () => {
    duplicateMutation.mutate(
      { id: quotationId },
      {
        onSuccess: (data) => {
          toast({ title: "Quotation duplicated" });
          setLocation(`/app/quotations/${data.id}`);
        },
      }
    );
  };

  const handlePrint = () => {
    window.print();
  };

  if (isLoading) return <div className="p-6">Loading quotation...</div>;
  if (!quotation) return <div className="p-6">Quotation not found</div>;

  const items = isEditing ? editItems : (quotation.items || []).map((item: any, idx: number) => ({
    id: String(item.id || idx),
    section: item.section,
    category: item.category || "",
    itemNo: item.itemNo || "",
    subItemNo: item.subItemNo || "",
    description: item.description,
    taxCode: item.taxCode,
    amountExclTax: item.amountExclTax,
    taxRate: item.taxRate || TAX_RATE,
    taxAmount: item.taxAmount,
    amountInclTax: item.amountInclTax,
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
    return (
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-800 mb-2 uppercase">{sectionLabel}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">No.</th>
              <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>
              <th className="text-center px-3 py-2 font-medium text-slate-600 w-20">Tax Code</th>
              <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Excl. ST (RM)</th>
              <th className="text-right px-3 py-2 font-medium text-slate-600 w-28">ST @ {TAX_RATE}%</th>
              <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Incl. ST (RM)</th>
              {isEditing && sectionLabel === "ATTACHMENT I" && <th className="w-10"></th>}
            </tr>
          </thead>
          <tbody>
            {sectionItems.map((item) => {
              const isHeader = !item.subItemNo && item.description === item.description.toUpperCase() && item.section !== "attachment";
              return (
                <tr key={item.id} className={`border-b border-slate-100 ${isHeader ? "bg-slate-50/50" : ""}`}>
                  <td className="px-3 py-1.5 text-slate-500 text-xs">{item.subItemNo || item.itemNo}</td>
                  <td className={`px-3 py-1.5 ${isHeader ? "font-semibold text-slate-800" : "text-slate-600"}`}>
                    {isEditing && sectionLabel === "ATTACHMENT I" ? (
                      <Input
                        value={item.description}
                        onChange={e => setEditItems(prev => prev.map(i => i.id === item.id ? { ...i, description: e.target.value } : i))}
                        className="h-7 text-xs"
                      />
                    ) : item.description}
                  </td>
                  <td className="px-3 py-1.5 text-center text-xs">
                    {isEditing && !isHeader ? (
                      <select
                        value={item.taxCode}
                        onChange={e => updateItemTaxCode(item.id, e.target.value)}
                        className="h-7 text-xs border rounded px-1 bg-white"
                      >
                        <option value="T">T</option>
                        <option value="NT">NT</option>
                        <option value="ZR">ZR</option>
                        <option value="SR">SR</option>
                      </select>
                    ) : !isHeader ? item.taxCode : ""}
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs">
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
                  <td className="px-3 py-1.5 text-right text-xs text-slate-500">
                    {!isHeader ? item.taxAmount.toFixed(2) : ""}
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs font-medium">
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
            <tr className="bg-slate-50 font-medium text-sm">
              <td colSpan={3} className="px-3 py-2 text-right">Total {sectionLabel}</td>
              <td className="px-3 py-2 text-right">{formatRM(totals.totalExclTax)}</td>
              <td className="px-3 py-2 text-right">{formatRM(totals.totalTax)}</td>
              <td className="px-3 py-2 text-right">{formatRM(totals.totalInclTax)}</td>
              {isEditing && sectionLabel === "ATTACHMENT I" && <td></td>}
            </tr>
          </tfoot>
        </table>
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

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6 print:hidden">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/app/accounting?tab=quotations")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Quotation {data.referenceNo}</h1>
            <p className="text-sm text-slate-500 mt-1">{data.clientName}</p>
          </div>
          <span className={`ml-3 inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${statusColors[data.status] || statusColors.draft}`}>
            {data.status}
          </span>
        </div>
        <div className="flex gap-2">
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
              <Button variant="outline" size="sm" onClick={handlePrint}><Printer className="w-4 h-4 mr-1" /> Print</Button>
              <Button variant="outline" size="sm" onClick={handleDuplicate}><Copy className="w-4 h-4 mr-1" /> Duplicate</Button>
              <Button variant="outline" size="sm" onClick={startEditing}><Pencil className="w-4 h-4 mr-1" /> Edit</Button>
              <Button variant="outline" size="sm" onClick={handleDelete} className="text-red-500 hover:text-red-700">
                <Trash2 className="w-4 h-4 mr-1" /> Delete
              </Button>
            </>
          )}
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quotation Details</CardTitle>
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label className="text-xs text-slate-500">Reference No.</Label>
                <Input value={editData.referenceNo} onChange={e => setEditData({ ...editData, referenceNo: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs text-slate-500">ST No.</Label>
                <Input value={editData.stNo} onChange={e => setEditData({ ...editData, stNo: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs text-slate-500">Client Name</Label>
                <Input value={editData.clientName} onChange={e => setEditData({ ...editData, clientName: e.target.value })} />
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
              {quotation.stNo && (
                <div>
                  <Label className="text-xs text-slate-500">ST No.</Label>
                  <p className="text-sm font-medium">{quotation.stNo}</p>
                </div>
              )}
              <div>
                <Label className="text-xs text-slate-500">Client Name</Label>
                <p className="text-sm font-medium">{quotation.clientName}</p>
              </div>
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

      <Card className="mb-6">
        <CardContent className="pt-4">
          {renderSectionTable("DISBURSEMENT", disbursementItems, disbTotals)}
          {renderSectionTable("PROFESSIONAL FEES", feesItems, feesTotals)}
          {renderSectionTable("REIMBURSEMENT", reimbursementItems, reimbTotals)}
          {renderSectionTable("ATTACHMENT I", attachmentItems, attTotals)}

          <div className="max-w-md ml-auto space-y-2 mt-6 border-t border-slate-200 pt-4">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Disbursement</span>
              <span>{formatRM(disbTotals.totalInclTax)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Professional Fees</span>
              <span>{formatRM(feesTotals.totalInclTax)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Reimbursement</span>
              <span>{formatRM(reimbTotals.totalInclTax)}</span>
            </div>
            {attTotals.totalInclTax > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Attachment I</span>
                <span>{formatRM(attTotals.totalInclTax)}</span>
              </div>
            )}
            <div className="border-t border-slate-200 pt-2 flex justify-between text-sm font-medium">
              <span>Total Amount Due</span>
              <span>{formatRM(grandTotalInclTax)}</span>
            </div>
            {roundingAdj !== 0 && (
              <div className="flex justify-between text-sm text-slate-500">
                <span>Rounding Adj.</span>
                <span>{formatRM(roundingAdj)}</span>
              </div>
            )}
            <div className="border-t border-slate-900 pt-2 flex justify-between text-base font-bold">
              <span>Total Payable Incl. ST</span>
              <span>{formatRM(totalPayable)}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
