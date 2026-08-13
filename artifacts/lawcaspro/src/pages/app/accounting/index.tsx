import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation, useSearch } from "wouter";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  DollarSign, TrendingUp, Clock, Briefcase, Plus, Search, FileText,
  Receipt, CreditCard, BookOpen, ChevronRight, RotateCcw, ArrowUpDown, ListOrdered, Landmark, Printer, Minus,
  Settings as SettingsIcon, Users, Calendar, Shield, AlertTriangle, Trash2, XCircle, CheckCircle2, Activity, CheckCircle,
  FolderKey, HandCoins, Archive, UserCheck, ArrowRightLeft, PackageOpen, AArrowDown, AArrowUp,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { DateOnlyInput } from "@/components/date-only-input";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { hasPermission } from "@/lib/permissions";
import { useListQuotations } from "@workspace/api-client-react";
import { QueryFallback } from "@/components/query-fallback";
import { useReAuth } from "@/components/re-auth-dialog";
import { useAuth } from "@/lib/auth-context";
import { CaseMultiSelect, type SelectedCase } from "@/components/accounting/case-multi-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { CreatePaymentVoucherBody, PaymentVoucherTransitionBody, type PaymentVoucherFundStatus } from "@workspace/api-zod";
import BankAccountsTab from "./bank-accounts";
import BankReconciliationPage from "./bank-reconciliation";
import {
  clearPendingPaymentVoucherCreateSessionState,
  derivePaymentVoucherSubmitUiState,
  getPaymentVoucherCreateStatus,
  PaymentVoucherConfirmationPendingError,
  PaymentVoucherConfirmationStaleError,
  PaymentVoucherConfirmationUnknownError,
  PaymentVoucherPreflightWarningShown,
  type PaymentVoucherPendingCreatePhase,
  restorePendingPaymentVoucherCreateFromSessionStorage,
  savePendingPaymentVoucherCreateSessionState,
  submitPaymentVoucherWithRecovery,
} from "./payment-voucher-submit";

function fmt(val: unknown) {
  return `RM ${Number(val ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type InvoiceRow = {
  id: number;
  invoiceNo: string;
  status: string;
  issuedDate?: string | null;
  dueDate?: string | null;
  grandTotal: number | string;
  amountPaid: number | string;
  amountDue: number | string;
  caseId?: number | null;
};

type AccountingSummaryResponse = {
  monthly?: Array<{ month: string; total: number }>;
};

type CaseFileParty = { role: string; name: string; idNo: string | null };
type CaseFileQuotation = { id: number; date: string; billedTo: string; amount: number | string | null };
type CaseFileInvoice = { id: number; date: string; invoiceNo: string; amount: number | string | null };
type CaseFileRow = {
  id: number;
  referenceNo: string;
  clientParties: CaseFileParty[];
  propertyInfo: string;
  lawyerInCharge: string | null;
  clerkInCharge: string | null;
  status: string;
  openFileDate: string;
  closedFileDate: string | null;
  daysToClose: number | null;
  daysSinceOpen: number | null;
  latestQuotation: CaseFileQuotation | null;
  latestInvoice: CaseFileInvoice | null;
};

type CaseFilesListResponse = {
  data: CaseFileRow[];
  page: number;
  limit: number;
  total: number;
};

const TABS = ["Overview", "Monitor", "File Listing", "Payment Vouchers", "Quotations", "Invoices", "Receipts", "Bank Accounts", "Bank Reconciliation", "Ledger", "Settings"] as const;
type Tab = typeof TABS[number];

const TAB_KEYS: Record<string, Tab> = {
  overview: "Overview",
  monitor: "Monitor",
  "file-listing": "File Listing",
  invoices: "Invoices",
  receipts: "Receipts",
  "payment-vouchers": "Payment Vouchers",
  quotations: "Quotations",
  "bank-accounts": "Bank Accounts",
  "bank-reconciliation": "Bank Reconciliation",
  ledger: "Ledger",
  settings: "Settings",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  issued: "bg-blue-100 text-blue-700",
  partially_paid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700",
  void: "bg-red-100 text-red-600",
  overdue: "bg-red-100 text-red-700",
  sent: "bg-blue-100 text-blue-700",
  accepted: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  pending_lawyer: "bg-blue-100 text-blue-700",
  pending_partner: "bg-indigo-100 text-indigo-700",
  pending_account: "bg-violet-100 text-violet-700",
  paid_pending_collection: "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
};

function StatusBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  return (
    <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600")}>
      {label}
    </span>
  );
}

const APPROVAL_COLORS: Record<string, string> = {
  approved: "bg-green-100 text-green-700",
  pending_approval: "bg-amber-100 text-amber-700",
  rejected: "bg-red-100 text-red-700",
};

function ApprovalBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  return (
    <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", APPROVAL_COLORS[status] ?? "bg-slate-100 text-slate-600")}>
      {label}
    </span>
  );
}

const PAYMENT_VOUCHER_NEXT_ACTIONS = [
  "Collect Physical File",
  "Retrieve File from Accounts",
  "Proceed with Registration",
  "Proceed with Stamping",
  "Release Document",
  "Send Document to Bank",
  "Send Document to Client",
  "Update Case Milestone",
  "Prepare Next Submission",
  "Follow Up with Relevant Party",
  "Custom Action",
] as const;

function toDateTimeLocalValue(value: string | null | undefined): string {
  if (!value) return "";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  const hour = String(dt.getHours()).padStart(2, "0");
  const minute = String(dt.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

// ── OVERVIEW TAB ─────────────────────────────────────────────────────────────

function LedgerSummaryInline() {
  const { data } = useQuery({ queryKey: ["ledger-summary"], queryFn: () => apiFetchJson("/ledger/summary"), retry: false, staleTime: 30_000, refetchInterval: false, refetchOnWindowFocus: false });
  const rows = (data ?? []) as any[];
  if (!rows.length) return <div className="text-slate-400 text-sm py-4 text-center">No ledger entries yet</div>;
  const acctLabel = (acct: string) => acct === "balance_sheet" ? "Balance Sheet / FD" : acct === "client" ? "Client Account" : "Office Account";
  const order = ["client", "office", "balance_sheet"];
  const sorted = [...rows].sort((a: any, b: any) => order.indexOf(String(a.accountType)) - order.indexOf(String(b.accountType)));
  return (
    <div className="space-y-3">
      {sorted.map((r: any) => (
        <div key={r.accountType} className="flex justify-between items-center py-2 border-b last:border-0">
          <div>
            <div className="text-sm font-medium text-slate-900">{acctLabel(String(r.accountType ?? ""))}</div>
            <div className="text-xs text-slate-400">Dr {fmt(r.totalDebit)} | Cr {fmt(r.totalCredit)}</div>
          </div>
          <div className={cn("text-base font-bold", Number(r.balance) >= 0 ? "text-green-600" : "text-red-500")}>
            {fmt(r.balance)}
          </div>
        </div>
      ))}
    </div>
  );
}

function OverviewTab() {
  const { data: invMetrics } = useQuery({
    queryKey: ["invoice-metrics"],
    queryFn: () => apiFetchJson<{ totalInvoiced: number; totalCollected: number; totalOutstanding: number; invoiceCount: number }>("/accounting/invoice-metrics"),
    retry: false,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const { data: invData } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetchJson<InvoiceRow[]>("/invoices"),
    retry: false,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const invoices = invData ?? [];
  const invTotals = {
    total: Number(invMetrics?.totalInvoiced ?? 0),
    paid: Number(invMetrics?.totalCollected ?? 0),
    due: Number(invMetrics?.totalOutstanding ?? 0),
  };

  const { data: accData } = useQuery<AccountingSummaryResponse>({
    queryKey: ["accounting-summary"],
    queryFn: () => apiFetchJson<AccountingSummaryResponse>("/accounting/summary"),
    retry: false,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const monthly = accData?.monthly ?? [];

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Invoiced", value: fmt(invTotals.total), icon: FileText, color: "bg-amber-50 text-amber-600" },
          { label: "Collected", value: fmt(invTotals.paid), icon: TrendingUp, color: "bg-green-50 text-green-600" },
          { label: "Outstanding", value: fmt(invTotals.due), icon: Clock, color: "bg-red-50 text-red-500" },
          { label: "Open Invoices", value: String(invoices.filter(i => i.status === "issued" || i.status === "partially_paid").length), icon: Briefcase, color: "bg-slate-100 text-slate-600" },
        ].map((item) => (
          <Card key={item.label}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${item.color}`}>
                  <item.icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-500">{item.label}</div>
                  <div className="text-lg font-bold text-slate-900 leading-tight">{item.value}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {monthly.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Monthly Revenue</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => `RM${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: unknown) => [`RM ${Number(v).toLocaleString("en-MY")}`, "Amount"]} />
                <Bar dataKey="total" fill="#f5a623" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Recent Invoices</CardTitle></CardHeader>
          <CardContent>
            {invoices.length === 0 ? (
              <div className="text-center py-6 text-slate-400 text-sm">No invoices yet</div>
            ) : (
              <div className="divide-y">
                {invoices.slice(0, 6).map((inv: any) => (
                  <div key={inv.id} className="flex items-center justify-between py-3">
                    <div>
                      <div className="font-medium text-sm text-slate-900">{inv.invoiceNo}</div>
                      <div className="text-xs text-slate-400">{inv.issuedDate ?? "—"}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={inv.status} />
                      <span className="text-sm font-semibold text-slate-700">{fmt(inv.grandTotal)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Account Balance Summary</CardTitle></CardHeader>
          <CardContent><LedgerSummaryInline /></CardContent>
        </Card>
      </div>
    </>
  );
}

// ── FILE LISTING TAB ─────────────────────────────────────────────────────────

function FileListingTab() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const limit = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced]);

  const listQuery = useQuery<CaseFilesListResponse>({
    queryKey: ["case-files", debounced, page, limit],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debounced) params.set("q", debounced);
      params.set("page", String(page));
      params.set("limit", String(limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return await apiFetchJson<CaseFilesListResponse>(`/case-files${suffix}`);
    },
    retry: false,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  function renderParties(parties: CaseFileParty[]) {
    if (!parties?.length) return <span className="text-slate-400">—</span>;
    const shown = parties.slice(0, 2);
    const more = parties.length - shown.length;
    return (
      <div className="space-y-1">
        {shown.map((p, idx) => (
          <div key={`${p.role}-${p.name}-${idx}`} className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded border border-slate-200 text-[10px] capitalize text-slate-500">{p.role}</span>
            <span className="text-sm text-slate-900 truncate">{p.name}</span>
          </div>
        ))}
        {more > 0 ? <div className="text-xs text-slate-500">+{more} more</div> : null}
      </div>
    );
  }

  function renderInvoiceInfo(inv: CaseFileInvoice | null) {
    if (!inv) return <span className="text-slate-400">—</span>;
    return (
      <div className="text-xs">
        <div className="font-medium text-slate-800">{inv.invoiceNo}</div>
        <div className="text-slate-500">{new Date(inv.date).toLocaleDateString()}</div>
        <div className="text-amber-600 font-semibold">{fmt(inv.amount)}</div>
      </div>
    );
  }

  function renderQuotationInfo(quo: CaseFileQuotation | null) {
    if (!quo) return <span className="text-slate-400">—</span>;
    return (
      <div className="text-xs">
        <div className="font-medium text-slate-800 truncate max-w-[120px]" title={quo.billedTo}>{quo.billedTo}</div>
        <div className="text-slate-500">{new Date(quo.date).toLocaleDateString()}</div>
        <div className="text-amber-600 font-semibold">{fmt(quo.amount)}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-3">
            <span>Case Files</span>
            <div className="relative w-full max-w-md">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                className="pl-9"
                placeholder="Search file ref, client, project, status…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {listQuery.isError ? (
            <QueryFallback title="Listing unavailable" error={listQuery.error} onRetry={() => listQuery.refetch()} isRetrying={listQuery.isFetching} />
          ) : listQuery.isLoading ? (
            <div className="text-slate-500 py-10 text-center">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-14 text-slate-500">
              <p className="font-medium text-slate-700">No files found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b">
                    <th className="py-3 pr-4 min-w-[120px]">File Reference</th>
                    <th className="py-3 pr-4 min-w-[140px]">Date</th>
                    <th className="py-3 pr-4 min-w-[220px]">Client / Parties</th>
                    <th className="py-3 pr-4 min-w-[200px]">Property / Project</th>
                    <th className="py-3 pr-4 min-w-[120px]">Lawyer / Clerk</th>
                    <th className="py-3 pr-4 min-w-[140px]">Status</th>
                    <th className="py-3 pr-4 min-w-[120px]">Latest Quotation</th>
                    <th className="py-3 pr-4 min-w-[120px]">Latest Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-b-0 hover:bg-slate-50 align-top">
                      <td className="py-3 pr-4 font-medium">
                        <Link href={`/app/cases/${r.id}`}>
                          <span className="text-amber-700 hover:underline cursor-pointer">{r.referenceNo}</span>
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-xs space-y-1 whitespace-nowrap">
                        <div><span className="text-slate-400">Open:</span> {new Date(r.openFileDate).toLocaleDateString()}</div>
                        {r.closedFileDate ? (
                          <>
                            <div><span className="text-slate-400">Closed:</span> {new Date(r.closedFileDate).toLocaleDateString()}</div>
                            <div className="text-slate-600 font-medium">{r.daysToClose} days</div>
                          </>
                        ) : (
                          <div className="text-slate-500 italic">{r.daysSinceOpen} days open</div>
                        )}
                      </td>
                      <td className="py-3 pr-4">{renderParties(r.clientParties)}</td>
                      <td className="py-3 pr-4 text-slate-700">{r.propertyInfo || "—"}</td>
                      <td className="py-3 pr-4 text-xs space-y-1">
                        <div><span className="text-slate-400">L:</span> {r.lawyerInCharge || "—"}</div>
                        <div><span className="text-slate-400">C:</span> {r.clerkInCharge || "—"}</div>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="text-xs font-medium text-slate-800 break-words">{r.status}</div>
                      </td>
                      <td className="py-3 pr-4">{renderQuotationInfo(r.latestQuotation)}</td>
                      <td className="py-3 pr-4">{renderInvoiceInfo(r.latestInvoice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t mt-4">
            <div className="text-xs text-slate-500">
              {total ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total}` : "—"}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || listQuery.isFetching}>Prev</Button>
              <div className="text-xs text-slate-500">Page {page} / {totalPages}</div>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || listQuery.isFetching}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── INVOICES TAB ─────────────────────────────────────────────────────────────

function InvoicesTab() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedQuotationId, setSelectedQuotationId] = useState("");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<number>>(new Set());
  const [bulkActionOpen, setBulkActionOpen] = useState(false);
  const { user } = useAuth();
  const roleName = String((user as any)?.roleName ?? "").trim().toLowerCase();
  const canCreateInvoices = roleName.includes("partner") || roleName === "account" || roleName === "accounts" || roleName === "accountant" || roleName === "finance";
  const bulkAllowed = canCreateInvoices;

  const invoicesQuery = useQuery({ queryKey: ["invoices"], queryFn: () => apiFetchJson("/invoices"), retry: false, enabled: !showCreate, staleTime: 30_000, refetchInterval: false, refetchOnWindowFocus: false });
  const { data, isLoading } = invoicesQuery;
  const invoices = (data ?? []) as any[];
  const { data: quotations = [] } = useListQuotations();
  const invoicedQuotationIds = new Set(
    invoices
      .map((i: any) => i?.quotationId)
      .filter((v: any) => v !== null && v !== undefined)
      .map((v: any) => String(v))
  );
  const selectableQuotations = quotations.filter((q: any) => !invoicedQuotationIds.has(String(q?.id)));

  const invoiceCreateParams = useMemo(() => {
    const sp = new URLSearchParams(searchString);
    return {
      openCreate: sp.get("openCreate") === "1",
      quotationId: sp.get("quotationId"),
    };
  }, [searchString]);
  const didPrefillRef = useRef(false);
  useEffect(() => {
    if (didPrefillRef.current) return;
    if (!invoiceCreateParams.openCreate) return;
    didPrefillRef.current = true;
    setShowCreate(true);
    if (invoiceCreateParams.quotationId) {
      const qid = String(invoiceCreateParams.quotationId);
      if (selectableQuotations.some((q: any) => String(q?.id ?? "") === qid)) {
        setSelectedQuotationId(qid);
      }
    }
    const next = new URLSearchParams(searchString);
    next.delete("openCreate");
    next.delete("quotationId");
    setLocation(`/app/accounting?${next.toString()}`);
  }, [invoiceCreateParams.openCreate, invoiceCreateParams.quotationId, searchString, selectableQuotations]);

  const createMut = useMutation({
    mutationFn: () => apiFetchJson(`/invoices/from-quotation/${selectedQuotationId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }),
    onSuccess: (inv: any) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setShowCreate(false);
      toast({ title: "Invoice created", description: `${inv.invoiceNo} created as draft` });
      setLocation(`/app/accounting/invoices/${inv.id}`);
    },
    onError: (e) => toastError(toast, e, "Create failed"),
  });

  const issueMut = useMutation({
    mutationFn: (id: number) => apiFetchJson(`/invoices/${id}/issue`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoices"] }); toast({ title: "Invoice issued" }); },
    onError: (e) => toastError(toast, e, "Action failed"),
  });

  const bulkPrepareMut = useMutation({
    mutationFn: async (ids: number[]) => {
      const results: Array<{ id: number; ok: boolean; data?: unknown; error?: string }> = [];
      for (const id of ids) {
        try { results.push({ id, ok: true, data: await apiFetchJson(`/invoices/${id}/einvoice/prepare`, { method: "POST" }) }); }
        catch (e: any) { results.push({ id, ok: false, error: e?.message ?? String(e) }); }
      }
      return results;
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => r.ok).length;
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast({ title: "Prepare complete", description: `${ok}/${results.length} prepared` });
    },
  });

  const bulkSubmitMut = useMutation({
    mutationFn: (ids: number[]) => apiFetchJson("/einvoices/consolidated/submit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoiceIds: ids }),
    }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      if (r?.error === "EINVOICE_SANDBOX_DISABLED") {
        toast({ variant: "destructive", title: "Sandbox disabled", description: "Set EINVOICE_SANDBOX=1 server-side. Production NOT allowed." });
      } else {
        toast({ title: "Consolidated submit complete", description: `success=${r?.successCount ?? 0} fail=${r?.failCount ?? 0}` });
      }
    },
    onError: (e: any) => {
      const detail = e?.responseJson ?? (typeof e?.message === "string" ? e.message : undefined);
      if (detail === "EINVOICE_SANDBOX_DISABLED" || (e && (e as any).message === "EINVOICE_SANDBOX_DISABLED")) {
        toast({ variant: "destructive", title: "Sandbox disabled", description: "Set EINVOICE_SANDBOX=1 server-side. Production NOT allowed." });
      } else toastError(toast, e, "Consolidated submit failed");
    },
  });

  const toggleSelected = (id: number) => {
    setSelectedInvoiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    const ids = filtered.map((i: any) => Number(i.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === selectedInvoiceIds.size && ids.every((id) => selectedInvoiceIds.has(id))) {
      setSelectedInvoiceIds(new Set());
    } else {
      setSelectedInvoiceIds(new Set(ids));
    }
  };

  const runBulkPrepare = async () => {
    const ids = Array.from(selectedInvoiceIds);
    setBulkActionOpen(false);
    bulkPrepareMut.mutate(ids);
  };
  const runBulkSubmit = () => {
    const ids = Array.from(selectedInvoiceIds);
    setBulkActionOpen(false);
    bulkSubmitMut.mutate(ids);
  };

  const filtered = invoices.filter((i: any) =>
    !search || i.invoiceNo?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input className="pl-9" placeholder="Search invoices…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {canCreateInvoices ? (
          <Button onClick={() => setShowCreate(true)} className="bg-amber-500 hover:bg-amber-600 text-white gap-2">
            <Plus className="w-4 h-4" /> New Invoice
          </Button>
        ) : (
          <div className="text-xs text-slate-500">Only Partner/Account can create invoices</div>
        )}
      </div>

      {showCreate && canCreateInvoices && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader><CardTitle className="text-base">Create Invoice from Quotation</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Select Quotation</label>
              <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                value={selectedQuotationId} onChange={(e) => setSelectedQuotationId(e.target.value)}>
                <option value="">— Select a quotation —</option>
                {selectableQuotations.map((q: any) => (
                  <option key={String(q.id)} value={String(q.id)}>
                    {String(q.referenceNo ?? "")} — {String(q.clientName ?? "")} (RM {Number(q.totalInclTax ?? 0).toLocaleString("en-MY")})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => createMut.mutate()} disabled={!selectedQuotationId || createMut.isPending}
                className="bg-amber-500 hover:bg-amber-600 text-white">
                {createMut.isPending ? "Creating…" : "Create Invoice"}
              </Button>
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {selectedInvoiceIds.size > 0 && bulkAllowed && (
        <Card className="border-indigo-200 bg-indigo-50/60">
          <CardContent className="py-3 flex flex-wrap items-center gap-3">
            <div className="text-xs text-indigo-700 font-medium">
              {selectedInvoiceIds.size} invoice{selectedInvoiceIds.size === 1 ? "" : "s"} selected
            </div>
            <div className="relative inline-block">
              <Button
                size="sm"
                className="gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white h-8 text-xs"
                onClick={() => setBulkActionOpen((v) => !v)}
                disabled={bulkPrepareMut.isPending || bulkSubmitMut.isPending}
              >
                <ListOrdered className="w-3.5 h-3.5" />
                Bulk Actions ▾
              </Button>
              {bulkActionOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setBulkActionOpen(false)} />
                  <div className="absolute right-0 z-40 mt-1 w-56 rounded-md border border-slate-200 bg-white shadow-lg p-1 text-sm">
                    <button
                      className="w-full text-left px-3 py-1.5 rounded hover:bg-slate-100 text-xs disabled:opacity-50"
                      disabled={bulkPrepareMut.isPending || bulkSubmitMut.isPending}
                      onClick={runBulkPrepare}
                    >
                      Prepare / Classify ({selectedInvoiceIds.size})
                    </button>
                    <button
                      className="w-full text-left px-3 py-1.5 rounded hover:bg-slate-100 text-xs disabled:opacity-50"
                      disabled={bulkPrepareMut.isPending || bulkSubmitMut.isPending}
                      onClick={runBulkSubmit}
                    >
                      Consolidated Submit (Sandbox)
                    </button>
                  </div>
                </>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setSelectedInvoiceIds(new Set())}
              disabled={bulkPrepareMut.isPending || bulkSubmitMut.isPending}
            >
              Clear
            </Button>
            {(bulkPrepareMut.isPending || bulkSubmitMut.isPending) && (
              <span className="text-xs text-indigo-600 flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                Processing…
              </span>
            )}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-slate-400">Loading…</div>
      ) : invoicesQuery.isError ? (
        <QueryFallback title="Invoices unavailable" error={invoicesQuery.error} onRetry={() => invoicesQuery.refetch()} isRetrying={invoicesQuery.isFetching} />
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No invoices found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-2 py-3 w-10">
                  {bulkAllowed && (
                    <Checkbox
                      checked={
                        filtered.length > 0 &&
                        filtered.every((i: any) => selectedInvoiceIds.has(Number(i.id)))
                      }
                      onCheckedChange={selectAllVisible}
                      aria-label="Select all visible"
                    />
                  )}
                </th>
                <th className="px-4 py-3 text-left font-medium">Invoice No</th>
                <th className="px-4 py-3 text-left font-medium">Issued</th>
                <th className="px-4 py-3 text-left font-medium">Due</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium">Paid</th>
                <th className="px-4 py-3 text-right font-medium">Due</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((inv: any) => (
                <tr key={inv.id} className={cn("hover:bg-slate-50 transition-colors", selectedInvoiceIds.has(Number(inv.id)) ? "bg-indigo-50/40" : "")}>
                  <td className="px-2 py-3">
                    {bulkAllowed && (
                      <Checkbox
                        checked={selectedInvoiceIds.has(Number(inv.id))}
                        onCheckedChange={() => toggleSelected(Number(inv.id))}
                        aria-label={`Select invoice ${inv.invoiceNo}`}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">{inv.invoiceNo}</td>
                  <td className="px-4 py-3 text-slate-500">{inv.issuedDate ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">{inv.dueDate ?? "—"}</td>
                  <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-800">{fmt(inv.grandTotal)}</td>
                  <td className="px-4 py-3 text-right text-green-600">{fmt(inv.amountPaid)}</td>
                  <td className="px-4 py-3 text-right text-red-500">{fmt(inv.amountDue)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {inv.status === "draft" && canCreateInvoices && (
                        <Button size="sm" variant="outline" className="text-xs h-7"
                          onClick={() => issueMut.mutate(inv.id)}
                          disabled={issueMut.isPending}
                        >Issue</Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                        onClick={() => setLocation(`/app/accounting/invoices/${inv.id}`)}>
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── RECEIPTS TAB ─────────────────────────────────────────────────────────────

function ReceiptsTab() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    invoiceId: "", paymentMethod: "bank_transfer", accountType: "client",
    amount: "", receivedDate: new Date().toISOString().slice(0, 10), referenceNo: "", notes: "",
  });

  const receiptsQuery = useQuery({ queryKey: ["receipts"], queryFn: () => apiFetchJson("/receipts"), retry: false, enabled: !showCreate, staleTime: 30_000, refetchInterval: false, refetchOnWindowFocus: false });
  const { data, isLoading } = receiptsQuery;
  const receipts = (data ?? []) as any[];
  const invoicesQuery = useQuery({ queryKey: ["invoices"], queryFn: () => apiFetchJson("/invoices"), retry: false, enabled: !showCreate, staleTime: 30_000, refetchInterval: false, refetchOnWindowFocus: false });
  const openInvoices = (((invoicesQuery.data ?? []) as any[]).filter((i: any) => i.status !== "void" && i.status !== "paid"));

  const receiptCreateParams = useMemo(() => {
    const sp = new URLSearchParams(searchString);
    return {
      openCreate: sp.get("openCreate") === "1",
      invoiceId: sp.get("invoiceId"),
    };
  }, [searchString]);
  const didPrefillRef = useRef(false);
  useEffect(() => {
    if (didPrefillRef.current) return;
    if (!receiptCreateParams.openCreate) return;
    didPrefillRef.current = true;
    setShowCreate(true);
    if (receiptCreateParams.invoiceId) {
      const id = String(receiptCreateParams.invoiceId);
      if (openInvoices.some((i: any) => String(i?.id ?? "") === id)) {
        setForm((f) => ({ ...f, invoiceId: id }));
      }
    }
    const next = new URLSearchParams(searchString);
    next.delete("openCreate");
    next.delete("invoiceId");
    setLocation(`/app/accounting?${next.toString()}`);
  }, [openInvoices, receiptCreateParams.invoiceId, receiptCreateParams.openCreate, searchString]);

  const createMut = useMutation({
    mutationFn: () => apiFetchJson("/receipts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, invoiceId: form.invoiceId || undefined, amount: parseFloat(form.amount) }),
    }),
    onSuccess: (rec: any) => {
      qc.invalidateQueries({ queryKey: ["receipts"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["ledger-summary"] });
      setShowCreate(false);
      setForm({ invoiceId: "", paymentMethod: "bank_transfer", accountType: "client", amount: "", receivedDate: new Date().toISOString().slice(0, 10), referenceNo: "", notes: "" });
      toast({ title: "Receipt recorded", description: `${rec.receiptNo} saved` });
    },
    onError: (e) => toastError(toast, e, "Create failed"),
  });

  const reverseMut = useMutation({
    mutationFn: (id: number) => apiFetchJson(`/receipts/${id}/reverse`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["receipts"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["ledger-summary"] });
      toast({ title: "Receipt reversed" });
    },
    onError: (e) => toastError(toast, e, "Action failed"),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowCreate(!showCreate)} className="bg-amber-500 hover:bg-amber-600 text-white gap-2">
          <Plus className="w-4 h-4" /> Record Receipt
        </Button>
      </div>

      {showCreate && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader><CardTitle className="text-base">Record New Receipt</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Allocate to Invoice</label>
                <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  value={form.invoiceId} onChange={(e) => setForm((f) => ({ ...f, invoiceId: e.target.value }))}>
                  <option value="">— General / Unallocated —</option>
                  {openInvoices.map((i: any) => (
                    <option key={i.id} value={i.id}>{i.invoiceNo} — Due {fmt(i.amountDue)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Payment Method</label>
                <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))}>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="cheque">Cheque</option>
                  <option value="cash">Cash</option>
                  <option value="online">Online Banking</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Account Type</label>
                <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  value={form.accountType} onChange={(e) => setForm((f) => ({ ...f, accountType: e.target.value }))}>
                  <option value="client">Client Account</option>
                  <option value="office">Office Account</option>
                  <option value="balance_sheet">Balance Sheet / FD</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Amount (RM)</label>
                <Input type="number" step="0.01" placeholder="0.00" value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Received Date</label>
                <DateOnlyInput valueYmd={form.receivedDate} onChangeYmd={(v) => setForm((f) => ({ ...f, receivedDate: v }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Reference No</label>
                <Input placeholder="Bank ref / cheque no." value={form.referenceNo}
                  onChange={(e) => setForm((f) => ({ ...f, referenceNo: e.target.value }))} />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-medium text-slate-700 block mb-1">Notes</label>
                <Input placeholder="Optional notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <Button onClick={() => createMut.mutate()} disabled={!form.amount || createMut.isPending}
                className="bg-amber-500 hover:bg-amber-600 text-white">
                {createMut.isPending ? "Recording…" : "Record Receipt"}
              </Button>
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {receiptsQuery.isError ? (
        <QueryFallback title="Receipts unavailable" error={receiptsQuery.error} onRetry={() => { receiptsQuery.refetch(); invoicesQuery.refetch(); }} isRetrying={receiptsQuery.isFetching || invoicesQuery.isFetching} />
      ) : isLoading ? (
        <div className="text-center py-12 text-slate-400">Loading…</div>
      ) : receipts.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Receipt className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No receipts recorded yet</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-4 py-3 text-left font-medium">Receipt No</th>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Method</th>
                <th className="px-4 py-3 text-left font-medium">Account</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Reference</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {receipts.map((r: any) => (
                <tr key={r.id} className={cn("hover:bg-slate-50 transition-colors", r.isReversed && "opacity-50")}>
                  <td className="px-4 py-3 font-medium text-slate-900">{r.receiptNo}</td>
                  <td className="px-4 py-3 text-slate-500">{r.receivedDate}</td>
                  <td className="px-4 py-3 text-slate-600 capitalize">{r.paymentMethod?.replace(/_/g, " ")}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">
                      {String(r.accountType ?? "") === "balance_sheet" ? "Balance Sheet / FD" : (String(r.accountType ?? "") === "trust" ? "Client Account" : `${String(r.accountType ?? "").replace(/\b\w/g, (c: string) => c.toUpperCase())} Account`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-green-600">{fmt(r.amount)}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{r.referenceNo || "—"}</td>
                  <td className="px-4 py-3">
                    {r.isReversed
                      ? <span className="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-600">Reversed</span>
                      : <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">Active</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-slate-400 hover:text-slate-700"
                      title="View / Print"
                      onClick={() => setLocation(`/app/accounting/receipts/${r.id}`)}
                    >
                      <Printer className="w-3.5 h-3.5" />
                    </Button>
                    {!r.isReversed && (
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-slate-400 hover:text-red-500"
                        title="Reverse receipt"
                        onClick={() => { if (confirm("Reverse this receipt? This will update invoice payment status.")) reverseMut.mutate(r.id); }}
                        disabled={reverseMut.isPending}
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── QUOTATIONS TAB ────────────────────────────────────────────────────────────

function QuotationsTab() {
  const [, setLocation] = useLocation();
  const { data: quotations, isLoading, isError, error, refetch, isFetching } = useListQuotations();
  const rows = Array.isArray(quotations) ? quotations : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Quotations</h2>
          <p className="text-sm text-slate-500 mt-1">All quotations across the firm.</p>
        </div>
        <Button onClick={() => setLocation("/app/quotations/new")} className="bg-amber-500 hover:bg-amber-600 text-white gap-2">
          <Plus className="w-4 h-4" /> New Quotation
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-slate-400">Loading…</div>
      ) : isError ? (
        <QueryFallback title="Quotations unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} />
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No quotations yet</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-4 py-3 text-left font-medium">File Ref</th>
                <th className="px-4 py-3 text-left font-medium">Client Name</th>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((q: any) => (
                <tr key={q.id} className="hover:bg-slate-50 transition-colors cursor-pointer" onClick={() => setLocation(`/app/quotations/${q.id}`)}>
                  <td className="px-4 py-3 font-medium text-slate-900">{q.referenceNo}</td>
                  <td className="px-4 py-3 text-slate-700">{q.clientName}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {q.createdAt ? new Date(String(q.createdAt)).toLocaleDateString("en-MY") : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-800">{fmt(q.totalInclTax)}</td>
                  <td className="px-4 py-3"><StatusBadge status={String(q.status ?? "draft")} /></td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="outline" className="text-xs h-7" onClick={(e) => { e.stopPropagation(); setLocation(`/app/quotations/${q.id}`); }}>
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── PAYMENT VOUCHERS TAB ──────────────────────────────────────────────────────

export function PaymentVouchersTab() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const printVoucherIdParam = useMemo(() => new URLSearchParams(searchString).get("printVoucherId"), [searchString]);
  const paymentVoucherFilterParam = useMemo(() => new URLSearchParams(searchString).get("pvFilter") ?? "all", [searchString]);
  const createParams = useMemo(() => {
    const sp = new URLSearchParams(searchString);
    return {
      openCreate: sp.get("openCreate") === "1",
      caseId: sp.get("caseId"),
      caseTitle: sp.get("caseTitle"),
    };
  }, [searchString]);
  const didAutoPrintRef = useRef(false);
  const didPrefillRef = useRef(false);
  const [showCreate, setShowCreate] = useState(() => createParams.openCreate);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { wrapWithReAuth } = useReAuth();
  const { user } = useAuth();
  const firmName = user?.firmName ?? "";
  const roleName = user?.userType === "firm_user" ? (user.roleName ?? "") : "";
  const roleKind =
    (roleName.toLowerCase() === "partner" || roleName.toLowerCase() === "founder")
      ? "partner"
      : (roleName.toLowerCase() === "manager" || roleName.toLowerCase().includes("senior lawyer") || roleName.toLowerCase() === "lawyer")
        ? "lawyer"
        : "staff";
  const canAccountingRead = hasPermission(user, "accounting", "read");
  const canAccountingCreate = hasPermission(user, "accounting", "create");
  const canAccountingReview = hasPermission(user, "accounting", "review");
  const canAccountingApprove = hasPermission(user, "accounting", "approve");
  const canAccountingMarkReceived = hasPermission(user, "accounting", "mark_received");
  const canAccountingMarkPaid = hasPermission(user, "accounting", "mark_paid");
  const canAccountingOverrideSla = hasPermission(user, "accounting", "override_sla");

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveVoucherId, setReceiveVoucherId] = useState<number | null>(null);
  const [receiveForm, setReceiveForm] = useState({ assignedAccountUserId: "", isUrgent: false });

  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignVoucherId, setReassignVoucherId] = useState<number | null>(null);
  const [reassignAssignedAccountUserId, setReassignAssignedAccountUserId] = useState("");

  const [overrideDeadlineOpen, setOverrideDeadlineOpen] = useState(false);
  const [overrideDeadlineVoucherId, setOverrideDeadlineVoucherId] = useState<number | null>(null);
  const [overrideDeadlineForm, setOverrideDeadlineForm] = useState({ paymentDueAt: "", reason: "" });

  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [markPaidVoucherId, setMarkPaidVoucherId] = useState<number | null>(null);
  const [markPaidForm, setMarkPaidForm] = useState({
    accountType: "office",
    paymentMethod: "bank_transfer",
    bankChequeRefNo: "",
    paidAmount: "",
    proofDocumentPath: "",
    nextActionType: "Collect Physical File",
    nextActionCustom: "",
    nextActionRemarks: "",
    assignedClerkUserId: "",
    clerkActionExemptReason: "",
    lateCompletionReason: "",
  });

  const todayLabel = new Date().toLocaleDateString("en-MY", { year: "numeric", month: "short", day: "2-digit" });

  const [simpleForm, setSimpleForm] = useState<{
    voucherType: "external_payment" | "internal_transfer" | "file_to_file_transfer";
    payeeName: string;
    beneficiaryBank: string;
    beneficiaryAccountNo: string;
    isAdvance: boolean;
    responsibleLawyerId: string;
    approvingPartnerId: string;
    quotationId: string;
  }>({
    voucherType: "external_payment",
    payeeName: "",
    beneficiaryBank: "",
    beneficiaryAccountNo: "",
    isAdvance: false,
    responsibleLawyerId: "",
    approvingPartnerId: "",
    quotationId: "",
  });
  const [quotationClaimWarning, setQuotationClaimWarning] = useState<string | null>(null);
  const [preflightPending, setPreflightPending] = useState(false);
  const [preflightUnclaimedWarnings, setPreflightUnclaimedWarnings] = useState<Array<{ item: string; matchedQuotationId?: number | null; matchedQuotationRef?: string | null }>>([]);
  const [acknowledgedUnclaimedItems, setAcknowledgedUnclaimedItems] = useState<Array<{ item: string; pvId?: number; caseId?: number; userId?: number; createdAt?: string }>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVoucherId, setHistoryVoucherId] = useState<number | null>(null);
  const historyQuery = useQuery({
    queryKey: ["payment-voucher-history", historyVoucherId],
    queryFn: () => {
      if (!historyVoucherId) throw new Error("Missing id");
      return apiFetchJson(`/payment-vouchers/${historyVoucherId}/history`);
    },
    enabled: historyOpen && historyVoucherId != null,
    retry: false,
    staleTime: 15_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const firmLawyerUsersQuery = useQuery<Array<{ id: number; name: string; roleName?: string | null; caseAssigned?: boolean }>>({
    queryKey: ["firm-lawyer-users-for-pv"],
    queryFn: () => apiFetchJson("/users?role_hint=lawyer"),
    retry: false,
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled: showCreate,
  });
  const firmPartnerUsersQuery = useQuery<Array<{ id: number; name: string; roleName?: string | null }>>({
    queryKey: ["firm-partner-users-for-pv"],
    queryFn: () => apiFetchJson("/users?role_hint=partner"),
    retry: false,
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled: showCreate,
  });
  const newLineItemId = (): string => {
    const c = (globalThis as any).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };
  const [lineItems, setLineItems] = useState<Array<{ id: string; purpose: string; amount: string }>>([
    { id: newLineItemId(), purpose: "", amount: "" },
  ]);
  const totalAmount = lineItems.reduce((sum, x) => {
    const n = parseFloat(String(x.amount ?? ""));
    if (!Number.isFinite(n) || n <= 0) return sum;
    return sum + n;
  }, 0);
  const [selectedCases, setSelectedCases] = useState<SelectedCase[]>([]);
  const [caseSelectionError, setCaseSelectionError] = useState<string | null>(null);
  const [caseQueryText, setCaseQueryText] = useState<string>("");
  const [targetCaseQueryText, setTargetCaseQueryText] = useState<string>("");
  const [targetCase, setTargetCase] = useState<SelectedCase | null>(null);
  const [pendingCreateRequestIds, setPendingCreateRequestIds] = useState<string[]>([]);
  const [pendingCreatePhase, setPendingCreatePhase] = useState<PaymentVoucherPendingCreatePhase | null>(null);
  const didRestorePendingRef = useRef(false);
  const pendingCreateStartedAtRef = useRef<string | null>(null);
  const lastCreateAttemptRef = useRef<Array<{ clientRequestId: string; payload: unknown }>>([]);
  const [failedCreateRequestIds, setFailedCreateRequestIds] = useState<string[]>([]);
  const firmId = user?.userType === "firm_user" ? Number((user as any).firmId ?? (user as any).firm_id ?? 0) : 0;
  const userId = user?.userType === "firm_user" ? Number((user as any).id ?? (user as any).userId ?? 0) : 0;

  useEffect(() => {
    if (selectedCases.length > 0) setCaseSelectionError(null);
  }, [selectedCases.length]);

  useEffect(() => {
    if (didPrefillRef.current) return;
    if (!createParams.openCreate) return;
    didPrefillRef.current = true;
    setShowCreate(canAccountingCreate);
    const cid = createParams.caseId ? Number.parseInt(createParams.caseId, 10) : NaN;
    if (Number.isFinite(cid) && cid > 0 && selectedCases.length === 0) {
      const title = String(createParams.caseTitle ?? "").trim() || `Case #${cid}`;
      setSelectedCases([{ case_id: cid, title }]);
    }
    const next = new URLSearchParams(searchString);
    next.delete("openCreate");
    next.delete("caseId");
    next.delete("caseTitle");
    setLocation(`/app/accounting?${next.toString()}`);
  }, [canAccountingCreate, createParams.caseId, createParams.caseTitle, createParams.openCreate, searchString, selectedCases.length]);

  useEffect(() => {
    if (!showCreate) return;
    void qc.cancelQueries({ queryKey: ["payment-vouchers"], exact: false });
  }, [qc, showCreate]);

  const [pvPage, setPvPage] = useState(1);
  const pvPageSize = 50;

  const vouchersQuery = useQuery({
    queryKey: ["payment-vouchers", { page: pvPage, limit: pvPageSize }],
    queryFn: ({ signal }) => apiFetchJson(`/payment-vouchers?page=${pvPage}&limit=${pvPageSize}`, { timeoutMs: 20000, signal }),
    retry: false,
    enabled: canAccountingRead && !showCreate,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const dashboardQuery = useQuery({
    queryKey: ["payment-vouchers", "dashboard"],
    queryFn: ({ signal }) => apiFetchJson("/payment-vouchers/dashboard", { signal }),
    retry: false,
    enabled: canAccountingRead && !showCreate,
    staleTime: 15_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const quotationsQuery = useQuery({
    queryKey: ["quotations", "for-pv-create", firmId],
    queryFn: async ({ signal }) => {
      const out = await apiFetchJson("/quotations?status=draft,approved&includeItems=false&limit=200", { signal, timeoutMs: 15_000 });
      return Array.isArray((out as any)?.rows) ? (out as any).rows : Array.isArray(out) ? out : [];
    },
    retry: false,
    enabled: canAccountingCreate && showCreate && Number.isFinite(firmId) && Number(firmId) > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data, isLoading } = vouchersQuery;
  const vouchers = (data ?? []) as any[];
  const dashboard = (dashboardQuery.data ?? {}) as Record<string, number>;
  const markPaidVoucher = markPaidVoucherId ? (vouchers.find((v: any) => Number(v.id) === Number(markPaidVoucherId)) ?? null) : null;
  const activeVoucherFilter = paymentVoucherFilterParam;
  const voucherFilterLabelMap: Record<string, string> = {
    awaitingReceipt: "Awaiting Accounts Receipt",
    receivedAndProcessing: "Received And Processing",
    waitingApproval: "Waiting For Approval",
    dueSoon: "Due Soon",
    overdue: "Overdue Payments",
    paidToday: "Paid Today",
    completedMonth: "Completed This Month",
  };
  const setVoucherFilter = (filterKey: string) => {
    const next = new URLSearchParams(searchString);
    next.set("tab", "payment-vouchers");
    if (!filterKey || filterKey === "all") next.delete("pvFilter");
    else next.set("pvFilter", filterKey);
    setLocation(`/app/accounting?${next.toString()}`);
  };
  const filteredVouchers = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfToday = startOfToday + 24 * 60 * 60 * 1000;
    return vouchers.filter((pv: any) => {
      const receivedAt = pv.receivedAt ? new Date(String(pv.receivedAt)).getTime() : NaN;
      const dueAt = pv.paymentDueAt ? new Date(String(pv.paymentDueAt)).getTime() : NaN;
      const paidAt = pv.paidAt ? new Date(String(pv.paidAt)).getTime() : NaN;
      const updatedAt = pv.updatedAt ? new Date(String(pv.updatedAt)).getTime() : NaN;
      switch (activeVoucherFilter) {
        case "awaitingReceipt":
          return pv.status === "pending_account" && !pv.receivedAt;
        case "receivedAndProcessing":
          return pv.status === "pending_account" && Number.isFinite(receivedAt);
        case "waitingApproval":
          return pv.approvalStatus === "pending_approval";
        case "dueSoon":
          return pv.status === "pending_account" && Number.isFinite(dueAt) && dueAt <= now.getTime() + 2 * 60 * 60 * 1000;
        case "overdue":
          return pv.status === "pending_account" && Number.isFinite(dueAt) && dueAt <= now.getTime();
        case "paidToday":
          return pv.status === "paid_pending_collection" && Number.isFinite(paidAt) && paidAt >= startOfToday && paidAt < endOfToday;
        case "completedMonth":
          return pv.status === "completed" && Number.isFinite(updatedAt) && updatedAt >= monthStart && updatedAt < monthEnd;
        default:
          return true;
      }
    });
  }, [activeVoucherFilter, vouchers]);

  const resetCreateForm = () => {
    setPendingCreateRequestIds([]);
    setPendingCreatePhase(null);
    setFailedCreateRequestIds([]);
    lastCreateAttemptRef.current = [];
    setShowCreate(false);
    setSimpleForm({ voucherType: "external_payment", payeeName: "", beneficiaryBank: "", beneficiaryAccountNo: "", isAdvance: false, responsibleLawyerId: "", approvingPartnerId: "", quotationId: "" });
    setQuotationClaimWarning(null);
    setPreflightUnclaimedWarnings([]);
    setAcknowledgedUnclaimedItems([]);
    setPreflightPending(false);
    setLineItems([{ id: newLineItemId(), purpose: "", amount: "" }]);
    setCaseQueryText("");
    setSelectedCases([]);
    setTargetCaseQueryText("");
    setTargetCase(null);
  };

  const checkPendingCreateStatusMut = useMutation({
    mutationFn: async (clientRequestIds: string[]) => {
      const statuses = await Promise.all(
        clientRequestIds.map(async (clientRequestId) => ({
          clientRequestId,
          result: await getPaymentVoucherCreateStatus(clientRequestId),
        })),
      );
      return {
        completed: statuses.filter((item) => item.result.status === "completed"),
        processing: statuses.filter((item) => item.result.status === "processing"),
        unknown: statuses.filter((item) => item.result.status === "not_found"),
        stale: statuses.filter((item) => item.result.status === "stale"),
        failed: statuses.filter((item) => item.result.status === "failed"),
      };
    },
    onSuccess: async ({ completed, processing, unknown, stale, failed }) => {
      if (completed.length > 0) {
        await qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      }

      if (failed.length > 0) {
        setFailedCreateRequestIds(failed.map((item) => item.clientRequestId));
        setPendingCreateRequestIds([...processing, ...unknown, ...stale].map((item) => item.clientRequestId));
        setPendingCreatePhase(
          stale.length > 0 ? "stale" : unknown.length > 0 ? "unknown" : processing.length > 0 ? "processing" : null,
        );
        toast({
          title: "Submission failed",
          description: failed[0]?.result.status === "failed"
            ? (failed[0].result.error || "Payment Voucher submission failed.")
            : "Payment Voucher submission failed.",
          variant: "destructive",
        });
        return;
      }

      if (stale.length > 0 || unknown.length > 0 || processing.length > 0) {
        const unresolvedIds = [...stale, ...unknown, ...processing].map((item) => item.clientRequestId);
        setPendingCreateRequestIds(unresolvedIds);
        setPendingCreatePhase(stale.length > 0 ? "stale" : unknown.length > 0 ? "unknown" : "processing");
        const confirmedCount = completed.length;
        toast({
          title: stale.length > 0 ? "Status stale" : unknown.length > 0 ? "Confirmation pending" : "Still confirming",
          description: stale.length > 0
            ? "Payment Voucher submission confirmation is stale. Please check status again before submitting again."
            : unknown.length > 0
              ? "Payment Voucher submission is still being confirmed. Please do not submit again."
              : confirmedCount > 0
                ? `${confirmedCount} voucher(s) confirmed. Remaining submission is still being confirmed. Please do not submit again.`
                : "Payment Voucher submission is still being confirmed. Please do not submit again.",
        });
        return;
      }

      const rows = completed.map((item) => item.result.status === "completed" ? item.result.voucher : null).filter(Boolean);
      resetCreateForm();
      toast({
        title: "Payment Voucher created",
        description: rows.length > 1
          ? `${rows.length} voucher(s) confirmed`
          : `Confirmed ${String(rows[0]?.voucherNo ?? "voucher")} successfully`,
      });
    },
    onError: (e) => toastError(toast, e, "Status check failed"),
  });

  useEffect(() => {
    if (didRestorePendingRef.current) return;
    didRestorePendingRef.current = true;

    if (!firmId || !userId) {
      clearPendingPaymentVoucherCreateSessionState();
      return;
    }

    restorePendingPaymentVoucherCreateFromSessionStorage({
      firmId,
      userId,
      onRestore: (state) => {
        pendingCreateStartedAtRef.current = state.createdAt;
        setPendingCreateRequestIds(state.clientRequestIds);
        setPendingCreatePhase(state.phase);
        checkPendingCreateStatusMut.mutate([...state.clientRequestIds]);
      },
    });
  }, [firmId, userId, checkPendingCreateStatusMut]);

  useEffect(() => {
    if (!firmId || !userId) {
      clearPendingPaymentVoucherCreateSessionState();
      return;
    }
    if (pendingCreateRequestIds.length > 0 && pendingCreatePhase) {
      if (!pendingCreateStartedAtRef.current) pendingCreateStartedAtRef.current = new Date().toISOString();
      savePendingPaymentVoucherCreateSessionState({
        v: 1,
        firmId,
        userId,
        createdAt: pendingCreateStartedAtRef.current,
        clientRequestIds: pendingCreateRequestIds,
        phase: pendingCreatePhase,
      });
      return;
    }
    pendingCreateStartedAtRef.current = null;
    clearPendingPaymentVoucherCreateSessionState();
  }, [firmId, pendingCreatePhase, pendingCreateRequestIds, userId]);

  const createBatchMut = useMutation({
    mutationFn: async () => {
      if (selectedCases.length === 0) {
        setCaseSelectionError("Please select at least one case.");
        throw new Error("Please select at least one case");
      }
      const voucherType = simpleForm.voucherType;
      const sourceCase = selectedCases[0] ?? null;
      const target = targetCase;
      if ((voucherType === "internal_transfer" || voucherType === "file_to_file_transfer") && !canAccountingCreate) {
        throw new Error("Forbidden");
      }
      if (simpleForm.isAdvance && voucherType !== "external_payment") throw new Error("Client Advance is only applicable to Payment Voucher");
      if (voucherType === "file_to_file_transfer") {
        if (selectedCases.length !== 1) throw new Error("File-to-file transfer requires exactly 1 source case");
        if (!sourceCase) throw new Error("Source case is required");
        if (!target) throw new Error("Target case is required");
        if (Number(target.case_id) === Number(sourceCase.case_id)) throw new Error("Target case must be different from source case");
      }
      if (voucherType !== "internal_transfer" && voucherType !== "file_to_file_transfer" && !simpleForm.payeeName.trim()) throw new Error("Payee name is required");

      const fundStatus: PaymentVoucherFundStatus = simpleForm.isAdvance ? "request_advance" : "client_paid";
      const parsedLineItems = lineItems
        .map((x) => ({ purpose: String(x.purpose ?? "").trim(), amount: parseFloat(String(x.amount ?? "")) }))
        .filter((x) => x.purpose && Number.isFinite(x.amount) && x.amount > 0);
      if (parsedLineItems.length === 0) throw new Error("At least one line item is required");
      const amount = parsedLineItems.reduce((sum, x) => sum + x.amount, 0);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid total amount");
      const purpose = parsedLineItems.length > 1 ? `${parsedLineItems[0].purpose} (+${parsedLineItems.length - 1} more)` : parsedLineItems[0].purpose;
      const responsibleLawyerId = simpleForm.responsibleLawyerId.trim() ? Number(simpleForm.responsibleLawyerId) : undefined;
      const approvingPartnerId = simpleForm.approvingPartnerId.trim() ? Number(simpleForm.approvingPartnerId) : undefined;
      const quotationId = simpleForm.quotationId.trim() ? Number(simpleForm.quotationId) : undefined;

      const casesToCreate = voucherType === "file_to_file_transfer" ? (sourceCase ? [sourceCase] : []) : selectedCases;
      const firstCaseId = casesToCreate[0]?.case_id;

      if (preflightUnclaimedWarnings.length === 0 && acknowledgedUnclaimedItems.length === 0) {
        setPreflightPending(true);
        try {
          const preflightBody: any = {
            voucherType,
            caseId: typeof firstCaseId === "number" ? firstCaseId : Number(firstCaseId ?? 0) || undefined,
            quotationId,
            purpose,
            amount,
            lineItems: parsedLineItems,
          };
          const preRes = await apiFetchJson("/payment-vouchers/preflight", { method: "POST", body: JSON.stringify(preflightBody) });
          const rawWarnings: any = (preRes as any)?.unclaimedWarnings ?? (preRes as any)?.warnings ?? [];
          const warnings: any[] = Array.isArray(rawWarnings) ? rawWarnings : [];
          if (warnings.length > 0) {
            setPreflightUnclaimedWarnings(warnings);
            setPreflightPending(false);
            throw new PaymentVoucherPreflightWarningShown("Items need quotation claim check");
          }
        } catch (e) {
          setPreflightPending(false);
          if (e instanceof PaymentVoucherPreflightWarningShown) throw e;
          throw e;
        } finally {
          setPreflightPending(false);
        }
      }

      const ackToPass = acknowledgedUnclaimedItems.length > 0 ? acknowledgedUnclaimedItems : undefined;

      const bodyBase = {
        voucherType,
        isAdvance: simpleForm.isAdvance || undefined,
        payeeName: voucherType === "internal_transfer"
          ? "Client Account → Office Account Transfer"
          : voucherType === "file_to_file_transfer"
            ? "Client Account File-to-File Transfer"
            : simpleForm.payeeName.trim(),
        beneficiaryBank: (voucherType === "internal_transfer" || voucherType === "file_to_file_transfer") ? null : (simpleForm.beneficiaryBank.trim() ? simpleForm.beneficiaryBank.trim() : null),
        beneficiaryAccountNo: (voucherType === "internal_transfer" || voucherType === "file_to_file_transfer") ? null : (simpleForm.beneficiaryAccountNo.trim() ? simpleForm.beneficiaryAccountNo.trim() : null),
        purpose,
        amount,
        fundStatus,
        notes: null,
        lineItems: parsedLineItems,
        responsibleLawyerId,
        approvingPartnerId,
        quotationId,
        acknowledgedUnclaimedItems: ackToPass,
      };

      setFailedCreateRequestIds([]);
      const attempts = casesToCreate.map((c) => {
        const clientRequestId = newLineItemId();
        const payload = voucherType === "file_to_file_transfer"
          ? { ...bodyBase, clientRequestId, caseId: c.case_id, targetCaseId: target?.case_id ?? null }
          : { ...bodyBase, clientRequestId, caseId: c.case_id };
        const parsed = CreatePaymentVoucherBody.safeParse(payload);
        if (!parsed.success) throw new Error(parsed.error.message);
        return { clientRequestId, payload: parsed.data as unknown };
      });
      lastCreateAttemptRef.current = attempts;
      return await Promise.all(attempts.map((a) => submitPaymentVoucherWithRecovery(a.payload, a.clientRequestId)));
    },
    onSuccess: async (rows: any[]) => {
      await qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      resetCreateForm();
      toast({ title: "Payment Vouchers created", description: `${rows.length} voucher(s) created` });
    },
    onError: async (e) => {
      if (e instanceof PaymentVoucherPreflightWarningShown) {
        return;
      }
      if (e instanceof PaymentVoucherConfirmationPendingError) {
        setPendingCreateRequestIds(e.clientRequestIds);
        setPendingCreatePhase("processing");
        if (e.completedVouchers.length > 0) {
          await qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
        }
        toast({
          title: "Submission is being confirmed",
          description: e.message,
        });
        return;
      }
      if (e instanceof PaymentVoucherConfirmationUnknownError) {
        setPendingCreateRequestIds(e.clientRequestIds);
        setPendingCreatePhase("unknown");
        toast({
          title: "Confirmation pending",
          description: e.message,
        });
        return;
      }
      if (e instanceof PaymentVoucherConfirmationStaleError) {
        setPendingCreateRequestIds(e.clientRequestIds);
        setPendingCreatePhase("stale");
        toast({
          title: "Status stale",
          description: e.message,
        });
        return;
      }
      if (lastCreateAttemptRef.current.length > 0) {
        setFailedCreateRequestIds(lastCreateAttemptRef.current.map((x) => x.clientRequestId));
      }
      if (e instanceof Error && e.message === "Please select at least one case") return;
      toastError(toast, e, "Create failed");
    },
  });

  const retryFailedCreateMut = useMutation({
    mutationFn: async () => {
      const ids = failedCreateRequestIds;
      if (ids.length === 0) throw new Error("No failed requests to retry");
      const attempts = lastCreateAttemptRef.current.filter((a) => ids.includes(a.clientRequestId));
      if (attempts.length === 0) throw new Error("Retry payload not available");
      return await Promise.all(attempts.map((a) => submitPaymentVoucherWithRecovery(a.payload, a.clientRequestId)));
    },
    onSuccess: async (rows: any[]) => {
      await qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      resetCreateForm();
      toast({
        title: "Payment Voucher retried",
        description: rows.length > 1 ? `${rows.length} voucher(s) confirmed` : `Confirmed ${String(rows[0]?.voucherNo ?? "voucher")} successfully`,
      });
    },
    onError: (e) => toastError(toast, e, "Retry failed"),
  });

  const createSubmitUi = derivePaymentVoucherSubmitUiState({
    isSubmitting: createBatchMut.isPending,
    isCheckingStatus: checkPendingCreateStatusMut.isPending,
    pendingClientRequestIds: pendingCreateRequestIds,
    unresolvedPhase: pendingCreatePhase,
  });

  const transitionMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: unknown }) =>
      wrapWithReAuth(
        (headers) => apiFetchJson(`/payment-vouchers/${id}/transition`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        "Changing a payment voucher status is a sensitive action. Continue?"
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      qc.invalidateQueries({ queryKey: ["ledger-summary"] });
      toast({ title: "Status updated" });
    },
    onError: (e) => toastError(toast, e, "Update failed"),
  });

  const fundStatusLabel = (v: string) => v === "request_advance" ? "Request Advance" : "Client Paid";

  async function printVoucher(voucherId: number): Promise<void> {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.open();
    w.document.write(`<html><head><title>Preparing voucher…</title></head><body style="font-family: Arial, sans-serif; padding:16px;">Preparing voucher…</body></html>`);
    w.document.close();
    const pv = await apiFetchJson<any>(`/payment-vouchers/${voucherId}`);
    const isInternal = String(pv.voucherType ?? "") === "internal_transfer";
    const isLedgerTransfer = String(pv.voucherType ?? "") === "file_to_file_transfer";
    const items = Array.isArray(pv.items) ? pv.items : [];
    const caseReferenceNo = typeof pv.caseReferenceNo === "string" ? pv.caseReferenceNo : "";
    const clientNames = typeof pv.clientNames === "string" ? pv.clientNames : "";
    const targetCaseReferenceNo = typeof pv.targetCaseReferenceNo === "string" ? pv.targetCaseReferenceNo : "";
    const targetClientNames = typeof pv.targetClientNames === "string" ? pv.targetClientNames : "";
    const preparedByName = typeof pv.preparedByName === "string" ? pv.preparedByName : (typeof pv.createdByName === "string" ? pv.createdByName : "");
    const verifiedByName = typeof pv.lawyerApprovedByName === "string" ? pv.lawyerApprovedByName : "";
    const approvedByName = typeof pv.partnerApprovedByName === "string" ? pv.partnerApprovedByName : "";
    const rowsHtml = items
      .map((it: any) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${String(it.description ?? "")}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${fmt(it.amount)}</td></tr>`)
      .join("");
    const printedAt = new Date().toLocaleString("en-MY");
    const docTitle = isLedgerTransfer ? "LEDGER TRANSFER VOUCHER" : isInternal ? "INTERNAL PAYMENT VOUCHER" : "PAYMENT VOUCHER";
    const docSubtitle = isLedgerTransfer
      ? "(CLIENT ACCOUNT: FILE-TO-FILE TRANSFER)"
      : isInternal
        ? "(CLIENT ACCOUNT TO OFFICE ACCOUNT TRANSFER)"
        : "";
    const pageSize = (isInternal || isLedgerTransfer) ? "A4 portrait" : "A5 portrait";
    w.document.open();
    w.document.write(`
      <html>
        <head>
          <title>${String(pv.voucherNo ?? "Payment Voucher")}</title>
          <style>
            @page { size: ${pageSize}; margin: 10mm; }
            body { font-family: Arial, sans-serif; margin: 0; color: #111; }
            .page { padding: 10mm; }
            .letterhead { border-bottom: 1px solid #111; padding-bottom: 8px; margin-bottom: 10px; display:flex; justify-content:space-between; gap:12px; }
            .firm { font-weight: 800; font-size: 14px; }
            .doc { text-align:right; }
            .doc .title { font-weight: 800; font-size: 14px; }
            .doc .subtitle { font-size: 11px; font-weight: 700; margin-top: 2px; }
            .doc .meta { font-size: 11px; color: #444; margin-top: 2px; }
            h1 { font-size: 18px; margin: 0 0 12px; }
            .meta { font-size: 12px; color: #444; margin-bottom: 12px; }
            table { width: 100%; border-collapse: collapse; margin-top: 8px; }
            .sig { margin-top: 24px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; font-size: 12px; }
            .sig > div { border-top: 1px solid #111; padding-top: 6px; }
            @media print { button { display:none; } }
          </style>
        </head>
        <body>
          <div class="page">
            <div class="letterhead">
              <div class="firm">${String(firmName || "Firm")}</div>
              <div class="doc">
                <div class="title">${docTitle}</div>
                ${docSubtitle ? `<div class="subtitle">${docSubtitle}</div>` : ""}
                <div class="meta">Printed: ${printedAt}</div>
              </div>
            </div>

            <div class="meta">
              <div><b>Voucher No:</b> ${String(pv.voucherNo ?? "")}</div>
              ${isLedgerTransfer
                ? `<div><b>Transfer From:</b> ${caseReferenceNo ? String(caseReferenceNo) : "—"}${clientNames ? ` - ${String(clientNames)}` : ""}</div>
                   <div><b>Transfer To:</b> ${targetCaseReferenceNo ? String(targetCaseReferenceNo) : "—"}${targetClientNames ? ` - ${String(targetClientNames)}` : ""}</div>`
                : isInternal
                  ? `<div><b>Source A/C:</b> Client Account</div><div><b>Destination A/C:</b> Office Account</div>`
                  : `<div><b>Payee:</b> ${String(pv.payeeName ?? "")}</div>`}
              ${isLedgerTransfer ? "" : `<div><b>File Reference:</b> ${caseReferenceNo ? String(caseReferenceNo) : "—"}</div>`}
              ${isLedgerTransfer ? "" : `<div><b>Client Name:</b> ${clientNames ? String(clientNames) : "—"}</div>`}
              <div><b>Purpose:</b> ${String(pv.purpose ?? "")}</div>
              <div><b>Fund Status:</b> ${fundStatusLabel(String(pv.fundStatus ?? ""))}</div>
              <div><b>Total:</b> ${fmt(pv.amount)}</div>
            </div>

            <table>
              <thead>
                <tr><th style="text-align:left;border-bottom:1px solid #111;padding:6px 8px;">Line Item</th><th style="text-align:right;border-bottom:1px solid #111;padding:6px 8px;">Amount</th></tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
            <div class="sig">
              ${isLedgerTransfer
                ? `<div>Prepared By: ${preparedByName ? String(preparedByName) : ""}</div><div>Partner Approved By: ${approvedByName ? String(approvedByName) : ""}</div><div>Account / Paid</div>`
                : isInternal
                  ? `<div>Prepared By: ${preparedByName ? String(preparedByName) : ""}</div><div>Verified By: ${verifiedByName ? String(verifiedByName) : ""}</div><div>Approved For Transfer By: ${approvedByName ? String(approvedByName) : ""}</div>`
                  : `<div>Lawyer Approval</div><div>Partner Approval</div><div>Account / Paid</div>`}
            </div>
            <button onclick="window.print()" style="margin-top:16px;">Print</button>
          </div>
        </body>
      </html>
    `);
    w.document.close();
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 250));
    w.focus();
    w.print();
  }

  useEffect(() => {
    if (didAutoPrintRef.current) return;
    const id = printVoucherIdParam ? Number(printVoucherIdParam) : NaN;
    if (!Number.isFinite(id) || id <= 0) return;
    didAutoPrintRef.current = true;
    const qs = new URLSearchParams(searchString);
    qs.delete("printVoucherId");
    const next = qs.toString();
    window.history.replaceState(null, "", `/app/accounting${next ? `?${next}` : ""}`);
    printVoucher(id).catch(() => void 0);
  }, [printVoucherIdParam, searchString]);

  async function submitReceivedByAccounts(): Promise<void> {
    if (!receiveVoucherId) return;
    const assignedAccountUserId = receiveForm.assignedAccountUserId.trim()
      ? Number(receiveForm.assignedAccountUserId)
      : undefined;
    const body = {
      action: "received_by_accounts" as const,
      assignedAccountUserId,
      isUrgent: receiveForm.isUrgent,
    };
    const parsed = PaymentVoucherTransitionBody.safeParse(body);
    if (!parsed.success) {
      toast({ title: "Invalid input", description: parsed.error.message, variant: "destructive" });
      return;
    }
    transitionMut.mutate({ id: receiveVoucherId, body: parsed.data });
    setReceiveOpen(false);
    setReceiveVoucherId(null);
    setReceiveForm({ assignedAccountUserId: "", isUrgent: false });
  }

  async function submitReassign(): Promise<void> {
    if (!reassignVoucherId) return;
    const assignedAccountUserId = Number(reassignAssignedAccountUserId);
    const body = { action: "reassign_account_user" as const, assignedAccountUserId };
    const parsed = PaymentVoucherTransitionBody.safeParse(body);
    if (!parsed.success) {
      toast({ title: "Invalid input", description: parsed.error.message, variant: "destructive" });
      return;
    }
    transitionMut.mutate({ id: reassignVoucherId, body: parsed.data });
    setReassignOpen(false);
    setReassignVoucherId(null);
    setReassignAssignedAccountUserId("");
  }

  async function submitOverrideDeadline(): Promise<void> {
    if (!overrideDeadlineVoucherId) return;
    const iso = overrideDeadlineForm.paymentDueAt ? new Date(overrideDeadlineForm.paymentDueAt).toISOString() : "";
    const body = {
      action: "override_deadline" as const,
      paymentDueAt: iso,
      reason: overrideDeadlineForm.reason,
    };
    const parsed = PaymentVoucherTransitionBody.safeParse(body);
    if (!parsed.success) {
      toast({ title: "Invalid input", description: parsed.error.message, variant: "destructive" });
      return;
    }
    transitionMut.mutate({ id: overrideDeadlineVoucherId, body: parsed.data });
    setOverrideDeadlineOpen(false);
    setOverrideDeadlineVoucherId(null);
    setOverrideDeadlineForm({ paymentDueAt: "", reason: "" });
  }

  async function submitMarkPaid(): Promise<void> {
    if (!markPaidVoucherId) return;
    const vt = markPaidVoucher ? String(markPaidVoucher.voucherType ?? "") : "";
    const isAdvance = Boolean((markPaidVoucher as any)?.isAdvance);
    const body = {
      action: "mark_paid",
      accountType: (vt === "internal_transfer" || vt === "file_to_file_transfer") ? "client" : isAdvance ? "office" : markPaidForm.accountType,
      paymentMethod: markPaidForm.paymentMethod,
      bankChequeRefNo: markPaidForm.bankChequeRefNo,
      paidAmount: markPaidForm.paidAmount.trim() ? Number(markPaidForm.paidAmount) : undefined,
      proofDocumentPath: markPaidForm.proofDocumentPath.trim() || undefined,
      nextActionType: markPaidForm.nextActionType,
      nextActionCustom: markPaidForm.nextActionType === "Custom Action" ? (markPaidForm.nextActionCustom.trim() || undefined) : undefined,
      nextActionRemarks: markPaidForm.nextActionRemarks.trim() || undefined,
      assignedClerkUserId: markPaidVoucher?.caseId && markPaidForm.assignedClerkUserId.trim() ? Number(markPaidForm.assignedClerkUserId) : undefined,
      clerkActionExemptReason: !markPaidVoucher?.caseId ? (markPaidForm.clerkActionExemptReason.trim() || undefined) : undefined,
      lateCompletionReason: markPaidForm.lateCompletionReason.trim() || undefined,
    };
    const parsed = PaymentVoucherTransitionBody.safeParse(body);
    if (!parsed.success) {
      toast({ title: "Invalid input", description: parsed.error.message, variant: "destructive" });
      return;
    }
    transitionMut.mutate({ id: markPaidVoucherId, body: parsed.data });
    setMarkPaidOpen(false);
    setMarkPaidVoucherId(null);
    setMarkPaidForm({
      accountType: "office",
      paymentMethod: "bank_transfer",
      bankChequeRefNo: "",
      paidAmount: "",
      proofDocumentPath: "",
      nextActionType: "Collect Physical File",
      nextActionCustom: "",
      nextActionRemarks: "",
      assignedClerkUserId: "",
      clerkActionExemptReason: "",
      lateCompletionReason: "",
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowCreate(!showCreate)} className="bg-amber-500 hover:bg-amber-600 text-white gap-2">
          <Plus className="w-4 h-4" /> New Payment Voucher
        </Button>
      </div>

      {showCreate && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader><CardTitle className="text-base">New Payment Voucher</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700 block">Date of issue</label>
                  <div className="h-10 flex items-center px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700">
                    {todayLabel}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700 block">Total Amount (RM)</label>
                  <div className="h-10 flex items-center px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-900 font-semibold">
                    {fmt(totalAmount)}
                  </div>
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-sm font-medium text-slate-700 block">Case Reference (multi-select)</label>
                  <CaseMultiSelect
                    value={selectedCases}
                    onChange={setSelectedCases}
                    placeholder="Search case ref / client / project…"
                    mode={simpleForm.voucherType === "file_to_file_transfer" ? "single" : "multi"}
                    error={caseSelectionError}
                    minSearchLength={2}
                    debounceMs={300}
                    limit={20}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700 block">Voucher Type</label>
                  <select
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                    value={simpleForm.voucherType}
                    onChange={(e) => {
                      const next = e.target.value === "internal_transfer"
                        ? "internal_transfer"
                        : e.target.value === "file_to_file_transfer"
                          ? "file_to_file_transfer"
                          : "external_payment";
                      setSimpleForm((f) => ({
                        ...f,
                        voucherType: next,
                        payeeName: next === "internal_transfer" ? "Client Account → Office Account Transfer" : f.payeeName,
                        beneficiaryBank: (next === "internal_transfer" || next === "file_to_file_transfer") ? "" : f.beneficiaryBank,
                        beneficiaryAccountNo: (next === "internal_transfer" || next === "file_to_file_transfer") ? "" : f.beneficiaryAccountNo,
                        isAdvance: (next === "internal_transfer" || next === "file_to_file_transfer") ? false : f.isAdvance,
                      }));
                      if (next !== "file_to_file_transfer") {
                        setTargetCase(null);
                        setTargetCaseQueryText("");
                      }
                    }}
                  >
                    <option value="external_payment">Payment Voucher</option>
                    {canAccountingCreate ? (
                      <option value="internal_transfer">Internal Payment Voucher</option>
                    ) : null}
                    {canAccountingCreate ? (
                      <option value="file_to_file_transfer">File-to-File Transfer</option>
                    ) : null}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700 block">Pay To (Payee Name)</label>
                  <Input
                    placeholder="Recipient / payee name"
                    value={simpleForm.payeeName}
                    onChange={(e) => setSimpleForm((f) => ({ ...f, payeeName: e.target.value }))}
                    disabled={simpleForm.voucherType === "internal_transfer" || simpleForm.voucherType === "file_to_file_transfer"}
                  />
                </div>

                {simpleForm.voucherType === "internal_transfer" ? (
                  <div className="space-y-1.5 md:col-span-1">
                    <label className="text-sm font-medium text-slate-700 block">Transfer</label>
                    <div className="h-10 flex items-center px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700">
                      Client Account → Office Account
                    </div>
                  </div>
                ) : simpleForm.voucherType === "file_to_file_transfer" ? (
                  <div className="space-y-2 md:col-span-2">
                    <div className="text-sm font-medium text-slate-700">Transfer</div>
                    <div className="text-sm text-slate-700">Client Account: File-to-File Transfer</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="text-xs text-slate-500">Source Case</div>
                        <div className="h-10 flex items-center px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700">
                          {selectedCases.length === 1 ? (selectedCases[0]?.title ?? "Select 1 source case above") : "Select 1 source case above"}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs text-slate-500">Target Case</div>
                        <CaseMultiSelect
                          value={targetCase ? [targetCase] : []}
                          onChange={(next) => setTargetCase(next[0] ?? null)}
                          placeholder="Search target case..."
                          mode="single"
                          minSearchLength={2}
                          debounceMs={300}
                          limit={20}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-slate-700 block">Beneficiary Bank</label>
                      <Input
                        placeholder="e.g. Maybank Islamic Berhad"
                        value={simpleForm.beneficiaryBank}
                        onChange={(e) => setSimpleForm((f) => ({ ...f, beneficiaryBank: e.target.value }))}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-slate-700 block">Beneficiary Account No.</label>
                      <Input
                        placeholder="Bank account number"
                        value={simpleForm.beneficiaryAccountNo}
                        onChange={(e) => setSimpleForm((f) => ({ ...f, beneficiaryAccountNo: e.target.value }))}
                      />
                    </div>

                    <div className="flex items-center gap-2 md:col-span-2">
                      <Checkbox
                        checked={simpleForm.isAdvance}
                        onCheckedChange={(v) => setSimpleForm((f) => ({ ...f, isAdvance: !!v }))}
                      />
                      <div className="text-sm text-slate-700">
                        Client Advance (代墊款) — requires Partner approval
                      </div>
                    </div>
                  </>
                )}

                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-sm font-medium text-slate-700 block">
                    Responsible Lawyer <span className="text-xs text-slate-400 font-normal">(Auto-populated from case assignment if blank)</span>
                  </label>
                  <select
                    value={simpleForm.responsibleLawyerId}
                    onChange={(e) => setSimpleForm((f) => ({ ...f, responsibleLawyerId: e.target.value }))}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  >
                    <option value="">— Auto from case assignment —</option>
                    {(Array.isArray(firmLawyerUsersQuery.data) ? firmLawyerUsersQuery.data : []).filter((u) => !u.roleName || u.roleName.toLowerCase().includes("lawyer") || u.roleName.toLowerCase().includes("partner") || u.roleName.toLowerCase().includes("legal") || u.roleName.toLowerCase().includes("manager") || u.roleName.toLowerCase().includes("senior")).map((u) => (
                      <option key={`lawyer-${u.id}`} value={String(u.id)}>
                        {u.name}{u.roleName ? ` · ${u.roleName}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700 block">
                    Approving Partner <span className="text-xs text-slate-400 font-normal">(Optional — override default)</span>
                  </label>
                  <select
                    value={simpleForm.approvingPartnerId}
                    onChange={(e) => setSimpleForm((f) => ({ ...f, approvingPartnerId: e.target.value }))}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  >
                    <option value="">— Auto / Default —</option>
                    {(Array.isArray(firmPartnerUsersQuery.data) ? firmPartnerUsersQuery.data : []).filter((u) => !u.roleName || u.roleName.toLowerCase().includes("partner") || u.roleName.toLowerCase() === "founder").map((u) => (
                      <option key={`partner-${u.id}`} value={String(u.id)}>
                        {u.name}{u.roleName ? ` · ${u.roleName}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700 block">
                    Quotation <span className="text-xs text-slate-400 font-normal">(Link for claim tracking)</span>
                  </label>
                  <select
                    value={simpleForm.quotationId}
                    onChange={(e) => {
                      setSimpleForm((f) => ({ ...f, quotationId: e.target.value }));
                      setQuotationClaimWarning(null);
                    }}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  >
                    <option value="">— None —</option>
                    {(quotationsQuery.data ?? [])
                      .filter((q: { id: number; caseId: number | null; totalAmount: number | string | null }) => selectedCases.length === 0 || selectedCases.some((c) => c.case_id === q.caseId))
                      .map((q: { id: number; caseId: number | null; totalAmount: number | string | null }) => (
                        <option key={`quot-${q.id}`} value={String(q.id)}>
                          Q-{q.id} · RM{(Number(q.totalAmount) || 0).toFixed(2)} · Case #{q.caseId}
                        </option>
                      ))}
                  </select>
                </div>

                {quotationClaimWarning ? (
                  <div className="md:col-span-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600 shrink-0" />
                    <div className="text-sm text-amber-800">{quotationClaimWarning}</div>
                  </div>
                ) : null}

                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-sm font-medium text-slate-700 block">Line Items</label>
                  <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr className="text-left text-slate-600">
                          <th className="py-2 px-3 font-medium">Purpose</th>
                          <th className="py-2 px-3 font-medium text-right w-[160px]">Amount (RM)</th>
                          <th className="py-2 px-3 font-medium text-right w-[56px]"> </th>
                        </tr>
                      </thead>
                      <tbody>
                        {lineItems.map((it, idx) => (
                          <tr key={it.id} className="border-b border-slate-100 last:border-b-0">
                            <td className="py-2 px-3">
                              <Input
                                placeholder="e.g. Stamp duty, registration, disbursement"
                                value={it.purpose}
                                onChange={(e) => {
                                  const next = [...lineItems];
                                  next[idx] = { ...next[idx], purpose: e.target.value };
                                  setLineItems(next);
                                }}
                              />
                            </td>
                            <td className="py-2 px-3 text-right">
                              <Input
                                type="number"
                                step="0.01"
                                placeholder="0.00"
                                value={it.amount}
                                onChange={(e) => {
                                  const next = [...lineItems];
                                  next[idx] = { ...next[idx], amount: e.target.value };
                                  setLineItems(next);
                                }}
                              />
                            </td>
                            <td className="py-2 px-3 text-right">
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-9 w-9"
                                disabled={lineItems.length <= 1}
                                onClick={() => setLineItems((xs) => xs.filter((x) => x.id !== it.id))}
                                title="Remove"
                              >
                                <Minus className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="pt-2 flex justify-between items-center">
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-2"
                      onClick={() => setLineItems((xs) => [...xs, { id: newLineItemId(), purpose: "", amount: "" }])}
                    >
                      <Plus className="w-4 h-4" /> Add Line
                    </Button>
                    <div className="text-sm font-semibold text-slate-900">Total: {fmt(totalAmount)}</div>
                  </div>
                </div>

                <div className="md:col-span-2">
                  <div className="text-xs text-slate-400">
                    {simpleForm.isAdvance ? "Partner approval required for Client Advance" : "—"}
                  </div>
                </div>
              </div>

              {pendingCreateRequestIds.length > 0 ? (
                <Alert className="md:col-span-2 border-amber-200 bg-amber-50 text-amber-900">
                  <Clock className="h-4 w-4 text-amber-700" />
                  <AlertTitle>
                    {pendingCreatePhase === "stale"
                      ? "Submission status is stale"
                      : pendingCreatePhase === "unknown"
                        ? "Submission still being confirmed"
                        : "Submission still being confirmed"}
                  </AlertTitle>
                  <AlertDescription>
                    {pendingCreatePhase === "stale"
                      ? "Payment Voucher submission confirmation is stale. Please check status again before submitting again."
                      : "Payment Voucher submission is still being confirmed. Please do not submit again."}
                    {pendingCreateRequestIds.length > 1 ? ` ${pendingCreateRequestIds.length} submissions are being checked.` : ""}
                  </AlertDescription>
                  <div className="mt-3 flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => checkPendingCreateStatusMut.mutate([...pendingCreateRequestIds])}
                      disabled={checkPendingCreateStatusMut.isPending}
                    >
                      {checkPendingCreateStatusMut.isPending ? "Checking…" : "Check Status"}
                    </Button>
                  </div>
                </Alert>
              ) : null}

              {failedCreateRequestIds.length > 0 ? (
                <Alert className="md:col-span-2 border-red-200 bg-red-50 text-red-900">
                  <AlertTitle>Submission failed</AlertTitle>
                  <AlertDescription>
                    The submission failed and can be retried deliberately using the same request key(s) to avoid duplicates.
                  </AlertDescription>
                  <div className="mt-3 flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => retryFailedCreateMut.mutate()}
                      disabled={retryFailedCreateMut.isPending || pendingCreateRequestIds.length > 0}
                    >
                      {retryFailedCreateMut.isPending ? "Retrying…" : "Retry Submission"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setFailedCreateRequestIds([])}
                      disabled={retryFailedCreateMut.isPending}
                    >
                      Dismiss
                    </Button>
                  </div>
                </Alert>
              ) : null}

              {preflightUnclaimedWarnings.length > 0 && !createSubmitUi.showCheckStatus ? (
                <Alert variant="default" className="bg-amber-50 border border-amber-200 text-amber-900">
                  <AlertTriangle className="w-5 h-5 text-amber-600" />
                  <AlertTitle className="text-amber-900 font-semibold">Quotation Claim Check — Items Not Found</AlertTitle>
                  <AlertDescription className="text-amber-800 text-sm">
                    <div className="mt-1">
                      These line items could not be matched to any line in the linked case quotation:
                    </div>
                    <ul className="list-disc pl-5 mt-2 space-y-0.5">
                      {preflightUnclaimedWarnings.slice(0, 10).map((w, i) => (
                        <li key={i} className="font-medium">{String(w.item)}</li>
                      ))}
                      {preflightUnclaimedWarnings.length > 10 && (
                        <li className="text-amber-700">…and {preflightUnclaimedWarnings.length - 10} more</li>
                      )}
                    </ul>
                    <div className="mt-3 text-xs text-amber-700">
                      You may still create — but finance/partner review may request clarification.
                    </div>
                  </AlertDescription>
                  <div className="mt-3 flex gap-2 flex-wrap">
                    <Button
                      type="button"
                      onClick={() => {
                        const items = preflightUnclaimedWarnings.map((w) => ({
                          item: String(w.item),
                          caseId: selectedCases[0]?.case_id ? Number(selectedCases[0].case_id) : undefined,
                          userId: userId || undefined,
                          createdAt: new Date().toISOString(),
                        }));
                        setAcknowledgedUnclaimedItems(items);
                        createBatchMut.mutate();
                      }}
                      disabled={createBatchMut.isPending || preflightPending}
                      className="bg-amber-500 hover:bg-amber-600 text-white"
                    >
                      Acknowledge &amp; Create
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setPreflightUnclaimedWarnings([]);
                        setAcknowledgedUnclaimedItems([]);
                      }}
                      disabled={createBatchMut.isPending || preflightPending}
                    >
                      Review &amp; Edit
                    </Button>
                  </div>
                </Alert>
              ) : null}

              <div className="flex gap-2">
                <Button
                  onClick={() => createBatchMut.mutate()}
                  disabled={createSubmitUi.submitDisabled || preflightPending}
                  className="bg-amber-500 hover:bg-amber-600 text-white"
                >
                  {preflightPending ? "Checking quotation…" : createSubmitUi.submitLabel}
                </Button>
                <Button variant="outline" onClick={() => { setPreflightUnclaimedWarnings([]); setAcknowledgedUnclaimedItems([]); setShowCreate(false); }} disabled={createBatchMut.isPending || checkPendingCreateStatusMut.isPending || preflightPending}>Cancel</Button>
              </div>
            </>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {[
          { key: "awaitingReceipt", label: "Awaiting Accounts Receipt", onClick: () => setVoucherFilter("awaitingReceipt") },
          { key: "receivedAndProcessing", label: "Received And Processing", onClick: () => setVoucherFilter("receivedAndProcessing") },
          { key: "waitingApproval", label: "Waiting For Approval", onClick: () => setVoucherFilter("waitingApproval") },
          { key: "dueSoon", label: "Due Soon", onClick: () => setVoucherFilter("dueSoon") },
          { key: "overdue", label: "Overdue Payments", onClick: () => setVoucherFilter("overdue") },
          { key: "paidToday", label: "Paid Today", onClick: () => setVoucherFilter("paidToday") },
          { key: "clerkPending", label: "Clerk Action Pending", onClick: () => setLocation("/app/workbench?tab=my-work&pvActionFilter=active") },
          { key: "clerkOverdue", label: "Clerk Action Overdue", onClick: () => setLocation("/app/workbench?tab=my-work&pvActionFilter=overdue") },
          { key: "completedMonth", label: "Completed This Month", onClick: () => setVoucherFilter("completedMonth") },
        ].map((card) => (
          <Card key={card.key} className="border-slate-200 cursor-pointer hover:border-amber-300 hover:shadow-sm" onClick={card.onClick}>
            <CardContent className="pt-5">
              <div className="text-xs text-slate-500">{card.label}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{Number(dashboard[card.key] ?? 0)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {activeVoucherFilter !== "all" && voucherFilterLabelMap[activeVoucherFilter] ? (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm text-slate-700">
            Filtered by <span className="font-semibold">{voucherFilterLabelMap[activeVoucherFilter]}</span>
            {" · "}
            {filteredVouchers.length} result(s)
          </div>
          <Button variant="outline" size="sm" onClick={() => setVoucherFilter("all")}>Clear Filter</Button>
        </div>
      ) : null}

      {vouchersQuery.isError ? (
        <QueryFallback title="Payment vouchers unavailable" error={vouchersQuery.error} onRetry={() => vouchersQuery.refetch()} isRetrying={vouchersQuery.isFetching} />
      ) : isLoading ? (
        <div className="text-center py-12 text-slate-400">Loading…</div>
      ) : filteredVouchers.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>{activeVoucherFilter === "all" ? "No payment vouchers yet" : "No payment vouchers match this filter"}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-4 py-3 text-left font-medium">Voucher No</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Payee</th>
                <th className="px-4 py-3 text-left font-medium">Purpose</th>
                <th className="px-4 py-3 text-left font-medium">Approval</th>
                <th className="px-4 py-3 text-left font-medium">Accounts Processing</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredVouchers.map((pv: any) => {
                const actions: Array<{ key: string; label: string; onClick: () => void; show: boolean }> = [
                  {
                    key: "lawyer_approve",
                    label: "Lawyer Approve",
                    onClick: () => transitionMut.mutate({ id: pv.id, body: { action: "lawyer_approve" } }),
                    show: pv.status === "pending_lawyer" && (roleKind === "lawyer" || roleKind === "partner"),
                  },
                  {
                    key: "partner_approve",
                    label: "Partner Approve",
                    onClick: () => transitionMut.mutate({ id: pv.id, body: { action: "partner_approve" } }),
                    show: pv.status === "pending_partner" && roleKind === "partner",
                  },
                  {
                    key: "approve",
                    label: "Approve",
                    onClick: () => transitionMut.mutate({ id: pv.id, body: { action: "approve", decision: "approved" } }),
                    show: pv.approvalStatus === "pending_approval" && canAccountingApprove,
                  },
                  {
                    key: "print",
                    label: "Print Voucher",
                    onClick: () => { printVoucher(pv.id).catch((e) => toastError(toast, e, "Print failed")); },
                    show: pv.status === "pending_account" && pv.approvalStatus !== "pending_approval" && pv.approvalStatus !== "rejected",
                  },
                  {
                    key: "receive_accounts",
                    label: "Received by Accounts",
                    onClick: () => {
                      setReceiveVoucherId(pv.id);
                      setReceiveForm({
                        assignedAccountUserId: pv.assignedAccountUserId ? String(pv.assignedAccountUserId) : "",
                        isUrgent: false,
                      });
                      setReceiveOpen(true);
                    },
                    show: pv.status === "pending_account" && !pv.receivedAt && (canAccountingMarkReceived || canAccountingReview),
                  },
                  {
                    key: "reassign_account_user",
                    label: "Reassign Account User",
                    onClick: () => {
                      setReassignVoucherId(pv.id);
                      setReassignAssignedAccountUserId(pv.assignedAccountUserId ? String(pv.assignedAccountUserId) : "");
                      setReassignOpen(true);
                    },
                    show: pv.status === "pending_account" && Boolean(pv.receivedAt) && (canAccountingMarkReceived || canAccountingReview),
                  },
                  {
                    key: "override_deadline",
                    label: "Override Deadline",
                    onClick: () => {
                      setOverrideDeadlineVoucherId(pv.id);
                      setOverrideDeadlineForm({
                        paymentDueAt: toDateTimeLocalValue(String(pv.paymentDueAt ?? "")),
                        reason: String(pv.deadlineOverrideReason ?? ""),
                      });
                      setOverrideDeadlineOpen(true);
                    },
                    show: pv.status === "pending_account" && Boolean(pv.receivedAt) && canAccountingOverrideSla,
                  },
                  {
                    key: "mark_paid",
                    label: "Mark as Paid",
                    onClick: () => {
                      setMarkPaidVoucherId(pv.id);
                      setMarkPaidForm({
                        accountType: (String(pv.voucherType ?? "") === "internal_transfer" || String(pv.voucherType ?? "") === "file_to_file_transfer")
                          ? "client"
                          : pv.isAdvance
                            ? "office"
                            : String(pv.accountType ?? "office"),
                        paymentMethod: String(pv.paymentMethod ?? "bank_transfer"),
                        bankChequeRefNo: String(pv.bankChequeRefNo ?? ""),
                        paidAmount: pv.amount ? String(pv.amount) : "",
                        proofDocumentPath: String(pv.proofDocumentPath ?? ""),
                        nextActionType: String(pv.nextActionType ?? "Collect Physical File"),
                        nextActionCustom: String(pv.nextActionCustom ?? ""),
                        nextActionRemarks: String(pv.nextActionRemarks ?? ""),
                        assignedClerkUserId: pv.assignedClerkUserId ? String(pv.assignedClerkUserId) : "",
                        clerkActionExemptReason: String(pv.clerkActionExemptReason ?? ""),
                        lateCompletionReason: String(pv.lateCompletionReason ?? ""),
                      });
                      setMarkPaidOpen(true);
                    },
                    show: pv.status === "pending_account" && Boolean(pv.receivedAt) && canAccountingMarkPaid && pv.approvalStatus !== "pending_approval" && pv.approvalStatus !== "rejected",
                  },
                  {
                    key: "history",
                    label: "History",
                    onClick: () => {
                      setHistoryVoucherId(pv.id);
                      setHistoryOpen(true);
                    },
                    show: true,
                  },
                ];
                return (
                  <tr key={pv.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-slate-900">{pv.voucherNo}</td>
                    <td className="px-4 py-3 text-slate-700 capitalize">{String(pv.voucherType ?? "external_payment").replace(/_/g, " ")}</td>
                    <td className="px-4 py-3 text-slate-700">{pv.payeeName}</td>
                    <td className="px-4 py-3 text-slate-500 max-w-xs truncate">{pv.purpose}</td>
                    <td className="px-4 py-3"><ApprovalBadge status={String(pv.approvalStatus ?? "approved")} /></td>
                    <td className="px-4 py-3">
                      <div className="space-y-1 text-xs text-slate-600">
                        <div>
                          {pv.accountType
                            ? <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">{String(pv.accountType)}</span>
                            : <span>{fundStatusLabel(String(pv.fundStatus ?? ""))}</span>
                          }
                        </div>
                        <div>Received: {pv.receivedAt ? new Date(String(pv.receivedAt)).toLocaleString("en-MY") : "Pending"}</div>
                        <div>Due: {pv.paymentDueAt ? new Date(String(pv.paymentDueAt)).toLocaleString("en-MY") : "Not started"}</div>
                        <div>Account User: {pv.assignedAccountUserId ? `#${String(pv.assignedAccountUserId)}` : "Unassigned"}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={pv.status} /></td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-800">{fmt(pv.amount)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        {actions.filter((a) => a.show).map((a) => (
                          <Button key={a.key} size="sm" variant="outline" className="text-xs h-7"
                            onClick={a.onClick}
                            disabled={transitionMut.isPending}
                          >
                            {a.label}
                          </Button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={receiveOpen} onOpenChange={(open) => { if (!open) setReceiveVoucherId(null); setReceiveOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Received by Accounts</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Assigned Account User ID</label>
              <Input
                type="number"
                placeholder={`Leave blank to use current user`}
                value={receiveForm.assignedAccountUserId}
                onChange={(e) => setReceiveForm((f) => ({ ...f, assignedAccountUserId: e.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2 rounded-md border border-slate-200 p-3">
              <Checkbox
                checked={receiveForm.isUrgent}
                onCheckedChange={(checked) => setReceiveForm((f) => ({ ...f, isUrgent: Boolean(checked) }))}
              />
              <div className="text-sm text-slate-700">Use urgent SLA for this voucher</div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiveOpen(false)}>Cancel</Button>
            <Button className="bg-amber-500 hover:bg-amber-600 text-white" onClick={() => submitReceivedByAccounts()} disabled={!receiveVoucherId || transitionMut.isPending}>
              Confirm Received
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reassignOpen} onOpenChange={(open) => { if (!open) setReassignVoucherId(null); setReassignOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign Account User</DialogTitle>
          </DialogHeader>
          <div>
            <label className="text-sm font-medium text-slate-700 block mb-1">New Account User ID</label>
            <Input
              type="number"
              placeholder="Enter firm user ID"
              value={reassignAssignedAccountUserId}
              onChange={(e) => setReassignAssignedAccountUserId(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignOpen(false)}>Cancel</Button>
            <Button className="bg-amber-500 hover:bg-amber-600 text-white" onClick={() => submitReassign()} disabled={!reassignVoucherId || !reassignAssignedAccountUserId.trim() || transitionMut.isPending}>
              Save Reassignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={overrideDeadlineOpen} onOpenChange={(open) => { if (!open) setOverrideDeadlineVoucherId(null); setOverrideDeadlineOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Override Deadline</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">New Due Time</label>
              <Input
                type="datetime-local"
                value={overrideDeadlineForm.paymentDueAt}
                onChange={(e) => setOverrideDeadlineForm((f) => ({ ...f, paymentDueAt: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Reason</label>
              <Input
                placeholder="Required audit reason"
                value={overrideDeadlineForm.reason}
                onChange={(e) => setOverrideDeadlineForm((f) => ({ ...f, reason: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideDeadlineOpen(false)}>Cancel</Button>
            <Button className="bg-amber-500 hover:bg-amber-600 text-white" onClick={() => submitOverrideDeadline()} disabled={!overrideDeadlineVoucherId || !overrideDeadlineForm.paymentDueAt || !overrideDeadlineForm.reason.trim() || transitionMut.isPending}>
              Apply Deadline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={markPaidOpen} onOpenChange={(v) => { if (!v) setMarkPaidVoucherId(null); setMarkPaidOpen(v); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as Paid</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {markPaidVoucher && String(markPaidVoucher.voucherType ?? "") === "internal_transfer" ? (
              <div className="space-y-1">
                <div className="text-sm font-medium text-slate-700">Transfer</div>
                <div className="text-sm text-slate-700">Source A/C: Client Account</div>
                <div className="text-sm text-slate-700">Destination A/C: Office Account</div>
              </div>
            ) : markPaidVoucher && String(markPaidVoucher.voucherType ?? "") === "file_to_file_transfer" ? (
              <div className="space-y-1">
                <div className="text-sm font-medium text-slate-700">Ledger Transfer</div>
                <div className="text-sm text-slate-700">Account: Client Account</div>
              </div>
            ) : markPaidVoucher && Boolean((markPaidVoucher as any).isAdvance) ? (
              <div className="space-y-1">
                <div className="text-sm font-medium text-slate-700">Client Advance</div>
                <div className="text-sm text-slate-700">Deduct From: Office Account</div>
              </div>
            ) : (
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Deduct From Account</label>
                <select
                  className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  value={markPaidForm.accountType}
                  onChange={(e) => setMarkPaidForm((f) => ({ ...f, accountType: e.target.value }))}
                >
                  <option value="office">Office Account</option>
                  <option value="client">Client Account</option>
                  <option value="balance_sheet">Balance Sheet / FD</option>
                </select>
              </div>
            )}
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Payment Method</label>
              <select
                className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                value={markPaidForm.paymentMethod}
                onChange={(e) => setMarkPaidForm((f) => ({ ...f, paymentMethod: e.target.value }))}
              >
                <option value="bank_transfer">Bank Transfer</option>
                <option value="cheque">Cheque</option>
                <option value="cash">Cash</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Bank/Cheque Ref No</label>
              <Input
                placeholder="e.g. Maybank Ref / Cheque No"
                value={markPaidForm.bankChequeRefNo}
                onChange={(e) => setMarkPaidForm((f) => ({ ...f, bankChequeRefNo: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Paid Amount</label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={markPaidForm.paidAmount}
                onChange={(e) => setMarkPaidForm((f) => ({ ...f, paidAmount: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Proof Of Payment Path</label>
              <Input
                placeholder="/objects/... proof file path"
                value={markPaidForm.proofDocumentPath}
                onChange={(e) => setMarkPaidForm((f) => ({ ...f, proofDocumentPath: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Next Action Required</label>
              <select
                className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                value={markPaidForm.nextActionType}
                onChange={(e) => setMarkPaidForm((f) => ({ ...f, nextActionType: e.target.value }))}
              >
                {PAYMENT_VOUCHER_NEXT_ACTIONS.map((action) => (
                  <option key={action} value={action}>{action}</option>
                ))}
              </select>
            </div>
            {markPaidForm.nextActionType === "Custom Action" ? (
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Custom Action</label>
                <Input
                  placeholder="Describe the exact next action"
                  value={markPaidForm.nextActionCustom}
                  onChange={(e) => setMarkPaidForm((f) => ({ ...f, nextActionCustom: e.target.value }))}
                />
              </div>
            ) : null}
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Next Action Remarks</label>
              <Input
                placeholder="Optional remarks for the assigned clerk"
                value={markPaidForm.nextActionRemarks}
                onChange={(e) => setMarkPaidForm((f) => ({ ...f, nextActionRemarks: e.target.value }))}
              />
            </div>
            {markPaidVoucher?.caseId ? (
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Assigned Clerk User ID</label>
                <Input
                  type="number"
                  placeholder="Required for case-linked vouchers"
                  value={markPaidForm.assignedClerkUserId}
                  onChange={(e) => setMarkPaidForm((f) => ({ ...f, assignedClerkUserId: e.target.value }))}
                />
              </div>
            ) : (
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Clerk Action Exemption Reason</label>
                <Input
                  placeholder="Required for vouchers without case-linked clerk action"
                  value={markPaidForm.clerkActionExemptReason}
                  onChange={(e) => setMarkPaidForm((f) => ({ ...f, clerkActionExemptReason: e.target.value }))}
                />
              </div>
            )}
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Late Completion Reason</label>
              <Input
                placeholder="Required when completing overdue payment"
                value={markPaidForm.lateCompletionReason}
                onChange={(e) => setMarkPaidForm((f) => ({ ...f, lateCompletionReason: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMarkPaidOpen(false)}>Cancel</Button>
            <Button
              className="bg-amber-500 hover:bg-amber-600 text-white"
              onClick={() => submitMarkPaid()}
              disabled={
                !markPaidVoucherId ||
                !markPaidForm.bankChequeRefNo.trim() ||
                !markPaidForm.paidAmount.trim() ||
                !markPaidForm.proofDocumentPath.trim() ||
                !markPaidForm.nextActionType.trim() ||
                (markPaidForm.nextActionType === "Custom Action" && !markPaidForm.nextActionCustom.trim()) ||
                (markPaidVoucher?.caseId ? !markPaidForm.assignedClerkUserId.trim() : !markPaidForm.clerkActionExemptReason.trim()) ||
                transitionMut.isPending
              }
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={(open) => { if (!open) setHistoryVoucherId(null); setHistoryOpen(open); }}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Payment Voucher History & Audit Trail</DialogTitle>
            <DialogDescription>
              {historyVoucherId ? `PV #${historyVoucherId} — timeline of all actions` : "Select a voucher to view history."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto pr-1 -mr-1 py-2">
            {historyQuery.isLoading ? (
              <div className="py-10 text-center text-sm text-slate-500">Loading history…</div>
            ) : historyQuery.isError ? (
              <div className="py-10 text-center text-sm text-red-600">Failed to load history. Please try again.</div>
            ) : (
              ((((historyQuery.data as any)?.items as any[]) ?? [])).length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-500">No history records yet.</div>
              ) : (
                <ol className="relative border-l border-slate-200 ml-3 space-y-5">
                  {((((historyQuery.data as any)?.items as any[]) ?? [])).map((evt: any, i: number) => {
                    const ts = evt.timestamp ? new Date(String(evt.timestamp)) : null;
                    const actorLabel = evt.actorName ? String(evt.actorName) : (evt.actorId ? `System #${evt.actorId}` : "System");
                    const color = evt.actionKind === "error" ? "bg-red-500"
                      : evt.actionKind === "success" ? "bg-green-500"
                      : evt.actionKind === "warning" ? "bg-amber-500"
                      : evt.actionKind === "status_change" ? "bg-indigo-500"
                      : "bg-slate-400";
                    return (
                      <li key={`hist-${i}-${evt.id ?? i}`} className="ml-5">
                        <span className={`absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white ${color}`} />
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-900 capitalize">{String(evt.action ?? "action").replace(/_/g, " ")}</p>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">{String(evt.category ?? evt.entityType ?? "audit")}</Badge>
                          <span className="text-xs text-slate-500">{ts ? ts.toLocaleString("en-MY") : ""}</span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">by {actorLabel}{evt.ipAddress ? ` · ${String(evt.ipAddress)}` : ""}</p>
                        {evt.notes ? (
                          <div className="mt-1.5 text-xs text-slate-700 whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 leading-relaxed">
                            {String(evt.notes)}
                          </div>
                        ) : null}
                        {evt.metadata && typeof evt.metadata === "object" ? (
                          <pre className="mt-1.5 text-[10px] text-slate-500 overflow-x-auto rounded-md bg-slate-50 border border-slate-200 px-2 py-1 leading-relaxed">
                            {JSON.stringify(evt.metadata, null, 2)}
                          </pre>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )
            )}
          </div>
          <DialogFooter className="pt-2 border-t border-slate-100">
            <Button variant="outline" onClick={() => { setHistoryOpen(false); setHistoryVoucherId(null); }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── LEDGER TAB ────────────────────────────────────────────────────────────────

function LedgerTab() {
  const [accountType, setAccountType] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: "date" | "type" | "amount"; dir: "asc" | "desc" }>({ key: "date", dir: "asc" });
  const ledgerQuery = useQuery({
    queryKey: ["ledger", accountType],
    queryFn: () => apiFetchJson(`/ledger${accountType ? `?accountType=${accountType}` : ""}`),
    retry: false,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const sumQuery = useQuery({ queryKey: ["ledger-summary"], queryFn: () => apiFetchJson("/ledger/summary"), retry: false, staleTime: 30_000, refetchInterval: false, refetchOnWindowFocus: false });
  const entries = ((ledgerQuery.data ?? []) as any[]);
  const summary = ((sumQuery.data ?? []) as any[]);
  const acctLabel = (acct: string) => acct === "balance_sheet" ? "Balance Sheet / FD" : acct === "client" ? "Client Account" : "Office Account";

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e: any) => {
      const desc = String(e.description ?? "").toLowerCase();
      const ref = String(e.referenceNo ?? "").toLowerCase();
      const type = String(e.entryType ?? "").toLowerCase();
      return desc.includes(needle) || ref.includes(needle) || type.includes(needle);
    });
  }, [entries, q]);

  const displayEntries = useMemo(() => {
    const sorted = [...filtered].sort((a: any, b: any) => {
      if (sort.key === "date") {
        const ad = String(a.entryDate ?? "");
        const bd = String(b.entryDate ?? "");
        if (ad !== bd) return ad.localeCompare(bd);
      }
      if (sort.key === "type") {
        const at = String(a.entryType ?? "");
        const bt = String(b.entryType ?? "");
        if (at !== bt) return at.localeCompare(bt);
      }
      if (sort.key === "amount") {
        const aa = Math.max(Number(a.credit ?? 0), Number(a.debit ?? 0));
        const ba = Math.max(Number(b.credit ?? 0), Number(b.debit ?? 0));
        if (aa !== ba) return aa - ba;
      }
      const ac = String(a.createdAt ?? "");
      const bc = String(b.createdAt ?? "");
      if (ac !== bc) return ac.localeCompare(bc);
      return Number(a.id ?? 0) - Number(b.id ?? 0);
    });
    if (sort.dir === "desc") sorted.reverse();
    let running = 0;
    return sorted.map((e: any) => {
      running += Number(e.credit ?? 0) - Number(e.debit ?? 0);
      return { ...e, _runningBalance: running };
    });
  }, [filtered, sort]);

  const toggleSort = (key: "date" | "type" | "amount") => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        {["client", "office", "balance_sheet"].map((acct) => {
          const s = summary.find((r: any) => r.accountType === acct) ?? { totalDebit: 0, totalCredit: 0, balance: 0 };
          return (
            <Card key={acct}
              className={cn("cursor-pointer transition-all hover:shadow-md", accountType === acct && "ring-2 ring-amber-400")}
              onClick={() => setAccountType(accountType === acct ? "" : acct)}>
              <CardContent className="pt-4 pb-4">
                <div className="text-xs text-slate-500 mb-1">{acctLabel(acct)}</div>
                <div className={cn("text-xl font-bold", Number(s.balance) >= 0 ? "text-green-600" : "text-red-500")}>
                  {fmt(s.balance)}
                </div>
                <div className="text-xs text-slate-400 mt-1">Dr {fmt(s.totalDebit)} | Cr {fmt(s.totalCredit)}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {ledgerQuery.isError || sumQuery.isError ? (
        <QueryFallback
          title="Ledger unavailable"
          error={ledgerQuery.error ?? sumQuery.error}
          onRetry={() => { ledgerQuery.refetch(); sumQuery.refetch(); }}
          isRetrying={ledgerQuery.isFetching || sumQuery.isFetching}
        />
      ) : null}

      {accountType && (
        <div className="text-sm text-slate-500 flex items-center gap-2">
          <ArrowUpDown className="w-3.5 h-3.5" />
          Showing <span className="font-medium">{acctLabel(accountType)}</span>
          <button className="text-amber-600 underline ml-1" onClick={() => setAccountType("")}>clear filter</button>
        </div>
      )}

      {ledgerQuery.isLoading || sumQuery.isLoading ? (
        <div className="text-center py-12 text-slate-400">Loading…</div>
      ) : displayEntries.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No ledger entries yet — record receipts or mark payment vouchers as paid</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                className="pl-9 h-9 bg-white"
                placeholder="Search description, ref no, type…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-4 py-3 text-left font-medium">
                  <button className="inline-flex items-center gap-1 hover:text-slate-700" onClick={() => toggleSort("date")}>
                    Date <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  <button className="inline-flex items-center gap-1 hover:text-slate-700" onClick={() => toggleSort("type")}>
                    Type <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-medium">Account</th>
                <th className="px-4 py-3 text-left font-medium">Description</th>
                <th className="px-4 py-3 text-right font-medium text-green-600">
                  <button className="inline-flex items-center gap-1 hover:text-green-700" onClick={() => toggleSort("amount")}>
                    Credit (In) <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="px-4 py-3 text-right font-medium text-red-500">
                  <button className="inline-flex items-center gap-1 hover:text-red-600" onClick={() => toggleSort("amount")}>
                    Debit (Out) <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="px-4 py-3 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {displayEntries.map((e: any) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-500 text-xs font-mono">{e.entryDate}</td>
                  <td className="px-4 py-2.5 capitalize text-slate-600 text-xs">{e.entryType?.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2.5">
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-xs">
                      {acctLabel(String(e.accountType ?? "") === "trust" ? "client" : String(e.accountType ?? ""))}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-700 max-w-xs truncate text-xs">{e.description}</td>
                  <td className="px-4 py-2.5 text-right text-green-600 font-mono text-xs">
                    {Number(e.credit) > 0 ? fmt(e.credit) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-red-500 font-mono text-xs">
                    {Number(e.debit) > 0 ? fmt(e.debit) : "—"}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2.5 text-right font-semibold font-mono text-xs",
                      Number(e._runningBalance) >= 0 ? "text-slate-800" : "text-red-500"
                    )}
                  >
                    {fmt(e._runningBalance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── SETTINGS TAB ──────────────────────────────────────────────────────────────

type SettingsRoleSummary = {
  id: number;
  name: string;
  isSystemRole: boolean;
  permissions: Array<{ module: string; action: string; allowed: boolean }>;
  suggestedAccountingRole: boolean;
  mappedKind: "account_manager" | "account_admin" | null;
};

type SettingsApiResponse = {
  settings: {
    firmId: number;
    accountManagerRoleIds: number[];
    accountAdminRoleIds: number[];
    timezone: string;
    workingHoursStart: string;
    workingHoursEnd: string;
    excludeSaturday: boolean;
    excludeSunday: boolean;
    firmHolidays: Array<{ date: string; label?: string }>;
    approvalRules: {
      requirePartnerApprovalByDefault: boolean;
      managerCanFinalApprove: boolean;
      adminCanFinalApprove: boolean;
      requireDoubleApproval: boolean;
      managerSoloVoucherTypes: string[];
      thresholds: Array<Record<string, unknown>>;
    };
    paymentVoucherSla: {
      defaultHours: number;
      urgentHours: number;
      dueSoonMinutes: number;
      voucherTypeHours: Record<string, number>;
      thresholds: Array<Record<string, unknown>>;
      notifyAssignedAccountUser: boolean;
      notifyAccountManager: boolean;
      notifyPartnerOnOverdue: boolean;
      escalationGraceHours: number;
      escalationRepeatHours: number;
    };
    clerkActionSla: {
      acknowledgeHours: number;
      completionHours: number;
      dueSoonMinutes: number;
      notifyCaseOwner: boolean;
      notifyPartnerOnOverdue: boolean;
    };
    paymentProofRequired: boolean;
  };
  roles: SettingsRoleSummary[];
  suggestedRoleIds: number[];
  defaults: unknown;
};

type PreviewResponse = {
  settings: unknown;
  existingSettings: unknown;
  roleChanges: Array<{ roleId: number; additions: Array<{ module: string; action: string }>; removals: Array<{ module: string; action: string }> }>;
};

// ── MONITOR TAB ───────────────────────────────────────────────────────────────

function MonitorTab() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const qc = useQueryClient();
  const { user } = useAuth();
  const canView = hasPermission(user, "case_monitor", "view");
  const [severity, setSeverity] = useState<string>(params.get("severity") ?? "");
  const [kind, setKind] = useState<string>(params.get("kind") ?? "");
  const [lawyerId, setLawyerId] = useState<string>(params.get("lawyerId") ?? "");
  const [onlyEscalated, setOnlyEscalated] = useState<boolean>(params.get("onlyEscalated") === "1");
  const [includeResolved, setIncludeResolved] = useState<boolean>(params.get("includeResolved") === "1");
  const [limit, setLimit] = useState<number>(30);
  const [offset, setOffset] = useState<number>(0);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveTargetId, setResolveTargetId] = useState<number | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateTargetId, setEscalateTargetId] = useState<number | null>(null);
  const [escalatePartner, setEscalatePartner] = useState<string>("");
  const [escalateNote, setEscalateNote] = useState("");
  const queryUrl = (() => {
    const p = new URLSearchParams();
    if (severity) p.set("severity", severity);
    if (kind) p.set("kind", kind);
    if (lawyerId) p.set("lawyerId", lawyerId);
    if (onlyEscalated) p.set("onlyEscalated", "1");
    if (includeResolved) p.set("includeResolved", "1");
    p.set("limit", String(limit));
    p.set("offset", String(offset));
    const s = p.toString();
    return s ? `/case-monitor/bottlenecks?${s}` : `/case-monitor/bottlenecks?limit=${limit}&offset=${offset}`;
  })();
  const summary = useQuery({
    queryKey: ["case-monitor", "summary"],
    queryFn: ({ signal }) =>
      apiFetchJson("/case-monitor/summary", { signal, timeoutMs: 12_000 }) as Promise<{
        total: number; bySeverity: Record<string, number>; byKind: Record<string, number>;
        byLawyer: Array<{ userId: number; userName: string; count: number }>;
        pvDelays: number; urgentCount: number; attentionCount: number; criticalCount: number;
      }>,
    enabled: canView,
    staleTime: 60_000, retry: 0,
  });
  const list = useQuery({
    queryKey: ["case-monitor", "bottlenecks", queryUrl],
    queryFn: ({ signal }) =>
      apiFetchJson(queryUrl, { signal, timeoutMs: 15_000 }) as Promise<{
        items: Array<{
          id: number; monitorKind: string; severity: string; daysStuck: number; title: string; detail: string;
          escalatedToPartner: boolean; caseId: number | null; caseReferenceNo: string | null;
          paymentVoucherId: number | null; voucherNo: string | null; lawyerName: string | null; createdAt: string;
        }>; limit: number; offset: number;
      }>,
    enabled: canView,
    staleTime: 30_000, retry: 0,
  });
  const resolveMut = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) =>
      apiFetchJson(`/case-monitor/bottlenecks/${id}/resolve`, {
        method: "POST", timeoutMs: 15_000,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      }) as Promise<{ ok: true; resolvedAt: string }>,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["case-monitor"] });
      setResolveOpen(false); setResolveTargetId(null); setResolveNote("");
    },
  });
  const escalateMut = useMutation({
    mutationFn: async ({ id, note, targetPartnerUserId }: { id: number; note?: string; targetPartnerUserId?: string }) =>
      apiFetchJson(`/case-monitor/bottlenecks/${id}/escalate`, {
        method: "POST", timeoutMs: 15_000,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note || undefined, targetPartnerUserId: targetPartnerUserId || undefined }),
      }) as Promise<{ ok: true; escalatedAt: string; targetPartnerUserId: number | null; allPartners: boolean }>,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["case-monitor"] });
      setEscalateOpen(false); setEscalateTargetId(null); setEscalatePartner(""); setEscalateNote("");
    },
  });

  if (!canView) {
    return (
      <div className="text-sm text-slate-500 py-12 text-center">
        You do not have permission to view Case Monitor.
      </div>
    );
  }

  const summaryD = summary.data;
  const listD = list.data;

  const sevBadge = (s: string) =>
    s === "critical"
      ? "bg-red-100 text-red-700 border border-red-200"
      : s === "urgent"
        ? "bg-amber-100 text-amber-800 border border-amber-200"
        : s === "attention"
          ? "bg-sky-100 text-sky-700 border border-sky-200"
          : "bg-slate-100 text-slate-700";
  const sevDot = (s: string) =>
    s === "critical" ? "bg-red-500" : s === "urgent" ? "bg-amber-500" : s === "attention" ? "bg-sky-500" : "bg-slate-400";
  const kindLabel = (k: string) =>
    k === "case_no_movement" ? "Case stuck" : k === "case_waiting" ? "Waiting" : k === "case_on_hold" ? "On Hold" : k === "pv_delay" ? "PV overdue" : k === "urgent" ? "Urgent" : String(k);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Active Bottlenecks", v: summaryD?.total, icon: AlertTriangle, color: "bg-rose-50 text-rose-600", border: (summaryD?.total ?? 0) > 0 ? "border-rose-200 bg-rose-50/40" : undefined },
          { label: "Critical", v: summaryD?.criticalCount, icon: XCircle, color: "bg-red-50 text-red-600", border: (summaryD?.criticalCount ?? 0) > 0 ? "border-red-300 bg-red-50/60" : undefined },
          { label: "Urgent", v: summaryD?.urgentCount, icon: Activity, color: "bg-amber-50 text-amber-600", border: (summaryD?.urgentCount ?? 0) > 0 ? "border-amber-300 bg-amber-50/60" : undefined },
          { label: "PV Delays", v: summaryD?.pvDelays, icon: Clock, color: "bg-orange-50 text-orange-600", border: (summaryD?.pvDelays ?? 0) > 0 ? "border-orange-200 bg-orange-50/50" : undefined },
        ].map((item) => (
          <Card key={item.label} className={item.border ? `cursor-default ${item.border}` : "cursor-default"}>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${item.color}`}>
                  <item.icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs text-slate-500">{item.label}</div>
                  <div className="text-2xl font-bold text-slate-900 leading-tight">
                    {summary.isLoading ? "…" : String(item.v ?? 0)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {summaryD?.byLawyer && summaryD.byLawyer.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Bottlenecks by Lawyer</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5 max-h-56 overflow-auto pr-1">
              {summaryD.byLawyer.slice(0, 10).map((r) => (
                <div key={String(r.userId)} className="flex items-center gap-3">
                  <div className="text-sm text-slate-700 w-56 truncate">{r.userName}</div>
                  <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-400 rounded-full"
                      style={{ width: `${summaryD.total ? Math.min(100, (r.count / summaryD.total) * 100) : 0}%` }}
                    />
                  </div>
                  <div className="text-sm font-semibold text-slate-700 w-8 text-right">{r.count}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Filter Bottlenecks</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
            <div>
              <Label className="text-xs text-slate-500">Severity</Label>
              <select className="w-full mt-1 rounded border border-slate-200 px-2 py-1.5 text-sm" value={severity} onChange={(e) => { setSeverity(e.target.value); setOffset(0); }}>
                <option value="">All</option>
                <option value="attention">Attention</option>
                <option value="urgent">Urgent</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <Label className="text-xs text-slate-500">Kind</Label>
              <select className="w-full mt-1 rounded border border-slate-200 px-2 py-1.5 text-sm" value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
                <option value="">All</option>
                <option value="case_no_movement">Case no movement (≥3d)</option>
                <option value="pv_delay">Payment voucher overdue (≥48h)</option>
                <option value="case_waiting">Waiting</option>
                <option value="case_on_hold">On Hold</option>
              </select>
            </div>
            <div>
              <Label className="text-xs text-slate-500">Lawyer ID</Label>
              <Input className="mt-1" placeholder="Numeric" value={lawyerId} onChange={(e) => { setLawyerId(e.target.value); setOffset(0); }} />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Items / page</Label>
              <select className="w-full mt-1 rounded border border-slate-200 px-2 py-1.5 text-sm" value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
                {[20, 30, 50, 100, 200].map((n) => <option key={n} value={String(n)}>{n}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="cm-escalated-only" checked={onlyEscalated} onCheckedChange={(v) => { setOnlyEscalated(Boolean(v)); setOffset(0); }} />
              <Label htmlFor="cm-escalated-only" className="text-xs text-slate-600">Only escalated</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="cm-include-resolved" checked={includeResolved} onCheckedChange={(v) => { setIncludeResolved(Boolean(v)); setOffset(0); }} />
              <Label htmlFor="cm-include-resolved" className="text-xs text-slate-600">Include resolved</Label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Bottleneck List</CardTitle>
            {listD?.items ? <Badge variant="secondary" className="bg-slate-100 text-slate-700 text-xs">{listD.items.length}</Badge> : null}
          </div>
          <button className="text-xs text-amber-600 hover:text-amber-700" onClick={() => {
            void qc.invalidateQueries({ queryKey: ["case-monitor"] });
          }}>
            Refresh
          </button>
        </CardHeader>
        <CardContent>
          {list.isLoading || summary.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <div key={i} className="animate-pulse h-16 rounded bg-slate-100" />)}
            </div>
          ) : list.error || summary.error ? (
            <div className="text-sm text-slate-500 italic py-6 text-center">Case monitor data unavailable.</div>
          ) : !listD || listD.items.length === 0 ? (
            <div className="text-sm text-slate-500 py-10 text-center flex flex-col items-center gap-2">
              <CheckCircle className="w-7 h-7 text-emerald-500" />
              <div className="font-medium text-emerald-700">No bottlenecks — all caught up.</div>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {listD.items.map((b) => (
                <li key={String(b.id)} className="py-4 first:pt-0 last:pb-0 flex items-start gap-3">
                  <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${sevDot(b.severity)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={sevBadge(b.severity)}>{b.severity.toUpperCase()}</Badge>
                      <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200">{kindLabel(b.monitorKind)}</Badge>
                      <span className="text-xs text-slate-500">{b.daysStuck}d stuck</span>
                      {b.escalatedToPartner ? (
                        <Badge variant="destructive" className="bg-red-50 text-red-700 border border-red-200 hover:bg-red-50">ESCALATED</Badge>
                      ) : null}
                    </div>
                    <button
                      className="mt-1 font-medium text-sm text-slate-800 hover:text-slate-900 truncate block text-left w-full"
                      onClick={() => {
                        if (b.caseId) setLocation(`/app/cases/${b.caseId}?returnTo=${encodeURIComponent("/app/accounting?tab=monitor")}`);
                        else if (b.paymentVoucherId) setLocation(`/app/accounting?tab=payment-vouchers&pv=${b.paymentVoucherId}&returnTo=${encodeURIComponent("/app/accounting?tab=monitor")}`);
                      }}
                    >
                      {b.title}
                    </button>
                    <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{b.detail}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                      {b.lawyerName ? <span>Assigned: <span className="font-medium text-slate-700">{b.lawyerName}</span></span> : null}
                      {b.caseReferenceNo ? <span>Case ref: <span className="font-medium text-slate-700">{b.caseReferenceNo}</span></span> : null}
                      {b.voucherNo ? <span>PV: <span className="font-medium text-slate-700">{b.voucherNo}</span></span> : null}
                      <span>Detected {new Date(b.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => { setEscalateTargetId(b.id); setEscalateOpen(true); setEscalatePartner(""); setEscalateNote(""); }} disabled={escalateMut.isPending}>
                      Escalate
                    </Button>
                    <Button size="sm" onClick={() => { setResolveTargetId(b.id); setResolveNote(""); setResolveOpen(true); }} disabled={resolveMut.isPending}>
                      Resolve
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {listD && listD.items.length >= limit ? (
            <div className="mt-3 flex justify-between items-center gap-2">
              <div className="text-xs text-slate-500">Showing {listD.items.length} · Page ends here (offset {offset})</div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</Button>
                <Button size="sm" variant="secondary" onClick={() => setOffset(offset + limit)}>Next</Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={resolveOpen} onOpenChange={(o) => { if (!o) { setResolveOpen(false); setResolveTargetId(null); setResolveNote(""); } }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Resolve Bottleneck #{resolveTargetId ?? "—"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="text-xs text-slate-500">
              Resolving a bottleneck writes an audit log.
            </div>
            <Textarea rows={4} value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} placeholder="Explain resolution / next step (min 3 chars)." />
            {resolveMut.error ? (
              <div className="text-xs text-red-600">Failed: {String((resolveMut.error as any)?.message ?? resolveMut.error ?? "unknown")}</div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => { setResolveOpen(false); setResolveTargetId(null); setResolveNote(""); }}>Cancel</Button>
            <Button
              disabled={!Number.isFinite(resolveTargetId) || resolveNote.trim().length < 3 || resolveMut.isPending}
              onClick={() => {
                if (!Number.isFinite(resolveTargetId)) return;
                void resolveMut.mutateAsync({ id: resolveTargetId as number, note: resolveNote });
              }}
            >
              {resolveMut.isPending ? "Resolving..." : "Confirm Resolve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={escalateOpen} onOpenChange={(o) => { if (!o) { setEscalateOpen(false); setEscalateTargetId(null); setEscalatePartner(""); setEscalateNote(""); } }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Escalate Bottleneck #{escalateTargetId ?? "—"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="text-xs text-slate-500">
              Leave the partner field empty to escalate to <span className="font-medium text-slate-700">ALL Partners</span> of this firm.
            </div>
            <div>
              <Label className="text-xs text-slate-500">Target partner user ID (optional)</Label>
              <Input className="mt-1" placeholder="Leave blank for all partners" value={escalatePartner} onChange={(e) => setEscalatePartner(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs text-slate-500">Note (optional)</Label>
              <Textarea rows={3} value={escalateNote} onChange={(e) => setEscalateNote(e.target.value)} placeholder="Escalation context." />
            </div>
            {escalateMut.error ? (
              <div className="text-xs text-red-600">Failed: {String((escalateMut.error as any)?.message ?? escalateMut.error ?? "unknown")}</div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => { setEscalateOpen(false); setEscalateTargetId(null); setEscalatePartner(""); setEscalateNote(""); }}>Cancel</Button>
            <Button
              disabled={!Number.isFinite(escalateTargetId) || escalateMut.isPending}
              onClick={() => {
                if (!Number.isFinite(escalateTargetId)) return;
                void escalateMut.mutateAsync({
                  id: escalateTargetId as number,
                  note: escalateNote.trim() || undefined,
                  targetPartnerUserId: escalatePartner.trim() || undefined,
                });
              }}
            >
              {escalateMut.isPending ? "Escalating..." : escalatePartner.trim() ? "Escalate to Partner" : "Escalate to All Partners"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FileCustodyTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const search = useSearch();
  const canWrite = hasPermission(user, "accounting", "update") || hasPermission(user, "accounting", "manage_settings");
  const params = new URLSearchParams(search ?? "");
  const [tab, setTab] = useState<"items" | "new" | "release" | "detail">("items");
  const [custodyId, setCustodyId] = useState<number | null>(null);
  const [filters, setFilters] = useState<{
    lifecycle: string; category: string; q: string; onlyOut: boolean; onlyOverdue: boolean; onlyUnack: boolean;
    holder: string; page: number; limit: number;
  }>({
    lifecycle: params.get("lifecycle") ?? "",
    category: params.get("category") ?? "",
    q: params.get("q") ?? "",
    onlyOut: (params.get("only_out") ?? "1") === "1",
    onlyOverdue: (params.get("only_overdue") ?? "0") === "1",
    onlyUnack: (params.get("only_unack") ?? "0") === "1",
    holder: params.get("holder") ?? "",
    page: Number(params.get("page") ?? "1"),
    limit: Number(params.get("limit") ?? "30"),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState<{ custodyItemId: number | null; defaultHolder: string; defaultContact: string }>({ custodyItemId: null, defaultHolder: "", defaultContact: "" });
  const [ackMoveId, setAckMoveId] = useState<number | null>(null);
  const [ackNote, setAckNote] = useState("");
  const [returnMoveId, setReturnMoveId] = useState<number | null>(null);
  const [returnNote, setReturnNote] = useState("");
  const [returnCond, setReturnCond] = useState<"good"|"damaged"|"partial"|"missing_pages">("good");
  const [escMoveId, setEscMoveId] = useState<number | null>(null);
  const [escNote, setEscNote] = useState("");
  const [escPartner, setEscPartner] = useState("");
  const [newItem, setNewItem] = useState({
    fileReferenceNo: "", fileTitle: "", fileDescription: "", physicalOrDigital: "digital",
    category: "court_document", storageLocation: "", tags: "",
    matterLabel: "General", caseId: "", projectId: "",
    expectedReturnAt: "", acknowledgeDueAt: "",
    currentHolderUserId: "", currentHolderName: "", currentHolderContact: "", currentHolderFirmExternal: "",
  });

  const summary = useQuery({
    queryKey: ["file-custody", "summary"],
    queryFn: () => apiFetchJson<{ total:number; out:number; overdueReturn:number; unacknowledgedOverdue:number; byStatus:Record<string,number>; byCategory:Record<string,number> }>("/file-custody/items/summary").catch(() => ({ total:0,out:0,overdueReturn:0,unacknowledgedOverdue:0,byStatus:{},byCategory:{} })),
    staleTime: 30_000,
  });

  const list = useQuery({
    queryKey: ["file-custody", "items", filters],
    queryFn: () => {
      const p = new URLSearchParams();
      if (filters.lifecycle) p.set("lifecycle_status", filters.lifecycle);
      if (filters.category) p.set("category", filters.category);
      if (filters.q) p.set("q", filters.q);
      if (filters.holder) p.set("current_holder_user_id", filters.holder);
      if (filters.onlyOut) p.set("only_out", "1");
      if (filters.onlyOverdue) p.set("only_overdue", "1");
      if (filters.onlyUnack) p.set("only_unacknowledged", "1");
      p.set("offset", String(Math.max(0, (filters.page - 1) * filters.limit)));
      p.set("limit", String(filters.limit));
      return apiFetchJson<{ total:number; offset:number; limit:number; items:any[] }>(`/file-custody/items?${p.toString()}`).catch(() => ({ total:0, offset:0, limit:filters.limit, items:[] }));
    },
    staleTime: 15_000,
  });

  const detail = useQuery({
    queryKey: ["file-custody", "detail", custodyId],
    queryFn: () => custodyId ? apiFetchJson<any>(`/file-custody/items/${custodyId}`) : Promise.resolve(null),
    enabled: custodyId != null,
    staleTime: 10_000,
  });

  const partners = useQuery({
    queryKey: ["file-custody", "partners"],
    queryFn: () => apiFetchJson<{ partners: { id:number; name:string; email:string }[] }>("/file-custody/partners").catch(() => ({ partners: [] })),
    staleTime: 60_000,
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const payload:any = { ...newItem };
      if (newItem.caseId) payload.caseId = Number(newItem.caseId); else delete payload.caseId;
      if (newItem.projectId) payload.projectId = Number(newItem.projectId); else delete payload.projectId;
      if (newItem.currentHolderUserId) payload.currentHolderUserId = Number(newItem.currentHolderUserId); else delete payload.currentHolderUserId;
      if (!newItem.expectedReturnAt) delete payload.expectedReturnAt;
      if (!newItem.acknowledgeDueAt) delete payload.acknowledgeDueAt;
      Object.keys(payload).forEach(k => { if (payload[k] === "") delete payload[k]; });
      return fetch("/api/file-custody/items", { method:"POST", headers:{"Content-Type":"application/json"}, credentials:"include", body: JSON.stringify(payload) }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    },
    onSuccess: async () => {
      toast({ title: "Custody item created" });
      setNewItem({ fileReferenceNo:"", fileTitle:"", fileDescription:"", physicalOrDigital:"digital", category:"court_document", storageLocation:"", tags:"", matterLabel:"General", caseId:"", projectId:"", expectedReturnAt:"", acknowledgeDueAt:"", currentHolderUserId:"", currentHolderName:"", currentHolderContact:"", currentHolderFirmExternal:"" });
      setCreateOpen(false);
      await qc.invalidateQueries({ queryKey: ["file-custody"] });
    },
    onError: (e:any) => toast({ title: "Create failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const releaseMut = useMutation({
    mutationFn: async (body:any) => fetch("/api/file-custody/movements/release", { method:"POST", headers:{"Content-Type":"application/json"}, credentials:"include", body: JSON.stringify(body) }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: async () => { toast({ title: "Release movement recorded" }); setReleaseOpen(false); setReleaseTarget({ custodyItemId:null, defaultHolder:"", defaultContact:"" }); await qc.invalidateQueries({ queryKey: ["file-custody"] }); },
    onError: (e:any) => toast({ title: "Release failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const ackMut = useMutation({
    mutationFn: async (movementId:number) => fetch("/api/file-custody/movements/acknowledge", { method:"POST", headers:{"Content-Type":"application/json"}, credentials:"include", body: JSON.stringify({ movementId, acknowledgedNote: ackNote || undefined, condition: "good" }) }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: async () => { toast({ title: "Acknowledged" }); setAckMoveId(null); setAckNote(""); await qc.invalidateQueries({ queryKey: ["file-custody"] }); },
    onError: (e:any) => toast({ title: "Acknowledge failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const returnMut = useMutation({
    mutationFn: async (movementId:number) => fetch("/api/file-custody/movements/return", { method:"POST", headers:{"Content-Type":"application/json"}, credentials:"include", body: JSON.stringify({ movementId, returnedNote: returnNote || undefined, returnedCondition: returnCond }) }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: async () => { toast({ title: "Return recorded" }); setReturnMoveId(null); setReturnNote(""); setReturnCond("good"); await qc.invalidateQueries({ queryKey: ["file-custody"] }); },
    onError: (e:any) => toast({ title: "Return failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const escMut = useMutation({
    mutationFn: async (movementId:number) => fetch(`/api/file-custody/movements/${movementId}/escalate`, { method:"POST", headers:{"Content-Type":"application/json"}, credentials:"include", body: JSON.stringify({ note: escNote || undefined, targetPartnerUserId: escPartner || undefined }) }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }),
    onSuccess: async () => { toast({ title: "Escalated" }); setEscMoveId(null); setEscNote(""); setEscPartner(""); await qc.invalidateQueries({ queryKey: ["file-custody", "user-notifications"] }); },
    onError: (e:any) => toast({ title: "Escalate failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const totalPages = Math.max(1, Math.ceil((list.data?.total ?? 0) / filters.limit));
  const latestOutMovement = (mv: any[]) => mv?.find((m: any) => m.movementKind === "release" && !m.returnedAt) ?? mv?.[0];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="hover:shadow-sm transition-shadow"><CardHeader className="py-3 px-4"><CardTitle className="text-xs font-medium text-slate-500">Registered files</CardTitle></CardHeader><CardContent className="px-4 pb-3"><div className="text-2xl font-semibold text-slate-900">{summary.data?.total ?? 0}</div></CardContent></Card>
        <Card className={`${(summary.data?.out ?? 0) > 0 ? "border-amber-300 bg-amber-50/50" : ""} hover:shadow-sm transition-shadow cursor-pointer`} onClick={() => setFilters(f => ({...f, onlyOut: true, onlyOverdue: false, onlyUnack: false, page: 1}))}>
          <CardHeader className="py-3 px-4"><CardTitle className={`text-xs font-medium ${(summary.data?.out ?? 0) > 0 ? "text-amber-700" : "text-slate-500"}`}>Currently out</CardTitle></CardHeader>
          <CardContent className="px-4 pb-3"><div className={`text-2xl font-semibold ${(summary.data?.out ?? 0) > 0 ? "text-amber-800" : "text-slate-900"}`}>{summary.data?.out ?? 0}</div></CardContent>
        </Card>
        <Card className={`${(summary.data?.overdueReturn ?? 0) > 0 ? "border-orange-400 bg-orange-50/60 ring-1 ring-orange-200" : ""} hover:shadow-sm transition-shadow cursor-pointer`} onClick={() => setFilters(f => ({...f, onlyOverdue: true, onlyOut: true, onlyUnack: false, page: 1}))}>
          <CardHeader className="py-3 px-4"><CardTitle className={`text-xs font-medium ${(summary.data?.overdueReturn ?? 0) > 0 ? "text-orange-700" : "text-slate-500"}`}>Return overdue</CardTitle></CardHeader>
          <CardContent className="px-4 pb-3"><div className={`text-2xl font-semibold ${(summary.data?.overdueReturn ?? 0) > 0 ? "text-orange-800" : "text-slate-900"}`}>{summary.data?.overdueReturn ?? 0}</div></CardContent>
        </Card>
        <Card className={`${(summary.data?.unacknowledgedOverdue ?? 0) > 0 ? "border-rose-400 bg-rose-50/60 ring-1 ring-rose-200" : ""} hover:shadow-sm transition-shadow cursor-pointer`} onClick={() => setFilters(f => ({...f, onlyUnack: true, onlyOut: true, onlyOverdue: false, page: 1}))}>
          <CardHeader className="py-3 px-4"><CardTitle className={`text-xs font-medium ${(summary.data?.unacknowledgedOverdue ?? 0) > 0 ? "text-rose-700" : "text-slate-500"}`}>Acknowledgement overdue</CardTitle></CardHeader>
          <CardContent className="px-4 pb-3"><div className={`text-2xl font-semibold ${(summary.data?.unacknowledgedOverdue ?? 0) > 0 ? "text-rose-800" : "text-slate-900"}`}>{summary.data?.unacknowledgedOverdue ?? 0}</div></CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-md border border-slate-300 bg-white p-0.5">
          {(["items","detail"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-sm transition ${tab===t ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}>
              {t === "items" ? "Items" : `Details${custodyId ? ` #${custodyId}` : ""}`}
            </button>
          ))}
        </div>
        <div className="inline-flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setFilters(f => ({...f, onlyOut: !f.onlyOut, onlyOverdue: false, onlyUnack: false, page: 1}))}
            className={`px-2 py-1 rounded-md border text-[11px] font-medium transition ${filters.onlyOut ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}
          >
            Only out
          </button>
          <button
            onClick={() => setFilters(f => ({...f, onlyOverdue: !f.onlyOverdue, onlyOut: f.onlyOverdue ? f.onlyOut : true, page: 1}))}
            className={`px-2 py-1 rounded-md border text-[11px] font-medium transition ${filters.onlyOverdue ? "bg-orange-100 text-orange-800 border-orange-300" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}
          >
            Return overdue
          </button>
          <button
            onClick={() => setFilters(f => ({...f, onlyUnack: !f.onlyUnack, onlyOut: f.onlyUnack ? f.onlyOut : true, page: 1}))}
            className={`px-2 py-1 rounded-md border text-[11px] font-medium transition ${filters.onlyUnack ? "bg-rose-100 text-rose-800 border-rose-300" : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"}`}
          >
            Ack overdue
          </button>
          {(filters.onlyOut || filters.onlyOverdue || filters.onlyUnack) ? (
            <button
              onClick={() => setFilters(f => ({...f, onlyOut: false, onlyOverdue: false, onlyUnack: false, page: 1}))}
              className="px-2 py-1 rounded-md border text-[11px] font-medium bg-white text-slate-500 border-slate-300 hover:bg-slate-50 transition"
            >
              Clear quick filters
            </button>
          ) : null}
        </div>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => void qc.invalidateQueries({ queryKey: ["file-custody"] })}>Refresh</Button>
        <Button size="sm" disabled={!canWrite || createMut.isPending} onClick={() => setCreateOpen(true)}><Plus className="w-3.5 h-3.5 mr-1" /> New file</Button>
      </div>

      {tab === "items" ? (
        <>
          <Card>
            <CardContent className="p-4 grid grid-cols-2 md:grid-cols-6 gap-2">
              <div>
                <label className="text-[11px] font-medium text-slate-600">Search</label>
                <Input value={filters.q} onChange={e => setFilters(f => ({...f, q: e.target.value, page:1}))} placeholder="ref / title / matter…" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-600">Lifecycle</label>
                <select className="w-full h-9 rounded-md border border-slate-300 px-2 text-sm" value={filters.lifecycle} onChange={e => setFilters(f => ({...f, lifecycle: e.target.value, page:1}))}>
                  <option value="">Any</option>
                  {ITEM_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g," ")}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-600">Category</label>
                <select className="w-full h-9 rounded-md border border-slate-300 px-2 text-sm" value={filters.category} onChange={e => setFilters(f => ({...f, category: e.target.value, page:1}))}>
                  <option value="">Any</option>
                  {CATEGORIES.map(s => <option key={s} value={s}>{s.replace(/_/g," ")}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-600">Holder user ID</label>
                <Input value={filters.holder} onChange={e => setFilters(f => ({...f, holder: e.target.value, page:1}))} placeholder="Leave blank = any" />
              </div>
              <div className="col-span-2 md:col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 md:justify-end mt-4 md:mt-0">
                <label className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={filters.onlyOut} onChange={e => setFilters(f => ({...f, onlyOut: e.target.checked, page:1}))} /> Only out</label>
                <label className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={filters.onlyOverdue} onChange={e => setFilters(f => ({...f, onlyOverdue: e.target.checked, page:1}))} /> Return overdue</label>
                <label className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={filters.onlyUnack} onChange={e => setFilters(f => ({...f, onlyUnack: e.target.checked, page:1}))} /> Ack overdue</label>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {list.isLoading ? <div className="text-sm text-slate-500 p-6 text-center">Loading…</div> :
              (list.data?.items ?? []).length === 0 ? <div className="p-8 text-center text-slate-500 text-sm flex flex-col items-center gap-2"><PackageOpen className="w-8 h-8 text-emerald-600" /><div className="font-medium text-slate-700">No items match</div></div> :
              (list.data!.items.map((it:any) => (
                <Card key={it.id} className={`overflow-hidden ${it.isReturnOverdue ? "border-orange-300 bg-orange-50/40" : it.isAcknowledgementOverdue ? "border-rose-300 bg-rose-50/40" : (it.lifecycleStatus !== "in_office" && it.lifecycleStatus !== "returned" && it.lifecycleStatus !== "archived") ? "border-amber-200 bg-amber-50/30" : ""}`}>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className="text-[10px] uppercase">{it.physicalOrDigital}</Badge>
                          <Badge variant="secondary" className="text-[10px]">{it.category.replace(/_/g," ")}</Badge>
                          <Badge variant="default" className={`text-[10px] ${it.lifecycleStatus === "archived" ? "bg-slate-700" : it.lifecycleStatus === "returned" ? "bg-emerald-600" : it.lifecycleStatus === "lost" ? "bg-rose-700" : it.lifecycleStatus === "in_office" ? "bg-slate-600" : "bg-amber-600"}`}>{it.lifecycleStatus.replace(/_/g," ")}</Badge>
                          {it.isReturnOverdue ? <Badge variant="default" className="bg-orange-600 text-[10px]">RETURN OVERDUE</Badge> : null}
                          {it.isAcknowledgementOverdue ? <Badge variant="destructive" className="text-[10px]">ACK OVERDUE</Badge> : null}
                          {it.isArchived ? <Badge variant="outline" className="text-[10px] text-slate-500 border-slate-400">ARCHIVED</Badge> : null}
                        </div>
                        <div className="mt-1.5 text-sm font-semibold text-slate-900 flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center gap-1"><FolderKey className="w-3.5 h-3.5 text-slate-500" /> {it.fileReferenceNo}</span>
                          <span className="text-slate-600 font-medium">·</span>
                          <span>{it.fileTitle}</span>
                        </div>
                        {it.fileDescription ? <div className="text-xs text-slate-600 mt-0.5 max-w-3xl whitespace-pre-wrap">{it.fileDescription}</div> : null}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                          <span>Holder: <span className="font-medium text-slate-700">{it.currentHolderName ?? it.holderName ?? (it.currentHolderFirmExternal ? `${it.currentHolderFirmExternal} · ` : "") + (it.currentHolderContact ?? "unassigned")}</span></span>
                          {it.storageLocation ? <span>Location: <span className="font-medium text-slate-700">{it.storageLocation}</span></span> : null}
                          {it.matterLabel && it.matterLabel !== "General" ? <span>Matter: <span className="font-medium text-slate-700">{it.matterLabel}</span></span> : null}
                          {it.caseId ? <span>Case: <Link className="underline text-blue-700" href={`/app/cases/${it.caseId}`}>#{it.caseId}</Link></span> : null}
                          {it.expectedReturnAt ? <span>Return due: <span className={`font-medium ${it.isReturnOverdue ? "text-orange-700" : "text-slate-700"}`}>{new Date(it.expectedReturnAt).toLocaleString()}</span></span> : null}
                          {it.acknowledgeDueAt && !it.acknowledgedAt ? <span>Ack due: <span className={`font-medium ${it.isAcknowledgementOverdue ? "text-rose-700" : "text-slate-700"}`}>{new Date(it.acknowledgeDueAt).toLocaleString()}</span></span> : it.acknowledgedAt ? <span>Ack at {new Date(it.acknowledgedAt).toLocaleString()}</span> : null}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 items-center">
                        <Button size="sm" variant="ghost" onClick={() => { setCustodyId(it.id); setTab("detail"); }}>Details <ArrowRightLeft className="w-3 h-3 ml-1" /></Button>
                        <Button size="sm" variant="secondary" disabled={!canWrite || it.isArchived || releaseMut.isPending} onClick={() => { setReleaseTarget({ custodyItemId: it.id, defaultHolder: it.currentHolderName ?? "", defaultContact: it.currentHolderContact ?? "" }); setReleaseOpen(true); }}>
                          <AArrowDown className="w-3 h-3 mr-1" /> Release
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )))
            }
          </div>

          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="text-slate-500">{list.data?.total ?? 0} items · page {filters.page}/{totalPages}</div>
            <div className="flex items-center gap-1.5">
              <select className="h-8 rounded-md border border-slate-300 px-2 text-xs" value={filters.limit} onChange={e => setFilters(f => ({...f, limit: Number(e.target.value), page:1}))}>
                {[20,30,50,100,200].map(n => <option key={n} value={n}>{n}/page</option>)}
              </select>
              <Button size="sm" variant="outline" disabled={filters.page <= 1} onClick={() => setFilters(f => ({...f, page: Math.max(1, f.page-1)}))}>Prev</Button>
              <Button size="sm" variant="outline" disabled={filters.page >= totalPages} onClick={() => setFilters(f => ({...f, page: f.page+1}))}>Next</Button>
            </div>
          </div>
        </>
      ) : custodyId != null ? (
        detail.isLoading ? <div className="text-sm text-slate-500 p-6 text-center">Loading…</div> :
        !detail.data ? <div className="p-8 text-center text-slate-500 text-sm">Item not found.</div> :
        (() => {
          const it = detail.data.item;
          const mvs: any[] = detail.data.movements ?? [];
          const latestRelease = mvs.find((m:any) => m.movementKind === "release" && !m.returnedAt) ?? mvs[0];
          return (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="lg:col-span-2"><CardHeader><CardTitle className="text-base flex items-center gap-2"><FolderKey className="w-4 h-4" /> {it.fileReferenceNo} <span className="text-slate-500 text-sm font-normal">· {it.fileTitle}</span></CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <InfoLine label="Category">{it.category.replace(/_/g," ")}</InfoLine>
                    <InfoLine label="Format">{it.physicalOrDigital}</InfoLine>
                    <InfoLine label="Status">{it.lifecycleStatus.replace(/_/g," ")}</InfoLine>
                    <InfoLine label="Storage">{it.storageLocation ?? "—"}</InfoLine>
                    <InfoLine label="Matter">{it.matterLabel ?? "—"}</InfoLine>
                    <InfoLine label="Case">{it.caseId ? <Link className="underline text-blue-700" href={`/app/cases/${it.caseId}`}>#{it.caseId}</Link> : "—"}</InfoLine>
                    <InfoLine label="Holder">{it.currentHolderName ?? (it.currentHolderFirmExternal ? it.currentHolderFirmExternal : "in office")}{it.currentHolderContact ? ` <${it.currentHolderContact}>` : ""}</InfoLine>
                    <InfoLine label="Archived">{it.isArchived ? `at ${new Date(it.archivedAt).toLocaleString()}` : "no"}</InfoLine>
                  </div>
                  {it.fileDescription ? <div className="rounded-md border border-slate-200 bg-slate-50 p-3 whitespace-pre-wrap text-xs text-slate-700">{it.fileDescription}</div> : null}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="secondary" disabled={!canWrite || it.isArchived || releaseMut.isPending} onClick={() => { setReleaseTarget({ custodyItemId: it.id, defaultHolder: it.currentHolderName ?? "", defaultContact: it.currentHolderContact ?? "" }); setReleaseOpen(true); }}><AArrowDown className="w-3 h-3 mr-1" /> New release</Button>
                    {latestRelease && !latestRelease.acknowledgedAt ? <Button size="sm" variant="outline" onClick={() => { setAckMoveId(latestRelease.id); setAckNote(""); }}><UserCheck className="w-3 h-3 mr-1" /> Acknowledge receipt</Button> : null}
                    {latestRelease && !latestRelease.returnedAt ? <Button size="sm" variant="default" className="bg-emerald-700 hover:bg-emerald-800" onClick={() => { setReturnMoveId(latestRelease.id); setReturnNote(""); setReturnCond("good"); }}><AArrowUp className="w-3 h-3 mr-1" /> Mark returned</Button> : null}
                    {latestRelease && !latestRelease.returnedAt ? <Button size="sm" variant="destructive" onClick={() => { setEscMoveId(latestRelease.id); setEscNote(""); setEscPartner(""); }}>Escalate</Button> : null}
                  </div>
                </CardContent>
              </Card>
              <Card><CardHeader><CardTitle className="text-sm">Custody timeline</CardTitle></CardHeader>
                <CardContent className="space-y-3 max-h-[62vh] overflow-y-auto pr-1">
                  {mvs.length === 0 ? <div className="text-xs text-slate-500">No movements yet.</div> :
                    mvs.map((m:any) => (
                      <div key={m.id} className={`rounded-lg border p-2.5 text-xs ${m.escalatedToPartner ? "border-rose-300 bg-rose-50/40" : m.movementKind === "return" ? "border-emerald-300 bg-emerald-50/40" : m.movementKind === "release" ? "border-amber-300 bg-amber-50/40" : "border-slate-200 bg-white"}`}>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-800 inline-flex items-center gap-1">{arrowIconFor(m.movementKind)} {m.movementKind.toUpperCase()}</span>
                          <span className="text-[10px] text-slate-500">{new Date(m.createdAt).toLocaleString()}</span>
                        </div>
                        <div className="mt-1 text-slate-700 space-y-0.5">
                          {m.fromHolderName || m.fromHolderFirmExternal || m.fromHolderUserId ? <div>From: <span className="font-medium">{m.fromHolderFirmExternal ? `${m.fromHolderFirmExternal} · ` : ""}{m.fromHolderName ?? `user ${m.fromHolderUserId}`}{m.fromHolderContact ? ` <${m.fromHolderContact}>` : ""}</span></div> : null}
                          {m.toHolderName || m.toHolderFirmExternal || m.toHolderUserId ? <div>To: <span className="font-medium">{m.toHolderFirmExternal ? `${m.toHolderFirmExternal} · ` : ""}{m.toHolderName ?? `user ${m.toHolderUserId}`}{m.toHolderContact ? ` <${m.toHolderContact}>` : ""}</span></div> : null}
                          {m.expectedReturnAt ? <div>Return due: <span className="font-medium">{new Date(m.expectedReturnAt).toLocaleString()}</span></div> : null}
                          {m.acknowledgeDueAt && !m.acknowledgedAt ? <div>Ack due: <span className="font-medium">{new Date(m.acknowledgeDueAt).toLocaleString()}</span></div> : m.acknowledgedAt ? <div>Ack: <span className="font-medium text-emerald-700">{new Date(m.acknowledgedAt).toLocaleString()}</span>{m.acknowledgedNote ? ` — ${m.acknowledgedNote}` : ""}</div> : null}
                          {m.returnedAt ? <div>Returned: <span className="font-medium text-emerald-700">{new Date(m.returnedAt).toLocaleString()}</span>{m.returnedCondition ? ` (${m.returnedCondition})` : ""}{m.returnedNote ? ` — ${m.returnedNote}` : ""}</div> : null}
                          {m.escalatedToPartner ? <div className="text-rose-700">ESCALATED at {new Date(m.escalatedAt!).toLocaleString()}</div> : null}
                          {m.movementNote ? <div className="rounded bg-slate-50 p-1.5 border border-slate-200 whitespace-pre-wrap">{m.movementNote}</div> : null}
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {m.movementKind === "release" && !m.acknowledgedAt ? <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => { setAckMoveId(m.id); setAckNote(""); }}>Ack</Button> : null}
                          {m.movementKind === "release" && !m.returnedAt ? <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => { setReturnMoveId(m.id); setReturnNote(""); setReturnCond("good"); }}>Return</Button> : null}
                          {m.movementKind === "release" && !m.returnedAt ? <Button size="sm" variant="destructive" className="h-7 px-2 text-[11px]" onClick={() => { setEscMoveId(m.id); setEscNote(""); setEscPartner(""); }}>Esc</Button> : null}
                        </div>
                      </div>
                    ))
                  }
                </CardContent>
              </Card>
            </div>
          );
        })()
      ) : null}

      <Dialog open={createOpen} onOpenChange={v => { setCreateOpen(v); }}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Register custody file</DialogTitle><DialogDescription>Minimal intake. Release movement can be recorded from item detail after creation.</DialogDescription></DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="File reference no (unique per firm)" required><Input value={newItem.fileReferenceNo} onChange={e => setNewItem(n => ({...n, fileReferenceNo: e.target.value}))} placeholder="e.g. KLHC-2026-0123 / ABC/SPA/001" /></Field>
            <Field label="File title" required><Input value={newItem.fileTitle} onChange={e => setNewItem(n => ({...n, fileTitle: e.target.value}))} placeholder="e.g. Sale & Purchase Agreement — Lot 12345" /></Field>
            <Field label="Format"><select className="w-full h-9 rounded-md border border-slate-300 px-2 text-sm" value={newItem.physicalOrDigital} onChange={e => setNewItem(n => ({...n, physicalOrDigital: e.target.value as any}))}><option>digital</option><option>physical</option><option>hybrid</option></select></Field>
            <Field label="Category"><select className="w-full h-9 rounded-md border border-slate-300 px-2 text-sm" value={newItem.category} onChange={e => setNewItem(n => ({...n, category: e.target.value as any}))}>{CATEGORIES.map(c => <option key={c} value={c}>{c.replace(/_/g," ")}</option>)}</select></Field>
            <Field label="Matter label"><Input value={newItem.matterLabel} onChange={e => setNewItem(n => ({...n, matterLabel: e.target.value}))} placeholder="General / Conveyancing / Loan / Litigation…" /></Field>
            <Field label="Storage location"><Input value={newItem.storageLocation} onChange={e => setNewItem(n => ({...n, storageLocation: e.target.value}))} placeholder="Cabinet A-3 / Drive:// / Room 2" /></Field>
            <Field label="Case ID (optional)"><Input value={newItem.caseId} onChange={e => setNewItem(n => ({...n, caseId: e.target.value}))} placeholder="e.g. 42" /></Field>
            <Field label="Project ID (optional)"><Input value={newItem.projectId} onChange={e => setNewItem(n => ({...n, projectId: e.target.value}))} placeholder="e.g. 7" /></Field>
            <Field label="Tags (comma separated)"><Input value={newItem.tags} onChange={e => setNewItem(n => ({...n, tags: e.target.value}))} placeholder="original, title, spa, caveat, …" /></Field>
            <div className="md:col-span-2"><Field label="Description"><textarea className="w-full rounded-md border border-slate-300 p-2 text-sm min-h-[84px]" value={newItem.fileDescription} maxLength={5000} onChange={e => setNewItem(n => ({...n, fileDescription: e.target.value}))} /></Field></div>
            <div className="md:col-span-2 rounded-md border border-slate-200 bg-slate-50/70 p-3 space-y-3">
              <div className="text-xs font-semibold text-slate-700">Current holder (blank = file is in office)</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Holder user ID (firm internal)"><Input value={newItem.currentHolderUserId} onChange={e => setNewItem(n => ({...n, currentHolderUserId: e.target.value}))} placeholder="Leave blank if not assigned" /></Field>
                <Field label="Holder name (override/external)"><Input value={newItem.currentHolderName} onChange={e => setNewItem(n => ({...n, currentHolderName: e.target.value}))} placeholder="Counsel / Borrower / External firm name" /></Field>
                <Field label="Contact"><Input value={newItem.currentHolderContact} onChange={e => setNewItem(n => ({...n, currentHolderContact: e.target.value}))} placeholder="email or phone" /></Field>
                <Field label="External firm / organisation"><Input value={newItem.currentHolderFirmExternal} onChange={e => setNewItem(n => ({...n, currentHolderFirmExternal: e.target.value}))} placeholder="Messrs. Foo &amp; Bar" /></Field>
                <Field label="Ack due (ISO datetime, blank = +24h when holder assigned)"><Input type="datetime-local" value={newItem.acknowledgeDueAt} onChange={e => setNewItem(n => ({...n, acknowledgeDueAt: e.target.value}))} /></Field>
                <Field label="Return due (ISO datetime)"><Input type="datetime-local" value={newItem.expectedReturnAt} onChange={e => setNewItem(n => ({...n, expectedReturnAt: e.target.value}))} /></Field>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button disabled={createMut.isPending || !newItem.fileReferenceNo || newItem.fileTitle.length < 2} onClick={() => createMut.mutate()}>{createMut.isPending ? "Saving…" : "Register"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={releaseOpen} onOpenChange={v => { if (!v) { setReleaseTarget({ custodyItemId:null, defaultHolder:"", defaultContact:"" }); } setReleaseOpen(v); }}>
        <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record release movement</DialogTitle><DialogDescription>Target a holder user ID OR provide external holder name/contact.</DialogDescription></DialogHeader>
          <ReleaseFormBody
            initial={{
              toHolderUserId: "", toHolderName: releaseTarget.defaultHolder, toHolderContact: releaseTarget.defaultContact,
              toHolderFirmExternal: "", expectedReturnAt: "", acknowledgeDueAt: "", severity: "normal", movementNote: ""
            }}
            onCancel={() => { setReleaseOpen(false); setReleaseTarget({ custodyItemId:null, defaultHolder:"", defaultContact:"" }); }}
            onSubmit={body => releaseMut.mutate({ ...body, custodyItemId: releaseTarget.custodyItemId! })}
            isPending={releaseMut.isPending}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={ackMoveId != null} onOpenChange={v => { if (!v) { setAckMoveId(null); setAckNote(""); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Acknowledge custody receipt</DialogTitle><DialogDescription>Confirms the holder has received the file. Audited.</DialogDescription></DialogHeader>
          <textarea className="w-full rounded-md border border-slate-300 p-3 text-sm min-h-[84px]" placeholder="Optional acknowledgement note (max 2000 chars)" maxLength={2000} value={ackNote} onChange={e => setAckNote(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setAckMoveId(null); setAckNote(""); }}>Cancel</Button>
            <Button disabled={ackMoveId == null || ackMut.isPending} onClick={() => ackMut.mutate(ackMoveId!)}>{ackMut.isPending ? "Saving…" : "Confirm acknowledge"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={returnMoveId != null} onOpenChange={v => { if (!v) { setReturnMoveId(null); setReturnNote(""); setReturnCond("good"); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Record file return</DialogTitle><DialogDescription>Mark the release movement as returned.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <Field label="Returned condition">
              <select className="w-full h-9 rounded-md border border-slate-300 px-2 text-sm" value={returnCond} onChange={e => setReturnCond(e.target.value as any)}>
                <option value="good">Good</option><option value="partial">Partial</option><option value="damaged">Damaged</option><option value="missing_pages">Missing pages</option>
              </select>
            </Field>
            <Field label="Notes (max 4000 chars)"><textarea className="w-full rounded-md border border-slate-300 p-2.5 text-sm min-h-[96px]" maxLength={4000} value={returnNote} onChange={e => setReturnNote(e.target.value)} /></Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setReturnMoveId(null); setReturnNote(""); setReturnCond("good"); }}>Cancel</Button>
            <Button disabled={returnMoveId == null || returnMut.isPending} className="bg-emerald-700 hover:bg-emerald-800" onClick={() => returnMut.mutate(returnMoveId!)}>{returnMut.isPending ? "Saving…" : "Confirm return"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={escMoveId != null} onOpenChange={v => { if (!v) { setEscMoveId(null); setEscNote(""); setEscPartner(""); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Escalate custody overdue</DialogTitle>
            <DialogDescription>Leave partner empty = notify all active Partners. Otherwise enter numeric user ID.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Target partner user ID (optional)">
              <div className="flex gap-2">
                <Input value={escPartner} onChange={e => setEscPartner(e.target.value)} placeholder="Blank = all partners" />
                {(partners.data?.partners ?? []).length > 0 ? (
                  <select className="h-9 rounded-md border border-slate-300 px-2 text-sm max-w-[42%]" value="" onChange={e => { if (e.target.value) setEscPartner(e.target.value); }}>
                    <option value="">Pick…</option>
                    {partners.data!.partners.map(p => <option key={p.id} value={String(p.id)}>{p.name} · {p.email}</option>)}
                  </select>
                ) : null}
              </div>
            </Field>
            <Field label="Escalation note"><textarea className="w-full rounded-md border border-slate-300 p-2.5 text-sm min-h-[96px]" maxLength={1000} value={escNote} onChange={e => setEscNote(e.target.value)} /></Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setEscMoveId(null); setEscNote(""); setEscPartner(""); }}>Cancel</Button>
            <Button disabled={escMoveId == null || escMut.isPending} variant="destructive" onClick={() => escMut.mutate(escMoveId!)}>
              {escMut.isPending ? "Escalating…" : (escPartner.trim() ? "Escalate to partner" : "Escalate to all partners")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const ITEM_STATUSES = ["in_office","out_on_loan","out_with_counsel","out_with_client","out_external","returned","archived","lost"] as const;
const CATEGORIES = ["court_document","spa","loan_agreement","land_title","caveat","identity_document","invoice","payment_voucher","quotation","firm_letter","correspondence","bundle","file_will","other"] as const;

function arrowIconFor(kind: string) {
  switch (kind) {
    case "release": return <AArrowDown className="w-3 h-3 text-amber-700" />;
    case "return": return <AArrowUp className="w-3 h-3 text-emerald-700" />;
    case "acknowledge": return <UserCheck className="w-3 h-3 text-blue-700" />;
    default: return <HandCoins className="w-3 h-3 text-slate-600" />;
  }
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div>
      <label className="text-[11px] font-medium text-slate-600">{label}{required ? <span className="text-rose-600 ml-1">*</span> : ""}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function InfoLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm text-slate-800 font-medium mt-0.5">{children}</div>
    </div>
  );
}

function ReleaseFormBody(props: {
  initial: {
    toHolderUserId: string; toHolderName: string; toHolderContact: string; toHolderFirmExternal: string;
    expectedReturnAt: string; acknowledgeDueAt: string; severity: string; movementNote: string;
  };
  onSubmit: (body: any) => void; onCancel: () => void; isPending: boolean;
}) {
  const [state, setState] = useState(props.initial);
  useEffect(() => setState(props.initial), [props.initial]);
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="To: holder user ID (firm internal)"><Input value={state.toHolderUserId} onChange={e => setState(s => ({...s, toHolderUserId: e.target.value}))} placeholder="Optional" /></Field>
        <Field label="To: holder name / external"><Input value={state.toHolderName} onChange={e => setState(s => ({...s, toHolderName: e.target.value}))} placeholder="Required if user ID blank" /></Field>
        <Field label="To: contact (email / phone)"><Input value={state.toHolderContact} onChange={e => setState(s => ({...s, toHolderContact: e.target.value}))} /></Field>
        <Field label="To: external firm / organisation"><Input value={state.toHolderFirmExternal} onChange={e => setState(s => ({...s, toHolderFirmExternal: e.target.value}))} /></Field>
        <Field label="Acknowledgement due (ISO)"><Input type="datetime-local" value={state.acknowledgeDueAt} onChange={e => setState(s => ({...s, acknowledgeDueAt: e.target.value}))} /></Field>
        <Field label="Return due (ISO)"><Input type="datetime-local" value={state.expectedReturnAt} onChange={e => setState(s => ({...s, expectedReturnAt: e.target.value}))} /></Field>
        <Field label="Severity"><select className="w-full h-9 rounded-md border border-slate-300 px-2 text-sm" value={state.severity} onChange={e => setState(s => ({...s, severity: e.target.value as any}))}><option>info</option><option>normal</option><option>high</option><option>urgent</option><option>critical</option></select></Field>
      </div>
      <Field label="Movement note"><textarea className="w-full rounded-md border border-slate-300 p-2.5 text-sm min-h-[80px]" maxLength={4000} value={state.movementNote} onChange={e => setState(s => ({...s, movementNote: e.target.value}))} /></Field>
      <DialogFooter>
        <Button variant="ghost" onClick={props.onCancel}>Cancel</Button>
        <Button disabled={props.isPending || !(state.toHolderUserId || state.toHolderName)} onClick={() => {
          const body:any = { ...state };
          if (state.toHolderUserId) body.toHolderUserId = Number(state.toHolderUserId); else delete body.toHolderUserId;
          Object.keys(body).forEach(k => { if (body[k] === "") delete body[k]; });
          props.onSubmit(body);
        }}>{props.isPending ? "Recording…" : "Confirm release"}</Button>
      </DialogFooter>
    </>
  );
}

function SettingsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManageSettings = hasPermission(user, "accounting", "manage_settings");

  const [form, setForm] = useState<{
    accountManagerRoleIds: number[];
    accountAdminRoleIds: number[];
    timezone: string;
    workingHoursStart: string;
    workingHoursEnd: string;
    excludeSaturday: boolean;
    excludeSunday: boolean;
    firmHolidays: Array<{ date: string; label: string }>;
    approvalRules: {
      requirePartnerApprovalByDefault: boolean;
      managerCanFinalApprove: boolean;
      adminCanFinalApprove: boolean;
      requireDoubleApproval: boolean;
      managerSoloVoucherTypes: string[];
    };
    paymentVoucherSla: {
      defaultHours: number;
      urgentHours: number;
      dueSoonMinutes: number;
      notifyAssignedAccountUser: boolean;
      notifyAccountManager: boolean;
      notifyPartnerOnOverdue: boolean;
      escalationGraceHours: number;
      escalationRepeatHours: number;
    };
    clerkActionSla: {
      acknowledgeHours: number;
      completionHours: number;
      dueSoonMinutes: number;
      notifyCaseOwner: boolean;
      notifyPartnerOnOverdue: boolean;
    };
    paymentProofRequired: boolean;
  } | null>(null);

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [dirty, setDirty] = useState(false);

  const settingsQuery = useQuery<SettingsApiResponse>({
    queryKey: ["accounting-settings"],
    queryFn: () => apiFetchJson("/accounting/settings"),
    retry: false,
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!settingsQuery.data || form) return;
    const d = settingsQuery.data;
    setForm({
      accountManagerRoleIds: [...d.settings.accountManagerRoleIds],
      accountAdminRoleIds: [...d.settings.accountAdminRoleIds],
      timezone: d.settings.timezone,
      workingHoursStart: d.settings.workingHoursStart,
      workingHoursEnd: d.settings.workingHoursEnd,
      excludeSaturday: d.settings.excludeSaturday,
      excludeSunday: d.settings.excludeSunday,
      firmHolidays: d.settings.firmHolidays.map((h) => ({ date: h.date, label: h.label ?? "" })),
      approvalRules: {
        requirePartnerApprovalByDefault: d.settings.approvalRules.requirePartnerApprovalByDefault,
        managerCanFinalApprove: d.settings.approvalRules.managerCanFinalApprove,
        adminCanFinalApprove: d.settings.approvalRules.adminCanFinalApprove,
        requireDoubleApproval: d.settings.approvalRules.requireDoubleApproval,
        managerSoloVoucherTypes: [...d.settings.approvalRules.managerSoloVoucherTypes],
      },
      paymentVoucherSla: {
        defaultHours: d.settings.paymentVoucherSla.defaultHours,
        urgentHours: d.settings.paymentVoucherSla.urgentHours,
        dueSoonMinutes: d.settings.paymentVoucherSla.dueSoonMinutes,
        notifyAssignedAccountUser: d.settings.paymentVoucherSla.notifyAssignedAccountUser,
        notifyAccountManager: d.settings.paymentVoucherSla.notifyAccountManager,
        notifyPartnerOnOverdue: d.settings.paymentVoucherSla.notifyPartnerOnOverdue,
        escalationGraceHours: d.settings.paymentVoucherSla.escalationGraceHours,
        escalationRepeatHours: d.settings.paymentVoucherSla.escalationRepeatHours,
      },
      clerkActionSla: {
        acknowledgeHours: d.settings.clerkActionSla.acknowledgeHours,
        completionHours: d.settings.clerkActionSla.completionHours,
        dueSoonMinutes: d.settings.clerkActionSla.dueSoonMinutes,
        notifyCaseOwner: d.settings.clerkActionSla.notifyCaseOwner,
        notifyPartnerOnOverdue: d.settings.clerkActionSla.notifyPartnerOnOverdue,
      },
      paymentProofRequired: d.settings.paymentProofRequired,
    });
  }, [settingsQuery.data, form]);

  const overlap = (form?.accountManagerRoleIds ?? []).filter((id) => (form?.accountAdminRoleIds ?? []).includes(id));

  const previewMut = useMutation<PreviewResponse, unknown>({
    mutationFn: () => {
      if (!form) throw new Error("Form not ready");
      return apiFetchJson("/accounting/settings/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    },
    onSuccess: (data) => setPreview(data),
    onError: (e) => toastError(toast, e, "Preview failed"),
  });

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form) throw new Error("Form not ready");
      return apiFetchJson("/accounting/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["accounting-settings"] });
      setDirty(false);
      setPreview(null);
      toast({ title: "Settings saved" });
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  function toggleRole(kind: "accountManagerRoleIds" | "accountAdminRoleIds", roleId: number) {
    if (!form || !canManageSettings) return;
    setDirty(true);
    setPreview(null);
    setForm((f) => {
      if (!f) return f;
      const current = f[kind];
      const next = current.includes(roleId) ? current.filter((x) => x !== roleId) : [...current, roleId];
      return { ...f, [kind]: next };
    });
  }

  function addHoliday() {
    if (!form || !canManageSettings) return;
    setDirty(true);
    setPreview(null);
    setForm((f) => {
      if (!f) return f;
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      return { ...f, firmHolidays: [...f.firmHolidays, { date: iso, label: "" }] };
    });
  }

  function removeHoliday(idx: number) {
    if (!form || !canManageSettings) return;
    setDirty(true);
    setPreview(null);
    setForm((f) => {
      if (!f) return f;
      return { ...f, firmHolidays: f.firmHolidays.filter((_, i) => i !== idx) };
    });
  }

  function updateHoliday(idx: number, key: "date" | "label", value: string) {
    if (!form || !canManageSettings) return;
    setDirty(true);
    setPreview(null);
    setForm((f) => {
      if (!f) return f;
      const next = [...f.firmHolidays];
      next[idx] = { ...next[idx], [key]: value };
      return { ...f, firmHolidays: next };
    });
  }

  const commonTimezones = [
    "Asia/Kuala_Lumpur",
    "Asia/Singapore",
    "Asia/Jakarta",
    "Asia/Bangkok",
    "Asia/Hong_Kong",
    "Asia/Manila",
    "Australia/Sydney",
    "Europe/London",
    "UTC",
  ];

  if (settingsQuery.isLoading) {
    return <div className="text-center py-16 text-slate-400">Loading settings…</div>;
  }
  if (settingsQuery.isError) {
    return <QueryFallback title="Settings unavailable" error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} isRetrying={settingsQuery.isFetching} />;
  }
  if (!form) {
    return <div className="text-center py-16 text-slate-400">Preparing form…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Accounting Settings</h2>
          <p className="text-sm text-slate-500 mt-1">Role mappings, SLA, working hours and approval workflow rules</p>
        </div>
        <div className="flex gap-2">
          {canManageSettings ? (
            <>
              <Button
                variant="outline"
                onClick={() => previewMut.mutate()}
                disabled={!dirty || previewMut.isPending || saveMut.isPending || overlap.length > 0}
              >
                {previewMut.isPending ? "Previewing…" : "Preview Changes"}
              </Button>
              <Button
                className="bg-amber-500 hover:bg-amber-600 text-white"
                onClick={() => saveMut.mutate()}
                disabled={!dirty || saveMut.isPending || previewMut.isPending || overlap.length > 0}
              >
                {saveMut.isPending ? "Saving…" : "Save Settings"}
              </Button>
            </>
          ) : (
            <Badge variant="outline" className="text-slate-500">Read-only</Badge>
          )}
        </div>
      </div>

      {overlap.length > 0 && (
        <Alert className="border-red-200 bg-red-50 text-red-900">
          <AlertTriangle className="h-4 w-4 text-red-700" />
          <AlertTitle>Role overlap detected</AlertTitle>
          <AlertDescription>A role cannot be both Account Manager and Account Admin. Role IDs: {overlap.join(", ")}</AlertDescription>
        </Alert>
      )}

      {preview && (
        <Card className="border-sky-200 bg-sky-50">
          <CardHeader><CardTitle className="text-base">Preview: Role permission changes</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {preview.roleChanges.every((c) => c.additions.length === 0 && c.removals.length === 0) ? (
              <div className="text-sm text-slate-600">No role permission changes detected from this save.</div>
            ) : (
              preview.roleChanges.map((c) => (
                <div key={c.roleId} className="space-y-1 border-t border-sky-200 pt-2 first:border-0 first:pt-0">
                  <div className="text-sm font-medium text-slate-900">Role #{c.roleId}</div>
                  {c.additions.length > 0 && (
                    <div className="text-xs text-green-700">
                      + Grant: {c.additions.map((x) => `${x.module}:${x.action}`).join(", ")}
                    </div>
                  )}
                  {c.removals.length > 0 && (
                    <div className="text-xs text-red-700">
                      − Revoke: {c.removals.map((x) => `${x.module}:${x.action}`).join(", ")}
                    </div>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Users className="w-4 h-4 text-slate-500" /> Role Mapping</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="text-xs text-slate-500">Define which roles act as <span className="font-medium">Account Managers</span> (full accounting permissions + optional final approval) and <span className="font-medium">Account Admins</span> (operations + review).</div>
            <div>
              <Label className="mb-2 block">Roles</Label>
              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-2">
                {(settingsQuery.data?.roles ?? []).map((role) => (
                  <div key={role.id} className={cn("flex items-center justify-between gap-3 p-3 border rounded-md", role.suggestedAccountingRole && "bg-amber-50/40 border-amber-200")}>
                    <div>
                      <div className="text-sm font-medium text-slate-900 flex items-center gap-2">
                        {role.name}
                        {role.isSystemRole && <Badge variant="outline" className="text-[10px] px-1.5 py-0">System</Badge>}
                        {role.suggestedAccountingRole && <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-[10px] px-1.5 py-0 border-0">Suggested</Badge>}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {role.mappedKind === "account_manager" ? <span className="text-green-700 font-medium">Account Manager</span>
                          : role.mappedKind === "account_admin" ? <span className="text-blue-700 font-medium">Account Admin</span>
                          : <span className="text-slate-400">Not mapped</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant={form.accountManagerRoleIds.includes(role.id) ? "default" : "outline"}
                        className={cn("text-xs h-7", form.accountManagerRoleIds.includes(role.id) && "bg-green-600 hover:bg-green-700")}
                        disabled={!canManageSettings}
                        onClick={() => toggleRole("accountManagerRoleIds", role.id)}
                      >
                        {form.accountManagerRoleIds.includes(role.id) ? <CheckCircle2 className="w-3 h-3 mr-1" /> : null}Manager
                      </Button>
                      <Button
                        size="sm"
                        variant={form.accountAdminRoleIds.includes(role.id) ? "default" : "outline"}
                        className={cn("text-xs h-7", form.accountAdminRoleIds.includes(role.id) && "bg-blue-600 hover:bg-blue-700")}
                        disabled={!canManageSettings}
                        onClick={() => toggleRole("accountAdminRoleIds", role.id)}
                      >
                        {form.accountAdminRoleIds.includes(role.id) ? <CheckCircle2 className="w-3 h-3 mr-1" /> : null}Admin
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Calendar className="w-4 h-4 text-slate-500" /> Working Hours &amp; Holidays</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="mb-1 block text-xs">Timezone</Label>
                <select
                  className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  value={form.timezone}
                  disabled={!canManageSettings}
                  onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, timezone: e.target.value } : f); }}
                >
                  {commonTimezones.map((tz) => (<option key={tz} value={tz}>{tz}</option>))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="mb-1 block text-xs">Start</Label>
                  <Input
                    type="time"
                    value={form.workingHoursStart}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, workingHoursStart: e.target.value } : f); }}
                  />
                </div>
                <div>
                  <Label className="mb-1 block text-xs">End</Label>
                  <Input
                    type="time"
                    value={form.workingHoursEnd}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, workingHoursEnd: e.target.value } : f); }}
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
                <div>
                  <Label className="text-sm font-medium text-slate-800">Exclude Saturday</Label>
                  <div className="text-xs text-slate-500">Non-working day for SLA</div>
                </div>
                <Switch
                  checked={form.excludeSaturday}
                  onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, excludeSaturday: Boolean(v) } : f); }}
                  disabled={!canManageSettings}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
                <div>
                  <Label className="text-sm font-medium text-slate-800">Exclude Sunday</Label>
                  <div className="text-xs text-slate-500">Non-working day for SLA</div>
                </div>
                <Switch
                  checked={form.excludeSunday}
                  onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, excludeSunday: Boolean(v) } : f); }}
                  disabled={!canManageSettings}
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-sm font-medium">Firm Holidays ({form.firmHolidays.length})</Label>
                {canManageSettings && (
                  <Button size="sm" variant="outline" onClick={addHoliday}><Plus className="w-3 h-3 mr-1" />Add</Button>
                )}
              </div>
              <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                {form.firmHolidays.length === 0 && (
                  <div className="text-xs text-slate-400 text-center py-3 border border-dashed rounded-md">No holidays configured.</div>
                )}
                {form.firmHolidays.map((h, i) => (
                  <div key={i} className="grid grid-cols-[auto_1fr_auto] gap-2 items-center p-2 border border-slate-200 rounded-md">
                    <Input
                      type="date"
                      value={h.date}
                      disabled={!canManageSettings}
                      onChange={(e) => updateHoliday(i, "date", e.target.value)}
                      className="h-8 text-xs"
                    />
                    <Input
                      placeholder="Label (optional)"
                      value={h.label}
                      disabled={!canManageSettings}
                      onChange={(e) => updateHoliday(i, "label", e.target.value)}
                      className="h-8 text-xs"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-slate-400 hover:text-red-500"
                      disabled={!canManageSettings}
                      onClick={() => removeHoliday(i)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="w-4 h-4 text-slate-500" /> Approval Rules</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {[
              ["requirePartnerApprovalByDefault", "Require Partner approval by default", "Most vouchers require Partner sign-off unless exempted by type/threshold."] as const,
              ["managerCanFinalApprove", "Manager can final-approve", "Allow Manager-role template to approve vouchers without Partner sign-off."] as const,
              ["adminCanFinalApprove", "Account Admin can final-approve", "Allow Account-Admin template to approve payments."] as const,
              ["requireDoubleApproval", "Require double approval (review + approve)", "Manager reviews then Partner approves; cannot be done by same user."] as const,
            ].map(([key, title, desc]) => (
              <div key={key} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 p-3">
                <div>
                  <Label className="text-sm font-medium text-slate-800">{title}</Label>
                  <div className="text-xs text-slate-500 mt-0.5">{desc}</div>
                </div>
                <Switch
                  checked={Boolean(form.approvalRules[key])}
                  onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, approvalRules: { ...f.approvalRules, [key]: Boolean(v) } } : f); }}
                  disabled={!canManageSettings}
                />
              </div>
            ))}
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <div>
                <Label className="text-sm font-medium text-slate-800">Payment Proof Required</Label>
                <div className="text-xs text-slate-500">Require a document upload when marking vouchers as paid.</div>
              </div>
              <Switch
                checked={form.paymentProofRequired}
                onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentProofRequired: Boolean(v) } : f); }}
                disabled={!canManageSettings}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Clock className="w-4 h-4 text-slate-500" /> Service Level Agreements</CardTitle></CardHeader>
          <CardContent className="space-y-6">
            <div>
              <div className="text-sm font-medium text-slate-800 mb-2">Payment Voucher SLA</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs mb-1 block">Default SLA (hours)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={String(form.paymentVoucherSla.defaultHours)}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentVoucherSla: { ...f.paymentVoucherSla, defaultHours: Number(e.target.value) || 0 } } : f); }}
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Urgent SLA (hours)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={String(form.paymentVoucherSla.urgentHours)}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentVoucherSla: { ...f.paymentVoucherSla, urgentHours: Number(e.target.value) || 0 } } : f); }}
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Due-soon Warn (min)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={String(form.paymentVoucherSla.dueSoonMinutes)}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentVoucherSla: { ...f.paymentVoucherSla, dueSoonMinutes: Number(e.target.value) || 0 } } : f); }}
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Escalation Grace (hours)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={String(form.paymentVoucherSla.escalationGraceHours)}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentVoucherSla: { ...f.paymentVoucherSla, escalationGraceHours: Number(e.target.value) || 0 } } : f); }}
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Escalation Repeat (hours)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={String(form.paymentVoucherSla.escalationRepeatHours)}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentVoucherSla: { ...f.paymentVoucherSla, escalationRepeatHours: Number(e.target.value) || 0 } } : f); }}
                  />
                </div>
                <div className="col-span-2 grid grid-cols-3 gap-2">
                  <div className="flex items-center gap-2 p-2 rounded-md border border-slate-200">
                    <Switch
                      checked={form.paymentVoucherSla.notifyAssignedAccountUser}
                      onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentVoucherSla: { ...f.paymentVoucherSla, notifyAssignedAccountUser: Boolean(v) } } : f); }}
                      disabled={!canManageSettings}
                    />
                    <Label className="text-xs">Assigned User</Label>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md border border-slate-200">
                    <Switch
                      checked={form.paymentVoucherSla.notifyAccountManager}
                      onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentVoucherSla: { ...f.paymentVoucherSla, notifyAccountManager: Boolean(v) } } : f); }}
                      disabled={!canManageSettings}
                    />
                    <Label className="text-xs">Manager</Label>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md border border-slate-200">
                    <Switch
                      checked={form.paymentVoucherSla.notifyPartnerOnOverdue}
                      onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, paymentVoucherSla: { ...f.paymentVoucherSla, notifyPartnerOnOverdue: Boolean(v) } } : f); }}
                      disabled={!canManageSettings}
                    />
                    <Label className="text-xs">Partner Overdue</Label>
                  </div>
                </div>
              </div>
            </div>
            <div className="pt-3 border-t border-slate-200">
              <div className="text-sm font-medium text-slate-800 mb-2">Clerk Action SLA</div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs mb-1 block">Acknowledge (hours)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={String(form.clerkActionSla.acknowledgeHours)}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, clerkActionSla: { ...f.clerkActionSla, acknowledgeHours: Number(e.target.value) || 0 } } : f); }}
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Completion (hours)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={String(form.clerkActionSla.completionHours)}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, clerkActionSla: { ...f.clerkActionSla, completionHours: Number(e.target.value) || 0 } } : f); }}
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Due-soon Warn (min)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={String(form.clerkActionSla.dueSoonMinutes)}
                    disabled={!canManageSettings}
                    onChange={(e) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, clerkActionSla: { ...f.clerkActionSla, dueSoonMinutes: Number(e.target.value) || 0 } } : f); }}
                  />
                </div>
                <div className="col-span-3 grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-2 p-2 rounded-md border border-slate-200">
                    <Switch
                      checked={form.clerkActionSla.notifyCaseOwner}
                      onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, clerkActionSla: { ...f.clerkActionSla, notifyCaseOwner: Boolean(v) } } : f); }}
                      disabled={!canManageSettings}
                    />
                    <Label className="text-xs">Notify Case Owner</Label>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded-md border border-slate-200">
                    <Switch
                      checked={form.clerkActionSla.notifyPartnerOnOverdue}
                      onCheckedChange={(v) => { setDirty(true); setPreview(null); setForm((f) => f ? { ...f, clerkActionSla: { ...f.clerkActionSla, notifyPartnerOnOverdue: Boolean(v) } } : f); }}
                      disabled={!canManageSettings}
                    />
                    <Label className="text-xs">Escalate Partner on Overdue</Label>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────

export default function Accounting() {
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const isLegacyFileCustodyTab = tabFromUrl === "file-custody";
  const initialTab = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : "Overview";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (isLegacyFileCustodyTab) {
      setActiveTab("Overview");
    } else if (tabFromUrl && TAB_KEYS[tabFromUrl]) {
      setActiveTab(TAB_KEYS[tabFromUrl]);
    }
  }, [tabFromUrl, isLegacyFileCustodyTab]);

  useEffect(() => {
    if (tabFromUrl === "file-listing") setLocation("/app/accounting/file-listing");
  }, [setLocation, tabFromUrl]);

  const TAB_ICONS: Record<Tab, React.ReactNode> = {
    "Overview": <DollarSign className="w-4 h-4" />,
    "Monitor": <AlertTriangle className="w-4 h-4" />,
    "File Listing": <ListOrdered className="w-4 h-4" />,
    "Invoices": <FileText className="w-4 h-4" />,
    "Receipts": <Receipt className="w-4 h-4" />,
    "Payment Vouchers": <CreditCard className="w-4 h-4" />,
    "Quotations": <FileText className="w-4 h-4" />,
    "Bank Accounts": <Landmark className="w-4 h-4" />,
    "Bank Reconciliation": <RotateCcw className="w-4 h-4" />,
    "Ledger": <BookOpen className="w-4 h-4" />,
    "Settings": <SettingsIcon className="w-4 h-4" />,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Accounting</h1>
        <p className="text-slate-500 mt-1">Invoices, receipts, payment vouchers, ledger and case files</p>
      </div>

      <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => {
              if (tab === "File Listing") {
                setLocation("/app/accounting/file-listing");
                return;
              }
              setActiveTab(tab);
            }}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
              activeTab === tab
                ? "border-amber-500 text-amber-600"
                : "border-transparent text-slate-500 hover:text-slate-700"
            )}
          >
            {TAB_ICONS[tab]}
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Overview" && <OverviewTab />}
      {activeTab === "Monitor" && <MonitorTab />}
      {activeTab === "File Listing" && <FileListingTab />}
      {activeTab === "Invoices" && <InvoicesTab />}
      {activeTab === "Receipts" && <ReceiptsTab />}
      {activeTab === "Payment Vouchers" && <PaymentVouchersTab />}
      {activeTab === "Quotations" && <QuotationsTab />}
      {activeTab === "Bank Accounts" && <BankAccountsTab />}
      {activeTab === "Bank Reconciliation" && <BankReconciliationPage />}
      {activeTab === "Ledger" && <LedgerTab />}
      {activeTab === "Settings" && <SettingsTab />}
    </div>
  );
}
