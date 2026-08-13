import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useCreateQuotation, getListQuotationsQueryKey, useGetCase, getGetCaseQueryKey, useGetClient, getGetClientQueryKey } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Plus, Trash2, Save, X, ChevronDown, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { apiFetchJson } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface LineItem {
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
  quantity?: number;
  unitAmount?: number;
  remarks?: string;
  isCustom?: boolean;
}

type ClientDetailRow = { id: string; name: string; tin: string };

const DEFAULT_TAX_RATE = 8;
const TAX_RATE = DEFAULT_TAX_RATE;

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function calcTax(amount: number, taxCode: string, rate: number) {
  const code = String(taxCode || "").trim().toUpperCase();
  const effectiveRate = (code === "Z" || code === "ZR" || code === "O" || code === "NT" || amount === 0) ? 0 : rate;
  if (effectiveRate === 0) return { taxRate: 0, taxAmount: 0, amountInclTax: amount };
  const taxAmount = Math.round(amount * effectiveRate) / 100;
  return { taxRate: effectiveRate, taxAmount, amountInclTax: amount + taxAmount };
}

type CategoryMeta = {
  quantity?: number;
  unitAmount?: number;
  remarks?: string;
};

function encodeCategory(base: string, meta: CategoryMeta): string {
  const b = String(base ?? "").trim();
  if (!b) return "";
  const parts: string[] = [b];
  if (typeof meta.quantity === "number" && Number.isFinite(meta.quantity)) parts.push(`q=${Math.trunc(meta.quantity)}`);
  if (typeof meta.unitAmount === "number" && Number.isFinite(meta.unitAmount)) parts.push(`u=${meta.unitAmount}`);
  if (meta.remarks && meta.remarks.trim()) parts.push(`r=${encodeURIComponent(meta.remarks.trim())}`);
  return parts.length === 1 ? b : parts.join("|");
}

type DisbursementCategoryKey = "search" | "stamp_duty" | "registration";

interface DisbursementPreset {
  id: string;
  label: string;
  section: "disbursement";
  category: DisbursementCategoryKey;
  defaultTaxCode: string;
  defaultAmount?: number;
}

const DISBURSEMENT_PRESETS: DisbursementPreset[] = [
  // 1. Search and Related (matches SEARCH header category: search)
  { id: "search-land", label: "1(a) Land Search", section: "disbursement", category: "search", defaultTaxCode: "Z", defaultAmount: 30 },
  { id: "search-ctc-title", label: "1(b) CTC Title / MOT", section: "disbursement", category: "search", defaultTaxCode: "Z", defaultAmount: 10 },
  { id: "search-bankruptcy", label: "1(c) Bankruptcy Search (MDI / SSM)", section: "disbursement", category: "search", defaultTaxCode: "Z", defaultAmount: 10 },
  { id: "search-bankruptcy-sc", label: "1(d) Bankruptcy Search Service Charge", section: "disbursement", category: "search", defaultTaxCode: "Z", defaultAmount: 5 },
  { id: "search-ccm-winding", label: "1(e) CCM / Company Search (Winding Up)", section: "disbursement", category: "search", defaultTaxCode: "Z", defaultAmount: 30 },

  // 2. Stamp Duty (category: stamp_duty)
  { id: "sd-spa", label: "2(a) Stamp Duty - SPA / SPA (Sub)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-loan", label: "2(b) Stamp Duty - Loan Agreement / LACA / FA", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-memo-charge", label: "2(c) Stamp Duty - Memorandum of Charge", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-form-14a", label: "2(d) Stamp Duty - Form 14A (Transfer)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-form-16a", label: "2(e) Stamp Duty - Form 16A (Annexure)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-form-16f", label: "2(f) Stamp Duty - Form 16F (Charge)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-form-16n", label: "2(g) Stamp Duty - Form 16N (Discharge)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-form-16i", label: "2(h) Stamp Duty - Form 16I", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-deed-assignment", label: "2(i) Stamp Duty - Deed of Assignment (DOA)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-power-attorney", label: "2(j) Stamp Duty - Power of Attorney (PA)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-deed-reassignment", label: "2(k) Stamp Duty - Deed of Receipt & Reassignment (DRR)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-lease", label: "2(l) Stamp Duty - Lease / Sub-Lease / Tenancy", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-caveat", label: "2(m) Stamp Duty - Caveat", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-withdrawal-caveat", label: "2(n) Stamp Duty - Withdrawal of Caveat", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-private-caveat", label: "2(o) Stamp Duty - Private Caveat", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-cancellation-sd", label: "2(p) Stamp Duty - Cancellation / Adjudication", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-refund-sd", label: "2(q) Stamp Duty - Refund / Remission", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-letter-offer", label: "2(r) Stamp Duty - Letter of Offer (LO)", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-lease-extension", label: "2(s) Stamp Duty - Lease Extension / Supplemental", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },
  { id: "sd-other", label: "2(t) Others - Refer Attachment I", section: "disbursement", category: "stamp_duty", defaultTaxCode: "Z" },

  // 3. Registration / Entry / Withdrawal (category: registration)
  { id: "reg-entry-pc", label: "3(a) Entry of Presentation Charge / LHC", section: "disbursement", category: "registration", defaultTaxCode: "Z", defaultAmount: 10 },
  { id: "reg-withdrawal-pc", label: "3(b) Withdrawal of Presentation Charge / LHC", section: "disbursement", category: "registration", defaultTaxCode: "Z", defaultAmount: 10 },
  { id: "reg-caveat-entry", label: "3(c) Caveat Entry (Lien / Charge Caveat)", section: "disbursement", category: "registration", defaultTaxCode: "Z", defaultAmount: 130 },
  { id: "reg-caveat-withdrawal", label: "3(d) Withdrawal of Caveat", section: "disbursement", category: "registration", defaultTaxCode: "Z", defaultAmount: 10 },
  { id: "reg-private-caveat", label: "3(e) Entry / Withdrawal of Private Caveat", section: "disbursement", category: "registration", defaultTaxCode: "Z", defaultAmount: 130 },
  { id: "reg-lease", label: "3(f) Entry of Lease / Sub-Lease", section: "disbursement", category: "registration", defaultTaxCode: "Z", defaultAmount: 500 },
  { id: "reg-mot", label: "3(g) MOT - Form 14A / Form 16F / Form 16I (NLC)", section: "disbursement", category: "registration", defaultTaxCode: "Z", defaultAmount: 100 },
];

const DEFAULT_DISBURSEMENT_ITEMS: Omit<LineItem, "id" | "itemCategory">[] = [
  { section: "disbursement", category: "search", itemNo: "1", subItemNo: "", description: "SEARCH", taxCode: "T", amountExclTax: 0, taxRate: DEFAULT_TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "stamp_duty", itemNo: "2", subItemNo: "", description: "STAMP DUTY", taxCode: "T", amountExclTax: 0, taxRate: DEFAULT_TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "disbursement", category: "registration", itemNo: "3", subItemNo: "", description: "REGISTRATION/ENTRY/WITHDRAWAL", taxCode: "T", amountExclTax: 0, taxRate: DEFAULT_TAX_RATE, taxAmount: 0, amountInclTax: 0 },
];

const DEFAULT_FEES_ITEMS: Omit<LineItem, "id" | "itemCategory">[] = [
  { section: "fees", category: "fees", itemNo: "1", subItemNo: "", description: "SPA/SPA(sub)", taxCode: "T", amountExclTax: 0, taxRate: DEFAULT_TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "fees", category: "fees", itemNo: "2", subItemNo: "", description: "Loan Agreement/LACA/Facilities Agreement", taxCode: "T", amountExclTax: 0, taxRate: DEFAULT_TAX_RATE, taxAmount: 0, amountInclTax: 0 },
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
];

const DEFAULT_REIMBURSEMENT_ITEMS: Omit<LineItem, "id" | "itemCategory">[] = [
  { section: "reimbursement", category: "reimbursement", itemNo: "1", subItemNo: "", description: "Developer's Confirmation Letter", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "2", subItemNo: "", description: "Travelling and transportation", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "3", subItemNo: "", description: "Paper, printing, photocopy, stationery, binding", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "4", subItemNo: "", description: "Telephone, postage, courier, facsimile", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "5", subItemNo: "", description: "Documentation Fees", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
  { section: "reimbursement", category: "reimbursement", itemNo: "6", subItemNo: "", description: "Miscellaneous", taxCode: "T", amountExclTax: 0, taxRate: TAX_RATE, taxAmount: 0, amountInclTax: 0 },
];

function initItems(defaults: Array<Omit<LineItem, "id"> | Omit<LineItem, "id" | "itemCategory">>): LineItem[] {
  return defaults.map((d: any) => ({
    ...d,
    id: generateId(),
    taxCode: d.section === "disbursement" ? "Z" : (d.taxCode || "T"),
    itemCategory: d.itemCategory === "fee" || d.itemCategory === "disbursement"
      ? d.itemCategory
      : d.section === "fees"
        ? "fee"
        : "disbursement",
    quantity: typeof d.quantity === "number" ? d.quantity : undefined,
    unitAmount: typeof d.unitAmount === "number" ? d.unitAmount : undefined,
    remarks: typeof d.remarks === "string" ? d.remarks : undefined,
    isCustom: Boolean(d.isCustom),
  }));
}

interface CaseSearchResultItem {
  id: number;
  referenceNo: string;
  purchaserName?: string | null;
  project?: string | null;
  propertyAddress?: string | null;
  parcelNo?: string | null;
  propertyParcelNo?: string | null;
  borrowerNames?: string[] | null;
  partyLabel?: string | null;
  propertyLabel?: string | null;
  developer?: string | null;
  property?: string | null;
}

interface CaseSearchResponse {
  ok?: boolean;
  data?: CaseSearchResultItem[];
  items?: CaseSearchResultItem[];
  total?: number;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), Math.max(0, delayMs));
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
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
  const [clientAddress, setClientAddress] = useState("");
  const [clientDetails, setClientDetails] = useState<ClientDetailRow[]>([]);
  const [propertyDescription, setPropertyDescription] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [bankName, setBankName] = useState("");
  const [loanAmount, setLoanAmount] = useState("");
  const [taxRate, setTaxRate] = useState<number>(DEFAULT_TAX_RATE);

  const [caseSearch, setCaseSearch] = useState("");
  const debouncedCaseSearch = useDebouncedValue(caseSearch, 250).trim();
  const caseSearchQuery = useQuery<CaseSearchResultItem[]>({
    queryKey: ["quotation", "case-search", debouncedCaseSearch],
    enabled: debouncedCaseSearch.length >= 2,
    queryFn: async ({ signal }) => {
      const q = encodeURIComponent(debouncedCaseSearch);
      const raw = await apiFetchJson<CaseSearchResponse>(`/accounting/cases/search?q=${q}&limit=20`, { signal });
      return Array.isArray(raw?.items) ? raw.items : Array.isArray((raw as any)?.data) ? (raw as any).data : [];
    },
  });
  const caseSearchItems = caseSearchQuery.data ?? [];

  const [selectedCase, setSelectedCase] = useState<CaseSearchResultItem | null>(null);
  const [caseComboboxOpen, setCaseComboboxOpen] = useState(false);

  useEffect(() => {
    if (!selectedCase) return;
    if (String(selectedCase.id) !== selectedCaseId) setSelectedCaseId(String(selectedCase.id));
    if (selectedCase.referenceNo && selectedCase.referenceNo !== referenceNo) {
      setReferenceNo(selectedCase.referenceNo);
    }
  }, [selectedCase]);

  const [disbursementPresetQuery, setDisbursementPresetQuery] = useState("");
  const [disbDropdownOpen, setDisbDropdownOpen] = useState(false);
  const debouncedDisbQ = useDebouncedValue(disbursementPresetQuery, 150).trim().toLowerCase();
  const filteredDisbursementPresets = useMemo(() => {
    const all = DISBURSEMENT_PRESETS;
    if (!debouncedDisbQ) return all;
    return all.filter(p => {
      const hay = `${p.label} ${p.category} ${p.defaultTaxCode}`.toLowerCase();
      return hay.includes(debouncedDisbQ);
    });
  }, [debouncedDisbQ]);

  const addDisbursementPresetLine = useCallback((preset: DisbursementPreset) => {
    const id = generateId();
    const amount = typeof preset.defaultAmount === "number" ? preset.defaultAmount : 0;
    const nextTax = calcTax(amount, preset.defaultTaxCode, taxRate);
    setDisbursementItems(prev => {
      // Determine itemNo by category (1=search, 2=stamp_duty, 3=registration)
      const itemNo = preset.category === "search" ? "1" : preset.category === "stamp_duty" ? "2" : "3";
      // Find the header row index for this category
      const headerIndex = prev.findIndex(x => x.category === preset.category && x.subItemNo === "" && x.description !== "" && !x.isCustom);
      const sibs = prev.filter(x => x.category === preset.category);
      const subs = sibs.filter(x => x.subItemNo !== "");
      // Letter: a,b,c.. aa,ab.. fallback numeric if too many
      const idx = subs.length;
      let sub = String.fromCharCode(97 + idx);
      if (idx >= 26) {
        const first = Math.floor(idx / 26) - 1;
        const second = idx % 26;
        sub = `${String.fromCharCode(97 + first)}${String.fromCharCode(97 + second)}`;
      }
      const newRow: LineItem = {
        id,
        section: "disbursement",
        category: preset.category,
        itemNo,
        subItemNo: sub,
        description: preset.label,
        taxCode: preset.defaultTaxCode || "Z",
        itemCategory: "disbursement",
        amountExclTax: amount,
        taxRate: nextTax.taxRate,
        taxAmount: nextTax.taxAmount,
        amountInclTax: nextTax.amountInclTax,
        quantity: undefined,
        unitAmount: undefined,
        remarks: undefined,
        isCustom: false,
      };
      // Insert after header row if we can find it, else end
      if (headerIndex >= 0) {
        // Find last sibling row with same itemNo (after header, before next header)
        let insertAt = headerIndex + 1;
        while (insertAt < prev.length && prev[insertAt].category === preset.category) insertAt++;
        return [...prev.slice(0, insertAt), newRow, ...prev.slice(insertAt)];
      }
      return [...prev, newRow];
    });
  }, [taxRate]);

  const { data: caseDetail } = useGetCase(
    parseInt(selectedCaseId) || 0,
    {
      query: {
        queryKey: getGetCaseQueryKey(parseInt(selectedCaseId) || 0),
        enabled: !!selectedCaseId && parseInt(selectedCaseId) > 0,
      },
    }
  );

  useEffect(() => {
    setClientAddress("");
    setClientDetails([]);
  }, [selectedCaseId]);

  useEffect(() => {
    if (!caseDetail) return;
    const purchaserNames = (caseDetail.purchasers || [])
      .map((p) => p.clientName)
      .filter(Boolean)
      .join(" & ");
    const purchaserRows = (caseDetail.purchasers || [])
      .map((p) => String(p.clientName ?? "").trim())
      .filter(Boolean)
      .map((name) => ({ id: generateId(), name, tin: "" }));
    if (purchaserRows.length > 0) setClientDetails(purchaserRows);

    const propParts = [caseDetail.projectName].filter(Boolean).join(", ");
    if (propParts) setPropertyDescription(propParts);

    if (caseDetail.spaPrice) setPurchasePrice(String(caseDetail.spaPrice));
    if (caseDetail.referenceNo) setReferenceNo(caseDetail.referenceNo);
  }, [caseDetail]);

  const primaryClientId = (() => {
    const ps = Array.isArray((caseDetail as any)?.purchasers) ? ((caseDetail as any).purchasers as any[]) : [];
    const primary = ps.find((p) => String(p?.role ?? "").toLowerCase() === "main") ?? ps[0];
    const id = Number(primary?.clientId);
    return Number.isFinite(id) ? id : 0;
  })();
  const { data: primaryClient } = useGetClient(primaryClientId, { query: { enabled: primaryClientId > 0, staleTime: 5 * 60 * 1000, queryKey: getGetClientQueryKey(primaryClientId) } });

  useEffect(() => {
    if (!primaryClient) return;
    setClientAddress((prev) => prev || String((primaryClient as any)?.address ?? ""));
  }, [primaryClient]);

  const [disbursementItems, setDisbursementItems] = useState<LineItem[]>(() => initItems(DEFAULT_DISBURSEMENT_ITEMS));
  const [feesItems, setFeesItems] = useState<LineItem[]>(() => initItems(DEFAULT_FEES_ITEMS));
  const [reimbursementItems, setReimbursementItems] = useState<LineItem[]>(() => initItems(DEFAULT_REIMBURSEMENT_ITEMS));
  const [attachmentItems, setAttachmentItems] = useState<LineItem[]>([]);

  const [activeSection, setActiveSection] = useState<string>("fees");
  const exclInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const descInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    const recalc = (items: LineItem[]): LineItem[] =>
      items.map((item) => {
        const nextTax = calcTax(item.amountExclTax, item.taxCode, taxRate);
        return { ...item, taxRate: nextTax.taxRate, taxAmount: nextTax.taxAmount, amountInclTax: nextTax.amountInclTax };
      });
    setDisbursementItems(recalc);
    setFeesItems(recalc);
    setReimbursementItems(recalc);
    setAttachmentItems(recalc);
  }, [taxRate]);

  const updateItemAmount = useCallback((
    setItems: React.Dispatch<React.SetStateAction<LineItem[]>>,
    itemId: string,
    amount: number
  ) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      const nextTax = calcTax(amount, item.taxCode, taxRate);
      return { ...item, amountExclTax: amount, taxRate: nextTax.taxRate, taxAmount: nextTax.taxAmount, amountInclTax: nextTax.amountInclTax };
    }));
  }, [taxRate]);

  const updateItemTaxCode = useCallback((
    setItems: React.Dispatch<React.SetStateAction<LineItem[]>>,
    itemId: string,
    taxCode: string
  ) => {
    setItems(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      const nextTax = calcTax(item.amountExclTax, taxCode, taxRate);
      return { ...item, taxCode, taxRate: nextTax.taxRate, taxAmount: nextTax.taxAmount, amountInclTax: nextTax.amountInclTax };
    }));
  }, [taxRate]);

  const updateItemDescription = useCallback((
    setItems: React.Dispatch<React.SetStateAction<LineItem[]>>,
    itemId: string,
    description: string
  ) => {
    setItems((prev) => prev.map((item) => item.id === itemId ? { ...item, description } : item));
  }, []);

  const updateItemRemarks = useCallback((itemId: string, remarks: string) => {
    setDisbursementItems((prev) => prev.map((item) => item.id === itemId ? { ...item, remarks } : item));
  }, []);

  const updateSearchMeta = useCallback((itemId: string, patch: { quantity?: number; unitAmount?: number }) => {
    setDisbursementItems((prev) => prev.map((item) => {
      if (item.id !== itemId) return item;
      const nextQty = typeof patch.quantity === "number" && Number.isFinite(patch.quantity) ? Math.max(1, Math.trunc(patch.quantity)) : (item.quantity ?? 1);
      const nextUnit = typeof patch.unitAmount === "number" && Number.isFinite(patch.unitAmount) ? Math.max(0, patch.unitAmount) : (item.unitAmount ?? 0);
      const amount = nextQty * nextUnit;
      const nextTax = calcTax(amount, item.taxCode, taxRate);
      return { ...item, quantity: nextQty, unitAmount: nextUnit, amountExclTax: amount, taxRate: nextTax.taxRate, taxAmount: nextTax.taxAmount, amountInclTax: nextTax.amountInclTax };
    }));
  }, [taxRate]);

  const removeLineItem = useCallback((setItems: React.Dispatch<React.SetStateAction<LineItem[]>>, itemId: string) => {
    setItems((prev) => prev.filter((item) => item.id !== itemId));
  }, []);

  const addFeesCustomLine = useCallback(() => {
    setActiveSection("fees");
    const id = generateId();
    setFeesItems((prev) => {
      const fixed = prev.filter((i) => {
        const n = Number.parseInt(String(i.itemNo ?? ""), 10);
        return Number.isFinite(n) && n > 0 && n <= 26;
      });
      const custom = prev.filter((i) => !fixed.includes(i) && i.subItemNo === "");
      const nextNo = String(26 + custom.length + 1);
      const nextTax = calcTax(0, "T", taxRate);
      return [
        ...prev,
        {
          id,
          section: "fees",
          category: "fees",
          itemNo: nextNo,
          subItemNo: "",
          description: "",
          taxCode: "T",
          itemCategory: "fee",
          amountExclTax: 0,
          taxRate: nextTax.taxRate,
          taxAmount: nextTax.taxAmount,
          amountInclTax: nextTax.amountInclTax,
          isCustom: true,
        },
      ];
    });
    window.setTimeout(() => descInputRefs.current[id]?.focus(), 0);
  }, [taxRate]);

  const addDisbursementLine = useCallback((category: "search" | "stamp_duty" | "registration") => {
    setActiveSection("disbursement");
    const id = generateId();
    setDisbursementItems((prev) => {
      const header = prev.find((i) => i.category === category && !i.subItemNo);
      const itemNo = header?.itemNo ?? (category === "search" ? "1" : category === "stamp_duty" ? "2" : "3");
      const existing = prev.filter((i) => i.category === category && i.subItemNo);
      const idx = existing.length;
      const nextSub = idx < 26 ? String.fromCharCode(97 + idx) : String(idx + 1);
      const nextTax = calcTax(0, "Z", taxRate);
      const base: LineItem = {
        id,
        section: "disbursement",
        category,
        itemNo,
        subItemNo: nextSub,
        description: "",
        taxCode: "Z",
        itemCategory: "disbursement",
        amountExclTax: 0,
        taxRate: nextTax.taxRate,
        taxAmount: nextTax.taxAmount,
        amountInclTax: nextTax.amountInclTax,
        isCustom: true,
      };
      const nextItem: LineItem = category === "search"
        ? { ...base, quantity: 1, unitAmount: 0 }
        : { ...base, remarks: "" };
      const order: Record<string, number> = { search: 1, stamp_duty: 2, registration: 3 };
      return [...prev, nextItem].sort((a, b) => {
        const ao = order[a.category] ?? 9;
        const bo = order[b.category] ?? 9;
        if (ao !== bo) return ao - bo;
        if (!a.subItemNo && b.subItemNo) return -1;
        if (a.subItemNo && !b.subItemNo) return 1;
        return String(a.subItemNo).localeCompare(String(b.subItemNo));
      });
    });
    window.setTimeout(() => descInputRefs.current[id]?.focus(), 0);
  }, [taxRate]);

  const addCustomDisbursementLine = useCallback(() => {
    addDisbursementLine("search");
  }, [addDisbursementLine]);

  const addAttachmentItem = () => {
    setAttachmentItems(prev => [...prev, {
      id: generateId(),
      section: "attachment",
      category: "attachment",
      itemNo: String(prev.length + 1),
      subItemNo: "",
      description: "",
      taxCode: "T",
      itemCategory: "disbursement",
      amountExclTax: 0,
      taxRate,
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
    const hasClient = clientDetails.some((c) => c.name.trim());
    if (!referenceNo.trim() || !hasClient) {
      toast({ title: "Reference number and client details are required", variant: "destructive" });
      return;
    }

    const sourceItems = [
      ...disbursementItems,
      ...feesItems,
      ...reimbursementItems,
      ...attachmentItems,
    ];

    const isHeaderRow = (item: LineItem) => !item.subItemNo && item.description === item.description.toUpperCase();
    const bad = sourceItems.find((item) => !isHeaderRow(item) && item.amountExclTax > 0 && !item.description.trim());
    if (bad) {
      toast({ title: "Description is required for all non-empty lines", variant: "destructive" });
      return;
    }

    const itemsToSave = sourceItems.filter((item) => {
      if (isHeaderRow(item)) return true;
      if (!item.description.trim()) return false;
      if (item.section === "attachment") return true;
      if (item.isCustom) return true;
      return item.amountExclTax > 0;
    });

    const allItems = itemsToSave.map((item, idx) => ({
      section: item.section,
      category: encodeCategory(item.category, {
        quantity: item.section === "disbursement" && item.category === "search" && item.subItemNo ? (item.quantity ?? 1) : undefined,
        unitAmount: item.section === "disbursement" && item.category === "search" && item.subItemNo ? (item.unitAmount ?? 0) : undefined,
        remarks: item.section === "disbursement" && (item.category === "stamp_duty" || item.category === "registration") && item.subItemNo
          ? (item.remarks ?? "")
          : undefined,
      }),
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

    createMutation.mutate(
      {
        data: {
          referenceNo,
          clientDetails: clientDetails
            .map((c) => ({ name: c.name.trim(), tin: c.tin.trim() || undefined }))
            .filter((c) => c.name),
          caseId: selectedCaseId ? parseInt(selectedCaseId) : undefined,
          propertyDescription: propertyDescription || undefined,
          purchasePrice: purchasePrice || undefined,
          bankName: bankName || undefined,
          loanAmount: loanAmount || undefined,
          items: allItems,
          ...({ clientAddress: clientAddress || undefined, taxRate } as any),
        } as any,
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
    { key: "fees", label: "Professional Fees", items: feesItems, setter: setFeesItems, totals: feesTotals },
    { key: "reimbursement", label: "Reimbursement", items: reimbursementItems, setter: setReimbursementItems, totals: reimbTotals },
    { key: "disbursement", label: "Disbursement", items: disbursementItems, setter: setDisbursementItems, totals: disbTotals },
    { key: "attachment", label: "Attachment I", items: attachmentItems, setter: setAttachmentItems, totals: attTotals },
  ];

  const currentSection = sections.find(s => s.key === activeSection)!;
  const currentEditableIds = currentSection.items
    .filter((item) => {
      const isHeader = !item.subItemNo && item.description === item.description.toUpperCase();
      return !isHeader;
    })
    .map((i) => i.id);
  const attachmentEditableIds = attachmentItems.map((i) => i.id);

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
            <div className="md:col-span-2 relative">
              <Label className="text-xs text-slate-500">Case / Reference No. *</Label>
              <div className="relative">
                <div className="relative flex items-stretch">
                  <div className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 pointer-events-none">
                    <Search className="w-4 h-4" />
                  </div>
                  <Input
                    className={cn("h-9 pl-9 pr-9", !!(selectedCase?.referenceNo) ? "bg-slate-50" : "")}
                    placeholder="Type reference, purchaser, project or property..."
                    value={selectedCase ? `${selectedCase.referenceNo} ${selectedCase.partyLabel ?? ""}` : caseSearch}
                    readOnly={!!selectedCase}
                    onFocus={() => !selectedCase && setCaseComboboxOpen(true)}
                    onBlur={() => window.setTimeout(() => setCaseComboboxOpen(false), 120)}
                    onChange={(e) => {
                      if (selectedCase) return;
                      setCaseSearch(e.target.value);
                      setCaseComboboxOpen(true);
                    }}
                  />
                  {selectedCase ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Clear selected case"
                      className="absolute inset-y-0 right-0 h-9 w-9 rounded-md text-slate-500 hover:text-slate-800"
                      onClick={() => {
                        setSelectedCase(null);
                        setSelectedCaseId("");
                        setReferenceNo("");
                        setCaseSearch("");
                        setCaseComboboxOpen(false);
                      }}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  ) : null}
                </div>
                {caseComboboxOpen && !selectedCase && (
                  <div className="absolute z-40 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg max-h-80 overflow-auto">
                    {debouncedCaseSearch.length < 2 ? (
                      <div className="px-4 py-3 text-xs text-slate-500">Type at least 2 characters to search...</div>
                    ) : caseSearchQuery.isFetching && caseSearchItems.length === 0 ? (
                      <div className="px-4 py-3 text-xs text-slate-500">Searching...</div>
                    ) : caseSearchItems.length === 0 ? (
                      <div className="px-4 py-3 text-xs text-slate-500">No matching cases.</div>
                    ) : (
                      caseSearchItems.map((it) => {
                        const secondLine = [it.partyLabel, it.project, it.propertyParcelNo || it.parcelNo, it.propertyAddress].filter(Boolean).join(" • ");
                        return (
                          <button
                            type="button"
                            key={it.id}
                            className="w-full text-left px-3 py-2 hover:bg-slate-100 border-b border-slate-100 last:border-b-0"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setSelectedCase(it);
                              setCaseSearch(it.referenceNo);
                              setCaseComboboxOpen(false);
                            }}
                          >
                            <div className="text-sm font-semibold text-slate-900">{it.referenceNo}</div>
                            {secondLine ? <div className="text-xs text-slate-500 mt-0.5 truncate">{secondLine}</div> : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                {selectedCase
                  ? `Linked to case id ${selectedCase.id}. Reference derived from the selected case. Click X to re-select.`
                  : "Find a case first — reference, purchaser, project, address, parcel, borrower or developer."}
              </div>
            </div>
            <div>
              <Label className="text-xs text-slate-500">
                Reference (derived from case)
              </Label>
              <Input
                value={referenceNo}
                readOnly
                tabIndex={-1}
                placeholder="Select a case above."
                className="h-9 bg-slate-50 text-slate-600 cursor-not-allowed"
              />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Service Tax Rate (%)</Label>
              <Input
                type="number"
                value={String(taxRate)}
                onChange={(e) => setTaxRate(Number(e.target.value) || 0)}
                placeholder="8"
              />
            </div>
            <div className="md:col-span-3">
              <Label className="text-xs text-slate-500">Client Details (Name + TIN)</Label>
              <div className="space-y-2 mt-2">
                {clientDetails.map((c) => (
                  <div key={c.id} className="grid grid-cols-1 md:grid-cols-12 gap-2">
                    <div className="md:col-span-7">
                      <Input
                        value={c.name}
                        placeholder="Name"
                        onChange={(e) => setClientDetails((xs) => xs.map((x) => x.id === c.id ? { ...x, name: e.target.value } : x))}
                      />
                    </div>
                    <div className="md:col-span-4">
                      <Input
                        value={c.tin}
                        placeholder="TIN Number"
                        onChange={(e) => setClientDetails((xs) => xs.map((x) => x.id === c.id ? { ...x, tin: e.target.value } : x))}
                      />
                    </div>
                    <div className="md:col-span-1 flex md:justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setClientDetails((xs) => xs.filter((x) => x.id !== c.id))}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                {clientDetails.length === 0 ? (
                  <div className="text-xs text-slate-500">Select a case to auto-fill purchasers, or add clients manually.</div>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setClientDetails((xs) => [...xs, { id: generateId(), name: "", tin: "" }])}
                >
                  <Plus className="w-4 h-4 mr-2" /> Add Client
                </Button>
              </div>
            </div>
            <div className="md:col-span-3">
              <Label className="text-xs text-slate-500">Client Address</Label>
              <Textarea value={clientAddress} onChange={e => setClientAddress(e.target.value)} placeholder="Client address" className="min-h-[70px]" />
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
                        <th className="text-right px-3 py-2 font-medium text-slate-600 w-28">ST @ {taxRate}% (RM)</th>
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
                            onChange={(e) => updateItemTaxCode(setAttachmentItems, item.id, e.target.value)}
                            className="h-8 border border-slate-200 rounded-md px-2 text-xs bg-white"
                          >
                            <option value="T">T</option>
                            <option value="Z">Z</option>
                          </select>
                        </td>
                          <td className="px-3 py-2">
                            <Input
                              type="number"
                              value={item.amountExclTax || ""}
                              onChange={e => updateItemAmount(setAttachmentItems, item.id, parseFloat(e.target.value) || 0)}
                              className="h-8 text-right"
                              placeholder="0.00"
                              ref={(el) => { exclInputRefs.current[item.id] = el; }}
                              onKeyDown={(e) => {
                                if (e.key !== "Tab" || e.shiftKey) return;
                                e.preventDefault();
                                const idx = attachmentEditableIds.indexOf(item.id);
                                const nextId = idx >= 0 ? attachmentEditableIds[idx + 1] : undefined;
                                if (nextId) exclInputRefs.current[nextId]?.focus();
                              }}
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Input readOnly tabIndex={-1} value={item.taxAmount.toFixed(2)} className="h-8 text-right text-xs text-slate-500 border-0 bg-transparent shadow-none focus-visible:ring-0" />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Input readOnly tabIndex={-1} value={item.amountInclTax.toFixed(2)} className="h-8 text-right text-xs font-medium border-0 bg-transparent shadow-none focus-visible:ring-0" />
                          </td>
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
            <div>
              {activeSection === "fees" ? (
                <div className="flex justify-end mb-3">
                  <Button size="sm" variant="outline" onClick={addFeesCustomLine}>
                    <Plus className="w-4 h-4 mr-1" /> Add Line
                  </Button>
                </div>
              ) : null}
              {activeSection === "disbursement" ? (
                <div className="flex flex-wrap justify-end items-center gap-2 mb-3 relative">
                  <div className="relative">
                    <Button
                      id="disbursement-preset-menu-button"
                      size="sm"
                      variant="outline"
                      aria-haspopup="listbox"
                      aria-expanded={disbDropdownOpen}
                      onClick={() => setDisbDropdownOpen(v => !v)}
                      onBlur={() => window.setTimeout(() => setDisbDropdownOpen(false), 150)}
                    >
                      <Plus className="w-4 h-4 mr-1" /> Add Disbursement
                      <ChevronDown className="w-3.5 h-3.5 ml-1.5" />
                    </Button>
                    {disbDropdownOpen ? (
                      <div
                        role="listbox"
                        className="absolute z-30 right-0 mt-1 w-[460px] max-w-[90vw] max-h-[380px] overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg flex flex-col"
                      >
                        <div className="px-3 py-2 border-b border-slate-100">
                          <Input
                            autoFocus
                            size={1}
                            value={disbursementPresetQuery}
                            onChange={(e) => setDisbursementPresetQuery(e.target.value)}
                            placeholder="Search presets..."
                            className="h-8 text-xs px-2"
                          />
                        </div>
                        <div className="overflow-y-auto flex-1 py-1">
                          {filteredDisbursementPresets.length === 0 ? (
                            <div className="px-3 py-3 text-xs text-slate-500">No presets match.</div>
                          ) : (
                            filteredDisbursementPresets.map((p) => (
                              <button
                                type="button"
                                key={p.id}
                                value={p.id}
                                className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-3"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  addDisbursementPresetLine(p);
                                  setDisbursementPresetQuery("");
                                  setDisbDropdownOpen(false);
                                }}
                              >
                                <div className="min-w-0">
                                  <div className="text-sm text-slate-800 truncate">{p.label}</div>
                                  <div className="text-[11px] text-slate-400 mt-0.5">
                                    {p.category.replace("_", " ")} • Tax {p.defaultTaxCode}
                                    {typeof p.defaultAmount === "number" ? ` • Suggested RM ${p.defaultAmount.toFixed(2)}` : ""}
                                  </div>
                                </div>
                                <span className="text-[10px] uppercase tracking-wide text-slate-400 whitespace-nowrap px-2 py-0.5 border border-slate-200 rounded">
                                  {p.category === "stamp_duty" ? "STAMP" : p.category === "registration" ? "REG" : "SEARCH"}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => { setActiveSection("disbursement"); addCustomDisbursementLine(); }}>
                    <Plus className="w-4 h-4 mr-1" /> Add Custom Line
                  </Button>
                </div>
              ) : null}
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">No.</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>
                    <th className="text-center px-3 py-2 font-medium text-slate-600 w-20">Tax Code</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Total Excl. ST (RM)</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600 w-28">ST @ {taxRate}% (RM)</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600 w-32">Total Incl. ST (RM)</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {currentSection.items.map((item) => {
                    const isHeader = !item.subItemNo && item.description === item.description.toUpperCase();
                    const isSearchLine = !isHeader && activeSection === "disbursement" && item.category === "search" && Boolean(item.subItemNo);
                    const showDelete =
                      !isHeader
                      && (activeSection === "disbursement"
                        || (activeSection === "fees" && Boolean(item.isCustom)));
                    const canEditDescription =
                      !isHeader
                      && (activeSection === "disbursement"
                        || (activeSection === "fees" && Boolean(item.isCustom)));
                    return (
                      <tr key={item.id} className={`border-b border-slate-100 ${isHeader ? "bg-slate-50/50" : ""}`}>
                        <td className="px-3 py-1.5 text-slate-500 text-xs">
                          {item.subItemNo || item.itemNo}
                        </td>
                        <td className={`px-3 py-1.5 ${isHeader ? "font-semibold text-slate-800" : "text-slate-600"}`}>
                          {isHeader ? (
                            item.description
                          ) : canEditDescription ? (
                            <div className="space-y-2">
                              <Input
                                value={item.description}
                                onChange={(e) => updateItemDescription(currentSection.setter, item.id, e.target.value)}
                                placeholder="Description"
                                className="h-7 text-xs"
                                ref={(el) => { descInputRefs.current[item.id] = el; }}
                              />
                              {activeSection === "disbursement" && item.category === "search" ? (
                                <div className="flex flex-wrap gap-2">
                                  <Input
                                    type="number"
                                    value={item.quantity ?? 1}
                                    onChange={(e) => updateSearchMeta(item.id, { quantity: Number.parseInt(e.target.value || "1", 10) })}
                                    className="h-7 text-xs w-24"
                                    min={1}
                                    placeholder="Qty"
                                  />
                                  <Input
                                    type="number"
                                    value={item.unitAmount ?? 0}
                                    onChange={(e) => updateSearchMeta(item.id, { unitAmount: parseFloat(e.target.value) || 0 })}
                                    className="h-7 text-xs w-32"
                                    min={0}
                                    placeholder="Unit (RM)"
                                  />
                                </div>
                              ) : null}
                              {activeSection === "disbursement" && (item.category === "stamp_duty" || item.category === "registration") ? (
                                <Input
                                  value={item.remarks ?? ""}
                                  onChange={(e) => updateItemRemarks(item.id, e.target.value)}
                                  placeholder="Remarks (optional)"
                                  className="h-7 text-xs"
                                />
                              ) : null}
                            </div>
                          ) : (
                            item.description
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {!isHeader ? (
                            <select
                              value={item.taxCode}
                              onChange={(e) => updateItemTaxCode(currentSection.setter, item.id, e.target.value)}
                              className="h-7 border border-slate-200 rounded-md px-2 text-xs bg-white"
                            >
                              <option value="T">T</option>
                              <option value="Z">Z</option>
                            </select>
                          ) : null}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {!isHeader && (
                            <Input
                              type="number"
                              value={item.amountExclTax || ""}
                              onChange={e => updateItemAmount(currentSection.setter, item.id, parseFloat(e.target.value) || 0)}
                              className="h-7 text-right text-xs w-28 ml-auto"
                              placeholder="0.00"
                              ref={(el) => { exclInputRefs.current[item.id] = el; }}
                              readOnly={isSearchLine}
                              disabled={isSearchLine}
                              onKeyDown={(e) => {
                                if (e.key !== "Tab" || e.shiftKey) return;
                                e.preventDefault();
                                const idx = currentEditableIds.indexOf(item.id);
                                const nextId = idx >= 0 ? currentEditableIds[idx + 1] : undefined;
                                if (nextId) exclInputRefs.current[nextId]?.focus();
                              }}
                            />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs text-slate-500">
                          {!isHeader ? (
                            <Input readOnly tabIndex={-1} value={item.taxAmount.toFixed(2)} className="h-7 text-right text-xs text-slate-500 border-0 bg-transparent shadow-none focus-visible:ring-0 w-24 ml-auto" />
                          ) : ""}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs font-medium">
                          {!isHeader ? (
                            <Input readOnly tabIndex={-1} value={item.amountInclTax.toFixed(2)} className="h-7 text-right text-xs font-medium border-0 bg-transparent shadow-none focus-visible:ring-0 w-24 ml-auto" />
                          ) : ""}
                        </td>
                        <td className="px-3 py-1.5">
                          {showDelete ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeLineItem(currentSection.setter, item.id)}
                              className="text-red-500"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          ) : null}
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
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="max-w-md ml-auto space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Professional Fees</span>
              <span>{formatRM(feesTotals.totalInclTax)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Reimbursement</span>
              <span>{formatRM(reimbTotals.totalInclTax)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Disbursement</span>
              <span>{formatRM(disbTotals.totalInclTax)}</span>
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
