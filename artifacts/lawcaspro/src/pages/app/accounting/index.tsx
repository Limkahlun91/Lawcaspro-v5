import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation, useSearch } from "wouter";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  DollarSign, TrendingUp, Clock, Briefcase, Plus, Search, FileText,
  Receipt, CreditCard, BookOpen, ChevronRight, RotateCcw, ArrowUpDown, ListOrdered, Landmark, Printer, Minus
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { DateOnlyInput } from "@/components/date-only-input";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { hasPermission } from "@/lib/permissions";
import { useListQuotations } from "@workspace/api-client-react";
import { QueryFallback } from "@/components/query-fallback";
import { useReAuth } from "@/components/re-auth-dialog";
import { useAuth } from "@/lib/auth-context";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { CreatePaymentVoucherBody, PaymentVoucherTransitionBody, type PaymentVoucherFundStatus } from "@workspace/api-zod";
import BankAccountsTab from "./bank-accounts";
import BankReconciliationPage from "./bank-reconciliation";

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

const TABS = ["Overview", "File Listing", "Payment Vouchers", "Quotations", "Invoices", "Receipts", "Bank Accounts", "Bank Reconciliation", "Ledger"] as const;
type Tab = typeof TABS[number];

const TAB_KEYS: Record<string, Tab> = {
  overview: "Overview",
  "file-listing": "File Listing",
  invoices: "Invoices",
  receipts: "Receipts",
  "payment-vouchers": "Payment Vouchers",
  quotations: "Quotations",
  "bank-accounts": "Bank Accounts",
  "bank-reconciliation": "Bank Reconciliation",
  ledger: "Ledger",
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
  const { data } = useQuery({ queryKey: ["ledger-summary"], queryFn: () => apiFetchJson("/ledger/summary"), retry: false });
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
  });
  const { data: invData } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetchJson<InvoiceRow[]>("/invoices"),
    retry: false,
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
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedQuotationId, setSelectedQuotationId] = useState("");
  const { user } = useAuth();
  const roleName = String((user as any)?.roleName ?? "").trim().toLowerCase();
  const canCreateInvoices = roleName.includes("partner") || roleName === "account" || roleName === "accounts" || roleName === "accountant" || roleName === "finance";

  const invoicesQuery = useQuery({ queryKey: ["invoices"], queryFn: () => apiFetchJson("/invoices"), retry: false });
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
                <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
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
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    invoiceId: "", paymentMethod: "bank_transfer", accountType: "client",
    amount: "", receivedDate: new Date().toISOString().slice(0, 10), referenceNo: "", notes: "",
  });

  const receiptsQuery = useQuery({ queryKey: ["receipts"], queryFn: () => apiFetchJson("/receipts"), retry: false });
  const { data, isLoading } = receiptsQuery;
  const receipts = (data ?? []) as any[];
  const invoicesQuery = useQuery({ queryKey: ["invoices"], queryFn: () => apiFetchJson("/invoices"), retry: false });
  const openInvoices = (((invoicesQuery.data ?? []) as any[]).filter((i: any) => i.status !== "void" && i.status !== "paid"));

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

function PaymentVouchersTab() {
  const searchString = useSearch();
  const printVoucherIdParam = useMemo(() => new URLSearchParams(searchString).get("printVoucherId"), [searchString]);
  const didAutoPrintRef = useRef(false);
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { wrapWithReAuth } = useReAuth();
  const { user } = useAuth();
  const firmName = user?.firmName ?? "";
  const roleName = user?.userType === "firm_user" ? (user.roleName ?? "") : "";
  const roleKind =
    roleName === "Partner" || roleName === "Founder"
      ? "partner"
      : (roleName === "Manager" || roleName === "Senior Lawyer" || roleName === "Lawyer")
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

  const [simpleForm, setSimpleForm] = useState({
    voucherType: "external_payment" as const,
    payeeName: "",
    beneficiaryBank: "",
    beneficiaryAccountNo: "",
    isAdvance: false,
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
  const [caseQueryText, setCaseQueryText] = useState("");
  const [casePickerOpen, setCasePickerOpen] = useState(false);
  const [selectedCases, setSelectedCases] = useState<Array<{ case_id: number; title: string }>>([]);
  const [targetCaseQueryText, setTargetCaseQueryText] = useState("");
  const [targetCasePickerOpen, setTargetCasePickerOpen] = useState(false);
  const [targetCase, setTargetCase] = useState<{ case_id: number; title: string } | null>(null);

  const caseSearchQuery = useQuery({
    queryKey: ["accounting", "cases-search", "multi", caseQueryText],
    queryFn: ({ signal }) =>
      apiFetchJson(`/accounting/cases/search?query=${encodeURIComponent(caseQueryText)}`, { signal }) as Promise<{ data?: any[] }>,
    retry: false,
    enabled: caseQueryText.trim().length >= 2 && casePickerOpen,
  });
  const caseResults = Array.isArray(caseSearchQuery.data?.data) ? (caseSearchQuery.data?.data ?? []) : [];

  const targetCaseSearchQuery = useQuery({
    queryKey: ["accounting", "cases-search", "target", targetCaseQueryText],
    queryFn: ({ signal }) =>
      apiFetchJson(`/accounting/cases/search?query=${encodeURIComponent(targetCaseQueryText)}`, { signal }) as Promise<{ data?: any[] }>,
    retry: false,
    enabled: targetCaseQueryText.trim().length >= 2 && targetCasePickerOpen,
  });
  const targetCaseResults = Array.isArray(targetCaseSearchQuery.data?.data) ? (targetCaseSearchQuery.data?.data ?? []) : [];

  const vouchersQuery = useQuery({ queryKey: ["payment-vouchers"], queryFn: () => apiFetchJson("/payment-vouchers"), retry: false });
  const dashboardQuery = useQuery({
    queryKey: ["payment-vouchers", "dashboard"],
    queryFn: () => apiFetchJson("/payment-vouchers/dashboard"),
    retry: false,
    enabled: canAccountingRead,
  });
  const { data, isLoading } = vouchersQuery;
  const vouchers = (data ?? []) as any[];
  const dashboard = (dashboardQuery.data ?? {}) as Record<string, number>;
  const markPaidVoucher = markPaidVoucherId ? (vouchers.find((v: any) => Number(v.id) === Number(markPaidVoucherId)) ?? null) : null;

  const createBatchMut = useMutation({
    mutationFn: async () => {
      if (selectedCases.length === 0) throw new Error("Please select at least one case");
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
      };

      const casesToCreate = voucherType === "file_to_file_transfer" ? (sourceCase ? [sourceCase] : []) : selectedCases;
      const calls = casesToCreate.map((c) => {
        const payload = voucherType === "file_to_file_transfer"
          ? { ...bodyBase, caseId: c.case_id, targetCaseId: target?.case_id ?? null }
          : { ...bodyBase, caseId: c.case_id };
        const parsed = CreatePaymentVoucherBody.safeParse(payload);
        if (!parsed.success) throw new Error(parsed.error.message);
        return apiFetchJson("/payment-vouchers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
        });
      });
      return await Promise.all(calls);
    },
    onSuccess: async (rows: any[]) => {
      await qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      setShowCreate(false);
      setSimpleForm({ voucherType: "external_payment", payeeName: "", beneficiaryBank: "", beneficiaryAccountNo: "", isAdvance: false });
      setLineItems([{ id: newLineItemId(), purpose: "", amount: "" }]);
      setCaseQueryText("");
      setSelectedCases([]);
      setTargetCaseQueryText("");
      setTargetCase(null);
      toast({ title: "Payment Vouchers created", description: `${rows.length} voucher(s) created` });
    },
    onError: (e) => toastError(toast, e, "Create failed"),
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
                  <Input
                    placeholder="Search case ref / client name…"
                    value={caseQueryText}
                    onFocus={() => setCasePickerOpen(true)}
                    onBlur={() => setTimeout(() => setCasePickerOpen(false), 120)}
                    onChange={(e) => setCaseQueryText(e.target.value)}
                  />
                  {selectedCases.length > 0 ? (
                    <div className="flex flex-wrap gap-2 pt-2">
                      {selectedCases.map((c) => (
                        <button
                          key={c.case_id}
                          type="button"
                          className="px-2 py-1 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50"
                          onClick={() => setSelectedCases((xs) => xs.filter((x) => x.case_id !== c.case_id))}
                          title="Remove"
                        >
                          {c.title} ×
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {casePickerOpen && caseQueryText.trim().length >= 2 && caseResults.length > 0 ? (
                    <div className="border border-slate-200 rounded-md bg-white shadow-sm overflow-hidden mt-2">
                      {caseResults.map((c: any) => {
                        const id = Number(c.case_id);
                        const title = String(c.title ?? "");
                        const already = selectedCases.some((x) => x.case_id === id);
                        return (
                          <button
                            key={String(c.case_id)}
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center justify-between gap-3"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              if (!Number.isFinite(id) || id <= 0) return;
                              if (already) return;
                              setSelectedCases((xs) => simpleForm.voucherType === "file_to_file_transfer" ? [{ case_id: id, title }] : [...xs, { case_id: id, title }]);
                              setCaseQueryText("");
                            }}
                          >
                            <span className="truncate">{title}</span>
                            {already ? <span className="text-xs text-slate-400">Selected</span> : <span className="text-xs text-amber-600">Add</span>}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
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
                        <div className="relative">
                          <Input
                            placeholder="Search target case..."
                            value={targetCase ? targetCase.title : targetCaseQueryText}
                            onChange={(e) => {
                              setTargetCase(null);
                              setTargetCaseQueryText(e.target.value);
                              setTargetCasePickerOpen(true);
                            }}
                            onFocus={() => setTargetCasePickerOpen(true)}
                          />
                          {targetCasePickerOpen && targetCaseQueryText.trim().length >= 2 ? (
                            <div className="absolute z-30 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-sm max-h-56 overflow-auto">
                              {targetCaseResults.map((c: any) => {
                                const id = Number(c.case_id);
                                const title = String(c.title ?? "");
                                return (
                                  <button
                                    key={String(id)}
                                    type="button"
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      if (!Number.isFinite(id) || id <= 0) return;
                                      setTargetCase({ case_id: id, title });
                                      setTargetCaseQueryText("");
                                      setTargetCasePickerOpen(false);
                                    }}
                                  >
                                    {title}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
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

              <div className="flex gap-2">
                <Button
                  onClick={() => createBatchMut.mutate()}
                  disabled={createBatchMut.isPending}
                  className="bg-amber-500 hover:bg-amber-600 text-white"
                >
                  {createBatchMut.isPending ? "Creating…" : "Submit"}
                </Button>
                <Button variant="outline" onClick={() => setShowCreate(false)} disabled={createBatchMut.isPending}>Cancel</Button>
              </div>
            </>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {[
          { key: "awaitingReceipt", label: "Awaiting Accounts Receipt" },
          { key: "receivedAndProcessing", label: "Received And Processing" },
          { key: "waitingApproval", label: "Waiting For Approval" },
          { key: "dueSoon", label: "Due Soon" },
          { key: "overdue", label: "Overdue Payments" },
          { key: "paidToday", label: "Paid Today" },
          { key: "clerkPending", label: "Clerk Action Pending" },
          { key: "clerkOverdue", label: "Clerk Action Overdue" },
          { key: "completedMonth", label: "Completed This Month" },
        ].map((card) => (
          <Card key={card.key} className="border-slate-200">
            <CardContent className="pt-5">
              <div className="text-xs text-slate-500">{card.label}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{Number(dashboard[card.key] ?? 0)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {vouchersQuery.isError ? (
        <QueryFallback title="Payment vouchers unavailable" error={vouchersQuery.error} onRetry={() => vouchersQuery.refetch()} isRetrying={vouchersQuery.isFetching} />
      ) : isLoading ? (
        <div className="text-center py-12 text-slate-400">Loading…</div>
      ) : vouchers.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No payment vouchers yet</p>
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
              {vouchers.map((pv: any) => {
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
  });
  const sumQuery = useQuery({ queryKey: ["ledger-summary"], queryFn: () => apiFetchJson("/ledger/summary"), retry: false });
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

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────

export default function Accounting() {
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const initialTab = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : "Overview";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (tabFromUrl && TAB_KEYS[tabFromUrl]) setActiveTab(TAB_KEYS[tabFromUrl]);
  }, [tabFromUrl]);

  useEffect(() => {
    if (tabFromUrl === "file-listing") setLocation("/app/accounting/file-listing");
  }, [setLocation, tabFromUrl]);

  const TAB_ICONS: Record<Tab, React.ReactNode> = {
    "Overview": <DollarSign className="w-4 h-4" />,
    "File Listing": <ListOrdered className="w-4 h-4" />,
    "Invoices": <FileText className="w-4 h-4" />,
    "Receipts": <Receipt className="w-4 h-4" />,
    "Payment Vouchers": <CreditCard className="w-4 h-4" />,
    "Quotations": <FileText className="w-4 h-4" />,
    "Bank Accounts": <Landmark className="w-4 h-4" />,
    "Bank Reconciliation": <RotateCcw className="w-4 h-4" />,
    "Ledger": <BookOpen className="w-4 h-4" />,
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
      {activeTab === "File Listing" && <FileListingTab />}
      {activeTab === "Invoices" && <InvoicesTab />}
      {activeTab === "Receipts" && <ReceiptsTab />}
      {activeTab === "Payment Vouchers" && <PaymentVouchersTab />}
      {activeTab === "Quotations" && <QuotationsTab />}
      {activeTab === "Bank Accounts" && <BankAccountsTab />}
      {activeTab === "Bank Reconciliation" && <BankReconciliationPage />}
      {activeTab === "Ledger" && <LedgerTab />}
    </div>
  );
}
