import { useState, useCallback, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useCreateQuotation, getListQuotationsQueryKey, useListCases, useGetCase, getGetCaseQueryKey } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Plus, Trash2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { apiFetchJson } from "@/lib/api-client";

interface LineItem {
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

const TAX_RATE = 8;

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function calcTax(amount: number, taxCode: string, rate: number = TAX_RATE) {
  if (taxCode === "NT" || taxCode === "ZR" || amount === 0) return { taxAmount: 0, amountInclTax: amount };
  const taxAmount = Math.round(amount * rate) / 100;
  return { taxAmount, amountInclTax: amount + taxAmount };
}

const DEFAULT_DISBURSEMENT_ITEMS: Omit<LineItem, "id">[] = [
  { section: "disbursement", category: "search", itemNo: "1", subItemNo: "", description: "SEARCH", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "search", itemNo: "1", subItemNo: "a", description: "Land Search", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "search", itemNo: "1", subItemNo: "b", description: "CTC Title", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "search", itemNo: "1", subItemNo: "c", description: "Bankruptcy Search", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "search", itemNo: "1", subItemNo: "d", description: "Bankruptcy Search Service Charge", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "search", itemNo: "1", subItemNo: "e", description: "CCM Search", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "", description: "STAMP DUTY", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "a", description: "SPA", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "b", description: "Deed of Mutual Covenants", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "c", description: "Transfer/Deed of Assignment (by way of Transfer)", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "d", description: "Discharge Form 16N/Deed of Receipt & Reassignment", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "e", description: "Loan Agreement/LACA/Facilities Agreement", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "f", description: "Charge 16A (Annexure)", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "g", description: "Personal Guarantee", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "h", description: "Corporate Guarantee", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "i", description: "Letter of Offer and SD", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "j", description: "Property Purchase Agreement", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "k", description: "Deed of Assignment", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "l", description: "Deed of Revocation", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "m", description: "Power of Attorney/Revocation of Power of Attorney", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "n", description: "Supplemental Letter Offer", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "o", description: "Memorandum of Deposit", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "p", description: "Letter of Set-Off", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "q", description: "Assignment of Rental Proceed", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "r", description: "Tenancy Agreement", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "s", description: "Islamic Banking", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "t", description: "Others-Refer Attachment I", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "", description: "REGISTRATION/ENTRY/WITHDRAWAL", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "a", description: "Entry PC/LHC", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "b", description: "Withdrawal PC/LHC", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "c", description: "Discharge/Charge", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "d", description: "Consent to Charge/Transfer", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "e", description: "Letter of Consent for Registration", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "f", description: "Application consent to Charge/Transfer", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "g", description: "MOT Form14A/Form16F/Form16I NLC", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
];

const DEFAULT_FEES_ITEMS: Omit<LineItem, "id">[] = [
  { section: "fees", category: "fees", itemNo: "1", subItemNo: "", description: "SPA/SPA(sub)", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "2", subItemNo: "", description: "Loan Agreement/LACA/Facilities Agreement", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "3", subItemNo: "", description: "Deed of Mutual Covenant", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "4", subItemNo: "", description: "Transfer Form 14A", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "5", subItemNo: "", description: "Charge Form 16A (Annexure)", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "6", subItemNo: "", description: "Deed of Assignment", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "7", subItemNo: "", description: "Deed of Revocation", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "8", subItemNo: "", description: "Memorandum of Transfer", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "9", subItemNo: "", description: "Discharge Form 16N", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "10", subItemNo: "", description: "Deed of Receipt and Reassignment", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "11", subItemNo: "", description: "Personal Guarantee", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "12", subItemNo: "", description: "Corporate Guarantee", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "13", subItemNo: "", description: "Power of Attorney", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "14", subItemNo: "", description: "Revocation of Power of Attorney", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "15", subItemNo: "", description: "Supplemental Letter Offer", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "16", subItemNo: "", description: "Memorandum of Deposit", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "17", subItemNo: "", description: "Letter of Set-Off", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "18", subItemNo: "", description: "Assignment of Rental Proceed", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "19", subItemNo: "", description: "Tenancy Agreement", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "20", subItemNo: "", description: "Notice of Assignment/Notice of Charge", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "21", subItemNo: "", description: "Property Purchase Agreement", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "22", subItemNo: "", description: "Islamic Banking", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "23", subItemNo: "", description: "Caveat", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "24", subItemNo: "", description: "Withdrawal of Caveat", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "25", subItemNo: "", description: "Form I", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "26", subItemNo: "", description: "Statutory Declaration", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "27", subItemNo: "", description: "Other Agreement", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "28", subItemNo: "", description: "Others-Refer Attachment I", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
];

const DEFAULT_REIMBURSEMENT_ITEMS: Omit<LineItem, "id">[] = [
  { section: "reimbursement", category: "reimbursement", itemNo: "1", subItemNo: "", description: "Developer's Confirmation Letter", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "2", subItemNo: "", description: "Travelling and transportation", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "3", subItemNo: "", description: "Paper, printing, photocopy, stationery, binding", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "4", subItemNo: "", description: "Telephone, postage, courier, facsimile", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "5", subItemNo: "", description: "Documentation Fees", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "6", subItemNo: "", description: "Miscellaneous", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
];

function initItems(defaults: Omit<LineItem, "id">[]): LineItem[] {
  return defaults.map(d => ({ ...d, id: generateId() }));
}

export default function NewQuotation() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createMutation = useCreateQuotation();

  const params = new URLSearchParams(search);
  const prefillCaseId = params.get("caseId");

  const [selectedCaseId, setSelectedCaseId] = useState<string>(prefillCaseId || "");
  const [referenceNo, setReferenceNo] = useState("");
  const [stNo, setStNo] = useState("");
  const [clientName, setClientName] = useState("");
  const [propertyDescription, setPropertyDescription] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [bankName, setBankName] = useState("");
  const [loanAmount, setLoanAmount] = useState("");

  const { data: casesRes } = useListCases({ limit: 100 });
  const cases = casesRes?.data ?? [];

  const { data: caseDetail } = useGetCase(
    parseInt(selectedCaseId) || 0,
    {
      query: {
        queryKey: getGetCaseQueryKey(parseInt(selectedCaseId) || 0),
        enabled: !!selectedCaseId && parseInt(selectedCaseId) > 0,
      },
    }
  );

  type FirmSettings = { stNumber?: string | null };
  const { data: firmSettings } = useQuery<FirmSettings>({
    queryKey: ["firm-settings"],
    queryFn: () => apiFetchJson<FirmSettings>("/firm-settings"),
    retry: false,
  });

  useEffect(() => {
    if (firmSettings?.stNumber) {
      setStNo(firmSettings.stNumber);
    }
  }, [firmSettings]);

  useEffect(() => {
    if (!caseDetail) return;
    const purchaserNames = (caseDetail.purchasers || [])
      .map((p) => p.clientName)
      .filter(Boolean)
      .join(" & ");
    if (purchaserNames) setClientName(purchaserNames);

    const propParts = [caseDetail.projectName].filter(Boolean).join(", ");
    if (propParts) setPropertyDescription(propParts);

    if (caseDetail.spaPrice) setPurchasePrice(String(caseDetail.spaPrice));
    if (caseDetail.referenceNo) setReferenceNo(caseDetail.referenceNo);
  }, [caseDetail]);

  const [disbursementItems, setDisbursementItems] = useState<LineItem[]>(() => initItems(DEFAULT_DISBURSEMENT_ITEMS));
  const [feesItems, setFeesItems] = useState<LineItem[]>(() => initItems(DEFAULT_FEES_ITEMS));
  const [reimbursementItems, setReimbursementItems] = useState<LineItem[]>(() => initItems(DEFAULT_REIMBURSEMENT_ITEMS));
  const [attachmentItems, setAttachmentItems] = useState<LineItem[]>([]);

  const [activeSection, setActiveSection] = useState<string>("disbursement");

  const updateItemAmount = useCallback((
    setItems: React.Dispatch<React.SetStateAction<LineItem[]>>,
    itemId: string,
    amount: number
  ) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      const { taxAmount, amountInclTax } = calcTax(amount, item.taxCode, item.taxRate);
      return { ...item, amountExclTax: amount, taxAmount, amountInclTax };
    }));
  }, []);

  const updateItemTaxCode = useCallback((
    setItems: React.Dispatch<React.SetStateAction<LineItem[]>>,
    itemId: string,
    taxCode: string
  ) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      const { taxAmount, amountInclTax } = calcTax(item.amountExclTax, taxCode, item.taxRate);
      return { ...item, taxCode, taxAmount, amountInclTax };
    }));
  }, []);

  const addAttachmentItem = () => {
    setAttachmentItems(prev => [...prev, {
      id: generateId(),
      section: "attachment",
      category: "attachment",
      itemNo: String(prev.length + 1),
      subItemNo: "",
      description: "",
      taxCode: "T",
      amountExclTax: 0,
      taxRate: TAX_RATE,
      taxAmount: 0,
      amountInclTax: 0,
    }]);
  };

  const removeAttachmentItem = (id: string) => {
    setAttachmentItems(prev => prev.filter(i => i.id !== id));
  };

  const updateAttachmentDesc = (id: string, description: string) => {
    setAttachmentItems(prev => prev.map(i => i.id === id ? { ...i, description } : i));
  };

  const sectionTotals = useCallback((items: LineItem[]) => {
    return {
      totalExclTax: items.reduce((s, i) => s + i.amountExclTax, 0),
      totalTax: items.reduce((s, i) => s + i.taxAmount, 0),
      totalInclTax: items.reduce((s, i) => s + i.amountInclTax, 0),
    };
  }, []);

  const disbTotals = sectionTotals(disbursementItems);
  const feesTotals = sectionTotals(feesItems);
  const reimbTotals = sectionTotals(reimbursementItems);
  const attTotals = sectionTotals(attachmentItems);

  const grandTotalExclTax = disbTotals.totalExclTax + feesTotals.totalExclTax + reimbTotals.totalExclTax + attTotals.totalExclTax;
  const grandTotalTax = disbTotals.totalTax + feesTotals.totalTax + reimbTotals.totalTax + attTotals.totalTax;
  const grandTotalInclTax = disbTotals.totalInclTax + feesTotals.totalInclTax + reimbTotals.totalInclTax + attTotals.totalInclTax;
  const roundingAdj = Math.round(grandTotalInclTax * 20) / 20 - grandTotalInclTax;
  const totalPayable = grandTotalInclTax + roundingAdj;

  const formatRM = (v: number) => `RM ${v.toFixed(2)}`;

  const handleSubmit = () => {
    if (!referenceNo.trim() || !clientName.trim()) {
      toast({ title: "Reference number and client name are required", variant: "destructive" });
      return;
    }

    const allItems = [
      ...disbursementItems,
      ...feesItems,
      ...reimbursementItems,
      ...attachmentItems,
    ].filter(i => i.amountExclTax > 0 || i.description.trim()).map((item, idx) => ({
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

    createMutation.mutate(
      {
        data: {
          referenceNo,
          stNo: stNo || undefined,
          clientName,
          caseId: selectedCaseId ? parseInt(selectedCaseId) : undefined,
          propertyDescription: propertyDescription || undefined,
          purchasePrice: purchasePrice || undefined,
          bankName: bankName || undefined,
          loanAmount: loanAmount || undefined,
          items: allItems,
        },
      },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey() });
          toast({ title: "Quotation created" });
          setLocation(`/app/quotations/${data.id}`);
        },
        onError: (e) => toastError(toast, e, "Create failed"),
      }
    );
  };

  const sections = [
    { key: "disbursement", label: "Disbursement", items: disbursementItems, setter: setDisbursementItems, totals: disbTotals },
    { key: "fees", label: "Professional Fees", items: feesItems, setter: setFeesItems, totals: feesTotals },
    { key: "reimbursement", label: "Reimbursement", items: reimbursementItems, setter: setReimbursementItems, totals: reimbTotals },
    { key: "attachment", label: "Attachment I", items: attachmentItems, setter: setAttachmentItems, totals: attTotals },
  ];

  const currentSection = sections.find(s => s.key === activeSection)!;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/app/accounting?tab=quotations")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">New Quotation</h1>
          <p className="text-sm text-slate-500 mt-1">Create a fee quotation for legal services</p>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Quotation Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-3">
              <Label className="text-xs text-slate-500">Select Case</Label>
              <select
                value={selectedCaseId}
                onChange={e => setSelectedCaseId(e.target.value)}
                className="w-full h-9 border rounded-md px-3 text-sm bg-white"
              >
                <option value="">-- Select a case to auto-fill --</option>
                {cases.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.referenceNo} - {c.projectName} ({c.status})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs text-slate-500">Reference No. *</Label>
              <Input value={referenceNo} onChange={e => setReferenceNo(e.target.value)} placeholder="e.g. NYC/CON" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">ST No.</Label>
              <Input value={stNo} onChange={e => setStNo(e.target.value)} placeholder="Service tax number" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Client Name *</Label>
              <Input value={clientName} onChange={e => setClientName(e.target.value)} placeholder="Client name" />
            </div>
            <div className="md:col-span-3">
              <Label className="text-xs text-slate-500">Property Description</Label>
              <Input value={propertyDescription} onChange={e => setPropertyDescription(e.target.value)} placeholder="RE: Property description" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Purchase Price (RM)</Label>
              <Input value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Bank</Label>
              <Input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="Bank name" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Loan Amount</Label>
              <Input value={loanAmount} onChange={e => setLoanAmount(e.target.value)} placeholder="Loan details" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-1 mb-4 border-b border-slate-200">
        {sections.map(s => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeSection === s.key
                ? "border-amber-500 text-amber-600"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {s.label}
            {s.totals.totalInclTax > 0 && (
              <span className="ml-2 text-xs text-slate-400">{formatRM(s.totals.totalInclTax)}</span>
            )}
          </button>
        ))}
      </div>

      <Card className="mb-6">
        <CardContent className="pt-4">
          {activeSection === "attachment" ? (
            <div>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-slate-500">Additional items not listed in the main sections</p>
                <Button size="sm" variant="outline" onClick={addAttachmentItem}>
                  <Plus className="w-4 h-4 mr-1" /> Add Item
                </Button>
              </div>
              {attachmentItems.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">No attachment items. Click "Add Item" to add.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[900px]">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">No.</th>
                        <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>
                        <th className="text-center px-3 py-2 font-medium text-slate-600 w-20">Tax Code</th>
                        <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Total Excl. ST (RM)</th>
                        <th className="text-right px-3 py-2 font-medium text-slate-600 w-28">ST @ {TAX_RATE}% (RM)</th>
                        <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Total Incl. ST (RM)</th>
                        <th className="w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {attachmentItems.map((item, idx) => (
                        <tr key={item.id} className="border-b border-slate-100">
                          <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                          <td className="px-3 py-2">
                            <Input
                              value={item.description}
                              onChange={e => updateAttachmentDesc(item.id, e.target.value)}
                              placeholder="Description"
                              className="h-8"
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <select
                              value={item.taxCode}
                              onChange={e => updateItemTaxCode(setAttachmentItems, item.id, e.target.value)}
                              className="h-7 text-xs border rounded px-1 bg-white"
                            >
                              <option value="T">T</option>
                              <option value="NT">NT</option>
                              <option value="ZR">ZR</option>
                              <option value="SR">SR</option>
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              type="number"
                              value={item.amountExclTax || ""}
                              onChange={e => updateItemAmount(setAttachmentItems, item.id, parseFloat(e.target.value) || 0)}
                              className="h-8 text-right"
                              placeholder="0.00"
                            />
                          </td>
                          <td className="px-3 py-2 text-right text-slate-500">{item.taxAmount.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-medium">{item.amountInclTax.toFixed(2)}</td>
                          <td className="px-3 py-2">
                            <Button variant="ghost" size="sm" onClick={() => removeAttachmentItem(item.id)} className="text-red-500">
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-50 font-medium">
                        <td colSpan={3} className="px-3 py-2 text-right">Total</td>
                        <td className="px-3 py-2 text-right">{formatRM(attTotals.totalExclTax)}</td>
                        <td className="px-3 py-2 text-right">{formatRM(attTotals.totalTax)}</td>
                        <td className="px-3 py-2 text-right">{formatRM(attTotals.totalInclTax)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">No.</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>
                    <th className="text-center px-3 py-2 font-medium text-slate-600 w-20">Tax Code</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Total Excl. ST (RM)</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600 w-28">ST @ {TAX_RATE}% (RM)</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Total Incl. ST (RM)</th>
                  </tr>
                </thead>
                <tbody>
                  {currentSection.items.map((item) => {
                    const isHeader = !item.subItemNo && item.description === item.description.toUpperCase();
                    return (
                      <tr key={item.id} className={`border-b border-slate-100 ${isHeader ? "bg-slate-50/50" : ""}`}>
                        <td className="px-3 py-1.5 text-slate-500 text-xs">
                          {item.subItemNo || item.itemNo}
                        </td>
                        <td className={`px-3 py-1.5 ${isHeader ? "font-semibold text-slate-800" : "text-slate-600"}`}>
                          {item.description}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {!isHeader && (
                            <select
                              value={item.taxCode}
                              onChange={e => updateItemTaxCode(currentSection.setter, item.id, e.target.value)}
                              className="h-7 text-xs border rounded px-1 bg-white"
                            >
                              <option value="T">T</option>
                              <option value="NT">NT</option>
                              <option value="ZR">ZR</option>
                              <option value="SR">SR</option>
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {!isHeader && (
                            <Input
                              type="number"
                              value={item.amountExclTax || ""}
                              onChange={e => updateItemAmount(currentSection.setter, item.id, parseFloat(e.target.value) || 0)}
                              className="h-7 text-right text-xs w-28 ml-auto"
                              placeholder="0.00"
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs text-slate-500">
                          {!isHeader ? item.taxAmount.toFixed(2) : ""}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs font-medium">
                          {!isHeader ? item.amountInclTax.toFixed(2) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-medium">
                    <td colSpan={3} className="px-3 py-2 text-right">Total {currentSection.label}</td>
                    <td className="px-3 py-2 text-right">{formatRM(currentSection.totals.totalExclTax)}</td>
                    <td className="px-3 py-2 text-right">{formatRM(currentSection.totals.totalTax)}</td>
                    <td className="px-3 py-2 text-right">{formatRM(currentSection.totals.totalInclTax)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="max-w-md ml-auto space-y-2">
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

          <div className="flex justify-end mt-6 gap-3">
            <Button variant="outline" onClick={() => setLocation("/app/accounting?tab=quotations")}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending}
              className="bg-amber-500 hover:bg-amber-600 text-white"
            >
              <Save className="w-4 h-4 mr-2" />
              {createMutation.isPending ? "Saving..." : "Save Quotation"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
