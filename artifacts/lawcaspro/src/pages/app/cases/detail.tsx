import { Link, useParams, useLocation, useSearch } from "wouter";
import { 
  useGetCase, getGetCaseQueryKey, 
  useGetCaseWorkflow, getGetCaseWorkflowQueryKey, 
  useUpdateWorkflowStep, 
  useListUsers
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle2, Clock, User, Building2, MapPin, Tag, Receipt, Printer, Upload, Download, Trash2, Plus, Minus, X, MoreHorizontal, Share2, AlertTriangle, Loader2, Activity, FolderKey, ChevronRight } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CaseDocumentsTab from "./components/CaseDocumentsTab";
import CaseBillingTab from "./components/CaseBillingTab";
import CaseCommunicationsTab from "./components/CaseCommunicationsTab";
import CaseCommunicationTimelineTab from "./components/CaseCommunicationTimelineTab";
import CaseComplianceTab from "./components/CaseComplianceTab";
import { ErrorBoundary } from "@/components/common/error-boundary";
import { CaseFormModal, mapCaseToFormValues } from "./components/case-form/CaseFormModal";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiFetchBlob, apiFetchJson, apiRequest } from "@/lib/api-client";
import { DateOnlyInput, formatYmdToDmy, normalizeDateOnlyFromApi } from "@/components/date-only-input";
import { downloadBlob } from "@/lib/download";
import { getApiFailureCodeFromError } from "@/lib/api-failure";
import { getGenerationJobDownloadManifest, getGenerationJobStatus, runNextGenerationJob } from "@/lib/document-generation-client";
import { amountToEnglishWords, formatRMAmount, toMoneyNumber } from "@/lib/money";
import { calculateLoanAmounts } from "@/lib/loan-amounts";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { DEFAULT_ALLOWED_MIME_TYPES, validateUploadFile } from "@/lib/upload-validation";
import { WORKFLOW_ATTACHMENT_ACCEPT, WORKFLOW_ATTACHMENT_ITEMS, isAllowedWorkflowAttachmentFileName, type WorkflowAttachmentDocKey, type WorkflowAttachmentDateKey } from "./components/workflow-attachments";

import { getListCasesQueryKey } from "@workspace/api-client-react";

type WorkflowDocument = {
  id: number;
  caseId: number;
  milestoneKey: WorkflowAttachmentDocKey;
  label: string;
  dateValue: string | null;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type LoanStampingItemKey = "facility_agreement" | "deed_of_assignment" | "power_of_attorney" | "charge_annexure" | "other";

type LoanStampingItem = {
  id?: number;
  itemKey: LoanStampingItemKey;
  customName: string | null;
  datedOn: string | null;
  stampedOn: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  sortOrder: number;
};

type LoanStampingSaveItem = Pick<
  LoanStampingItem,
  "id" | "itemKey" | "customName" | "datedOn" | "stampedOn" | "sortOrder"
>;

type CaseLedgerEntry = {
  id: string;
  transactionDate: string;
  entryCategory: "office" | "client";
  entryType: "invoice_billed" | "payment_received" | "disbursement_paid" | "trust_received" | "trust_paid";
  description: string;
  amount: number;
  sourceType?: string | null;
  sourceId?: number | null;
  createdAt?: string | null;
};

type CaseLedgerResponse = {
  summary: {
    total_billed: number;
    total_received: number;
    outstanding_balance: number;
    trust_balance: number;
  };
  data: CaseLedgerEntry[];
};

function safeFileNamePart(name: string): string {
  const base = name.trim().replace(/\s+/g, "_");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
}

function fmtMoney(val: unknown) {
  return formatRMAmount(val);
}

function CaseLedgerTab({ caseId }: { caseId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [transactionDate, setTransactionDate] = useState<string | null>(null);
  const [entryCategory, setEntryCategory] = useState<"office" | "client">("office");
  const [entryType, setEntryType] = useState<CaseLedgerEntry["entryType"]>("invoice_billed");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [entrySearch, setEntrySearch] = useState("");
  const [entrySort, setEntrySort] = useState<{ key: "date" | "type" | "amount"; dir: "asc" | "desc" }>({ key: "date", dir: "desc" });

  const ledgerQuery = useQuery<CaseLedgerResponse>({
    queryKey: ["case-ledger", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/ledger`, { signal }),
    enabled: Number.isFinite(caseId) && caseId > 0,
    retry: false,
  });

  const entries = Array.isArray(ledgerQuery.data?.data) ? ledgerQuery.data!.data : [];
  const summary = ledgerQuery.data?.summary ?? { total_billed: 0, total_received: 0, outstanding_balance: 0, trust_balance: 0 };

  const displayEntries = useMemo(() => {
    const needle = entrySearch.trim().toLowerCase();
    const filtered = needle
      ? entries.filter((e) => {
          const desc = String(e.description ?? "").toLowerCase();
          const ref = typeof e.sourceId === "number" ? String(e.sourceId) : "";
          return desc.includes(needle) || ref.includes(needle) || String(e.entryType ?? "").toLowerCase().includes(needle);
        })
      : entries;
    const sorted = [...filtered].sort((a, b) => {
      if (entrySort.key === "date") return String(a.transactionDate ?? "").localeCompare(String(b.transactionDate ?? ""));
      if (entrySort.key === "type") return String(a.entryType ?? "").localeCompare(String(b.entryType ?? ""));
      const aa = Math.abs(Number(a.amount ?? 0));
      const ba = Math.abs(Number(b.amount ?? 0));
      if (aa !== ba) return aa - ba;
      return String(a.transactionDate ?? "").localeCompare(String(b.transactionDate ?? ""));
    });
    if (entrySort.dir === "desc") sorted.reverse();
    return sorted;
  }, [entries, entrySearch, entrySort]);

  const toggleEntrySort = (key: "date" | "type" | "amount") => {
    setEntrySort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const n = Number(String(amount).replace(/,/g, "").trim());
      if (!Number.isFinite(n)) throw new Error("INVALID_AMOUNT");
      if (!transactionDate) throw new Error("MISSING_DATE");
      return await apiFetchJson(`/cases/${caseId}/ledger`, {
        method: "POST",
        body: JSON.stringify({
          transactionDate,
          entryCategory,
          entryType,
          description: description.trim(),
          amount: n,
        }),
      });
    },
    onSuccess: async () => {
      toast({ title: "Added" });
      setOpen(false);
      setTransactionDate(null);
      setEntryCategory("office");
      setEntryType("invoice_billed");
      setDescription("");
      setAmount("");
      await qc.invalidateQueries({ queryKey: ["case-ledger", caseId] });
    },
    onError: (e) => toastError(toast, e, "Add failed"),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Case Ledger</h3>
          <p className="text-sm text-slate-500 mt-1">Track billed, payments, and client trust balance for this case.</p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={createMutation.isPending}>
          Add Transaction
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-slate-500">Total Billed</div>
            <div className="text-lg font-bold text-slate-900">{fmtMoney(summary.total_billed)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-slate-500">Amount Paid</div>
            <div className="text-lg font-bold text-slate-900">{fmtMoney(summary.total_received)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-slate-500">Outstanding</div>
            <div className="flex items-center gap-2">
              {summary.outstanding_balance > 0 ? <AlertTriangle className="w-4 h-4 text-red-500" /> : null}
              <div className={cn("text-lg font-bold", summary.outstanding_balance > 0 ? "text-red-600" : "text-slate-900")}>
                {fmtMoney(summary.outstanding_balance)}
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-slate-500">Client Trust Balance</div>
            <div className="text-lg font-bold text-slate-900">{fmtMoney(summary.trust_balance)}</div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Ledger Transaction</DialogTitle>
            <DialogDescription className="sr-only">Add a manual ledger entry.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <DateOnlyInput value={transactionDate} onChange={setTransactionDate} />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={entryCategory} onValueChange={(v) => setEntryCategory(v as any)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="office">office</SelectItem>
                  <SelectItem value="client">client</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>Type</Label>
              <Select value={entryType} onValueChange={(v) => setEntryType(v as any)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="invoice_billed">invoice_billed</SelectItem>
                  <SelectItem value="payment_received">payment_received</SelectItem>
                  <SelectItem value="disbursement_paid">disbursement_paid</SelectItem>
                  <SelectItem value="trust_received">trust_received</SelectItem>
                  <SelectItem value="trust_paid">trust_paid</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[90px]" />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>Amount</Label>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={createMutation.isPending}>Cancel</Button>
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !transactionDate || !description.trim() || !amount.trim()}>
              {createMutation.isPending ? "Saving..." : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between gap-3">
            <span>Entries</span>
            <div className="w-full max-w-sm">
              <Input
                value={entrySearch}
                onChange={(e) => setEntrySearch(e.target.value)}
                placeholder="Search description, ref no, type…"
                className="h-9"
              />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {ledgerQuery.isError ? <div className="text-sm text-red-600">Failed to load ledger.</div> : null}
          {ledgerQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading...</div>
          ) : displayEntries.length === 0 ? (
            <div className="text-sm text-slate-500 py-6 text-center">No ledger entries yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-slate-600">
                    <th className="py-3 px-3 font-medium">
                      <button className="hover:text-slate-900" onClick={() => toggleEntrySort("date")}>Date</button>
                    </th>
                    <th className="py-3 px-3 font-medium">Category</th>
                    <th className="py-3 px-3 font-medium">
                      <button className="hover:text-slate-900" onClick={() => toggleEntrySort("type")}>Type</button>
                    </th>
                    <th className="py-3 px-3 font-medium">Description</th>
                    <th className="py-3 px-3 font-medium text-right">
                      <button className="hover:text-slate-900" onClick={() => toggleEntrySort("amount")}>Amount</button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayEntries.map((e) => (
                    <tr key={e.id} className="border-b border-slate-100">
                      <td className="py-2 px-3 whitespace-nowrap">{e.transactionDate}</td>
                      <td className="py-2 px-3">{e.entryCategory}</td>
                      <td className="py-2 px-3 font-mono text-xs">{e.entryType}</td>
                      <td className="py-2 px-3">
                        {e.sourceType === "payment_voucher" && typeof e.sourceId === "number" ? (
                          <Link href={`/app/accounting?tab=payment-vouchers&printVoucherId=${e.sourceId}`} className="text-amber-700 hover:underline">
                            {e.description}
                          </Link>
                        ) : (
                          e.description
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-xs">{fmtMoney(e.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type ReferenceHistoryRow = {
  id: number;
  caseId: number;
  previousReferenceNo: string | null;
  newReferenceNo: string;
  changeType: string;
  actorUserId: number | null;
  actorName: string | null;
  changedAt: string | null;
  reason: string | null;
  source: string;
  createdAt: string | null;
};

function changeTypeBadge(t: string) {
  switch (t) {
    case "MANUAL_CHANGE":
      return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Manual Change</Badge>;
    case "PROPOSED_TO_FINAL":
      return <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">Proposed → Final</Badge>;
    case "REAPPROVAL_CHANGE":
      return <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">Reapproval</Badge>;
    case "SYSTEM_ASSIGNMENT":
      return <Badge variant="outline" className="bg-sky-50 text-sky-700 border-sky-200">System</Badge>;
    case "BACKFILLED_FROM_CASE_SNAPSHOT":
      return <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">Backfilled</Badge>;
    default:
      return <Badge variant="outline">{t}</Badge>;
  }
}

function ReferenceHistoryPanel({ caseId }: { caseId: number }) {
  const { user } = useAuth();
  const canView = hasPermission(user, "case_reference", "view") || hasPermission(user, "cases", "read");

  const q = useQuery<ReferenceHistoryRow[]>({
    queryKey: ["case-reference-history", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/reference-history`, { signal }),
    enabled: !!caseId && caseId > 0,
    retry: false,
  });

  if (!canView) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reference Number History</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-600">
          You do not have permission to view reference change history.
        </CardContent>
      </Card>
    );
  }

  const rows = Array.isArray(q.data) ? q.data : [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base sm:text-lg">Reference Number History</CardTitle>
          <div className="text-xs text-slate-500">
            {rows.length} change{rows.length === 1 ? "" : "s"}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        )}
        {!q.isLoading && rows.length === 0 && (
          <div className="text-sm text-slate-500 py-8 text-center">
            No reference number changes recorded for this case.
          </div>
        )}
        <ol className="relative border-l border-slate-200 ml-2 space-y-5">
          {rows.map((r) => (
            <li key={r.id} className="ml-5">
              <span className="absolute -left-[7px] mt-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-800 ring-4 ring-white" />
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  {changeTypeBadge(r.changeType)}
                  <span className="text-xs text-slate-500">
                    {r.changedAt ? new Date(r.changedAt).toLocaleString() : r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}
                  </span>
                  {r.actorName && (
                    <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                      <User className="h-3 w-3" />
                      {r.actorName}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap font-mono text-sm">
                  <span className={cn(
                    "px-2 py-0.5 rounded border",
                    r.previousReferenceNo ? "bg-slate-100 text-slate-700 border-slate-200 line-through" : "text-slate-400"
                  )}>
                    {r.previousReferenceNo ?? "—"}
                  </span>
                  <span className="text-slate-400">→</span>
                  <span className="px-2 py-0.5 rounded border bg-emerald-50 text-emerald-800 border-emerald-200 font-semibold">
                    {r.newReferenceNo}
                  </span>
                </div>
                {r.reason && (
                  <p className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 whitespace-pre-wrap break-words">
                    {r.reason}
                  </p>
                )}
                {!r.reason && (
                  <p className="text-xs text-slate-400 italic">No reason recorded.</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export default function CaseDetail() {
  const SHOW_COMPLIANCE_TAB = false;
  const { id } = useParams<{ id: string }>();
  const caseId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const canAssignAny = hasPermission(user, "cases", "assign_any");
  const myUserId = typeof (user as any)?.id === "number" ? (user as any).id : Number((user as any)?.id);
  const roleName = String((user as any)?.roleName ?? "");
  const isPartnerOrManager = roleName.toLowerCase().includes("partner") || roleName.toLowerCase().includes("manager");
  const canEditAssignments = (() => {
    const rn = roleName.trim();
    return rn === "Partner" || rn === "Manager" || rn.startsWith("Manager");
  })();

  const {
    data: caseInfo,
    isLoading: isLoadingCase,
    isError: isCaseError,
    error: caseError,
    refetch: refetchCase,
    isFetching: isFetchingCase,
  } = useGetCase(caseId, {
    query: { enabled: !!caseId, queryKey: getGetCaseQueryKey(caseId) }
  });

  const advancesQuery = useQuery<{ outstanding_advances?: number }>({
    queryKey: ["case-advances", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/advances`, { signal }),
    enabled: Number.isFinite(caseId) && caseId > 0,
    retry: false,
  });
  const outstandingAdvances = Number(advancesQuery.data?.outstanding_advances ?? 0);

  const { data: usersRes } = useListUsers({ limit: 200 }, { query: { staleTime: 5 * 60 * 1000 } });
  const users = usersRes?.data || [];
  const lawyerOptions = users.filter((u) => ["Partner", "Senior Lawyer", "Lawyer"].includes(String(u.roleName ?? "").trim()));
  const clerkOptions = users.filter((u) => ["Senior Clerk", "Clerk"].includes(String(u.roleName ?? "").trim()));
  const currentLawyerIds = (Array.isArray((caseInfo as any)?.assignments) ? (caseInfo as any).assignments : [])
    .filter((a: any) => a?.roleInCase === "lawyer")
    .map((a: any) => Number(a?.userId))
    .filter((id: number) => Number.isInteger(id) && id > 0);
  const currentClerkIds = (Array.isArray((caseInfo as any)?.assignments) ? (caseInfo as any).assignments : [])
    .filter((a: any) => a?.roleInCase === "clerk")
    .map((a: any) => Number(a?.userId))
    .filter((id: number) => Number.isInteger(id) && id > 0);
  const canAccessClientInteraction = !!caseId && (canAssignAny || isPartnerOrManager || (Number.isFinite(myUserId) && (currentLawyerIds.includes(myUserId) || currentClerkIds.includes(myUserId))));
  const [assignedLawyerIds, setAssignedLawyerIds] = useState<string[]>([]);
  const [assignedClerkIds, setAssignedClerkIds] = useState<string[]>([]);
  const assignmentsKey = `${currentLawyerIds.slice().sort((a, b) => a - b).join(",")}|${currentClerkIds.slice().sort((a, b) => a - b).join(",")}`;
  useEffect(() => {
    setAssignedLawyerIds(currentLawyerIds.length > 0 ? currentLawyerIds.map(String) : [""]);
    setAssignedClerkIds(currentClerkIds.length > 0 ? currentClerkIds.map(String) : [""]);
  }, [assignmentsKey]);

  const {
    data: workflow,
    isLoading: isLoadingWorkflow,
    isError: isWorkflowError,
    error: workflowError,
    refetch: refetchWorkflow,
    isFetching: isFetchingWorkflow,
  } = useGetCaseWorkflow(caseId, {
    query: { enabled: !!caseId, queryKey: getGetCaseWorkflowQueryKey(caseId) }
  });

  const updateStepMutation = useUpdateWorkflowStep();
  const updateCaseMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      return apiFetchJson(`/cases/${caseId}`, { method: "PATCH", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
    },
    onError: (err) => {
      toastError(toast, err, { fallback: "Failed to update case" });
    },
  });

  const updateAssignmentsMutation = useMutation({
    mutationFn: async (payload: { lawyerIds: number[]; clerkIds: number[] }) => {
      return apiFetchJson(`/cases/${caseId}/assignments`, { method: "PATCH", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
      toast({ title: "Assignments updated" });
    },
    onError: (err) => {
      toastError(toast, err, { fallback: "Failed to update assignments" });
    },
  });

  const normalizeSelectedIds = (values: string[]): number[] => {
    const ids = values
      .map((v) => Number(String(v || "").trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    return Array.from(new Set(ids));
  };

  const saveAssignments = (nextLawyers: string[], nextClerks: string[]) => {
    const lawyerIds = normalizeSelectedIds(nextLawyers);
    const clerkIds = normalizeSelectedIds(nextClerks);
    if (lawyerIds.length === 0) {
      toast({ title: "Assigned Lawyer is required", variant: "destructive" });
      return;
    }
    updateAssignmentsMutation.mutate({ lawyerIds, clerkIds });
  };
  const saveKeyDatesMutation = useMutation({
    mutationFn: (vars: { scope: string; payload: Record<string, unknown>; keys: string[] }) =>
      apiFetchJson(`/cases/${caseId}/key-dates`, { method: "PATCH", body: JSON.stringify(vars.payload) }),
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
      queryClient.invalidateQueries({ queryKey: ["case-key-dates", caseId] });
      queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
      setKeyDatesBaseline((prev) => {
        const next = { ...prev };
        for (const k of vars.keys) next[k] = keyDatesDraft[k] ?? "";
        return next;
      });
      setSavingScope("");
      toast({ title: `${vars.scope} saved` });
    },
    onError: (err) => toastError(toast, err, "Save failed"),
  });

  const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
  const todayYmdLocal = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  const autoKeyDatesMutation = useMutation({
    mutationFn: (vars: { payload: Record<string, unknown>; statusLabel: string }) =>
      apiFetchJson(`/cases/${caseId}/key-dates`, { method: "PATCH", body: JSON.stringify(vars.payload) }),
    onSuccess: async (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
      queryClient.invalidateQueries({ queryKey: ["case-key-dates", caseId] });
      queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
      toast({ title: "Loan Status automatically updated", description: `Loan Status automatically updated to ${vars.statusLabel}` });
    },
    onError: (err) => toastError(toast, err, "Auto status update failed"),
  });
  const printMutation = useMutation({
    mutationFn: async (payload: { printKey: string }) => {
      const startedAt = Date.now();
      const resp = await apiFetchJson<unknown>(`/cases/${caseId}/documents/print`, {
        method: "POST",
        timeoutMs: 20000,
        body: JSON.stringify({ ...payload, outputFormat: "pdf" }),
      });
      const jobId =
        resp && typeof resp === "object" && typeof (resp as any).jobId === "string"
          ? String((resp as any).jobId)
          : "";
      if (!jobId) throw new Error("print jobId missing");

      const wait = (ms: number): Promise<void> =>
        new Promise((r) => window.setTimeout(r, ms));

      const getProgress = (snapshot: any): { total: number; success: number; failed: number; pending: number; running: number } => {
        const p = snapshot?.progress;
        if (p && typeof p === "object") {
          return {
            total: Number(p.total ?? 0),
            success: Number(p.success ?? 0),
            failed: Number(p.failed ?? 0),
            pending: Number(p.pending ?? 0),
            running: Number(p.running ?? 0),
          };
        }
        return {
          total: Number(snapshot?.totalCount ?? 0),
          success: Number(snapshot?.successCount ?? 0),
          failed: Number(snapshot?.failedCount ?? 0),
          pending: Number(snapshot?.pendingCount ?? 0),
          running: Number(snapshot?.runningCount ?? 0),
        };
      };

      const isComplete = (snapshot: any): boolean => {
        const p = getProgress(snapshot);
        return p.total > 0 && p.pending === 0 && p.running === 0 && p.success + p.failed === p.total;
      };

      const getFailureSummary = (snapshot: any): string => {
        const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
        const failed = items.find((i: any) => String(i?.status ?? "") === "failed");
        const msg = failed && typeof failed.errorMessage === "string" ? failed.errorMessage : "";
        return msg || (typeof snapshot?.errorSummary === "string" ? snapshot.errorSummary : "") || "Generation failed";
      };

      let snapshot: any = await getGenerationJobStatus(jobId);
      for (let attempt = 1; attempt <= 12 && !isComplete(snapshot); attempt++) {
        try {
          snapshot = await runNextGenerationJob(jobId);
        } catch (err) {
          const code = getApiFailureCodeFromError(err) ?? "";
          const status =
            err && typeof err === "object" && "status" in (err as any) && typeof (err as any).status === "number"
              ? Number((err as any).status)
              : null;
          if (code === "RUN_NEXT_IN_FLIGHT") {
            await wait(2500);
            snapshot = await getGenerationJobStatus(jobId);
            continue;
          }
          if (status === 409) {
            await wait(1200);
            snapshot = await getGenerationJobStatus(jobId);
            continue;
          }
          throw err;
        }
        await wait(250);
        snapshot = await getGenerationJobStatus(jobId);
      }

      snapshot = await getGenerationJobStatus(jobId);
      if (!isComplete(snapshot)) {
        const elapsed = Date.now() - startedAt;
        throw new Error(`Generation still running after ${Math.round(elapsed / 1000)}s`);
      }
      const p = getProgress(snapshot);
      if (p.failed > 0 || p.success === 0) {
        throw new Error(getFailureSummary(snapshot));
      }

      let manifest: any = null;
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          manifest = await getGenerationJobDownloadManifest(jobId);
          break;
        } catch (err) {
          const code = getApiFailureCodeFromError(err) ?? "";
          if (code === "JOB_NOT_READY_FOR_DOWNLOAD") {
            await wait(800);
            continue;
          }
          throw err;
        }
      }
      const files = manifest && typeof manifest === "object" && Array.isArray((manifest as any).files) ? ((manifest as any).files as any[]) : [];
      const first = files.find((f) => String(f?.status ?? "") === "success" && typeof f?.signedUrl === "string" && String(f?.signedUrl).trim());
      if (first?.signedUrl) {
        const url = String(first.signedUrl);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
        const blob = await resp.blob();
        const name = typeof first.fileName === "string" && first.fileName.trim() ? String(first.fileName) : "download.pdf";
        downloadBlob(blob, name);
        return { jobId, fileName: name };
      }

      const zipRes = await apiRequest(`/documents/jobs/${jobId}/download`, { timeoutMs: 180000 });
      const zipBlob = await zipRes.blob();
      const fallbackName = `print-${jobId}.zip`;
      downloadBlob(zipBlob, fallbackName);
      return { jobId, fileName: fallbackName };
    },
    onSuccess: async ({ fileName }, vars) => {
      queryClient.invalidateQueries({ queryKey: ["case-documents", caseId] });
      toast({ title: "Downloaded" });

      if (vars?.printKey === "acting_letter") {
        const existing = typeof keyDatesDraft.acting_letter_issued_date === "string" ? keyDatesDraft.acting_letter_issued_date : "";
        if (!existing) {
          autoKeyDatesMutation.mutate({ payload: { acting_letter_issued_date: todayYmdLocal() }, statusLabel: "Acting Letter Issued" });
        }
      } else if (vars?.printKey === "letter_advice_spa_sol_lu") {
        const existing = typeof keyDatesDraft.advice_to_bank_date === "string" ? keyDatesDraft.advice_to_bank_date : "";
        if (!existing) {
          autoKeyDatesMutation.mutate({ payload: { advice_to_bank_date: todayYmdLocal() }, statusLabel: "Advised" });
        }
      }
    },
    onError: (err) => toastError(toast, err, "Print failed"),
  });
  const [activeStepId, setActiveStepId] = useState<number | null>(null);
  const [stepNote, setStepNote] = useState("");
  const [shareTrackingOpen, setShareTrackingOpen] = useState(false);
  const [clientReplyDraft, setClientReplyDraft] = useState("");
  const [editCaseOpen, setEditCaseOpen] = useState(false);
  const params = new URLSearchParams(searchString);
  const tabFromUrlRaw = params.get("tab") ?? "overview";
  const threadIdFromUrl = params.get("threadId");
  const initialThreadIdRaw = threadIdFromUrl ? parseInt(threadIdFromUrl, 10) : NaN;
  const returnToRaw = params.get("returnTo");
  const returnTo =
    returnToRaw && (returnToRaw.startsWith("/app/cases") || returnToRaw.startsWith("/app/dashboard"))
      ? returnToRaw
      : "/app/cases";
  const initialThreadId = Number.isNaN(initialThreadIdRaw) ? null : initialThreadIdRaw;
  const initialActiveTab = (() => {
    const allowed = new Set([
      "overview",
      "workflow",
      "documents",
      "billing",
      "ledger",
      "communications",
      "communication-timeline",
      "client-interaction",
      "reference-history",
      "operations",
      ...(SHOW_COMPLIANCE_TAB ? (["compliance"] as const) : []),
    ]);
    const next = allowed.has(tabFromUrlRaw) ? tabFromUrlRaw : "overview";
    if (next === "client-interaction" && !canAccessClientInteraction) return "overview";
    return next;
  })();
  const [activeTab, setActiveTab] = useState(initialActiveTab);

  const canViewCaseMonitor = hasPermission(user, "case_monitor", "view");
  const canViewFileCustody = hasPermission(user, "accounting", "view") || hasPermission(user, "file_custody", "view");

  const caseOpsCustodyQuery = useQuery({
    queryKey: ["case-ops", "file-custody", caseId],
    queryFn: ({ signal }) =>
      apiFetchJson(`/file-custody/items?case_id=${encodeURIComponent(String(caseId))}&limit=20`, { signal, timeoutMs: 12_000 }) as Promise<{
        total: number; offset: number; limit: number;
        items: Array<{
          id: number; fileReferenceNo: string; fileTitle: string; category: string; physicalOrDigital: string;
          lifecycleStatus: string; currentHolderName?: string | null; holderName?: string | null;
          currentHolderFirmExternal?: string | null; currentHolderContact?: string | null;
          acknowledgedAt?: string | null; acknowledgeDueAt?: string | null; expectedReturnAt?: string | null;
          isReturnOverdue?: boolean | null; isAcknowledgementOverdue?: boolean | null;
          lastMovementId?: number | null; createdAt: string; updatedAt: string;
        }>;
      }>,
    enabled: canViewFileCustody && Number.isFinite(caseId) && caseId > 0,
    staleTime: 30_000,
    retry: 0,
  });

  const caseOpsBottlenecksQuery = useQuery({
    queryKey: ["case-ops", "bottlenecks", caseId],
    queryFn: ({ signal }) =>
      apiFetchJson(`/case-monitor/bottlenecks?case_id=${encodeURIComponent(String(caseId))}&limit=20`, { signal, timeoutMs: 12_000 }) as Promise<{
        items: Array<{
          id: number; monitorKind: string; severity: string; daysStuck: number; title: string; detail: string;
          escalatedToPartner: boolean; createdAt: string;
        }>;
        limit: number; offset: number;
      }>,
    enabled: canViewCaseMonitor && Number.isFinite(caseId) && caseId > 0,
    staleTime: 30_000,
    retry: 0,
  });

  const formatHoldDuration = (iso: string | null | undefined): string => {
    if (!iso) return "—";
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h`;
  };

  const keyDatesQuery = useQuery<Record<string, unknown>>({
    queryKey: ["case-key-dates", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/key-dates`, { signal }),
    enabled: !!caseId,
    retry: false,
  });
  const keyDates = (keyDatesQuery.data && typeof keyDatesQuery.data === "object") ? keyDatesQuery.data : {};

  const trackingToken = String((caseInfo as any)?.trackingToken ?? "").trim();
  const trackingLink = (() => {
    if (!trackingToken) return "";
    const base = import.meta.env.BASE_URL ? String(import.meta.env.BASE_URL).replace(/\/$/, "") : "";
    return `${window.location.origin}${base}/track/${encodeURIComponent(trackingToken)}`;
  })();

  const workflowDocsQuery = useQuery<WorkflowDocument[]>({
    queryKey: ["case-workflow-documents", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/workflow-documents`, { signal }),
    enabled: !!caseId,
    retry: false,
  });

  const loanStampingQuery = useQuery<LoanStampingItem[]>({
    queryKey: ["case-loan-stamping", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/loan-stamping`, { signal }),
    enabled: !!caseId,
    retry: false,
  });

  const progressQuery = useQuery<any>({
    queryKey: ["case-progress", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/progress`, { signal }),
    enabled: !!caseId,
    retry: false,
  });

  type SuppLoDocument = {
    id: number;
    documentName: string;
    documentDate: string | null;
    objectPath: string | null;
    fileName: string | null;
    mimeType: string | null;
    fileSize: number | null;
    sortOrder: number | null;
    createdAt: string | null;
    updatedAt: string | null;
  };

  type SuppLoDocumentDraft = {
    rowKey: string;
    id: number | null;
    documentName: string;
    documentDate: string;
    objectPath: string | null;
    fileName: string | null;
    mimeType: string | null;
    fileSize: number | null;
    sortOrder: number;
  };

  const suppLoDocsQuery = useQuery<SuppLoDocument[]>({
    queryKey: ["case-supp-lo-documents", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/supp-lo-documents`, { signal }),
    enabled: !!caseId,
    retry: false,
  });

  const [suppLoDocsDraft, setSuppLoDocsDraft] = useState<SuppLoDocumentDraft[]>([]);
  const suppLoFileInputRef = useRef<HTMLInputElement>(null);
  const suppLoUploadRowKeyRef = useRef<string | null>(null);
  const [suppLoUploadingRowKey, setSuppLoUploadingRowKey] = useState<string | null>(null);
  const [suppLoDownloadingId, setSuppLoDownloadingId] = useState<number | null>(null);

  type CaseMessage = {
    id: string;
    channel?: "client" | "developer";
    senderType: "client" | "staff" | "developer";
    senderId: number | null;
    senderName: string;
    messageText: string;
    attachments: unknown;
    createdAt: string;
  };

  const [interactionChannel, setInteractionChannel] = useState<"client" | "developer">("client");

  const caseMessagesQuery = useQuery<{ data: CaseMessage[] }>({
    queryKey: ["case-messages", caseId, interactionChannel],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/messages?channel=${encodeURIComponent(interactionChannel)}`, { signal }),
    enabled: !!caseId && canAccessClientInteraction,
    retry: false,
  });

  const caseMessagesUnreadQuery = useQuery<{ totalUnreadCount: number; unreadCountByChannel: { client: number; developer: number } }>({
    queryKey: ["case-messages-unread-count", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/messages/unread-count`, { signal }),
    enabled: !!caseId && canAccessClientInteraction,
    retry: false,
    refetchInterval: 15000,
  });
  const paymentVoucherCaseSummaryQuery = useQuery<{ activeCount: number; overdueCount: number }>({
    queryKey: ["payment-voucher-actions", "case-summary", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/payment-voucher-actions/cases/${caseId}/summary`, { signal }),
    enabled: !!caseId,
    retry: false,
    refetchInterval: 15000,
  });
  const unreadClient = Number((caseMessagesUnreadQuery.data as any)?.unreadCountByChannel?.client ?? 0) || 0;
  const unreadDeveloper = Number((caseMessagesUnreadQuery.data as any)?.unreadCountByChannel?.developer ?? 0) || 0;
  const unreadTotal = Number((caseMessagesUnreadQuery.data as any)?.totalUnreadCount ?? (unreadClient + unreadDeveloper)) || 0;
  const paymentVoucherCaseActiveCount = Number((paymentVoucherCaseSummaryQuery.data as any)?.activeCount ?? 0) || 0;
  const prevUnreadRef = useRef<{ client: number; developer: number } | null>(null);

  const markCaseMessagesReadMutation = useMutation({
    mutationFn: async (channel: "client" | "developer") => {
      return await apiFetchJson(`/cases/${caseId}/messages/read`, { method: "POST", body: JSON.stringify({ channel }) });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-messages-unread-count", caseId] });
    },
  });

  useEffect(() => {
    if (!canAccessClientInteraction) return;
    if (!Number.isFinite(unreadClient) || !Number.isFinite(unreadDeveloper)) return;
    if (prevUnreadRef.current === null) {
      prevUnreadRef.current = { client: unreadClient, developer: unreadDeveloper };
      return;
    }
    if (unreadClient > prevUnreadRef.current.client) {
      queryClient.invalidateQueries({ queryKey: ["case-messages", caseId, "client"] });
    }
    if (unreadDeveloper > prevUnreadRef.current.developer) {
      queryClient.invalidateQueries({ queryKey: ["case-messages", caseId, "developer"] });
    }
    if (activeTab !== "client-interaction") {
      if (unreadClient > prevUnreadRef.current.client) {
        toast({ title: "New message from client received!" });
      }
      if (unreadDeveloper > prevUnreadRef.current.developer) {
        toast({ title: "New message from developer received!" });
      }
    }
    prevUnreadRef.current = { client: unreadClient, developer: unreadDeveloper };
  }, [unreadClient, unreadDeveloper, activeTab, canAccessClientInteraction, toast]);

  useEffect(() => {
    if (!canAccessClientInteraction) return;
    if (activeTab !== "client-interaction") return;
    if (caseMessagesQuery.isLoading) return;
    const unread = interactionChannel === "client" ? unreadClient : unreadDeveloper;
    if (unread <= 0) return;
    markCaseMessagesReadMutation.mutate(interactionChannel);
  }, [activeTab, canAccessClientInteraction, caseMessagesQuery.isLoading, interactionChannel, unreadClient, unreadDeveloper]);

  const sendCaseMessageMutation = useMutation({
    mutationFn: async (vars: { messageText: string; channel: "client" | "developer" }) => {
      return await apiFetchJson(`/cases/${caseId}/messages`, {
        method: "POST",
        body: JSON.stringify({ messageText: vars.messageText, channel: vars.channel }),
      });
    },
    onSuccess: async () => {
      setClientReplyDraft("");
      await queryClient.invalidateQueries({ queryKey: ["case-messages", caseId, interactionChannel] });
      await queryClient.invalidateQueries({ queryKey: ["case-messages-unread-count", caseId] });
    },
    onError: (err) => toastError(toast, err, { fallback: "Failed to send message" }),
  });

  const printableQuery = useQuery<any[]>({
    queryKey: ["printable-config"],
    queryFn: ({ signal }) => apiFetchJson("/printable-config", { signal }),
    retry: false,
  });
  const printableConfig = Array.isArray(printableQuery.data) ? printableQuery.data : [];
  const printState = (printKey: string) => (printableConfig || []).find((x) => x?.printKey === printKey) as any;
  const printStatusLabel = (st: any): string => {
    const s = st?.status;
    if (s === "configured") return "Ready";
    if (s === "template_not_template_kind") return "Template misclassified";
    if (s === "template_not_capable") return "Not template-capable";
    return "Template not configured";
  };
  const printTitle = (printKey: string, dateVal: string) => {
    if (!dateVal) return "Enter date to enable printing";
    if (printableQuery.isError) return "Template config unavailable";
    const st = printState(printKey);
    if (st?.status === "configured") return "Print";
    return st?.hint || "Template not configured";
  };
  const canPrint = (printKey: string, dateVal: string) => !printableQuery.isError && Boolean(dateVal) && printState(printKey)?.status === "configured";
  const templateIssuesCount = (printableConfig || []).filter((x) => x?.status && x.status !== "configured").length;
  const [savingScope, setSavingScope] = useState<string>("");
  const [keyDatesDraft, setKeyDatesDraft] = useState<Record<string, string | boolean>>({});
  const [keyDatesBaseline, setKeyDatesBaseline] = useState<Record<string, string | boolean>>({});
  const [keyDatesInitialized, setKeyDatesInitialized] = useState(false);

  const workflowFileInputRef = useRef<HTMLInputElement>(null);
  const workflowUploadKeyRef = useRef<{ docKey: WorkflowAttachmentDocKey; dateKey: WorkflowAttachmentDateKey } | null>(null);
  const [workflowUploadingKey, setWorkflowUploadingKey] = useState<WorkflowAttachmentDocKey | null>(null);
  const [workflowDownloadingId, setWorkflowDownloadingId] = useState<number | null>(null);

  const stampingFileInputRef = useRef<HTMLInputElement>(null);
  const stampingUploadIdRef = useRef<number | null>(null);
  const [stampingUploadingId, setStampingUploadingId] = useState<number | null>(null);
  const [stampingDownloadingId, setStampingDownloadingId] = useState<number | null>(null);
  const [stampingDraft, setStampingDraft] = useState<LoanStampingItem[]>([]);
  const [stampingDirty, setStampingDirty] = useState(false);

  const parseKeyDates = (src: Record<string, unknown>) => {
    const consentTransferApproval =
      normalizeDateOnlyFromApi((src as any).blanket_consent_transfer_approval)
      || normalizeDateOnlyFromApi((src as any).consent_to_transfer_date);
    const consentChargeApproval =
      normalizeDateOnlyFromApi((src as any).consent_to_charge_approval)
      || normalizeDateOnlyFromApi((src as any).consent_to_charge_date);

    return {
      spa_signed_date: normalizeDateOnlyFromApi((src as any).spa_signed_date),
      spa_forward_to_developer_execution_on: normalizeDateOnlyFromApi((src as any).spa_forward_to_developer_execution_on),
      spa_received_dev_return_spa_on: normalizeDateOnlyFromApi((src as any).spa_received_dev_return_spa_on),
      spa_date: normalizeDateOnlyFromApi((src as any).spa_date),
      spa_stamped_date: normalizeDateOnlyFromApi((src as any).spa_stamped_date),
      stamped_spa_send_to_developer_on: normalizeDateOnlyFromApi((src as any).stamped_spa_send_to_developer_on),
      stamped_spa_sent_to_purchaser_on: normalizeDateOnlyFromApi((src as any).stamped_spa_sent_to_purchaser_on),

      li_date: normalizeDateOnlyFromApi((src as any).li_date),
      li_received_on: normalizeDateOnlyFromApi((src as any).li_received_on),
      letter_of_offer_date: normalizeDateOnlyFromApi((src as any).letter_of_offer_date),
      letter_of_offer_stamped_date: normalizeDateOnlyFromApi((src as any).letter_of_offer_stamped_date),
      supp_lo_date: normalizeDateOnlyFromApi((src as any).supp_lo_date),
      acting_letter_issued_date: normalizeDateOnlyFromApi((src as any).acting_letter_issued_date),
      loan_bank_executed_date: normalizeDateOnlyFromApi((src as any).loan_bank_executed_date),
      developer_confirmation_received_on: normalizeDateOnlyFromApi((src as any).developer_confirmation_received_on),
      developer_confirmation_date: normalizeDateOnlyFromApi((src as any).developer_confirmation_date),
      differential_sum_rm: (src as any).differential_sum_rm !== null && (src as any).differential_sum_rm !== undefined ? String((src as any).differential_sum_rm) : "",
      differential_sum_settled_on: normalizeDateOnlyFromApi((src as any).differential_sum_settled_on),
      bank_lu_dated: normalizeDateOnlyFromApi((src as any).bank_lu_dated),
      bank_lu_received_date: normalizeDateOnlyFromApi((src as any).bank_lu_received_date),
      bank_lu_forward_to_developer_on: normalizeDateOnlyFromApi((src as any).bank_lu_forward_to_developer_on),
      developer_lu_received_on: normalizeDateOnlyFromApi((src as any).developer_lu_received_on),
      developer_lu_dated: normalizeDateOnlyFromApi((src as any).developer_lu_dated),
      master_lu_exempted: Boolean((src as any).master_lu_exempted),
      encumbrance_free_exempted: Boolean((src as any).encumbrance_free_exempted),
      letter_disclaimer_received_on: normalizeDateOnlyFromApi((src as any).letter_disclaimer_received_on),
      letter_disclaimer_dated: normalizeDateOnlyFromApi((src as any).letter_disclaimer_dated),
      letter_disclaimer_reference_nos: typeof (src as any).letter_disclaimer_reference_nos === "string" ? String((src as any).letter_disclaimer_reference_nos) : "",
      redemption_sum: (src as any).redemption_sum !== null && (src as any).redemption_sum !== undefined ? String((src as any).redemption_sum) : "",
      balance_sum_less_last_5_rm: (src as any).balance_sum_less_last_5_rm !== null && (src as any).balance_sum_less_last_5_rm !== undefined ? String((src as any).balance_sum_less_last_5_rm) : "",
      bankruptcy_search_dated: normalizeDateOnlyFromApi((src as any).bankruptcy_search_dated),
      received_executed_document_on_1: normalizeDateOnlyFromApi((src as any).received_executed_document_on_1),
      received_unexecuted_document_on: normalizeDateOnlyFromApi((src as any).received_unexecuted_document_on),
      resent_bank_execution_dated: normalizeDateOnlyFromApi((src as any).resent_bank_execution_dated),
      received_executed_document_on_2: normalizeDateOnlyFromApi((src as any).received_executed_document_on_2),

      statutory_declaration_dated: normalizeDateOnlyFromApi((src as any).statutory_declaration_dated),
      statutory_declaration_stamped_on: normalizeDateOnlyFromApi((src as any).statutory_declaration_stamped_on),
      fa_date: normalizeDateOnlyFromApi((src as any).fa_date),
      fa_adjudication_number: typeof (src as any).fa_adjudication_number === "string" ? String((src as any).fa_adjudication_number) : "",
      fa_stamp_on: normalizeDateOnlyFromApi((src as any).fa_stamp_on),
      doa_date: normalizeDateOnlyFromApi((src as any).doa_date),
      doa_stamp_on: normalizeDateOnlyFromApi((src as any).doa_stamp_on),
      poa_date: normalizeDateOnlyFromApi((src as any).poa_date),
      poa_stamp_on: normalizeDateOnlyFromApi((src as any).poa_stamp_on),
      noa_dated: normalizeDateOnlyFromApi((src as any).noa_dated),
      register_pa_on: normalizeDateOnlyFromApi((src as any).register_pa_on),
      pa_no: typeof (src as any).pa_no === "string" ? String((src as any).pa_no) : "",
      register_poa_on: normalizeDateOnlyFromApi((src as any).register_poa_on),
      registered_poa_registration_number: typeof (src as any).registered_poa_registration_number === "string" ? String((src as any).registered_poa_registration_number) : "",

      advice_to_bank_date: normalizeDateOnlyFromApi((src as any).advice_to_bank_date),
      completion_sla_activated_at: typeof (src as any).completion_sla_activated_at === "string" ? String((src as any).completion_sla_activated_at) : "",
      completion_sla_notified_48h_at: typeof (src as any).completion_sla_notified_48h_at === "string" ? String((src as any).completion_sla_notified_48h_at) : "",
      bank_1st_release_on: normalizeDateOnlyFromApi((src as any).bank_1st_release_on),
      first_release_amount_rm: (src as any).first_release_amount_rm !== null && (src as any).first_release_amount_rm !== undefined ? String((src as any).first_release_amount_rm) : "",

      request_letter_no_objection: normalizeDateOnlyFromApi((src as any).request_letter_no_objection),
      received_letter_no_objection_on: normalizeDateOnlyFromApi((src as any).received_letter_no_objection_on),
      blanket_consent_transfer_req: normalizeDateOnlyFromApi((src as any).blanket_consent_transfer_req),
      blanket_consent_transfer_approval: consentTransferApproval,
      consent_to_charge_req: normalizeDateOnlyFromApi((src as any).consent_to_charge_req),
      consent_to_charge_approval: consentChargeApproval,

      request_discharge_date: normalizeDateOnlyFromApi((src as any).request_discharge_date),
      discharge_title_received_on: normalizeDateOnlyFromApi((src as any).discharge_title_received_on),
      discharge_date: normalizeDateOnlyFromApi((src as any).discharge_date),
      mot_signed_date: normalizeDateOnlyFromApi((src as any).mot_signed_date),
      mot_submit_stamping: normalizeDateOnlyFromApi((src as any).mot_submit_stamping),
      mot_stamped_date: normalizeDateOnlyFromApi((src as any).mot_stamped_date),
      charge_date: normalizeDateOnlyFromApi((src as any).charge_date),
      charge_submit_stamping: normalizeDateOnlyFromApi((src as any).charge_submit_stamping),
      charge_stamped: normalizeDateOnlyFromApi((src as any).charge_stamped),

      completion_date: normalizeDateOnlyFromApi((src as any).completion_date),
    };
  };

  const scopeKeys = {
    spa: [
      "spa_signed_date",
      "spa_forward_to_developer_execution_on",
      "spa_received_dev_return_spa_on",
      "spa_date",
      "spa_stamped_date",
      "stamped_spa_send_to_developer_on",
      "stamped_spa_sent_to_purchaser_on",
    ],
    loan: [
      "li_date",
      "li_received_on",
      "letter_of_offer_date",
      "letter_of_offer_stamped_date",
      "supp_lo_date",
      "acting_letter_issued_date",
      "loan_bank_executed_date",
      "developer_confirmation_received_on",
      "developer_confirmation_date",
      "differential_sum_rm",
      "differential_sum_settled_on",
      "received_executed_document_on_1",
      "received_unexecuted_document_on",
      "resent_bank_execution_dated",
      "received_executed_document_on_2",
      "master_lu_exempted",
      "encumbrance_free_exempted",
      "bank_lu_dated",
      "bank_lu_received_date",
      "bank_lu_forward_to_developer_on",
      "developer_lu_received_on",
      "developer_lu_dated",
      "letter_disclaimer_received_on",
      "letter_disclaimer_dated",
      "letter_disclaimer_reference_nos",
      "redemption_sum",
      "balance_sum_less_last_5_rm",
      "bankruptcy_search_dated",
      "statutory_declaration_dated",
      "statutory_declaration_stamped_on",
      "fa_date",
      "fa_adjudication_number",
      "fa_stamp_on",
      "doa_date",
      "doa_stamp_on",
      "poa_date",
      "poa_stamp_on",
      "noa_dated",
      "register_pa_on",
      "pa_no",
      "register_poa_on",
      "registered_poa_registration_number",
      "advice_to_bank_date",
      "bank_1st_release_on",
      "first_release_amount_rm",
    ],
    titleWithConsent: [
      "request_letter_no_objection",
      "received_letter_no_objection_on",
      "blanket_consent_transfer_req",
      "blanket_consent_transfer_approval",
      "consent_to_charge_req",
      "consent_to_charge_approval",
    ],
    title: [
      "request_discharge_date",
      "discharge_title_received_on",
      "discharge_date",
      "mot_signed_date",
      "mot_submit_stamping",
      "mot_stamped_date",
      "charge_date",
      "charge_submit_stamping",
      "charge_stamped",
    ],
  } as const;

  const isDirtyScope = (scope: keyof typeof scopeKeys) => {
    for (const k of scopeKeys[scope]) {
      if ((keyDatesDraft[k] ?? "") !== (keyDatesBaseline[k] ?? "")) return true;
    }
    return false;
  };
  const dirtySpaStatus = isDirtyScope("spa");
  const dirtyLoanStatus = isDirtyScope("loan");
  const dirtyTitleWithConsent = isDirtyScope("titleWithConsent");
  const dirtyTitleCase = isDirtyScope("title");
  const anyDirty = dirtySpaStatus || dirtyLoanStatus || dirtyTitleWithConsent || dirtyTitleCase;

  useEffect(() => {
    setKeyDatesInitialized(false);
    setKeyDatesDraft({});
    setKeyDatesBaseline({});
    setSavingScope("");
  }, [caseId]);

  useEffect(() => {
    const parsed = parseKeyDates(keyDates);
    if (!keyDatesInitialized) {
      setKeyDatesDraft(parsed);
      setKeyDatesBaseline(parsed);
      setKeyDatesInitialized(true);
      return;
    }
    if (!anyDirty) {
      setKeyDatesDraft(parsed);
      setKeyDatesBaseline(parsed);
    }
  }, [keyDates, keyDatesInitialized, anyDirty]);

  useEffect(() => {
    if (!keyDatesInitialized) return;

    const priceRaw = (caseInfo as any)?.spaPrice;
    const purchasePrice = typeof priceRaw === "number"
      ? priceRaw
      : typeof priceRaw === "string"
        ? Number(priceRaw.replace(/[^0-9.]/g, "").trim())
        : NaN;

    const rawLoanDetails = (caseInfo as any)?.loanDetails;
    const loanDetailsObj: Record<string, unknown> | null = (() => {
      if (!rawLoanDetails) return null;
      if (typeof rawLoanDetails === "object" && !Array.isArray(rawLoanDetails)) return rawLoanDetails as Record<string, unknown>;
      if (typeof rawLoanDetails !== "string") return null;
      try {
        const parsed = JSON.parse(rawLoanDetails);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    })();

    const loanAmountRaw = loanDetailsObj?.loanAmountNum ?? loanDetailsObj?.loanAmount ?? loanDetailsObj?.loan_amount ?? loanDetailsObj?.amount;
    const loanAmount = typeof loanAmountRaw === "number"
      ? loanAmountRaw
      : typeof loanAmountRaw === "string"
        ? Number(loanAmountRaw.replace(/[^0-9.]/g, "").trim())
        : NaN;

    if (!Number.isFinite(purchasePrice) || !Number.isFinite(loanAmount)) return;

    const redemptionRaw = typeof keyDatesDraft.redemption_sum === "string" ? keyDatesDraft.redemption_sum : "";
    const redemption = redemptionRaw ? Number(redemptionRaw.replace(/[^0-9.]/g, "").trim()) : 0;
    if (!Number.isFinite(redemption)) return;

    const computed = loanAmount - redemption - (purchasePrice * 0.05);
    const next = Number.isFinite(computed) ? computed.toFixed(2) : "";
    setKeyDatesDraft((d) => {
      const current = typeof d.balance_sum_less_last_5_rm === "string" ? d.balance_sum_less_last_5_rm : "";
      if (current === next) return d;
      return { ...d, balance_sum_less_last_5_rm: next };
    });
  }, [caseInfo, keyDatesDraft.redemption_sum, keyDatesInitialized]);

  useEffect(() => {
    if (stampingDirty) return;
    const rows = Array.isArray(loanStampingQuery.data) ? loanStampingQuery.data : [];
    setStampingDraft(rows.map((x, idx) => ({
      id: x.id,
      itemKey: x.itemKey,
      customName: x.customName ?? null,
      datedOn: x.datedOn ?? null,
      stampedOn: x.stampedOn ?? null,
      fileName: x.fileName ?? null,
      mimeType: x.mimeType ?? null,
      fileSize: x.fileSize ?? null,
      sortOrder: Number.isFinite(x.sortOrder) ? x.sortOrder : idx,
    })));
  }, [loanStampingQuery.data, stampingDirty]);

  useEffect(() => {
    if (initialActiveTab === "compliance" && !SHOW_COMPLIANCE_TAB) {
      setActiveTab("overview");
      return;
    }
    setActiveTab(initialActiveTab);
  }, [initialActiveTab]);

  const workflowDocsByKey = useMemo(() => {
    const rows = Array.isArray(workflowDocsQuery.data) ? workflowDocsQuery.data : [];
    const map = new Map<WorkflowAttachmentDocKey, WorkflowDocument>();
    for (const r of rows) {
      if (r && (r.milestoneKey as any)) map.set(r.milestoneKey as WorkflowAttachmentDocKey, r);
    }
    return map;
  }, [workflowDocsQuery.data]);

  useEffect(() => {
    const rows = Array.isArray(suppLoDocsQuery.data) ? suppLoDocsQuery.data : [];
    setSuppLoDocsDraft((prev) => {
      const unsaved = prev.filter((x) => x.id == null);
      const prevKeys = new Map<number, string>();
      for (const r of prev) {
        if (r.id != null) prevKeys.set(r.id, r.rowKey);
      }
      const nextSaved: SuppLoDocumentDraft[] = rows.map((r, idx) => ({
        rowKey: prevKeys.get(r.id) ?? `id-${r.id}`,
        id: r.id,
        documentName: r.documentName ?? "",
        documentDate: r.documentDate ? String(r.documentDate) : "",
        objectPath: r.objectPath ?? null,
        fileName: r.fileName ?? null,
        mimeType: r.mimeType ?? null,
        fileSize: typeof r.fileSize === "number" ? r.fileSize : null,
        sortOrder: Number.isFinite(r.sortOrder as number) ? Number(r.sortOrder) : idx * 10,
      }));
      return [...unsaved, ...nextSaved];
    });
  }, [suppLoDocsQuery.data]);

  const createSuppLoDocMutation = useMutation({
    mutationFn: async (vars: { documentName: string; documentDate: string | null; sortOrder: number }) => {
      if (!caseId) throw new Error("Missing caseId");
      return await apiFetchJson<SuppLoDocument>(`/cases/${caseId}/supp-lo-documents`, {
        method: "POST",
        body: JSON.stringify({ documentName: vars.documentName, documentDate: vars.documentDate, sortOrder: vars.sortOrder }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-supp-lo-documents", caseId] });
    },
    onError: (err) => toastError(toast, err, "Failed to create document"),
  });

  const patchSuppLoDocMutation = useMutation({
    mutationFn: async (vars: { id: number; patch: Partial<Pick<SuppLoDocument, "documentName" | "documentDate" | "objectPath" | "fileName" | "mimeType" | "fileSize" | "sortOrder">> }) => {
      if (!caseId) throw new Error("Missing caseId");
      return await apiFetchJson<SuppLoDocument>(`/cases/${caseId}/supp-lo-documents/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify(vars.patch),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-supp-lo-documents", caseId] });
    },
    onError: (err) => toastError(toast, err, "Failed to update document"),
  });

  const deleteSuppLoDocMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!caseId) throw new Error("Missing caseId");
      return await apiFetchJson(`/cases/${caseId}/supp-lo-documents/${id}`, { method: "DELETE", allowStatuses: [204] });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-supp-lo-documents", caseId] });
      toast({ title: "Deleted" });
    },
    onError: (err) => toastError(toast, err, "Failed to delete document"),
  });

  const addSuppLoDocDraft = () => {
    const nextSortOrder = (() => {
      const max = suppLoDocsDraft.reduce((m, r) => Math.max(m, r.sortOrder), 0);
      return (Number.isFinite(max) ? max : 0) + 10;
    })();
    setSuppLoDocsDraft((prev) => prev.concat({
      rowKey: `tmp-${crypto.randomUUID()}`,
      id: null,
      documentName: "",
      documentDate: "",
      objectPath: null,
      fileName: null,
      mimeType: null,
      fileSize: null,
      sortOrder: nextSortOrder,
    }));
  };

  const ensureSuppLoDocCreated = async (rowKey: string): Promise<number | null> => {
    const row = suppLoDocsDraft.find((x) => x.rowKey === rowKey);
    if (!row) return null;
    if (row.id != null) return row.id;
    if (!row.documentName.trim()) {
      toast({ title: "Document Name required", variant: "destructive" });
      return null;
    }
    const created = await createSuppLoDocMutation.mutateAsync({
      documentName: row.documentName.trim(),
      documentDate: row.documentDate ? row.documentDate : null,
      sortOrder: row.sortOrder,
    });
    setSuppLoDocsDraft((prev) => prev.map((x) => x.rowKey === rowKey ? {
      ...x,
      id: created.id,
      documentName: created.documentName ?? x.documentName,
      documentDate: created.documentDate ? String(created.documentDate) : x.documentDate,
      objectPath: created.objectPath ?? null,
      fileName: created.fileName ?? null,
      mimeType: created.mimeType ?? null,
      fileSize: typeof created.fileSize === "number" ? created.fileSize : null,
      sortOrder: Number.isFinite(created.sortOrder as number) ? Number(created.sortOrder) : x.sortOrder,
    } : x));
    return created.id;
  };

  const suppLoObjectPath = (id: number, file: File) => {
    const firmId = user?.firmId;
    return `/objects/cases/${firmId}/case-${caseId}/supp-lo/${id}/${crypto.randomUUID()}-${safeFileNamePart(file.name)}`;
  };

  const openSuppLoUpload = async (rowKey: string) => {
    const id = await ensureSuppLoDocCreated(rowKey);
    if (!id) return;
    suppLoUploadRowKeyRef.current = rowKey;
    if (suppLoFileInputRef.current) {
      suppLoFileInputRef.current.value = "";
      suppLoFileInputRef.current.click();
    }
  };

  const handleSuppLoFileSelected = async (file: File | null) => {
    const rowKey = suppLoUploadRowKeyRef.current;
    if (!file || !rowKey) return;
    const row = suppLoDocsDraft.find((x) => x.rowKey === rowKey);
    if (!row) return;
    const id = row.id ?? await ensureSuppLoDocCreated(rowKey);
    if (!id) return;
    if (!canDocsWrite) {
      toast({ title: "Permission denied", description: "You do not have permission to upload documents.", variant: "destructive" });
      return;
    }
    const v = validateUploadFile(file, { allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES });
    if (!v.ok) {
      toast({ title: "Invalid file", description: v.message, variant: "destructive" });
      return;
    }
    if (!user?.firmId) {
      toast({ title: "No firm context", description: "Please sign in again." });
      return;
    }
    setSuppLoUploadingRowKey(rowKey);
    try {
      const objectPath = suppLoObjectPath(id, file);
      const uploaded = await uploadToPrivateCasePath(objectPath, file);
      await patchSuppLoDocMutation.mutateAsync({
        id,
        patch: {
          objectPath: uploaded.objectPath,
          fileName: file.name,
          mimeType: file.type || null,
          fileSize: file.size,
        },
      });
      toast({ title: "Upload success" });
    } finally {
      setSuppLoUploadingRowKey(null);
      suppLoUploadRowKeyRef.current = null;
      if (suppLoFileInputRef.current) suppLoFileInputRef.current.value = "";
    }
  };

  const downloadSuppLoDoc = async (row: SuppLoDocumentDraft) => {
    if (!row.id) return;
    if (suppLoDownloadingId === row.id) return;
    setSuppLoDownloadingId(row.id);
    try {
      const blob = await apiFetchBlob(`/cases/${caseId}/supp-lo-documents/${row.id}/download`);
      downloadBlob(blob, row.fileName || "download");
    } catch (err) {
      toastDownloadError(err);
    } finally {
      setSuppLoDownloadingId(null);
    }
  };

  const toastDownloadError = (err: unknown) => {
    const status = (err as any)?.status;
    if (status === 404) toastError(toast, err, "File not found");
    else if (status === 403) toastError(toast, err, "Permission denied");
    else if (status === 503) toastError(toast, err, "Storage unavailable");
    else toastError(toast, err, "Download failed");
  };

  const uploadWorkflowDocMutation = useMutation({
    mutationFn: (vars: { milestoneKey: WorkflowAttachmentDocKey; objectPath: string; file: File; dateYmd: string }) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/workflow-documents`, {
        method: "POST",
        body: JSON.stringify({
          milestoneKey: vars.milestoneKey,
          objectPath: vars.objectPath,
          fileName: vars.file.name,
          mimeType: vars.file.type || null,
          fileSize: vars.file.size,
          dateYmd: vars.dateYmd || null,
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-workflow-documents", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      await queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
    },
    onError: (err) => toastError(toast, err, "Upload failed"),
  });

  const deleteWorkflowDocMutation = useMutation({
    mutationFn: (id: number) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/workflow-documents/${id}`, { method: "DELETE", allowStatuses: [204] });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-workflow-documents", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      await queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
      toast({ title: "Deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const saveStampingMutation = useMutation({
    mutationFn: (items: LoanStampingSaveItem[]) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping`, { method: "PUT", body: JSON.stringify({ items }) });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      setStampingDirty(false);
      toast({ title: "Stamping saved" });
    },
    onError: (err) => toastError(toast, err, "Save failed"),
  });

  const deleteStampingRowMutation = useMutation({
    mutationFn: (id: number) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping/${id}`, { method: "DELETE", allowStatuses: [204] });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      setStampingDirty(false);
      toast({ title: "Deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const bindStampingFileMutation = useMutation({
    mutationFn: (vars: { id: number; objectPath: string; file: File }) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping/${vars.id}/file`, {
        method: "POST",
        body: JSON.stringify({
          objectPath: vars.objectPath,
          fileName: vars.file.name,
          mimeType: vars.file.type || null,
          fileSize: vars.file.size,
        }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      setStampingDirty(false);
    },
    onError: (err) => toastError(toast, err, "Upload failed"),
  });

  const clearStampingFileMutation = useMutation({
    mutationFn: (id: number) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping/${id}/file`, { method: "DELETE", allowStatuses: [204] });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
      setStampingDirty(false);
      toast({ title: "Deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  const ensureStampingItemMutation = useMutation({
    mutationFn: (payload: { itemKey: LoanStampingItemKey; customName?: string | null; sortOrder?: number; datedOn?: string | null; stampedOn?: string | null }) => {
      if (!caseId) throw new Error("Missing caseId");
      return apiFetchJson(`/cases/${caseId}/loan-stamping/ensure`, { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["case-loan-stamping", caseId] });
      await queryClient.invalidateQueries({ queryKey: ["case-progress", caseId] });
    },
    onError: (err) => toastError(toast, err, "Failed to prepare upload"),
  });

  const normalizeTitleType = (raw: string): "master" | "strata" | "individual" | "unknown" => {
    const s = (raw || "").trim().toLowerCase();
    if (!s) return "unknown";
    if (s === "master" || s === "master title" || s === "master_title") return "master";
    if (s === "strata" || s === "strata title" || s === "strata_title") return "strata";
    if (s === "individual" || s === "individual title" || s === "individual_title") return "individual";
    return "unknown";
  };
  const titleType = normalizeTitleType(String(caseInfo?.titleType ?? ""));
  const isMasterTitle = titleType === "master";
  const isStrataOrIndividual = titleType === "strata" || titleType === "individual";
  const caseMeta: Record<string, unknown> = caseInfo && typeof caseInfo === "object" ? (caseInfo as unknown as Record<string, unknown>) : {};
  const propertyDetailsObj = useMemo(() => {
    const raw = (caseMeta as any).propertyDetails;
    if (!raw) return {} as Record<string, unknown>;
    if (typeof raw === "object") return raw as Record<string, unknown>;
    if (typeof raw !== "string") return {} as Record<string, unknown>;
    try {
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj as Record<string, unknown> : ({} as Record<string, unknown>);
    } catch {
      return {} as Record<string, unknown>;
    }
  }, [caseMeta.propertyDetails]);
  const propertyAddressBaseline = typeof (propertyDetailsObj as any).propertyAddress === "string" ? String((propertyDetailsObj as any).propertyAddress) : "";
  const [propertyAddressDraft, setPropertyAddressDraft] = useState("");
  useEffect(() => {
    setPropertyAddressDraft(propertyAddressBaseline);
  }, [propertyAddressBaseline, caseId]);
  const projectMeta: Record<string, unknown> =
    caseMeta.project && typeof caseMeta.project === "object"
      ? (caseMeta.project as Record<string, unknown>)
      : {};
  const isEncumbered = !!(
    (caseInfo as any)?.project?.isEncumbered ||
    (caseInfo as any)?.project?.is_encumbered ||
    (caseInfo as any)?.isEncumbered ||
    (caseInfo as any)?.is_encumbered ||
    caseMeta.isEncumbered === true ||
    caseMeta.is_encumbered === true ||
    projectMeta.isEncumbered === true ||
    projectMeta.is_encumbered === true
  );
  const tenureRaw =
    typeof caseMeta.tenure === "string"
      ? caseMeta.tenure.trim().toLowerCase()
      : typeof projectMeta.tenure === "string"
        ? projectMeta.tenure.trim().toLowerCase()
        : "";
  const tenure = tenureRaw === "leasehold" ? "leasehold" : "freehold";
  const showNoaAndPoa = isMasterTitle;
  const showEncumbranceFields = isEncumbered;

  const visibleWorkflowAttachmentItems = useMemo(() => {
    return WORKFLOW_ATTACHMENT_ITEMS.filter((it) => {
      if (it.docKey === "register_poa") return showNoaAndPoa;
      if (it.docKey === "letter_disclaimer") return showEncumbranceFields;
      return true;
    });
  }, [showNoaAndPoa, showEncumbranceFields]);

  const fixedStampingKeys: Array<{ key: LoanStampingItemKey; label: string; visible: boolean }> = [
    { key: "facility_agreement", label: "Facility Agreement", visible: true },
    { key: "deed_of_assignment", label: "Deed of Assignment", visible: isMasterTitle },
    { key: "power_of_attorney", label: "Power of Attorney", visible: isMasterTitle },
    { key: "charge_annexure", label: "Charge Annexure", visible: isStrataOrIndividual },
  ];

  const visibleStampingItems = useMemo(() => {
    const existing = stampingDraft.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const fixed: LoanStampingItem[] = [];
    let order = 0;
    for (const k of fixedStampingKeys) {
      if (!k.visible) continue;
      const row = existing.find((x) => x.itemKey === k.key && x.customName == null);
      fixed.push({
        id: row?.id,
        itemKey: k.key,
        customName: null,
        datedOn: row?.datedOn ?? null,
        stampedOn: row?.stampedOn ?? null,
        fileName: row?.fileName ?? null,
        mimeType: row?.mimeType ?? null,
        fileSize: row?.fileSize ?? null,
        sortOrder: row?.sortOrder ?? order,
      });
      order += 10;
    }
    const others = existing.filter((x) => x.itemKey === "other").map((x, idx) => ({
      ...x,
      sortOrder: Number.isFinite(x.sortOrder) ? x.sortOrder : 1000 + idx,
    }));
    return { fixed, others };
  }, [stampingDraft, fixedStampingKeys.map((x) => x.visible).join("|")]);

  if (!caseId) return <div className="py-10 text-sm text-slate-500">Case not found</div>;
  if (isLoadingCase || isLoadingWorkflow) return <div className="py-10 text-sm text-slate-500">Loading case details...</div>;
  if (isCaseError) return <div className="py-10"><QueryFallback title="Case unavailable" error={caseError} onRetry={() => refetchCase()} isRetrying={isFetchingCase} /></div>;
  if (isWorkflowError) return <div className="py-10"><QueryFallback title="Workflow unavailable" error={workflowError} onRetry={() => refetchWorkflow()} isRetrying={isFetchingWorkflow} /></div>;
  if (!caseInfo) return <div className="py-10 text-sm text-slate-500">Case not found</div>;

  const handleCompleteStep = (stepId: number) => {
    updateStepMutation.mutate(
      { caseId, stepId, data: { status: "completed", notes: stepNote } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
          queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
          toast({ title: "Step marked as completed" });
          setActiveStepId(null);
          setStepNote("");
        },
        onError: (err) => toastError(toast, err, "Update failed"),
      }
    );
  };

  const safeWorkflow = Array.isArray(workflow) ? workflow : [];
  const commonSteps = safeWorkflow.filter(s => s?.pathType === "common");
  const loanSteps = safeWorkflow.filter(s => s?.pathType === "loan");
  const motSteps = safeWorkflow.filter(s => s?.pathType === "mot");
  const noaPoaSteps = safeWorkflow.filter(s => s?.pathType === "noa_pa");

  const stageStatus = (steps: any[]) => {
    const completed = (steps || []).filter((s) => s?.status === "completed");
    const last = completed.length ? completed[completed.length - 1] : null;
    return last?.stepName ? String(last.stepName) : "Pending";
  };

  const spaStatus = stageStatus(commonSteps);
  const loanStatus = loanSteps.length ? stageStatus(loanSteps) : "N/A";
  const workflowDone = safeWorkflow.filter((s) => s?.status === "completed").length;
  const workflowTotal = safeWorkflow.length;

  const safeAssignments = Array.isArray((caseInfo as any)?.assignments) ? ((caseInfo as any).assignments as any[]) : [];
  const safePurchasers = Array.isArray((caseInfo as any)?.purchasers) ? ((caseInfo as any).purchasers as any[]) : [];
  const loanDetailsObj: Record<string, unknown> | null = (() => {
    const raw = (caseInfo as any)?.loanDetails;
    if (!raw) return null;
    if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  })();

  const safeBorrowers = (() => {
    const normalize = (raw: any) => ({
      name: typeof raw?.name === "string" ? raw.name.trim() : "",
      ic: typeof raw?.ic === "string" ? raw.ic.trim() : "",
      tin: typeof raw?.tin === "string" ? raw.tin.trim() : "",
      phone: typeof raw?.hp === "string" ? raw.hp.trim() : typeof raw?.phone === "string" ? raw.phone.trim() : "",
      email: typeof raw?.email === "string" ? raw.email.trim() : "",
      address: typeof raw?.address === "string" ? raw.address.trim() : "",
    });

    const fromColumn = Array.isArray((caseInfo as any)?.borrowers) ? ((caseInfo as any).borrowers as any[]) : [];
    const normalizedFromColumn = fromColumn
      .map((b) => normalize(b))
      .filter((b) => b.name.length > 0);
    if (normalizedFromColumn.length > 0) return normalizedFromColumn;

    const fromLoanDetailsList = Array.isArray((loanDetailsObj as any)?.borrowers) ? (((loanDetailsObj as any).borrowers) as any[]) : [];
    const normalizedFromLoanDetailsList = fromLoanDetailsList
      .map((b) => normalize(b))
      .filter((b) => b.name.length > 0);
    if (normalizedFromLoanDetailsList.length > 0) return normalizedFromLoanDetailsList;

    const fromLegacy = (idx: 1 | 2) => {
      const name = typeof (loanDetailsObj as any)?.[`borrower${idx}Name`] === "string" ? String((loanDetailsObj as any)[`borrower${idx}Name`]).trim() : "";
      if (!name) return null;
      const ic = typeof (loanDetailsObj as any)?.[`borrower${idx}Ic`] === "string" ? String((loanDetailsObj as any)[`borrower${idx}Ic`]).trim() : "";
      const tin = typeof (loanDetailsObj as any)?.[`borrower${idx}Tin`] === "string" ? String((loanDetailsObj as any)[`borrower${idx}Tin`]).trim() : "";
      const hp = typeof (loanDetailsObj as any)?.[`borrower${idx}Hp`] === "string" ? String((loanDetailsObj as any)[`borrower${idx}Hp`]).trim() : "";
      const email = typeof (loanDetailsObj as any)?.[`borrower${idx}Email`] === "string" ? String((loanDetailsObj as any)[`borrower${idx}Email`]).trim() : "";
      const address = typeof (loanDetailsObj as any)?.[`borrower${idx}Address`] === "string" ? String((loanDetailsObj as any)[`borrower${idx}Address`]).trim() : "";
      return { name, ic, tin, phone: hp, email, address };
    };
    const legacy = [fromLegacy(1), fromLegacy(2)].filter(Boolean);
    return legacy as Array<{ name: string; ic: string; tin: string; phone: string; email: string; address: string }>;
  })();

  const loanBank = (() => {
    const v = loanDetailsObj?.endFinancierBank ?? loanDetailsObj?.end_financier ?? loanDetailsObj?.endFinancier ?? loanDetailsObj?.bank ?? loanDetailsObj?.financier;
    return v ? String(v).trim() : "";
  })();

  const purchasePriceRaw = (caseMeta as any)?.spaPrice;
  const hasPurchasePrice = purchasePriceRaw != null && String(purchasePriceRaw).trim() !== "";
  const purchasePriceAmount = hasPurchasePrice ? toMoneyNumber(purchasePriceRaw) : 0;
  const purchasePriceWords = hasPurchasePrice ? amountToEnglishWords(purchasePriceAmount) : "";

  const financingSumRaw =
    loanDetailsObj?.propertyFinancingSum ??
    loanDetailsObj?.financingSum ??
    loanDetailsObj?.loanAmountNum ??
    loanDetailsObj?.loanAmount ??
    loanDetailsObj?.loan_amount ??
    loanDetailsObj?.amount;
  const othersRaw = loanDetailsObj?.othersText ?? loanDetailsObj?.othersSum ?? loanDetailsObj?.otherCharges ?? loanDetailsObj?.other_charges;
  const totalLoanRaw = loanDetailsObj?.totalLoan ?? loanDetailsObj?.total_loan;
  const loanAmounts = calculateLoanAmounts({
    financingSum: financingSumRaw,
    others: typeof othersRaw === "string" ? othersRaw : othersRaw == null ? "" : String(othersRaw),
  });
  const hasFinancingSum = financingSumRaw != null && String(financingSumRaw).trim() !== "";
  const hasOthersTotal = loanAmounts.othersTotal > 0;
  const hasStoredTotalLoan = totalLoanRaw != null && String(totalLoanRaw).trim() !== "";
  const totalLoanAmount = hasStoredTotalLoan ? toMoneyNumber(totalLoanRaw) : loanAmounts.totalLoan;
  const hasTotalLoan = hasStoredTotalLoan || hasFinancingSum || hasOthersTotal;
  const totalLoanWords = hasTotalLoan ? amountToEnglishWords(totalLoanAmount) : "";

  const saveScope = (scope: "SPA Status" | "Loan Status" | "Title Case with Consent" | "Title Case") => {
    const key: keyof typeof scopeKeys =
      scope === "SPA Status" ? "spa" :
      scope === "Loan Status" ? "loan" :
      scope === "Title Case with Consent" ? "titleWithConsent" :
      "title";
    const dirty =
      key === "spa" ? dirtySpaStatus :
      key === "loan" ? dirtyLoanStatus :
      key === "titleWithConsent" ? dirtyTitleWithConsent :
      dirtyTitleCase;
    if (!dirty) return;

    const keys = scopeKeys[key] as readonly string[];
    const payload: Record<string, unknown> = {};
    const booleanKeys = new Set(["master_lu_exempted", "encumbrance_free_exempted"]);
    for (const k of keys) {
      const raw = keyDatesDraft[k];
      if (booleanKeys.has(k)) {
        payload[k] = Boolean(raw);
        continue;
      }
      const v = typeof raw === "string" ? raw : "";
      payload[k] = v ? v : null;
    }

    setSavingScope(scope);
    saveKeyDatesMutation.mutate({ scope, payload, keys: keys as string[] });
  };

  async function uploadToPrivateCasePath(objectPath: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    return await apiFetchJson<{ objectPath: string }>(`/storage/upload?objectPath=${encodeURIComponent(objectPath)}`, { method: "POST", body: fd });
  }

  function workflowObjectPath(milestoneKey: WorkflowAttachmentDocKey, file: File): string {
    const firmId = user?.firmId;
    return `/objects/cases/${firmId}/case-${caseId}/workflow/${milestoneKey}/${crypto.randomUUID()}-${safeFileNamePart(file.name)}`;
  }

  function openWorkflowUpload(docKey: WorkflowAttachmentDocKey, dateKey: WorkflowAttachmentDateKey) {
    workflowUploadKeyRef.current = { docKey, dateKey };
    workflowFileInputRef.current?.click();
  }

  async function handleWorkflowFileSelected(file: File | null) {
    const ref = workflowUploadKeyRef.current;
    if (!file || !ref) return;
    if (!hasPermission(user, "documents", "create") && !hasPermission(user, "documents", "update")) {
      toast({ title: "Permission denied", description: "You do not have permission to upload documents.", variant: "destructive" });
      return;
    }
    const v = validateUploadFile(file, { allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES });
    if (!v.ok) {
      toast({ title: "Invalid file", description: v.message, variant: "destructive" });
      return;
    }
    const dateYmd = keyDatesDraft[ref.dateKey] || "";
    if (!dateYmd) {
      toast({ title: "Select date first", description: "Please enter the date before uploading the file." });
      return;
    }
    if (!user?.firmId) {
      toast({ title: "No firm context", description: "Please sign in again." });
      return;
    }
    setWorkflowUploadingKey(ref.docKey);
    try {
      const existed = Boolean(workflowDocsByKey.get(ref.docKey));
      const objectPath = workflowObjectPath(ref.docKey, file);
      const uploaded = await uploadToPrivateCasePath(objectPath, file);
      await uploadWorkflowDocMutation.mutateAsync({
        milestoneKey: ref.docKey,
        objectPath: uploaded.objectPath,
        file,
        dateYmd,
      });
      toast({ title: existed ? "Replace success" : "Upload success" });
    } finally {
      setWorkflowUploadingKey(null);
      workflowUploadKeyRef.current = null;
      if (workflowFileInputRef.current) workflowFileInputRef.current.value = "";
    }
  }

  async function downloadWorkflowDoc(doc: WorkflowDocument) {
    if (workflowDownloadingId === doc.id) return;
    setWorkflowDownloadingId(doc.id);
    try {
      const blob = await apiFetchBlob(`/cases/${caseId}/workflow-documents/${doc.id}/download`);
      downloadBlob(blob, doc.fileName);
    } catch (err) {
      toastDownloadError(err);
    } finally {
      setWorkflowDownloadingId(null);
    }
  }

  function stampingObjectPath(file: File): string {
    const firmId = user?.firmId;
    return `/objects/cases/${firmId}/case-${caseId}/loan-stamping/${crypto.randomUUID()}-${safeFileNamePart(file.name)}`;
  }

  async function ensureStampingRowForUpload(row: LoanStampingItem): Promise<number | null> {
    if (!canDocsUpdate) return null;
    const ensured = await ensureStampingItemMutation.mutateAsync({
      itemKey: row.itemKey,
      customName: row.itemKey === "other" ? (row.customName ?? "") : null,
      sortOrder: row.sortOrder,
      datedOn: row.datedOn ?? null,
      stampedOn: row.stampedOn ?? null,
    });
    const ensuredId = Number((ensured as any)?.id);
    if (!Number.isFinite(ensuredId)) return null;
    setStampingDraft((prev) => {
      const next = [...prev];
      const idx = next.findIndex((x) =>
        x.id
          ? x.id === row.id
          : (row.itemKey !== "other" ? x.itemKey === row.itemKey : x.itemKey === "other" && x.sortOrder === row.sortOrder)
      );
      const merged = {
        ...row,
        id: ensuredId,
        customName: (ensured as any)?.customName ?? row.customName ?? null,
        datedOn: (ensured as any)?.datedOn ?? row.datedOn ?? null,
        stampedOn: (ensured as any)?.stampedOn ?? row.stampedOn ?? null,
      } as LoanStampingItem;
      if (idx >= 0) next[idx] = { ...next[idx], ...merged };
      else next.push(merged);
      return next;
    });
    return ensuredId;
  }

  async function openStampingUpload(row: LoanStampingItem) {
    const ensuredId = row.id ? row.id : await ensureStampingRowForUpload(row);
    if (!ensuredId) return;
    stampingUploadIdRef.current = ensuredId;
    stampingFileInputRef.current?.click();
  }

  async function addStampingOtherRow() {
    if (!canDocsUpdate) return;
    const nextOrder = 1000 + visibleStampingItems.others.length;
    const ensured = await ensureStampingItemMutation.mutateAsync({
      itemKey: "other",
      customName: "",
      sortOrder: nextOrder,
      datedOn: null,
      stampedOn: null,
    });
    const ensuredId = Number((ensured as any)?.id);
    if (!Number.isFinite(ensuredId)) return;
    setStampingDraft((prev) => [
      ...prev,
      { id: ensuredId, itemKey: "other", customName: "", datedOn: null, stampedOn: null, fileName: null, mimeType: null, fileSize: null, sortOrder: nextOrder },
    ]);
  }

  async function handleStampingFileSelected(file: File | null) {
    const id = stampingUploadIdRef.current;
    if (!file || !id) return;
    if (!hasPermission(user, "documents", "create") && !hasPermission(user, "documents", "update")) {
      toast({ title: "Permission denied", description: "You do not have permission to upload documents.", variant: "destructive" });
      return;
    }
    const v = validateUploadFile(file, { allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES });
    if (!v.ok) {
      toast({ title: "Invalid file", description: v.message, variant: "destructive" });
      return;
    }
    if (!user?.firmId) {
      toast({ title: "No firm context", description: "Please sign in again." });
      return;
    }
    setStampingUploadingId(id);
    try {
      const existed = Boolean(stampingDraft.find((x) => x.id === id)?.fileName);
      const objectPath = stampingObjectPath(file);
      const uploaded = await uploadToPrivateCasePath(objectPath, file);
      await bindStampingFileMutation.mutateAsync({ id, objectPath: uploaded.objectPath, file });
      toast({ title: existed ? "Replace success" : "Upload success" });
    } finally {
      setStampingUploadingId(null);
      stampingUploadIdRef.current = null;
      if (stampingFileInputRef.current) stampingFileInputRef.current.value = "";
    }
  }

  async function downloadStampingFile(item: LoanStampingItem) {
    if (!item.id) return;
    if (stampingDownloadingId === item.id) return;
    setStampingDownloadingId(item.id);
    try {
      const blob = await apiFetchBlob(`/cases/${caseId}/loan-stamping/${item.id}/download`);
      downloadBlob(blob, item.fileName || "download");
    } catch (err) {
      toastDownloadError(err);
    } finally {
      setStampingDownloadingId(null);
    }
  }

  function FieldCard(props: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    type?: "date" | "text" | "number";
    printerKey?: string;
    alwaysShowPrinter?: boolean;
    disabled?: boolean;
    required?: boolean;
    readOnly?: boolean;
    statusTag?: { label: string; tone: "green" | "amber" | "red" };
  }) {
    const type = props.type ?? "date";
    const isDate = type === "date";
    const dateVal = props.value || "";
    const showPrinter = Boolean(props.printerKey);
    const printerKey = props.printerKey || "";
    const st = showPrinter ? printState(printerKey) : null;
    const showStatus = showPrinter && st?.status !== "configured";
    const statusLabel = showStatus ? printStatusLabel(st) : "";
    const showRequired = Boolean(props.required) && !dateVal;
    const isGenerating = printMutation.isPending && printMutation.variables?.printKey === printerKey;

    return (
      <div className="group rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-slate-600">{props.label}</Label>
          <div className="flex items-center gap-1">
            {props.statusTag ? (
              <span
                className={[
                  "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
                  props.statusTag.tone === "red"
                    ? "bg-red-100 text-red-700"
                    : props.statusTag.tone === "amber"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-emerald-100 text-emerald-800",
                ].join(" ")}
              >
                {props.statusTag.label}
              </span>
            ) : null}
            {showRequired ? (
              <Badge variant="destructive" className="text-[10px] whitespace-nowrap">required</Badge>
            ) : null}
            {showStatus && (
              <Badge
                variant={st?.status === "configured" ? "secondary" : "outline"}
                className="text-[10px] whitespace-nowrap"
                title={st?.hint}
              >
                {statusLabel}
              </Badge>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          {isDate ? (
            <DateOnlyInput className="flex-1" valueYmd={props.value} onChangeYmd={props.onChange} disabled={props.disabled} />
          ) : (
            <Input
              className="flex-1"
              type={type}
              value={props.value}
              onChange={(e) => props.onChange(e.target.value)}
              disabled={props.disabled}
              readOnly={props.readOnly}
            />
          )}
          {showPrinter && (
            <div className={props.alwaysShowPrinter ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"}>
              <Button
                size="icon"
                variant={canPrint(printerKey, dateVal) ? "default" : "outline"}
                className={canPrint(printerKey, dateVal) ? "bg-slate-900 hover:bg-slate-800" : undefined}
                title={isGenerating ? "Generating..." : printTitle(printerKey, dateVal)}
                onClick={() => printMutation.mutate({ printKey: printerKey })}
                disabled={printMutation.isPending || props.disabled || !canPrint(printerKey, dateVal)}
              >
                {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const canDocsRead = hasPermission(user, "documents", "read");
  const canDocsUpdate = hasPermission(user, "documents", "update");
  const canDocsWrite = hasPermission(user, "documents", "create") || canDocsUpdate;
  const canDocsDelete = hasPermission(user, "documents", "delete");

  function WorkflowFileCard(props: { label: string; docKey: WorkflowAttachmentDocKey; dateKey: WorkflowAttachmentDateKey; printerKey?: string; requireEvidenceUpload?: boolean; evidenceLabel?: string; disabled?: boolean }) {
    const value = String(keyDatesDraft[props.dateKey] ?? "");
    const doc = workflowDocsByKey.get(props.docKey);
    const uploading = workflowUploadingKey === props.docKey || uploadWorkflowDocMutation.isPending;
    const canUpload = canDocsWrite && Boolean(value) && !uploading && !deleteWorkflowDocMutation.isPending && !props.disabled;
    const derivedStatus = Array.isArray(progressQuery.data?.attachments)
      ? progressQuery.data.attachments.find((x: any) => x?.docKey === props.docKey)?.status
      : null;
    const showPrinter = Boolean(props.printerKey);
    const printerKey = props.printerKey || "";
    const st = showPrinter ? printState(printerKey) : null;
    const showStatus = showPrinter && st?.status !== "configured";
    const statusLabel = showStatus ? printStatusLabel(st) : "";
    const isGenerating = printMutation.isPending && printMutation.variables?.printKey === printerKey;

    return (
      <div className="group rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-slate-600">{props.label}</Label>
          <div className="flex items-center gap-1">
            {(() => {
              const mustUpload = Boolean(props.requireEvidenceUpload);
              const pending = mustUpload && Boolean(value) && !doc;
              if (pending) {
                return (
                  <Badge variant="destructive" className="text-[10px] whitespace-nowrap">
                    incomplete
                  </Badge>
                );
              }
              if (derivedStatus) {
                return (
                  <Badge
                    variant={derivedStatus === "completed" ? "default" : "outline"}
                    className="text-[10px] whitespace-nowrap"
                  >
                    {String(derivedStatus).replace(/_/g, " ")}
                  </Badge>
                );
              }
              return null;
            })()}
            {showStatus && (
              <Badge
                variant={st?.status === "configured" ? "secondary" : "outline"}
                className="text-[10px] whitespace-nowrap"
                title={st?.hint}
              >
                {statusLabel}
              </Badge>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <DateOnlyInput
            className="flex-1"
            valueYmd={String(value)}
            onChangeYmd={(v) => setKeyDatesDraft((d) => ({ ...d, [props.dateKey]: v }))}
            disabled={props.disabled}
          />
          {showPrinter && (
            <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <Button
                size="icon"
                variant={canPrint(printerKey, value) ? "default" : "outline"}
                className={canPrint(printerKey, value) ? "bg-slate-900 hover:bg-slate-800" : undefined}
                title={isGenerating ? "Generating..." : printTitle(printerKey, value)}
                onClick={() => printMutation.mutate({ printKey: printerKey })}
                disabled={printMutation.isPending || props.disabled || !canPrint(printerKey, value)}
              >
                {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
              </Button>
            </div>
          )}
        </div>
        {props.requireEvidenceUpload && value && !doc && canDocsWrite && !props.disabled ? (
          <div
            className="mt-3 rounded-md border border-dashed border-red-300 bg-red-50 px-3 py-4 text-sm text-red-700 cursor-pointer"
            onClick={() => openWorkflowUpload(props.docKey, props.dateKey)}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={async (e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0] ?? null;
              if (!f) return;
              if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") {
                toast({ title: "PDF required", description: "Please upload a PDF file.", variant: "destructive" });
                return;
              }
              workflowUploadKeyRef.current = { docKey: props.docKey, dateKey: props.dateKey };
              await handleWorkflowFileSelected(f);
            }}
          >
            <div className="font-medium">Upload required: {props.evidenceLabel ?? "PDF"}</div>
            <div className="text-xs mt-1 text-red-600">Drop PDF here, or click to upload</div>
          </div>
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-2 min-w-0">
          <div className="text-xs text-slate-600 truncate min-w-0" title={doc?.fileName ?? "No file uploaded"}>
            {doc ? doc.fileName : "No file uploaded"}
          </div>
          <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {doc ? (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  title="Download"
                  onClick={() => downloadWorkflowDoc(doc)}
                  disabled={!canDocsRead || workflowDownloadingId === doc.id}
                >
                  <Download className="w-4 h-4" />
                </Button>
                {canDocsWrite && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    title="Replace"
                    onClick={() => openWorkflowUpload(props.docKey, props.dateKey)}
                    disabled={!canUpload}
                  >
                    <Upload className="w-4 h-4" />
                  </Button>
                )}
                {canDocsDelete && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-red-600"
                    title="Delete"
                    onClick={() => deleteWorkflowDocMutation.mutate(doc.id)}
                    disabled={deleteWorkflowDocMutation.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </>
            ) : (
              canDocsWrite ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => openWorkflowUpload(props.docKey, props.dateKey)}
                  disabled={!canUpload}
                  title={value ? "Upload file" : "Enter date to enable upload"}
                >
                  <Upload className="w-4 h-4" />
                  Upload
                </Button>
              ) : null
            )}
          </div>
        </div>
      </div>
    );
  }

  const upsertStampingItem = (next: LoanStampingItem) => {
    setStampingDirty(true);
    setStampingDraft((prev) => {
      const idx = next.id
        ? prev.findIndex((x) => x.id === next.id)
        : prev.findIndex((x) => x.id == null && x.itemKey === next.itemKey && (x.customName ?? null) === (next.customName ?? null));
      if (idx >= 0) {
        const copy = prev.slice();
        copy[idx] = { ...copy[idx], ...next };
        return copy;
      }
      return prev.concat(next);
    });
  };

  const removeUnsavedStampingOther = (sortOrder: number) => {
    setStampingDirty(true);
    setStampingDraft((prev) => prev.filter((x) => !(x.id == null && x.itemKey === "other" && x.sortOrder === sortOrder)));
  };

  const saveStamping = () => {
    const items: LoanStampingSaveItem[] = [...visibleStampingItems.fixed, ...visibleStampingItems.others].map((x, idx) => ({
      id: x.id,
      itemKey: x.itemKey,
      customName: x.customName,
      datedOn: x.datedOn,
      stampedOn: x.stampedOn,
      sortOrder: Number.isFinite(x.sortOrder) ? x.sortOrder : idx * 10,
    }));
    saveStampingMutation.mutate(items);
  };

  return (
    <div className="space-y-6 pb-12">
      <input
        ref={workflowFileInputRef}
        type="file"
        accept={WORKFLOW_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => handleWorkflowFileSelected(e.target.files?.[0] ?? null)}
      />
      <input
        ref={stampingFileInputRef}
        type="file"
        accept={WORKFLOW_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => handleStampingFileSelected(e.target.files?.[0] ?? null)}
      />
      <input
        ref={suppLoFileInputRef}
        type="file"
        accept={WORKFLOW_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => handleSuppLoFileSelected(e.target.files?.[0] ?? null)}
      />
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 min-w-0">
        <div className="flex items-start gap-4 min-w-0">
          <Button variant="outline" size="icon" onClick={() => setLocation(returnTo)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-0">
            <Breadcrumb className="mb-1">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={returnTo}>Cases</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={`/app/projects/${String((caseInfo as any)?.projectId ?? "")}`}>
                      {String((caseInfo as any)?.projectName ?? "Project")}
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{String((caseInfo as any).referenceNo ?? "")}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold text-slate-900 tracking-tight break-words">{String((caseInfo as any).referenceNo ?? "")}</h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider bg-slate-100 text-slate-700 border border-slate-200">
                {String((caseInfo as any).status ?? "").replace(/_/g, " ")}
              </span>
            </div>
            <p className="text-slate-500 mt-1 break-words">
              {[String((caseInfo as any).projectName ?? ""), String((caseInfo as any).developerName ?? "")].filter((x) => x.trim()).join(" • ")}
            </p>
            {(() => {
              const proposed = String((caseInfo as any).proposedReferenceNo ?? "").trim();
              const finalRef = String((caseInfo as any).referenceNo ?? "").trim();
              if (!proposed || !finalRef || proposed === finalRef) return null;
              return (
                <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                  <div className="font-semibold text-slate-900">Reference No. Updated</div>
                  <div className="mt-1 font-mono text-slate-800 break-words">Proposed: {proposed}</div>
                  <div className="mt-1 font-mono text-slate-800 break-words">Final: {finalRef}</div>
                </div>
              );
            })()}
            {Number.isFinite(outstandingAdvances) && outstandingAdvances > 0 ? (
              <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                ⚠️ This case has <span className="font-semibold">{formatRMAmount(outstandingAdvances)}</span> in outstanding advances. Please issue an Invoice / Collect payment.
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => setEditCaseOpen(true)}
            disabled={updateCaseMutation.isPending}
          >
            Edit Case
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShareTrackingOpen(true)}
            disabled={!trackingToken}
          >
            <Share2 className="w-4 h-4 mr-2" />
            Share Tracking Link
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const params = new URLSearchParams();
              params.set("caseId", String((caseInfo as any).id ?? ""));
              params.set("ref", String((caseInfo as any).referenceNo ?? ""));
              if ((caseInfo as any).spaPrice) params.set("price", String((caseInfo as any).spaPrice));
              const propDesc = [String((caseInfo as any).projectName ?? ""), String((caseInfo as any).developerName ?? "")].filter((x) => x.trim()).join(" • ");
              if (propDesc) params.set("property", propDesc);
              setLocation(`/app/quotations/new?${params.toString()}`);
            }}
          >
            <Receipt className="w-4 h-4 mr-2" />
            Generate Quotation
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setLocation("/app/documents?tab=firm")}>
                Configure Templates
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <CaseFormModal
        open={editCaseOpen}
        onOpenChange={setEditCaseOpen}
        mode="edit"
        title="Edit Case"
        initialValues={caseInfo ? mapCaseToFormValues(caseInfo) : undefined}
        onSubmit={async (payload) => {
          await apiFetchJson(`/cases/${caseId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
          await queryClient.invalidateQueries({ queryKey: ["cases"] });
          await queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
          await queryClient.invalidateQueries({ queryKey: getGetCaseQueryKey(caseId) });
          await queryClient.invalidateQueries({ queryKey: getGetCaseWorkflowQueryKey(caseId) });
          await queryClient.invalidateQueries({ queryKey: ["cases", "filter-options"] });
          await queryClient.invalidateQueries({ queryKey: ["case-files"] });
        }}
      />

      <Dialog open={shareTrackingOpen} onOpenChange={setShareTrackingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share Tracking Link</DialogTitle>
            <DialogDescription>Send this link to your client (no login required).</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="text-sm font-medium">Tracking URL</div>
            <Input value={trackingLink || "Tracking link unavailable"} readOnly />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!trackingLink) return;
                try {
                  await navigator.clipboard.writeText(trackingLink);
                  toast({ title: "Link copied" });
                } catch (err) {
                  toastError(toast, err, "Copy failed");
                }
              }}
              disabled={!trackingLink}
            >
              Copy Link
            </Button>
            <Button
              onClick={() => {
                if (!trackingLink) return;
                const msg = `Hi, you can track your property transaction progress here: ${trackingLink}`;
                const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
                window.open(url, "_blank", "noopener,noreferrer");
              }}
              disabled={!trackingLink}
            >
              Share via WhatsApp
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!progressQuery.isError && Array.isArray(progressQuery.data?.sections) && progressQuery.data.sections.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Progress Summary</CardTitle>
          </CardHeader>
          <CardContent className="min-w-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 min-w-0">
              {progressQuery.data.sections.map((s: any) => (
                <button
                  key={s.key}
                  type="button"
                  className="min-w-0 rounded-lg border border-slate-200 bg-white p-3 text-left hover:bg-slate-50"
                  onClick={() => {
                    setActiveTab("overview");
                    if (s?.target?.milestoneTab) setMilestoneTab(s.target.milestoneTab);
                  }}
                >
                  <div className="text-sm font-medium text-slate-800 break-words">{s.label}</div>
                  <div className="mt-1 flex items-center justify-between gap-2 min-w-0">
                    <div className="text-xl font-bold text-slate-900">{s.completed}/{s.total}</div>
                    <Badge variant={s.total > 0 && s.completed === s.total ? "default" : "secondary"}>
                      {s.total > 0 && s.completed === s.total ? "Completed" : "In Progress"}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="flex w-full flex-wrap gap-1 mb-6 bg-slate-100 p-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="workflow">Workflow</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="communications">Comms</TabsTrigger>
          <TabsTrigger value="communication-timeline" className="gap-2">
            <span>Case Timeline</span>
            {paymentVoucherCaseActiveCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-red-500 text-white text-[11px] px-2 py-0.5">
                {paymentVoucherCaseActiveCount}
              </span>
            )}
          </TabsTrigger>
          {canAccessClientInteraction && (
            <TabsTrigger value="client-interaction" className="gap-2">
              <span>Client Interaction</span>
              {unreadTotal > 0 && (
                <span className="inline-flex items-center rounded-full bg-red-500 text-white text-[11px] px-2 py-0.5">
                  {unreadTotal}
                </span>
              )}
            </TabsTrigger>
          )}
          {SHOW_COMPLIANCE_TAB && (
            <TabsTrigger value="compliance">Compliance</TabsTrigger>
          )}
          <TabsTrigger value="reference-history" className="gap-2">
            <Tag className="h-4 w-4" />
            <span>Ref History</span>
          </TabsTrigger>
          <TabsTrigger value="operations" className="gap-2">
            <Activity className="h-4 w-4" />
            <span>Operations</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="space-y-6 lg:col-span-2">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Property & Financial Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-500">Property / Project</div>
                      <div className="text-sm font-semibold text-slate-900">
                        {(() => {
                          const prop = typeof (propertyDetailsObj as any).propertyAddress === "string"
                            ? String((propertyDetailsObj as any).propertyAddress).trim()
                            : "";
                          const proj = String((caseInfo as any)?.projectName ?? "").trim();
                          return prop || proj || "—";
                        })()}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-500">Developer / Vendor</div>
                      <div className="text-sm font-semibold text-slate-900">
                        {String((caseInfo as any)?.developerName ?? "").trim() || "—"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-500">Purchase Mode</div>
                      <div className="text-sm font-semibold text-slate-900 capitalize">{String((caseInfo as any)?.purchaseMode ?? "") || "—"}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-500">Title Type</div>
                      <div className="text-sm font-semibold text-slate-900 capitalize">{String((caseInfo as any)?.titleType ?? "") || "—"}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-500">Purchase Price</div>
                      <div className="text-sm font-semibold text-slate-900">
                        {hasPurchasePrice ? fmtMoney(purchasePriceAmount) : "Not set"}
                      </div>
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <div className="text-xs font-medium text-slate-500">Purchase Price In Words</div>
                      <div className="text-sm font-semibold text-slate-900 break-words">
                        {purchasePriceWords || "Not set"}
                      </div>
                    </div>

                    {String((caseInfo as any)?.purchaseMode ?? "").trim().toLowerCase() === "loan" && (
                      <>
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-500">Loan Bank</div>
                          <div className="text-sm font-semibold text-slate-900">{loanBank || "—"}</div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-500">Financing Sum</div>
                          <div className="text-sm font-semibold text-slate-900">
                            {hasFinancingSum ? fmtMoney(financingSumRaw) : "Not set"}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-500">Others Total</div>
                          <div className="text-sm font-semibold text-slate-900">
                            {hasOthersTotal ? fmtMoney(loanAmounts.othersTotal) : "RM0.00"}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-500">Total Loan Amount</div>
                          <div className="text-sm font-semibold text-slate-900">
                            {hasTotalLoan ? fmtMoney(totalLoanAmount) : "Not set"}
                          </div>
                        </div>
                        <div className="space-y-1 md:col-span-2">
                          <div className="text-xs font-medium text-slate-500">Total Loan In Words</div>
                          <div className="text-sm font-semibold text-slate-900 break-words">
                            {totalLoanWords || "Not set"}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="mt-4 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
                    <div className="md:col-span-4 space-y-1.5">
                      <Label>Property Address *</Label>
                      <Input
                        value={propertyAddressDraft}
                        onChange={(e) => setPropertyAddressDraft(e.target.value)}
                        disabled={updateCaseMutation.isPending}
                        placeholder="Enter property address"
                      />
                    </div>
                    <div className="md:col-span-2 flex gap-2">
                      <Button
                        type="button"
                        disabled={updateCaseMutation.isPending}
                        onClick={() => {
                          const next = propertyAddressDraft.trim();
                          if (!next) {
                            toast({ title: "Property Address is required", variant: "destructive" });
                            return;
                          }
                          updateCaseMutation.mutate({
                            propertyDetails: {
                              ...propertyDetailsObj,
                              propertyAddress: next,
                            },
                          });
                        }}
                      >
                        {updateCaseMutation.isPending ? "Saving..." : "Save"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle>Firm Assignments</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-slate-500">Assigned Lawyer</div>
                      {canEditAssignments ? (
                        <div className="space-y-2">
                          {assignedLawyerIds.map((v, idx) => (
                            <div key={`lawyer-${idx}`} className="flex items-center gap-2">
                              <Select
                                value={v}
                                disabled={updateAssignmentsMutation.isPending}
                                onValueChange={(nextValue) => {
                                  const next = [...assignedLawyerIds];
                                  next[idx] = nextValue;
                                  setAssignedLawyerIds(next);
                                  saveAssignments(next, assignedClerkIds);
                                }}
                              >
                                <SelectTrigger className="h-9 text-sm border-slate-200 bg-white flex-1">
                                  <SelectValue placeholder="Select existing lawyer..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {lawyerOptions.map((u) => (
                                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {idx > 0 ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  className="h-9 w-9"
                                  disabled={updateAssignmentsMutation.isPending}
                                  onClick={() => {
                                    const next = assignedLawyerIds.filter((_, i) => i !== idx);
                                    setAssignedLawyerIds(next.length > 0 ? next : [""]);
                                    saveAssignments(next, assignedClerkIds);
                                  }}
                                  title="Remove"
                                >
                                  <Minus className="h-4 w-4" />
                                </Button>
                              ) : null}
                              {idx === assignedLawyerIds.length - 1 ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  className="h-9 w-9"
                                  disabled={updateAssignmentsMutation.isPending}
                                  onClick={() => setAssignedLawyerIds((prev) => [...prev, ""])}
                                  title="Add another lawyer"
                                >
                                  <Plus className="h-4 w-4" />
                                </Button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm font-semibold text-slate-900">
                          {safeAssignments.filter((a) => (a as any)?.roleInCase === "lawyer").map((a: any) => String(a?.userName ?? "").trim()).filter(Boolean).join(", ") || "Unassigned"}
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-slate-500">Assigned Clerk</div>
                      {canEditAssignments ? (
                        <div className="space-y-2">
                          {assignedClerkIds.map((v, idx) => (
                            <div key={`clerk-${idx}`} className="flex items-center gap-2">
                              <Select
                                value={v || "__none__"}
                                disabled={updateAssignmentsMutation.isPending}
                                onValueChange={(nextValue) => {
                                  const next = [...assignedClerkIds];
                                  next[idx] = nextValue === "__none__" ? "" : nextValue;
                                  setAssignedClerkIds(next);
                                  saveAssignments(assignedLawyerIds, next);
                                }}
                              >
                                <SelectTrigger className="h-9 text-sm border-slate-200 bg-white flex-1">
                                  <SelectValue placeholder="Select existing clerk..." />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">None</SelectItem>
                                  {clerkOptions.map((u) => (
                                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {idx > 0 ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  className="h-9 w-9"
                                  disabled={updateAssignmentsMutation.isPending}
                                  onClick={() => {
                                    const next = assignedClerkIds.filter((_, i) => i !== idx);
                                    setAssignedClerkIds(next.length > 0 ? next : [""]);
                                    saveAssignments(assignedLawyerIds, next);
                                  }}
                                  title="Remove"
                                >
                                  <Minus className="h-4 w-4" />
                                </Button>
                              ) : null}
                              {idx === assignedClerkIds.length - 1 ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  className="h-9 w-9"
                                  disabled={updateAssignmentsMutation.isPending}
                                  onClick={() => setAssignedClerkIds((prev) => [...prev, ""])}
                                  title="Add another clerk"
                                >
                                  <Plus className="h-4 w-4" />
                                </Button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm font-semibold text-slate-900">
                          {safeAssignments.filter((a) => (a as any)?.roleInCase === "clerk").map((a: any) => String(a?.userName ?? "").trim()).filter(Boolean).join(", ") || "Unassigned"}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card className="h-full">
                <CardHeader className="pb-3">
                  <CardTitle>Parties</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Purchasers</div>
                    <div className="space-y-3">
                      {safePurchasers.map((p: any, idx: number) => (
                        <div key={p?.id ?? `p-${idx}`} className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100">
                          <User className="w-5 h-5 text-slate-400 mt-0.5" />
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 break-words">{String(p?.clientName ?? "")}</div>
                            <div className="text-xs text-slate-500 break-words">{String(p?.icNo ?? "")}</div>
                            <span className="inline-block mt-1 px-2 py-0.5 text-[10px] uppercase font-semibold bg-white border border-slate-200 rounded text-slate-600">
                              {String(p?.role ?? "")} Purchaser
                            </span>
                          </div>
                        </div>
                      ))}
                      {safePurchasers.length === 0 ? (
                        <div className="text-sm text-slate-500">No purchasers.</div>
                      ) : null}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Borrowers</div>
                    <div className="space-y-3">
                      {safeBorrowers.map((b, idx) => (
                        <div key={`${b.name}-${idx}`} className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100">
                          <User className="w-5 h-5 text-slate-400 mt-0.5" />
                          <div className="min-w-0">
                            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Borrower {idx + 1}</div>
                            <div className="mt-0.5 font-medium text-slate-900 break-words">{b.name}</div>
                            {b.ic ? <div className="text-xs text-slate-500 break-words">IC: {b.ic}</div> : null}
                            {b.tin ? <div className="text-xs text-slate-500 break-words">TIN: {b.tin}</div> : null}
                            {b.phone ? <div className="text-xs text-slate-500 break-words">Phone: {b.phone}</div> : null}
                            {b.email ? <div className="text-xs text-slate-500 break-words">Email: {b.email}</div> : null}
                            {b.address ? <div className="mt-1 text-xs text-slate-500 break-words">{b.address}</div> : null}
                          </div>
                        </div>
                      ))}
                      {safeBorrowers.length === 0 ? (
                        <div className="text-sm text-slate-500">No borrowers.</div>
                      ) : null}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader>
              <div className="space-y-1">
                <CardTitle>Key Dates & Milestones</CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <Badge variant="outline" className="border-slate-200 text-slate-700">SPA: {spaStatus}</Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">Loan: {loanStatus}</Badge>
                  <Badge variant="outline" className={templateIssuesCount ? "border-red-200 text-red-700" : "border-emerald-200 text-emerald-700"}>
                    Print templates: {templateIssuesCount ? `${templateIssuesCount} issue(s)` : "All ready"}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">
                    Workflow: {workflowDone}/{workflowTotal}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">
                    SPA Date: {keyDatesDraft.spa_date ? formatYmdToDmy(keyDatesDraft.spa_date) : "—"}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">
                    LO Date: {keyDatesDraft.letter_of_offer_date ? formatYmdToDmy(keyDatesDraft.letter_of_offer_date) : "—"}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 text-slate-700">
                    Charge Stamped: {keyDatesDraft.charge_stamped ? formatYmdToDmy(keyDatesDraft.charge_stamped) : "—"}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {keyDatesQuery.isError ? (
                <QueryFallback title="Key dates unavailable" error={keyDatesQuery.error} onRetry={() => keyDatesQuery.refetch()} isRetrying={keyDatesQuery.isFetching} />
              ) : (
                <Accordion type="multiple" defaultValue={["spa", "loan", "titleWithConsent", "title"]} className="w-full">
                  <AccordionItem value="spa">
                    <AccordionTrigger className="text-slate-800">
                      <span className="flex items-center gap-2">SPA Status{dirtySpaStatus && <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}</span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="flex items-center justify-between pb-3">
                        <div className="text-sm font-semibold text-slate-800">SPA Status</div>
                        <Button
                          size="sm"
                          variant={dirtySpaStatus ? "default" : "outline"}
                          className={dirtySpaStatus ? "bg-amber-500 hover:bg-amber-600" : undefined}
                          onClick={() => saveScope("SPA Status")}
                          disabled={saveKeyDatesMutation.isPending || !dirtySpaStatus}
                        >
                          {saveKeyDatesMutation.isPending && savingScope === "SPA Status" ? "Saving..." : dirtySpaStatus ? "Save" : "Saved"}
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        <FieldCard label="SPA signing" value={keyDatesDraft.spa_signed_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, spa_signed_date: v }))} />
                        <FieldCard
                          label="SPA sent to dev for execution"
                          value={keyDatesDraft.spa_forward_to_developer_execution_on || ""}
                          onChange={(v) => setKeyDatesDraft((p) => ({ ...p, spa_forward_to_developer_execution_on: v }))}
                          printerKey="letter_send_spa_to_developer_execution"
                          alwaysShowPrinter
                        />
                        <FieldCard label="Received dev return SPA" value={keyDatesDraft.spa_received_dev_return_spa_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, spa_received_dev_return_spa_on: v }))} />
                        <FieldCard label="SPA date" value={keyDatesDraft.spa_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, spa_date: v }))} />
                        <WorkflowFileCard label="SPA stamping" docKey="spa_stamped" dateKey="spa_stamped_date" requireEvidenceUpload />
                        <FieldCard
                          label="Stamped SPA sent to dev"
                          value={keyDatesDraft.stamped_spa_send_to_developer_on || ""}
                          onChange={(v) => setKeyDatesDraft((p) => ({ ...p, stamped_spa_send_to_developer_on: v }))}
                          printerKey="letter_send_stamped_spa_to_developer"
                          alwaysShowPrinter
                        />
                        <FieldCard
                          label="Stamped SPA sent to Pur"
                          value={keyDatesDraft.stamped_spa_sent_to_purchaser_on || ""}
                          onChange={(v) => setKeyDatesDraft((p) => ({ ...p, stamped_spa_sent_to_purchaser_on: v }))}
                          printerKey="letter_send_stamped_spa_to_purchaser"
                          alwaysShowPrinter
                        />
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="loan">
                    <AccordionTrigger className="text-slate-800">
                      <span className="flex items-center gap-2">Loan Status{dirtyLoanStatus && <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}</span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="flex items-center justify-between pb-3">
                        <div className="text-sm font-semibold text-slate-800">Loan Status</div>
                        <Button
                          size="sm"
                          variant={dirtyLoanStatus ? "default" : "outline"}
                          className={dirtyLoanStatus ? "bg-amber-500 hover:bg-amber-600" : undefined}
                          onClick={() => saveScope("Loan Status")}
                          disabled={saveKeyDatesMutation.isPending || !dirtyLoanStatus}
                        >
                          {saveKeyDatesMutation.isPending && savingScope === "Loan Status" ? "Saving..." : dirtyLoanStatus ? "Save" : "Saved"}
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        <FieldCard label="LI Date" value={keyDatesDraft.li_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, li_date: v }))} />
                        <FieldCard label="LI received" value={keyDatesDraft.li_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, li_received_on: v }))} />
                        <FieldCard label="LO Date" value={keyDatesDraft.letter_of_offer_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_of_offer_date: v }))} />
                        <WorkflowFileCard label="LO Stamping date" docKey="lo_stamped" dateKey="letter_of_offer_stamped_date" requireEvidenceUpload evidenceLabel="Stamped LO (PDF)" />
                        <FieldCard
                          label="Acting Letter dated"
                          value={keyDatesDraft.acting_letter_issued_date || ""}
                          onChange={(v) => setKeyDatesDraft((p) => ({ ...p, acting_letter_issued_date: v }))}
                          printerKey="acting_letter"
                          alwaysShowPrinter
                          disabled={!(keyDatesDraft.letter_of_offer_stamped_date && workflowDocsByKey.get("lo_stamped"))}
                          required={Boolean(keyDatesDraft.letter_of_offer_stamped_date && workflowDocsByKey.get("lo_stamped"))}
                        />
                        <FieldCard
                          label="Bank execution dated"
                          value={keyDatesDraft.loan_bank_executed_date || ""}
                          onChange={(v) => setKeyDatesDraft((p) => ({ ...p, loan_bank_executed_date: v }))}
                          printerKey="letter_forward_bank_execution"
                          alwaysShowPrinter
                          disabled={!(keyDatesDraft.spa_stamped_date && workflowDocsByKey.get("spa_stamped") && keyDatesDraft.letter_of_offer_stamped_date && workflowDocsByKey.get("lo_stamped"))}
                          required={Boolean(keyDatesDraft.spa_stamped_date && workflowDocsByKey.get("spa_stamped") && keyDatesDraft.letter_of_offer_stamped_date && workflowDocsByKey.get("lo_stamped"))}
                        />
                        <FieldCard label="Received Executed document on" value={keyDatesDraft.received_executed_document_on_1 || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, received_executed_document_on_1: v }))} />
                        <FieldCard label="Received Unexecuted document on" value={keyDatesDraft.received_unexecuted_document_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, received_unexecuted_document_on: v }))} />
                        <FieldCard label="Re-Sent Bank execution dated" value={keyDatesDraft.resent_bank_execution_dated || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, resent_bank_execution_dated: v }))} />
                        <FieldCard label="Received Executed document on (2)" value={keyDatesDraft.received_executed_document_on_2 || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, received_executed_document_on_2: v }))} />
                        <FieldCard label="Developer Confirmation receive on" value={keyDatesDraft.developer_confirmation_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, developer_confirmation_received_on: v }))} />
                        <FieldCard label="Developer Confirmation dated" value={keyDatesDraft.developer_confirmation_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, developer_confirmation_date: v }))} />
                        <FieldCard
                          label="Differential Sum (RM)"
                          type="number"
                          value={keyDatesDraft.differential_sum_rm || ""}
                          onChange={(v) => setKeyDatesDraft((p) => ({ ...p, differential_sum_rm: v }))}
                          required={Boolean(keyDatesDraft.developer_confirmation_date)}
                        />
                        <FieldCard label="Differential Sum Settled ON" value={keyDatesDraft.differential_sum_settled_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, differential_sum_settled_on: v }))} />
                        <FieldCard label="Redemption Sum (RM)" type="number" value={keyDatesDraft.redemption_sum || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, redemption_sum: v }))} />
                        <FieldCard label="Balance Sum (LESS LAST 5%)" type="number" value={keyDatesDraft.balance_sum_less_last_5_rm || ""} onChange={() => {}} readOnly />
                        <FieldCard label="Bankruptcy Search Dated" value={keyDatesDraft.bankruptcy_search_dated || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, bankruptcy_search_dated: v }))} />
                      </div>

                      <div className="pt-6 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-slate-800">Supp LO / LON / LOV</div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            onClick={addSuppLoDocDraft}
                            disabled={!canDocsUpdate}
                          >
                            <Plus className="w-4 h-4" />
                            Add Document
                          </Button>
                        </div>
                        {suppLoDocsQuery.isError ? (
                          <QueryFallback title="Supplementary loan documents unavailable" error={suppLoDocsQuery.error} onRetry={() => suppLoDocsQuery.refetch()} isRetrying={suppLoDocsQuery.isFetching} />
                        ) : (
                          <div className="space-y-2">
                            {suppLoDocsDraft.length === 0 ? (
                              <div className="text-sm text-slate-500">No supplementary documents.</div>
                            ) : null}
                            {suppLoDocsDraft.map((row) => {
                              const pending = Boolean(row.documentDate) && !row.fileName;
                              return (
                                <div key={row.rowKey} className="rounded-lg border border-slate-200 bg-white p-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div className="text-xs text-slate-600 truncate" title={row.documentName || "Untitled"}>
                                        {row.documentName || "Untitled"}
                                      </div>
                                      {pending ? (
                                        <Badge variant="destructive" className="text-[10px] whitespace-nowrap">incomplete</Badge>
                                      ) : null}
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      {canDocsRead && row.id && row.fileName ? (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8"
                                          title="Download"
                                          onClick={() => downloadSuppLoDoc(row)}
                                          disabled={suppLoDownloadingId === row.id}
                                        >
                                          <Download className="w-4 h-4" />
                                        </Button>
                                      ) : null}
                                      {canDocsWrite ? (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8"
                                          title="Upload"
                                          onClick={() => { void openSuppLoUpload(row.rowKey); }}
                                          disabled={suppLoUploadingRowKey === row.rowKey || createSuppLoDocMutation.isPending || patchSuppLoDocMutation.isPending}
                                        >
                                          <Upload className="w-4 h-4" />
                                        </Button>
                                      ) : null}
                                      {canDocsUpdate ? (
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-8 w-8 text-red-600"
                                          title="Delete"
                                          onClick={() => {
                                            if (!row.id) {
                                              setSuppLoDocsDraft((prev) => prev.filter((x) => x.rowKey !== row.rowKey));
                                              return;
                                            }
                                            deleteSuppLoDocMutation.mutate(row.id, {
                                              onSuccess: () => setSuppLoDocsDraft((prev) => prev.filter((x) => x.id !== row.id)),
                                            });
                                          }}
                                          disabled={deleteSuppLoDocMutation.isPending}
                                        >
                                          <Trash2 className="w-4 h-4" />
                                        </Button>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <div className="space-y-1">
                                      <Label className="text-xs text-slate-600">Document Name</Label>
                                      <Input
                                        value={row.documentName}
                                        onChange={(e) => {
                                          const next = e.target.value;
                                          setSuppLoDocsDraft((prev) => prev.map((x) => x.rowKey === row.rowKey ? { ...x, documentName: next } : x));
                                        }}
                                        onBlur={() => {
                                          const name = row.documentName.trim();
                                          if (!name) return;
                                          if (row.id == null) {
                                            void ensureSuppLoDocCreated(row.rowKey);
                                            return;
                                          }
                                          patchSuppLoDocMutation.mutate({ id: row.id, patch: { documentName: name } });
                                        }}
                                        disabled={!canDocsUpdate}
                                      />
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs text-slate-600">Date</Label>
                                      <DateOnlyInput
                                        valueYmd={row.documentDate}
                                        onChangeYmd={(v) => setSuppLoDocsDraft((prev) => prev.map((x) => x.rowKey === row.rowKey ? { ...x, documentDate: v } : x))}
                                        disabled={!canDocsUpdate}
                                      />
                                      <div className="text-[10px] text-slate-500 truncate" title={row.fileName ?? "No file uploaded"}>
                                        {row.fileName ?? "No file uploaded"}
                                      </div>
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs text-slate-600">Save</Label>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="w-full"
                                        onClick={() => {
                                          const name = row.documentName.trim();
                                          if (!name) {
                                            toast({ title: "Document Name required", variant: "destructive" });
                                            return;
                                          }
                                          if (row.id == null) {
                                            void ensureSuppLoDocCreated(row.rowKey);
                                            return;
                                          }
                                          patchSuppLoDocMutation.mutate({
                                            id: row.id,
                                            patch: { documentName: name, documentDate: row.documentDate ? row.documentDate : null, sortOrder: row.sortOrder },
                                          });
                                        }}
                                        disabled={!canDocsUpdate || createSuppLoDocMutation.isPending || patchSuppLoDocMutation.isPending}
                                      >
                                        Save
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="pt-6 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-slate-800">Bank's LU & DEV. LU</div>
                          <div className="flex items-center gap-2">
                            <Label className="text-xs text-slate-600">Exempted (Master LU)</Label>
                            <Checkbox
                              checked={Boolean(keyDatesDraft.master_lu_exempted)}
                              onCheckedChange={(checked) => {
                                const next = checked === true;
                                setKeyDatesDraft((p) => ({
                                  ...p,
                                  master_lu_exempted: next,
                                  bank_lu_dated: next ? "" : (p.bank_lu_dated || ""),
                                  bank_lu_received_date: next ? "" : (p.bank_lu_received_date || ""),
                                  bank_lu_forward_to_developer_on: next ? "" : (p.bank_lu_forward_to_developer_on || ""),
                                  developer_lu_received_on: next ? "" : (p.developer_lu_received_on || ""),
                                  developer_lu_dated: next ? "" : (p.developer_lu_dated || ""),
                                }));
                              }}
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          <FieldCard label="Bank's LU dated" value={keyDatesDraft.bank_lu_dated || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, bank_lu_dated: v }))} disabled={Boolean(keyDatesDraft.master_lu_exempted)} />
                          <FieldCard label="Bank's LU received on" value={keyDatesDraft.bank_lu_received_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, bank_lu_received_date: v }))} disabled={Boolean(keyDatesDraft.master_lu_exempted)} />
                          <FieldCard label="Bank's LU sent to developer ON" value={keyDatesDraft.bank_lu_forward_to_developer_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, bank_lu_forward_to_developer_on: v }))} printerKey="letter_forward_bank_lu_to_dev" disabled={Boolean(keyDatesDraft.master_lu_exempted)} />
                          <FieldCard label="DEV. LU RECEIVED ON" value={keyDatesDraft.developer_lu_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, developer_lu_received_on: v }))} disabled={Boolean(keyDatesDraft.master_lu_exempted)} />
                          <FieldCard label="DEV. LU DATED" value={keyDatesDraft.developer_lu_dated || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, developer_lu_dated: v }))} disabled={Boolean(keyDatesDraft.master_lu_exempted)} />
                        </div>
                      </div>

                      <div className="pt-6 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-slate-800">Disclaimer Letter</div>
                          <div className="flex items-center gap-2">
                            <Label className="text-xs text-slate-600">Exempted (Free from encumbrances)</Label>
                            <Checkbox
                              checked={Boolean(keyDatesDraft.encumbrance_free_exempted)}
                              onCheckedChange={(checked) => {
                                const next = checked === true;
                                setKeyDatesDraft((p) => ({
                                  ...p,
                                  encumbrance_free_exempted: next,
                                  letter_disclaimer_received_on: next ? "" : (p.letter_disclaimer_received_on || ""),
                                  letter_disclaimer_dated: next ? "" : (p.letter_disclaimer_dated || ""),
                                  letter_disclaimer_reference_nos: next ? "" : (p.letter_disclaimer_reference_nos || ""),
                                }));
                              }}
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          <FieldCard label="Disclaimer Letter receive on" value={keyDatesDraft.letter_disclaimer_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_received_on: v }))} disabled={Boolean(keyDatesDraft.encumbrance_free_exempted)} />
                          <WorkflowFileCard label="Disclaimer Letter Dated" docKey="letter_disclaimer" dateKey="letter_disclaimer_dated" disabled={Boolean(keyDatesDraft.encumbrance_free_exempted)} />
                          <FieldCard label="Disclaimer Lttr Ref. No" type="text" value={keyDatesDraft.letter_disclaimer_reference_nos || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, letter_disclaimer_reference_nos: v }))} disabled={Boolean(keyDatesDraft.encumbrance_free_exempted)} />
                        </div>
                      </div>

                      <div className="pt-6 space-y-3">
                        <div className="text-sm font-semibold text-slate-800">STAMPING SESSION</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          <FieldCard label="STATUTORY DECLARATION DATED" value={keyDatesDraft.statutory_declaration_dated || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, statutory_declaration_dated: v }))} />
                          <FieldCard label="STATUTORY DECLARATION STAMPED ON" value={keyDatesDraft.statutory_declaration_stamped_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, statutory_declaration_stamped_on: v }))} />
                          <FieldCard label="FA DATE" value={keyDatesDraft.fa_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, fa_date: v }))} />
                          <FieldCard label="FA ADJUDICATION NUMBER" type="text" value={keyDatesDraft.fa_adjudication_number || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, fa_adjudication_number: v }))} />
                          <FieldCard label="FA STAMP ON" value={keyDatesDraft.fa_stamp_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, fa_stamp_on: v }))} />
                          <FieldCard label="DOA DATE" value={keyDatesDraft.doa_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, doa_date: v }))} />
                          <FieldCard label="DOA STAMP ON" value={keyDatesDraft.doa_stamp_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, doa_stamp_on: v }))} />
                          <FieldCard label="POA DATE" value={keyDatesDraft.poa_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, poa_date: v }))} />
                          <FieldCard label="POA STAMP ON" value={keyDatesDraft.poa_stamp_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, poa_stamp_on: v }))} />
                          <FieldCard label="NOA DATED" value={keyDatesDraft.noa_dated || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, noa_dated: v }))} />
                          <FieldCard
                            label="Presentation Number"
                            type="text"
                            value={keyDatesDraft.registered_poa_registration_number || ""}
                            onChange={(v) => setKeyDatesDraft((p) => ({ ...p, registered_poa_registration_number: v }))}
                            required={Boolean(keyDatesDraft.register_poa_on)}
                          />
                          <WorkflowFileCard label="Registered Power of Attorney" docKey="register_poa" dateKey="register_poa_on" requireEvidenceUpload evidenceLabel="Registered POA (PDF)" />
                        </div>
                      </div>

                      <div className="pt-6 space-y-3">
                        <div className="text-sm font-semibold text-slate-800">COMPLETION SESSION</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {(() => {
                            const prereqsOk =
                              Boolean(keyDatesDraft.differential_sum_settled_on) &&
                              Boolean(keyDatesDraft.noa_dated) &&
                              Boolean(keyDatesDraft.register_poa_on) &&
                              Boolean(keyDatesDraft.registered_poa_registration_number) &&
                              Boolean(workflowDocsByKey.get("register_poa"));
                            const locked = !prereqsOk;
                            const adviceVal = keyDatesDraft.advice_to_bank_date || "";
                            const activatedAtIso = typeof keyDatesDraft.completion_sla_activated_at === "string" ? keyDatesDraft.completion_sla_activated_at : "";
                            const hoursElapsed = (() => {
                              if (!activatedAtIso) return 0;
                              const ms = Date.now() - new Date(activatedAtIso).getTime();
                              return Number.isFinite(ms) ? Math.max(0, ms / 3600_000) : 0;
                            })();
                            const tag = (() => {
                              if (locked) return { label: "Locked", tone: "amber" as const };
                              if (adviceVal) return null;
                              if (hoursElapsed >= 72) return { label: "Overdue", tone: "red" as const };
                              if (hoursElapsed >= 48) return { label: "Soon", tone: "amber" as const };
                              return { label: "Due", tone: "green" as const };
                            })();
                            return (
                              <FieldCard
                                label="ADVICE ON"
                                value={adviceVal}
                                onChange={(v) => setKeyDatesDraft((p) => ({ ...p, advice_to_bank_date: v }))}
                                printerKey="letter_advice_spa_sol_lu"
                                disabled={locked}
                                required={prereqsOk}
                                statusTag={tag ?? undefined}
                              />
                            );
                          })()}
                          <FieldCard label="1ST RELEASE ON" value={keyDatesDraft.bank_1st_release_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, bank_1st_release_on: v }))} />
                          <FieldCard label="1ST PAYMENT AMOUNT" type="number" value={keyDatesDraft.first_release_amount_rm || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, first_release_amount_rm: v }))} />
                        </div>
                      </div>

                      <Card className="mt-6">
                        <CardHeader className="flex flex-row items-center justify-between gap-3">
                          <div className="min-w-0">
                            <CardTitle className="text-sm">Stamping Documents</CardTitle>
                            {progressQuery.data?.stamping && (
                              <div className="mt-1 text-xs text-slate-600 break-words">
                                {progressQuery.data.stamping.completed}/{progressQuery.data.stamping.total} completed
                                {Array.isArray(progressQuery.data.stamping.missing) && progressQuery.data.stamping.missing.length > 0 && (
                                  <span className="ml-2">
                                    Missing: {progressQuery.data.stamping.missing
                                      .slice(0, 4)
                                      .map((m: any) => `${m.itemKey}(${String(m.status).replace(/_/g, " ")})`)
                                      .join(", ")}
                                    {progressQuery.data.stamping.missing.length > 4 ? "…" : ""}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              onClick={addStampingOtherRow}
                              disabled={!canDocsUpdate}
                            >
                              <Plus className="w-4 h-4" />
                              Add Another Document
                            </Button>
                            <Button
                              size="sm"
                              variant={stampingDirty ? "default" : "outline"}
                              className={stampingDirty ? "bg-amber-500 hover:bg-amber-600" : undefined}
                              onClick={saveStamping}
                              disabled={!canDocsUpdate || saveStampingMutation.isPending || !stampingDirty}
                            >
                              {saveStampingMutation.isPending ? "Saving..." : stampingDirty ? "Save Stamping" : "Saved"}
                            </Button>
                          </div>
                        </CardHeader>
                        <CardContent>
                          {loanStampingQuery.isError ? (
                            <QueryFallback title="Stamping unavailable" error={loanStampingQuery.error} onRetry={() => loanStampingQuery.refetch()} isRetrying={loanStampingQuery.isFetching} />
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full min-w-[980px] text-sm">
                                <thead className="bg-slate-50 border-b">
                                  <tr>
                                    <th className="text-left px-3 py-2 font-medium text-slate-600 w-[320px]">Document</th>
                                    <th className="text-left px-3 py-2 font-medium text-slate-600 w-[180px]">Dated</th>
                                    <th className="text-left px-3 py-2 font-medium text-slate-600 w-[180px]">Stamped On</th>
                                    <th className="text-left px-3 py-2 font-medium text-slate-600">File</th>
                                    <th className="text-right px-3 py-2 font-medium text-slate-600 w-[140px]">Actions</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y">
                                  {visibleStampingItems.fixed.map((row) => (
                                    <tr key={`fixed-${row.itemKey}`}>
                                      <td className="px-3 py-2 font-medium text-slate-800">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <span className="truncate">{fixedStampingKeys.find((x) => x.key === row.itemKey)?.label}</span>
                                          {Array.isArray(progressQuery.data?.stampingItems) && (
                                            (() => {
                                              const st = progressQuery.data.stampingItems.find((x: any) => x?.itemKey === row.itemKey && (row.id ? x?.id === row.id : true));
                                              return st?.status ? (
                                                <Badge variant={st.status === "completed" ? "default" : "outline"} className="text-[10px] whitespace-nowrap">
                                                  {String(st.status).replace(/_/g, " ")}
                                                </Badge>
                                              ) : null;
                                            })()
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3 py-2">
                                        <DateOnlyInput disabled={!canDocsUpdate} valueYmd={row.datedOn || ""} onChangeYmd={(v) => upsertStampingItem({ ...row, datedOn: v || null })} />
                                      </td>
                                      <td className="px-3 py-2">
                                        <DateOnlyInput disabled={!canDocsUpdate} valueYmd={row.stampedOn || ""} onChangeYmd={(v) => upsertStampingItem({ ...row, stampedOn: v || null })} />
                                      </td>
                                      <td className="px-3 py-2">
                                        <div className="truncate text-slate-600" title={row.fileName || "No file uploaded"}>{row.fileName || "No file uploaded"}</div>
                                      </td>
                                      <td className="px-3 py-2 text-right">
                                        <div className="inline-flex items-center gap-1">
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-8 w-8"
                                            title="Download"
                                            disabled={!canDocsRead || !row.id || !row.fileName || stampingDownloadingId === row.id}
                                            onClick={() => downloadStampingFile(row)}
                                          >
                                            <Download className="w-4 h-4" />
                                          </Button>
                                          {canDocsUpdate && (
                                            <Button
                                              size="icon"
                                              variant="ghost"
                                              className="h-8 w-8"
                                              title="Upload/Replace"
                                              disabled={ensureStampingItemMutation.isPending || stampingUploadingId === row.id}
                                              onClick={() => openStampingUpload(row)}
                                            >
                                              <Upload className="w-4 h-4" />
                                            </Button>
                                          )}
                                          {canDocsUpdate && (
                                            <Button
                                              size="icon"
                                              variant="ghost"
                                              className="h-8 w-8 text-red-600"
                                              title="Remove file"
                                              disabled={!row.id || !row.fileName || clearStampingFileMutation.isPending}
                                              onClick={() => row.id && clearStampingFileMutation.mutate(row.id)}
                                            >
                                              <X className="w-4 h-4" />
                                            </Button>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                  {visibleStampingItems.others.map((row) => (
                                    <tr key={`other-${row.id ?? row.sortOrder}`}>
                                      <td className="px-3 py-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                          <Input
                                            className="min-w-0"
                                            value={row.customName ?? ""}
                                            placeholder="Other document name"
                                            onChange={(e) => upsertStampingItem({ ...row, customName: e.target.value })}
                                            disabled={!canDocsUpdate}
                                          />
                                          {Array.isArray(progressQuery.data?.stampingItems) && (
                                            (() => {
                                              const st = progressQuery.data.stampingItems.find((x: any) => x?.itemKey === "other" && (row.id ? x?.id === row.id : x?.sortOrder === row.sortOrder));
                                              return st?.status ? (
                                                <Badge variant={st.status === "completed" ? "default" : "outline"} className="text-[10px] whitespace-nowrap">
                                                  {String(st.status).replace(/_/g, " ")}
                                                </Badge>
                                              ) : null;
                                            })()
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3 py-2">
                                        <DateOnlyInput disabled={!canDocsUpdate} valueYmd={row.datedOn || ""} onChangeYmd={(v) => upsertStampingItem({ ...row, datedOn: v || null })} />
                                      </td>
                                      <td className="px-3 py-2">
                                        <DateOnlyInput disabled={!canDocsUpdate} valueYmd={row.stampedOn || ""} onChangeYmd={(v) => upsertStampingItem({ ...row, stampedOn: v || null })} />
                                      </td>
                                      <td className="px-3 py-2">
                                        <div className="truncate text-slate-600" title={row.fileName || "No file uploaded"}>{row.fileName || "No file uploaded"}</div>
                                      </td>
                                      <td className="px-3 py-2 text-right">
                                        <div className="inline-flex items-center gap-1">
                                          <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-8 w-8"
                                            title="Download"
                                            disabled={!canDocsRead || !row.id || !row.fileName || stampingDownloadingId === row.id}
                                            onClick={() => downloadStampingFile(row)}
                                          >
                                            <Download className="w-4 h-4" />
                                          </Button>
                                          {canDocsUpdate && (
                                            <Button
                                              size="icon"
                                              variant="ghost"
                                              className="h-8 w-8"
                                              title="Upload/Replace"
                                              disabled={ensureStampingItemMutation.isPending || stampingUploadingId === row.id}
                                              onClick={() => openStampingUpload(row)}
                                            >
                                              <Upload className="w-4 h-4" />
                                            </Button>
                                          )}
                                          {(row.fileName ? canDocsUpdate : row.id ? canDocsDelete : canDocsUpdate) ? (
                                            <Button
                                              size="icon"
                                              variant="ghost"
                                              className="h-8 w-8 text-red-600"
                                              title={row.fileName ? "Remove file" : "Remove row"}
                                              disabled={clearStampingFileMutation.isPending || deleteStampingRowMutation.isPending}
                                              onClick={() => {
                                                if (row.fileName && row.id) {
                                                  clearStampingFileMutation.mutate(row.id);
                                                  return;
                                                }
                                                if (row.id) {
                                                  deleteStampingRowMutation.mutate(row.id);
                                                  return;
                                                }
                                                removeUnsavedStampingOther(row.sortOrder);
                                              }}
                                            >
                                              <X className="w-4 h-4" />
                                            </Button>
                                          ) : null}
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="titleWithConsent">
                    <AccordionTrigger className="text-slate-800">
                      <span className="flex items-center gap-2">Title Case with Consent{dirtyTitleWithConsent && <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}</span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="flex items-center justify-between pb-3">
                        <div className="text-sm font-semibold text-slate-800">Title Case with Consent</div>
                        <Button
                          size="sm"
                          variant={dirtyTitleWithConsent ? "default" : "outline"}
                          className={dirtyTitleWithConsent ? "bg-amber-500 hover:bg-amber-600" : undefined}
                          onClick={() => saveScope("Title Case with Consent")}
                          disabled={saveKeyDatesMutation.isPending || !dirtyTitleWithConsent}
                        >
                          {saveKeyDatesMutation.isPending && savingScope === "Title Case with Consent" ? "Saving..." : dirtyTitleWithConsent ? "Save" : "Saved"}
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        <FieldCard label="Request Letter of NO Objection" value={keyDatesDraft.request_letter_no_objection || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, request_letter_no_objection: v }))} />
                        <FieldCard label="Received Letter of NO Objection ON" value={keyDatesDraft.received_letter_no_objection_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, received_letter_no_objection_on: v }))} />
                        <FieldCard label="Blanket Consent / Consent Transfer Req." value={keyDatesDraft.blanket_consent_transfer_req || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, blanket_consent_transfer_req: v }))} />
                        <FieldCard label="Blanket Consent / Consent Transfer approval" value={keyDatesDraft.blanket_consent_transfer_approval || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, blanket_consent_transfer_approval: v }))} />
                        <FieldCard label="Consent to Charge Req." value={keyDatesDraft.consent_to_charge_req || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, consent_to_charge_req: v }))} />
                        <FieldCard label="Consent to Charge approval" value={keyDatesDraft.consent_to_charge_approval || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, consent_to_charge_approval: v }))} />
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="title">
                    <AccordionTrigger className="text-slate-800">
                      <span className="flex items-center gap-2">Title Case{dirtyTitleCase && <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />}</span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="flex items-center justify-between pb-3">
                        <div className="text-sm font-semibold text-slate-800">Title Case</div>
                        <Button
                          size="sm"
                          variant={dirtyTitleCase ? "default" : "outline"}
                          className={dirtyTitleCase ? "bg-amber-500 hover:bg-amber-600" : undefined}
                          onClick={() => saveScope("Title Case")}
                          disabled={saveKeyDatesMutation.isPending || !dirtyTitleCase}
                        >
                          {saveKeyDatesMutation.isPending && savingScope === "Title Case" ? "Saving..." : dirtyTitleCase ? "Save" : "Saved"}
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        <FieldCard label="Discharge sent to ON" value={keyDatesDraft.request_discharge_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, request_discharge_date: v }))} />
                        <FieldCard label="Discharge & Title Received ON" value={keyDatesDraft.discharge_title_received_on || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, discharge_title_received_on: v }))} />
                        <FieldCard label="Discharge Date" value={keyDatesDraft.discharge_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, discharge_date: v }))} />
                        <FieldCard label="MOT Date" value={keyDatesDraft.mot_signed_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, mot_signed_date: v }))} />
                        <FieldCard label="MOT Submit Stamping" value={keyDatesDraft.mot_submit_stamping || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, mot_submit_stamping: v }))} />
                        <FieldCard label="MOT Stamped" value={keyDatesDraft.mot_stamped_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, mot_stamped_date: v }))} />
                        <FieldCard label="Charge Date" value={keyDatesDraft.charge_date || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, charge_date: v }))} />
                        <FieldCard label="Charge Submit Stamping" value={keyDatesDraft.charge_submit_stamping || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, charge_submit_stamping: v }))} />
                        <FieldCard label="Charge Stamped" value={keyDatesDraft.charge_stamped || ""} onChange={(v) => setKeyDatesDraft((p) => ({ ...p, charge_stamped: v }))} />
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="workflow" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Workflow Attachments</CardTitle>
            </CardHeader>
            <CardContent className="min-w-0">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 min-w-0">
                {visibleWorkflowAttachmentItems.map((it) => (
                  <WorkflowFileCard key={it.docKey} label={it.label} docKey={it.docKey} dateKey={it.dateKey} />
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Conveyancing Workflow</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-8">
                {/* Common Steps */}
                <div>
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs">1</span>
                    Initial SPA Stage
                  </h3>
                  <div className="space-y-3 pl-3 border-l-2 border-slate-200 ml-3">
                    {commonSteps.map(step => (
                      <div key={step.id} className="relative pl-6">
                        <div className={`absolute -left-[23px] top-1 w-5 h-5 rounded-full border-2 bg-white flex items-center justify-center ${
                          step.status === 'completed' ? 'border-amber-500' : 'border-slate-300'
                        }`}>
                          {step.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-amber-500" />}
                        </div>
                        
                        <div className={`p-4 rounded-lg border ${
                          step.status === 'completed' ? 'bg-amber-50/30 border-amber-100' : 'bg-white border-slate-200 shadow-sm'
                        }`}>
                          <div className="flex justify-between items-start mb-2">
                            <h4 className="font-semibold text-slate-900">{step.stepName}</h4>
                            <span className="text-xs text-slate-500">
                              {step.status === "completed"
                                ? `Done by ${step.completedByName}`
                                : (Array.isArray(progressQuery.data?.workflowSteps)
                                  ? (progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus
                                    ? String(progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus).replace(/_/g, " ")
                                    : "Pending")
                                  : "Pending")}
                            </span>
                          </div>
                          
                          {step.status === 'completed' && step.notes && (
                            <p className="text-sm text-slate-600 mt-2 italic border-l-2 border-amber-200 pl-2">"{step.notes}"</p>
                          )}

                          {step.status !== 'completed' && activeStepId === step.id && (
                            <div className="mt-4 space-y-3">
                              <Textarea 
                                placeholder="Add optional notes for this step..." 
                                value={stepNote}
                                onChange={e => setStepNote(e.target.value)}
                                className="text-sm"
                              />
                              <div className="flex gap-2">
                                <Button size="sm" onClick={() => handleCompleteStep(step.id)} disabled={updateStepMutation.isPending}>
                                  Confirm Completion
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setActiveStepId(null)}>Cancel</Button>
                              </div>
                            </div>
                          )}

                          {step.status !== "completed"
                            && activeStepId !== step.id
                            && !(Array.isArray(progressQuery.data?.workflowSteps) && progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus)
                            && (
                              <Button size="sm" variant="secondary" className="mt-2 text-xs" onClick={() => setActiveStepId(step.id)}>
                                Mark Complete
                              </Button>
                            )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Loan Steps */}
                {loanSteps.length > 0 && (
                  <div>
                    <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs">2</span>
                      Loan Stage
                    </h3>
                    <div className="space-y-3 pl-3 border-l-2 border-slate-200 ml-3">
                      {loanSteps.map(step => (
                        <div key={step.id} className="relative pl-6">
                           <div className={`absolute -left-[23px] top-1 w-5 h-5 rounded-full border-2 bg-white flex items-center justify-center ${
                            step.status === 'completed' ? 'border-amber-500' : 'border-slate-300'
                          }`}>
                            {step.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-amber-500" />}
                          </div>
                          
                          <div className={`p-4 rounded-lg border ${
                            step.status === 'completed' ? 'bg-amber-50/30 border-amber-100' : 'bg-white border-slate-200 shadow-sm'
                          }`}>
                            <div className="flex justify-between items-start mb-2">
                              <h4 className="font-semibold text-slate-900">{step.stepName}</h4>
                              <span className="text-xs text-slate-500">
                                {step.status === "completed"
                                  ? "Completed"
                                  : (Array.isArray(progressQuery.data?.workflowSteps)
                                    ? (progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus
                                      ? String(progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus).replace(/_/g, " ")
                                      : "Pending")
                                    : "Pending")}
                              </span>
                            </div>
                            
                            {step.status !== 'completed' && activeStepId === step.id && (
                              <div className="mt-4 space-y-3">
                                <Textarea 
                                  placeholder="Add optional notes for this step..." 
                                  value={stepNote}
                                  onChange={e => setStepNote(e.target.value)}
                                  className="text-sm"
                                />
                                <div className="flex gap-2">
                                  <Button size="sm" onClick={() => handleCompleteStep(step.id)} disabled={updateStepMutation.isPending}>
                                    Confirm Completion
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={() => setActiveStepId(null)}>Cancel</Button>
                                </div>
                              </div>
                            )}

                            {step.status !== "completed"
                              && activeStepId !== step.id
                              && !(Array.isArray(progressQuery.data?.workflowSteps) && progressQuery.data.workflowSteps.find((x: any) => x?.stepKey === step.stepKey)?.derivedStatus)
                              && (
                                <Button size="sm" variant="secondary" className="mt-2 text-xs" onClick={() => setActiveStepId(step.id)}>
                                  Mark Complete
                                </Button>
                              )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents">
          <ErrorBoundary title="Documents tab crashed" description="This error is isolated to the Documents tab. Retry or refresh to continue.">
            <CaseDocumentsTab caseId={caseId} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="billing">
          <CaseBillingTab caseId={caseId} />
        </TabsContent>

        <TabsContent value="ledger" className="space-y-6">
          <CaseLedgerTab caseId={caseId} />
        </TabsContent>

        <TabsContent value="communications">
          <CaseCommunicationsTab caseId={caseId} initialThreadId={initialThreadId} />
        </TabsContent>

        <TabsContent value="communication-timeline">
          <CaseCommunicationTimelineTab caseId={caseId} />
        </TabsContent>

        {canAccessClientInteraction && (
          <TabsContent value="client-interaction" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Client Interaction</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Tabs value={interactionChannel} onValueChange={(v) => setInteractionChannel(v === "developer" ? "developer" : "client")} className="w-full">
                  <TabsList className="w-full justify-start">
                    <TabsTrigger value="client" className="gap-2">
                      <span>Client Chat</span>
                      {unreadClient > 0 && (
                        <span className="inline-flex items-center rounded-full bg-red-500 text-white text-[11px] px-2 py-0.5">
                          {unreadClient}
                        </span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="developer" className="gap-2">
                      <span>Developer Chat</span>
                      {unreadDeveloper > 0 && (
                        <span className="inline-flex items-center rounded-full bg-red-500 text-white text-[11px] px-2 py-0.5">
                          {unreadDeveloper}
                        </span>
                      )}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                {caseMessagesQuery.isLoading && (
                  <div className="text-sm text-slate-500">Loading messages...</div>
                )}
                {caseMessagesQuery.isError && (
                  <div className="text-sm text-red-600">Failed to load messages.</div>
                )}
                {!caseMessagesQuery.isLoading && !caseMessagesQuery.isError && (
                  <div className="space-y-2">
                    {(Array.isArray(caseMessagesQuery.data?.data) ? caseMessagesQuery.data!.data : []).map((m) => {
                      const isExternal = m.senderType !== "staff";
                      return (
                        <div key={m.id} className={`flex ${isExternal ? "justify-start" : "justify-end"}`}>
                          <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${isExternal ? "bg-slate-100 text-slate-900" : "bg-slate-900 text-white"}`}>
                            <div className={`text-[11px] ${isExternal ? "text-slate-500" : "text-slate-200"}`}>
                              {isExternal ? (m.senderType === "developer" ? "Developer" : "Client") : (m.senderName || "Staff")}
                            </div>
                            <div className="text-sm whitespace-pre-wrap break-words">{m.messageText}</div>
                            <div className={`mt-1 text-[10px] ${isExternal ? "text-slate-400" : "text-slate-300"}`}>
                              {m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {(Array.isArray(caseMessagesQuery.data?.data) ? caseMessagesQuery.data!.data : []).length === 0 && (
                      <div className="text-sm text-slate-600">
                        {interactionChannel === "client" ? "No client messages yet." : "No developer messages yet."}
                      </div>
                    )}
                  </div>
                )}

                <div className="pt-2 border-t border-slate-200 space-y-2">
                  <Textarea
                    value={clientReplyDraft}
                    onChange={(e) => setClientReplyDraft(e.target.value)}
                    placeholder={interactionChannel === "client" ? "Reply to client..." : "Reply to developer..."}
                    className="min-h-[90px]"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-slate-500">{Math.min(2000, clientReplyDraft.length)}/2000</div>
                    <Button
                      onClick={() => {
                        const t = clientReplyDraft.trim();
                        if (!t) return;
                        if (t.length > 2000) return;
                        sendCaseMessageMutation.mutate({ messageText: t, channel: interactionChannel });
                      }}
                      disabled={sendCaseMessageMutation.isPending || !clientReplyDraft.trim()}
                    >
                      Send
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {SHOW_COMPLIANCE_TAB ? (
          <TabsContent value="compliance">
            <CaseComplianceTab caseId={caseId} />
          </TabsContent>
        ) : (
          <TabsContent value="compliance">
            <Card>
              <CardHeader>
                <CardTitle>Compliance</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-600">
                This feature is not available yet.
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="reference-history" className="space-y-4">
          <ReferenceHistoryPanel caseId={caseId} />
        </TabsContent>

        <TabsContent value="operations" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className={((caseOpsCustodyQuery.data?.total ?? 0) > 0 && ((caseOpsCustodyQuery.data?.items ?? []).some((i:any) => i.isReturnOverdue || i.isAcknowledgementOverdue)) ) ? "border-rose-200 bg-rose-50/30" : undefined}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base flex items-center gap-2"><FolderKey className="w-4 h-4 text-amber-600" /> File Custody</CardTitle>
                  {!caseOpsCustodyQuery.isLoading && (caseOpsCustodyQuery.data?.total ?? 0) > 0 ? (
                    <Badge variant="secondary" className="bg-slate-100 text-slate-700 text-xs">{caseOpsCustodyQuery.data.total} item{caseOpsCustodyQuery.data.total === 1 ? "" : "s"}</Badge>
                  ) : null}
                </div>
                {canViewFileCustody ? (
                  <Link
                    className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1"
                    href={`/app/accounting?tab=file-custody&case_id=${encodeURIComponent(String(caseId))}`}
                  >
                    Open Custody <ChevronRight className="w-3 h-3" />
                  </Link>
                ) : null}
              </CardHeader>
              <CardContent>
                {!canViewFileCustody ? (
                  <div className="text-xs text-slate-500 italic py-4 text-center">File custody is not available for your role</div>
                ) : caseOpsCustodyQuery.isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="animate-pulse h-14 rounded bg-slate-100" />
                    ))}
                  </div>
                ) : caseOpsCustodyQuery.error ? (
                  <div className="text-xs text-slate-500 italic py-4 text-center">File custody unavailable right now</div>
                ) : (() => {
                  const items = caseOpsCustodyQuery.data?.items ?? [];
                  const total = caseOpsCustodyQuery.data?.total ?? 0;
                  const outCount = items.filter((i:any) => i.lifecycleStatus && i.lifecycleStatus !== "in_office" && i.lifecycleStatus !== "returned" && i.lifecycleStatus !== "archived").length;
                  const overdueReturn = items.filter((i:any) => !!i.isReturnOverdue).length;
                  const ackOverdue = items.filter((i:any) => !!i.isAcknowledgementOverdue).length;
                  if (total === 0) {
                    return (
                      <div className="text-sm text-slate-500 py-6 text-center flex flex-col items-center gap-2">
                        <CheckCircle2 className="w-6 h-6 text-emerald-500" />
                        <div className="font-medium text-emerald-700">No custody items for this case</div>
                      </div>
                    );
                  }
                  return (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <div className="rounded-md border border-slate-200 bg-white p-2.5">
                          <div className="text-[11px] uppercase text-slate-500 font-medium tracking-wider">Total</div>
                          <div className="text-lg font-bold text-slate-900 mt-0.5">{total}</div>
                        </div>
                        <div className="rounded-md border border-amber-200 bg-amber-50/60 p-2.5">
                          <div className="text-[11px] uppercase text-amber-700 font-medium tracking-wider">Out</div>
                          <div className="text-lg font-bold text-amber-800 mt-0.5">{outCount}</div>
                        </div>
                        <div className={`rounded-md border p-2.5 ${overdueReturn > 0 ? "border-orange-300 bg-orange-50/60" : "border-slate-200 bg-white"}`}>
                          <div className={`text-[11px] uppercase font-medium tracking-wider ${overdueReturn > 0 ? "text-orange-700" : "text-slate-500"}`}>Return overdue</div>
                          <div className={`text-lg font-bold mt-0.5 ${overdueReturn > 0 ? "text-orange-800" : "text-slate-900"}`}>{overdueReturn}</div>
                        </div>
                        <div className={`rounded-md border p-2.5 ${ackOverdue > 0 ? "border-rose-300 bg-rose-50/60" : "border-slate-200 bg-white"}`}>
                          <div className={`text-[11px] uppercase font-medium tracking-wider ${ackOverdue > 0 ? "text-rose-700" : "text-slate-500"}`}>Ack overdue</div>
                          <div className={`text-lg font-bold mt-0.5 ${ackOverdue > 0 ? "text-rose-800" : "text-slate-900"}`}>{ackOverdue}</div>
                        </div>
                      </div>
                      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 overflow-hidden">
                        {items.slice(0, 8).map((it:any) => {
                          const who = it.currentHolderName || it.holderName || (it.currentHolderFirmExternal ? `${it.currentHolderFirmExternal}` : "in office");
                          const whoContact = it.currentHolderContact && it.currentHolderName ? ` <${it.currentHolderContact}>` : "";
                          const holdAnchor = it.updatedAt || it.createdAt;
                          const holdDuration = formatHoldDuration(holdAnchor);
                          const ackBadge = it.acknowledgedAt
                            ? <Badge variant="default" className="bg-emerald-600 text-[10px]">ACKED</Badge>
                            : it.isAcknowledgementOverdue
                              ? <Badge variant="destructive" className="text-[10px]">NOT ACK</Badge>
                              : <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">PENDING ACK</Badge>;
                          const returnBadge = it.isReturnOverdue
                            ? <Badge variant="destructive" className="text-[10px]">OVERDUE</Badge>
                            : it.expectedReturnAt
                              ? <Badge variant="outline" className="text-[10px] bg-sky-50 text-sky-700 border-sky-200">Due {new Date(it.expectedReturnAt).toLocaleDateString("en-MY")}</Badge>
                              : null;
                          return (
                            <li key={String(it.id)} className="p-3 first:pt-3 last:pb-3 bg-white">
                              <div className="flex items-start gap-3">
                                <span className="inline-flex items-center gap-1 mt-0.5 text-[11px] font-medium text-slate-500 shrink-0 min-w-[72px]">
                                  <Clock className="w-3 h-3" /> {holdDuration}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-semibold text-slate-800 truncate inline-flex items-center gap-1">
                                      <span className="text-slate-400">#{String(it.fileReferenceNo ?? it.id)}</span>
                                      <span>{String(it.fileTitle ?? "Untitled")}</span>
                                    </span>
                                    <Badge variant="secondary" className="text-[10px]">{String(it.category ?? "other").replace(/_/g," ")}</Badge>
                                    <Badge variant="outline" className="text-[10px] uppercase">{String(it.physicalOrDigital ?? "digital")}</Badge>
                                  </div>
                                  <div className="mt-1 text-xs text-slate-600">
                                    Holder: <span className="font-medium text-slate-800">{who}{whoContact}</span>
                                  </div>
                                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                    {ackBadge}
                                    {returnBadge}
                                    {it.lifecycleStatus ? <Badge variant="outline" className="text-[10px]">{String(it.lifecycleStatus).replace(/_/g," ")}</Badge> : null}
                                  </div>
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            <Card className={(caseOpsBottlenecksQuery.data?.items ?? []).some((b:any) => b.severity === "critical" || b.severity === "urgent") ? "border-red-200 bg-red-50/20" : undefined}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base flex items-center gap-2"><Activity className="w-4 h-4 text-rose-600" /> Bottlenecks</CardTitle>
                  {!caseOpsBottlenecksQuery.isLoading && (caseOpsBottlenecksQuery.data?.items?.length ?? 0) > 0 ? (
                    <Badge variant="secondary" className="bg-slate-100 text-slate-700 text-xs">{caseOpsBottlenecksQuery.data.items.length} active</Badge>
                  ) : null}
                </div>
                {canViewCaseMonitor ? (
                  <Link
                    className="text-xs text-rose-600 hover:text-rose-700 flex items-center gap-1"
                    href={`/app/accounting?tab=monitor&case_id=${encodeURIComponent(String(caseId))}`}
                  >
                    Open Monitor <ChevronRight className="w-3 h-3" />
                  </Link>
                ) : null}
              </CardHeader>
              <CardContent>
                {!canViewCaseMonitor ? (
                  <div className="text-xs text-slate-500 italic py-4 text-center">Case monitor is not available for your role</div>
                ) : caseOpsBottlenecksQuery.isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="animate-pulse h-12 rounded bg-slate-100" />
                    ))}
                  </div>
                ) : caseOpsBottlenecksQuery.error ? (
                  <div className="text-xs text-slate-500 italic py-4 text-center">Case monitor unavailable right now</div>
                ) : (() => {
                  const items = caseOpsBottlenecksQuery.data?.items ?? [];
                  const critical = items.filter((b:any) => b.severity === "critical").length;
                  const urgent = items.filter((b:any) => b.severity === "urgent").length;
                  const attention = items.filter((b:any) => b.severity === "attention").length;
                  if (items.length === 0) {
                    return (
                      <div className="text-sm text-slate-500 py-6 text-center flex flex-col items-center gap-2">
                        <CheckCircle2 className="w-6 h-6 text-emerald-500" />
                        <div className="font-medium text-emerald-700">All caught up — no active bottlenecks</div>
                      </div>
                    );
                  }
                  const kindLabel = (k:string) => {
                    if (k === "case_no_movement") return "Case stuck";
                    if (k === "case_waiting") return "Waiting";
                    if (k === "case_on_hold") return "On hold";
                    if (k === "pv_delay") return "PV overdue";
                    if (k === "approval_waiting") return "Approval pending";
                    return k;
                  };
                  return (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <div className="rounded-md border border-slate-200 bg-white p-2.5">
                          <div className="text-[11px] uppercase text-slate-500 font-medium tracking-wider">Active</div>
                          <div className="text-lg font-bold text-slate-900 mt-0.5">{items.length}</div>
                        </div>
                        <div className={`rounded-md border p-2.5 ${critical > 0 ? "border-red-300 bg-red-50/60" : "border-slate-200 bg-white"}`}>
                          <div className={`text-[11px] uppercase font-medium tracking-wider ${critical > 0 ? "text-red-700" : "text-slate-500"}`}>Critical</div>
                          <div className={`text-lg font-bold mt-0.5 ${critical > 0 ? "text-red-800" : "text-slate-900"}`}>{critical}</div>
                        </div>
                        <div className={`rounded-md border p-2.5 ${urgent > 0 ? "border-amber-300 bg-amber-50/60" : "border-slate-200 bg-white"}`}>
                          <div className={`text-[11px] uppercase font-medium tracking-wider ${urgent > 0 ? "text-amber-700" : "text-slate-500"}`}>Urgent</div>
                          <div className={`text-lg font-bold mt-0.5 ${urgent > 0 ? "text-amber-800" : "text-slate-900"}`}>{urgent}</div>
                        </div>
                        <div className={`rounded-md border p-2.5 ${attention > 0 ? "border-sky-300 bg-sky-50/60" : "border-slate-200 bg-white"}`}>
                          <div className={`text-[11px] uppercase font-medium tracking-wider ${attention > 0 ? "text-sky-700" : "text-slate-500"}`}>Attention</div>
                          <div className={`text-lg font-bold mt-0.5 ${attention > 0 ? "text-sky-800" : "text-slate-900"}`}>{attention}</div>
                        </div>
                      </div>
                      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 overflow-hidden bg-white">
                        {items.slice(0, 8).map((b:any) => {
                          const sevDot = b.severity === "critical" ? "bg-red-500" : b.severity === "urgent" ? "bg-amber-500" : b.severity === "attention" ? "bg-sky-500" : "bg-slate-400";
                          const sevBadge = b.severity === "critical"
                            ? <Badge variant="destructive" className="text-[10px]">CRITICAL</Badge>
                            : b.severity === "urgent"
                              ? <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-800 border-amber-200">URGENT</Badge>
                              : b.severity === "attention"
                                ? <Badge variant="outline" className="text-[10px] bg-sky-50 text-sky-800 border-sky-200">ATTENTION</Badge>
                                : <Badge variant="secondary" className="text-[10px]">{String(b.severity ?? "info").toUpperCase()}</Badge>;
                          return (
                            <li key={String(b.id)} className="p-3 flex items-start gap-3">
                              <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${sevDot}`} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  {sevBadge}
                                  <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200 text-[10px]">{kindLabel(String(b.monitorKind))}</Badge>
                                  <span className="text-[11px] text-slate-500">{b.daysStuck ?? 0}d stuck</span>
                                  {b.escalatedToPartner ? (
                                    <Badge variant="destructive" className="bg-red-50 text-red-700 border-red-200 hover:bg-red-50 text-[10px]">ESCALATED</Badge>
                                  ) : null}
                                </div>
                                <div className="mt-1 text-sm font-medium text-slate-800 truncate">{String(b.title ?? "")}</div>
                                {b.detail ? <div className="mt-0.5 text-xs text-slate-500 line-clamp-2">{String(b.detail)}</div> : null}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
