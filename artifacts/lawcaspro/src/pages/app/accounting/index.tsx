import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocation, useSearch } from "wouter";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  DollarSign, TrendingUp, Clock, Briefcase, Plus, Search, FileText,
  Receipt, CreditCard, BookOpen, ChevronRight, RotateCcw, ArrowUpDown, ListOrdered
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { useListQuotations } from "@workspace/api-client-react";
import { QueryFallback } from "@/components/query-fallback";
import { useReAuth } from "@/components/re-auth-dialog";

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

const TABS = ["Overview", "File Listing", "Invoices", "Receipts", "Payment Vouchers", "Ledger"] as const;
type Tab = typeof TABS[number];

const TAB_KEYS: Record<string, Tab> = {
  overview: "Overview",
  "file-listing": "File Listing",
  invoices: "Invoices",
  receipts: "Receipts",
  "payment-vouchers": "Payment Vouchers",
  ledger: "Ledger",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  issued: "bg-blue-100 text-blue-700",
  partially_paid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700",
  void: "bg-red-100 text-red-600",
  overdue: "bg-red-100 text-red-700",
  prepared: "bg-blue-100 text-blue-700",
  lawyer_approved: "bg-indigo-100 text-indigo-700",
  partner_approved: "bg-violet-100 text-violet-700",
  submitted: "bg-amber-100 text-amber-700",
  returned: "bg-orange-100 text-orange-700",
  locked: "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  return (
    <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium", STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600")}>
      {label}
    </span>
  );
}

// ── OVERVIEW TAB ─────────────────────────────────────────────────────────────

function LedgerSummaryInline() {
  const { data } = useQuery({ queryKey: ["ledger-summary"], queryFn: () => apiFetchJson("/ledger/summary"), retry: false });
  const rows = (data ?? []) as any[];
  if (!rows.length) return <div className="text-slate-400 text-sm py-4 text-center">No ledger entries yet</div>;
  return (
    <div className="space-y-3">
      {rows.map((r: any) => (
        <div key={r.accountType} className="flex justify-between items-center py-2 border-b last:border-0">
          <div>
            <div className="text-sm font-medium text-slate-900 capitalize">{r.accountType} Account</div>
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
  const { data: invData } = useQuery({
    queryKey: ["invoices"],
    queryFn: () => apiFetchJson<InvoiceRow[]>("/invoices"),
    retry: false,
  });
  const invoices = invData ?? [];
  const invTotals = invoices.reduce((acc, inv) => ({
    total: acc.total + Number(inv.grandTotal),
    paid: acc.paid + Number(inv.amountPaid),
    due: acc.due + Number(inv.amountDue),
  }), { total: 0, paid: 0, due: 0 });

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
          { label: "Open Invoices", value: String(invoices.filter(i => i.status !== "void" && i.status !== "paid").length), icon: Briefcase, color: "bg-slate-100 text-slate-600" },
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

  const invoicesQuery = useQuery({ queryKey: ["invoices"], queryFn: () => apiFetchJson("/invoices"), retry: false });
  const { data, isLoading } = invoicesQuery;
  const invoices = (data ?? []) as any[];
  const { data: quotations = [] } = useListQuotations();

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
        <Button onClick={() => setShowCreate(true)} className="bg-amber-500 hover:bg-amber-600 text-white gap-2">
          <Plus className="w-4 h-4" /> New Invoice
        </Button>
      </div>

      {showCreate && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader><CardTitle className="text-base">Create Invoice from Quotation</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">Select Quotation</label>
              <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                value={selectedQuotationId} onChange={(e) => setSelectedQuotationId(e.target.value)}>
                <option value="">— Select a quotation —</option>
                {quotations.map((q: any) => (
                  <option key={q.id} value={q.id}>
                    {q.referenceNo} — {q.clientName} (RM {Number(q.totalInclTax ?? 0).toLocaleString("en-MY")})
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
                      {inv.status === "draft" && (
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
                  <option value="trust">Trust Account</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Amount (RM)</label>
                <Input type="number" step="0.01" placeholder="0.00" value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Received Date</label>
                <Input type="date" value={form.receivedDate} onChange={(e) => setForm((f) => ({ ...f, receivedDate: e.target.value }))} />
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
                    <span className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600 capitalize">{r.accountType}</span>
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

// ── PAYMENT VOUCHERS TAB ──────────────────────────────────────────────────────

const PV_ACTIONS: Record<string, { label: string; toStatus: string }[]> = {
  draft: [{ label: "Submit for Approval", toStatus: "prepared" }],
  prepared: [{ label: "Lawyer Approve", toStatus: "lawyer_approved" }, { label: "Return to Draft", toStatus: "draft" }],
  lawyer_approved: [{ label: "Partner Approve", toStatus: "partner_approved" }, { label: "Return", toStatus: "prepared" }],
  partner_approved: [{ label: "Submit to Finance", toStatus: "submitted" }, { label: "Return", toStatus: "lawyer_approved" }],
  submitted: [{ label: "Mark Paid", toStatus: "paid" }, { label: "Return", toStatus: "returned" }],
  returned: [{ label: "Resubmit", toStatus: "prepared" }],
  paid: [],
  locked: [],
};

function PaymentVouchersTab() {
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { wrapWithReAuth } = useReAuth();
  const [form, setForm] = useState({
    payeeName: "", payeeBank: "", payeeAccountNo: "",
    paymentMethod: "bank_transfer", accountType: "office",
    amount: "", purpose: "", notes: "",
    items: [{ description: "", itemType: "disbursement", amount: "" }],
  });

  const vouchersQuery = useQuery({ queryKey: ["payment-vouchers"], queryFn: () => apiFetchJson("/payment-vouchers"), retry: false });
  const { data, isLoading } = vouchersQuery;
  const vouchers = (data ?? []) as any[];

  const createMut = useMutation({
    mutationFn: () => apiFetchJson("/payment-vouchers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        amount: parseFloat(form.amount),
        items: form.items.filter((i) => i.description && i.amount).map((i) => ({ ...i, amount: parseFloat(i.amount) })),
      }),
    }),
    onSuccess: (pv: any) => {
      qc.invalidateQueries({ queryKey: ["payment-vouchers"] });
      setShowCreate(false);
      setForm({ payeeName: "", payeeBank: "", payeeAccountNo: "", paymentMethod: "bank_transfer", accountType: "office", amount: "", purpose: "", notes: "", items: [{ description: "", itemType: "disbursement", amount: "" }] });
      toast({ title: "Payment Voucher created", description: `${pv.voucherNo} created as draft` });
    },
    onError: (e) => toastError(toast, e, "Create failed"),
  });

  const transitionMut = useMutation({
    mutationFn: ({ id, toStatus }: { id: number; toStatus: string }) =>
      wrapWithReAuth(
        (headers) => apiFetchJson(`/payment-vouchers/${id}/transition`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ toStatus }),
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

  const updateItem = (idx: number, field: string, val: string) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => i === idx ? { ...it, [field]: val } : it) }));

  const totalFromItems = form.items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);

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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Payee Name</label>
                <Input placeholder="Recipient name" value={form.payeeName}
                  onChange={(e) => setForm((f) => ({ ...f, payeeName: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Payee Bank</label>
                <Input placeholder="e.g. Maybank" value={form.payeeBank}
                  onChange={(e) => setForm((f) => ({ ...f, payeeBank: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Account Number</label>
                <Input placeholder="Bank account number" value={form.payeeAccountNo}
                  onChange={(e) => setForm((f) => ({ ...f, payeeAccountNo: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Payment Method</label>
                <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))}>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="cheque">Cheque</option>
                  <option value="cash">Cash</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Deduct From Account</label>
                <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  value={form.accountType} onChange={(e) => setForm((f) => ({ ...f, accountType: e.target.value }))}>
                  <option value="office">Office Account</option>
                  <option value="client">Client Account</option>
                  <option value="trust">Trust Account</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 block mb-1">Total Amount (RM)</label>
                <Input type="number" step="0.01" placeholder="0.00" value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
                {totalFromItems > 0 && Math.abs(totalFromItems - parseFloat(form.amount || "0")) > 0.01 && (
                  <p className="text-xs text-amber-600 mt-1">Items total: {fmt(totalFromItems)}</p>
                )}
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-medium text-slate-700 block mb-1">Purpose</label>
                <Input placeholder="Brief purpose of payment" value={form.purpose}
                  onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-slate-700">Line Items</label>
                <Button type="button" variant="ghost" size="sm" className="text-xs h-7"
                  onClick={() => setForm((f) => ({ ...f, items: [...f.items, { description: "", itemType: "disbursement", amount: "" }] }))}>
                  + Add Item
                </Button>
              </div>
              <div className="space-y-2">
                {form.items.map((item, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2">
                    <div className="col-span-6">
                      <Input placeholder="Description" value={item.description}
                        onChange={(e) => updateItem(idx, "description", e.target.value)} />
                    </div>
                    <div className="col-span-3">
                      <select className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                        value={item.itemType} onChange={(e) => updateItem(idx, "itemType", e.target.value)}>
                        <option value="disbursement">Disbursement</option>
                        <option value="professional_fee">Prof. Fee</option>
                        <option value="trust_amount">Trust</option>
                      </select>
                    </div>
                    <div className="col-span-3">
                      <Input type="number" step="0.01" placeholder="Amount" value={item.amount}
                        onChange={(e) => updateItem(idx, "amount", e.target.value)} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => createMut.mutate()}
                disabled={!form.payeeName || !form.amount || !form.purpose || createMut.isPending}
                className="bg-amber-500 hover:bg-amber-600 text-white">
                {createMut.isPending ? "Creating…" : "Create Voucher"}
              </Button>
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

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
                <th className="px-4 py-3 text-left font-medium">Payee</th>
                <th className="px-4 py-3 text-left font-medium">Purpose</th>
                <th className="px-4 py-3 text-left font-medium">Account</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {vouchers.map((pv: any) => {
                const actions = PV_ACTIONS[pv.status] ?? [];
                return (
                  <tr key={pv.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-slate-900">{pv.voucherNo}</td>
                    <td className="px-4 py-3 text-slate-700">{pv.payeeName}</td>
                    <td className="px-4 py-3 text-slate-500 max-w-xs truncate">{pv.purpose}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600 capitalize">{pv.accountType}</span>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={pv.status} /></td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-800">{fmt(pv.amount)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        {actions.map((a) => (
                          <Button key={a.toStatus} size="sm" variant="outline" className="text-xs h-7"
                            onClick={() => transitionMut.mutate({ id: pv.id, toStatus: a.toStatus })}
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
    </div>
  );
}

// ── LEDGER TAB ────────────────────────────────────────────────────────────────

function LedgerTab() {
  const [accountType, setAccountType] = useState("");
  const ledgerQuery = useQuery({
    queryKey: ["ledger", accountType],
    queryFn: () => apiFetchJson(`/ledger${accountType ? `?accountType=${accountType}` : ""}`),
    retry: false,
  });
  const sumQuery = useQuery({ queryKey: ["ledger-summary"], queryFn: () => apiFetchJson("/ledger/summary"), retry: false });
  const entries = ((ledgerQuery.data ?? []) as any[]);
  const summary = ((sumQuery.data ?? []) as any[]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        {["client", "office", "trust"].map((acct) => {
          const s = summary.find((r: any) => r.accountType === acct) ?? { totalDebit: 0, totalCredit: 0, balance: 0 };
          return (
            <Card key={acct}
              className={cn("cursor-pointer transition-all hover:shadow-md", accountType === acct && "ring-2 ring-amber-400")}
              onClick={() => setAccountType(accountType === acct ? "" : acct)}>
              <CardContent className="pt-4 pb-4">
                <div className="text-xs text-slate-500 capitalize mb-1">{acct} Account</div>
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
          Showing <span className="font-medium capitalize">{accountType}</span> account
          <button className="text-amber-600 underline ml-1" onClick={() => setAccountType("")}>clear filter</button>
        </div>
      )}

      {ledgerQuery.isLoading || sumQuery.isLoading ? (
        <div className="text-center py-12 text-slate-400">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No ledger entries yet — record receipts or mark payment vouchers as paid</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Account</th>
                <th className="px-4 py-3 text-left font-medium">Description</th>
                <th className="px-4 py-3 text-right font-medium text-green-600">Credit (In)</th>
                <th className="px-4 py-3 text-right font-medium text-red-500">Debit (Out)</th>
                <th className="px-4 py-3 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((e: any) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-500 text-xs font-mono">{e.entryDate}</td>
                  <td className="px-4 py-2.5 capitalize text-slate-600 text-xs">{e.entryType?.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2.5">
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-xs capitalize">{e.accountType}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-700 max-w-xs truncate text-xs">{e.description}</td>
                  <td className="px-4 py-2.5 text-right text-green-600 font-mono text-xs">
                    {Number(e.credit) > 0 ? fmt(e.credit) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-red-500 font-mono text-xs">
                    {Number(e.debit) > 0 ? fmt(e.debit) : "—"}
                  </td>
                  <td className={cn("px-4 py-2.5 text-right font-semibold font-mono text-xs",
                    Number(e.balanceAfter) >= 0 ? "text-slate-800" : "text-red-500")}>
                    {fmt(e.balanceAfter)}
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
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const initialTab = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : "Overview";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (tabFromUrl && TAB_KEYS[tabFromUrl]) setActiveTab(TAB_KEYS[tabFromUrl]);
  }, [tabFromUrl]);

  const TAB_ICONS: Record<Tab, React.ReactNode> = {
    "Overview": <DollarSign className="w-4 h-4" />,
    "File Listing": <ListOrdered className="w-4 h-4" />,
    "Invoices": <FileText className="w-4 h-4" />,
    "Receipts": <Receipt className="w-4 h-4" />,
    "Payment Vouchers": <CreditCard className="w-4 h-4" />,
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
            onClick={() => setActiveTab(tab)}
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
      {activeTab === "Ledger" && <LedgerTab />}
    </div>
  );
}
