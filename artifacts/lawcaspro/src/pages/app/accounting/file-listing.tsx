import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { getListCasesQueryKey } from "@workspace/api-client-react";
import { formatRMAmount } from "@/lib/money";

type ApprovalStatus = "pending_approval" | "rejected" | "approved";

export type ApproveRequestInput = {
  caseId: number;
  referenceNo: string;
  approvalNote: string;
  changeReason: string;
};

export type RejectRequestInput = {
  caseId: number;
  approvalNote: string;
};

export type JsonRequestSpec = {
  url: string;
  method: "POST";
  body: string;
};

export function buildApproveRequestSpec(input: ApproveRequestInput): JsonRequestSpec {
  const referenceNo = input.referenceNo.trim();
  const approvalNote = input.approvalNote.trim() ? input.approvalNote.trim() : null;
  const changeReason = input.changeReason.trim() ? input.changeReason.trim() : null;
  return {
    url: `/cases/${encodeURIComponent(String(input.caseId))}/approve`,
    method: "POST",
    body: JSON.stringify({ referenceNo, approvalNote, changeReason }),
  };
}

export function buildRejectRequestSpec(input: RejectRequestInput): JsonRequestSpec {
  const approvalNote = input.approvalNote.trim();
  return {
    url: `/cases/${encodeURIComponent(String(input.caseId))}/reject`,
    method: "POST",
    body: JSON.stringify({ approvalNote }),
  };
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), Math.max(0, delayMs));
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function fmtIsoToYmd(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = String(iso);
  if (s.length < 10) return s;
  const [y, m, d] = s.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function caseTypeLabel(v: string | null | undefined): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "—";
  if (s === "subsale") return "Subsale";
  if (s === "perfection") return "Perfection";
  if (s === "developer_sales") return "Developer Sales";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildCaseSummary(c: any): string {
  const ct = String((c as any)?.caseType ?? "").trim().toLowerCase();
  if (ct === "subsale") {
    const parts = [
      (c as any)?.titleType ? `Title: ${(c as any).titleType}` : null,
      (c as any)?.landCondition ? `Land: ${(c as any).landCondition}` : null,
      (c as any)?.encumbrances ? `Encumbrances: ${(c as any).encumbrances}` : null,
      (c as any)?.actingFor ? `Acting: ${(c as any).actingFor}` : null,
    ].filter(Boolean);
    return parts.join(" · ") || "—";
  }
  if (ct === "perfection") {
    const pt = String((c as any)?.perfectionType ?? "").trim();
    return pt ? `Perfection: ${pt}` : "—";
  }
  const parts = [
    (c as any)?.projectName ? `Project: ${(c as any).projectName}` : null,
    (c as any)?.developerName ? `Developer: ${(c as any).developerName}` : null,
    (c as any)?.titleType ? `Title: ${(c as any).titleType}` : null,
    (c as any)?.purchaseMode ? `Mode: ${(c as any).purchaseMode}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "—";
}

function showCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const s = String(v).trim();
  return s ? s : "—";
}

function formatClientParties(parties: any): string {
  const arr = Array.isArray(parties) ? parties : [];
  const names = arr
    .map((p) => (p && typeof p === "object" ? String((p as any).name ?? "").trim() : ""))
    .filter((x) => x);
  if (names.length === 0) return "—";
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

export default function AccountingFileListing() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const canAccountingCreate = hasPermission(user, "accounting", "create");

  const roleLower = String((user as any)?.roleName ?? "").trim().toLowerCase();
  const canApproveCases =
    roleLower.includes("partner")
    || roleLower === "account admin"
    || roleLower === "account manager"
    || (roleLower.includes("account") && roleLower.includes("admin"))
    || (roleLower.includes("account") && roleLower.includes("manager"));

  const sp = useMemo(() => {
    const qs = typeof window !== "undefined" ? window.location.search : "";
    return new URLSearchParams(qs.startsWith("?") ? qs.slice(1) : qs);
  }, [typeof window !== "undefined" ? window.location.search : ""]);

  const initialStatus = ((): ApprovalStatus => {
    const raw = String(sp.get("approvalStatus") ?? "").trim().toLowerCase();
    if (raw === "rejected") return "rejected";
    if (raw === "approved") return "approved";
    return "pending_approval";
  })();

  const [status, setStatus] = useState<ApprovalStatus>(initialStatus);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const limit = 50;

  useEffect(() => {
    setPage(1);
  }, [status, search]);

  useEffect(() => {
    const nextSp = new URLSearchParams();
    if (status !== "pending_approval") nextSp.set("approvalStatus", status);
    else nextSp.set("approvalStatus", "pending_approval");
    if (search.trim()) nextSp.set("search", search.trim());
    nextSp.set("page", String(page));
    setLocation(`/app/accounting/file-listing?${nextSp.toString()}`);
  }, [status, search, page, setLocation]);

  const listQuery = useQuery<{ data: any[]; total: number; page: number; limit: number }>({
    queryKey: ["cases", "approval", status, search, page, limit],
    enabled: canApproveCases && status !== "approved",
    queryFn: () => apiFetchJson(`/cases?approvalStatus=${encodeURIComponent(status)}&page=${page}&limit=${limit}&search=${encodeURIComponent(search.trim())}`),
    retry: false,
  });

  const approvedFilesQuery = useQuery<any>({
    queryKey: ["case-files", search, page, limit],
    enabled: canApproveCases && status === "approved",
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search.trim()) params.set("q", search.trim());
      params.set("page", String(page));
      params.set("limit", String(limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return await apiFetchJson(`/case-files${suffix}`);
    },
    retry: false,
  });

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewCaseId, setReviewCaseId] = useState<number | null>(null);
  const [reviewProposedReferenceNo, setReviewProposedReferenceNo] = useState("");
  const [reviewReferenceNo, setReviewReferenceNo] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewChangeReason, setReviewChangeReason] = useState("");
  const [reviewSubmittedAt, setReviewSubmittedAt] = useState<string | null>(null);
  const [reviewSubmittedByName, setReviewSubmittedByName] = useState<string | null>(null);

  const reviewSummaryQuery = useQuery<any>({
    queryKey: ["accounting", "case-summary", reviewCaseId],
    enabled: reviewOpen && reviewCaseId != null,
    queryFn: ({ signal }) => apiFetchJson(`/accounting/cases/${encodeURIComponent(String(reviewCaseId))}/summary`, { signal }),
    retry: false,
  });

  const isPendingTab = status === "pending_approval";

  const [caseInfoOpen, setCaseInfoOpen] = useState(false);
  const [caseInfoCaseId, setCaseInfoCaseId] = useState<number | null>(null);
  const caseInfoQuery = useQuery<any>({
    queryKey: ["accounting", "case-summary", caseInfoCaseId],
    enabled: caseInfoOpen && caseInfoCaseId != null,
    queryFn: ({ signal }) => apiFetchJson(`/accounting/cases/${encodeURIComponent(String(caseInfoCaseId))}/summary`, { signal }),
    retry: false,
  });

  const notificationCountsQuery = useQuery<{
    totalUnreadCount: number;
    pendingApprovalUnreadCount: number;
    amendUnreadCount: number;
    approvedUnreadCount: number;
  }>({
    queryKey: ["case-notifications", "unread-counts"],
    enabled: Boolean(user),
    queryFn: () => apiFetchJson<{ totalUnreadCount: number; pendingApprovalUnreadCount: number; amendUnreadCount: number; approvedUnreadCount: number }>("/case-notifications/unread-counts").catch(() => ({
      totalUnreadCount: 0,
      pendingApprovalUnreadCount: 0,
      amendUnreadCount: 0,
      approvedUnreadCount: 0,
    })),
    refetchInterval: 30000,
    retry: false,
  });
  const notifCounts = notificationCountsQuery.data as
    | { totalUnreadCount: number; pendingApprovalUnreadCount: number; amendUnreadCount: number; approvedUnreadCount: number }
    | undefined;

  const markReadMutation = useMutation<unknown, Error, { types: string[] }>({
    mutationFn: async (vars: { types: string[] }) => {
      return await apiFetchJson("/case-notifications/mark-read", {
        method: "POST",
        body: JSON.stringify({ types: vars.types }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["case-notifications", "unread-counts"] });
    },
  });

  useEffect(() => {
    const counts = notifCounts;
    if (!counts) return;
    const types =
      status === "pending_approval"
        ? ["OPEN_FILE_PENDING_APPROVAL"]
        : status === "rejected"
          ? ["CASE_DETAILS_TO_AMEND"]
          : ["CASE_APPROVED", "REFERENCE_NO_CHANGED"];
    const count =
      status === "pending_approval"
        ? counts.pendingApprovalUnreadCount
        : status === "rejected"
          ? counts.amendUnreadCount
          : counts.approvedUnreadCount;
    if (count <= 0) return;
    const ready = status === "approved" ? approvedFilesQuery.isSuccess : listQuery.isSuccess;
    if (!ready) return;
    if (markReadMutation.isPending) return;
    markReadMutation.mutate({ types });
  }, [approvedFilesQuery.isSuccess, listQuery.isSuccess, markReadMutation, notifCounts, status]);

  const debouncedReferenceNo = useDebouncedValue(reviewReferenceNo, 250).trim();
  const referenceSuggestionsQuery = useQuery<{
    suggestedReference: string;
    startingNumber: number;
    nextNumber: number;
    highestExistingNumber: number | null;
    sequenceWarning: string | null;
    previousReferences: string[];
    duplicateWarning: { isDuplicate: boolean; existingCaseId?: number } | null;
  }>({
    queryKey: ["cases", "reference-suggestions", reviewCaseId, debouncedReferenceNo],
    enabled: Boolean(reviewOpen && reviewCaseId && isPendingTab),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (reviewCaseId) params.set("caseId", String(reviewCaseId));
      if (debouncedReferenceNo) params.set("referenceNo", debouncedReferenceNo);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return await apiFetchJson(`/cases/reference-suggestions${suffix}`);
    },
    retry: false,
  });

  const previousReferenceSuggestions = referenceSuggestionsQuery.data?.previousReferences ?? [];
  const suggestedReference = referenceSuggestionsQuery.data?.suggestedReference ?? "";
  const sequenceWarning = referenceSuggestionsQuery.data?.sequenceWarning ?? null;
  const duplicateWarning = referenceSuggestionsQuery.data?.duplicateWarning;

  useEffect(() => {
    if (!reviewOpen || !isPendingTab) return;
    if (reviewReferenceNo.trim()) return;
    if (!suggestedReference.trim()) return;
    setReviewReferenceNo(suggestedReference.trim());
  }, [isPendingTab, reviewOpen, reviewReferenceNo, suggestedReference]);

  const approveMutation = useMutation({
    mutationFn: async (vars: { caseId: number; referenceNo: string; approvalNote: string; changeReason: string }) => {
      const spec = buildApproveRequestSpec({
        caseId: vars.caseId,
        referenceNo: vars.referenceNo,
        approvalNote: vars.approvalNote,
        changeReason: vars.changeReason,
      });
      return await apiFetchJson(spec.url, {
        method: spec.method,
        body: spec.body,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["dashboard"] }),
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: getListCasesQueryKey() }),
        qc.invalidateQueries({ queryKey: ["cases", "filter-options"] }),
        qc.invalidateQueries({ queryKey: ["case-files"] }),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: ["dashboard"], type: "active" }),
        qc.refetchQueries({ queryKey: ["cases"], type: "active" }),
        qc.refetchQueries({ queryKey: ["case-files"], type: "active" }),
        qc.refetchQueries({ queryKey: ["case-notifications", "unread-counts"], type: "active" }),
      ]);
      toast({ title: "Approved" });
      setReviewOpen(false);
    },
    onError: (err) => toastError(toast, err, "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: async (vars: { caseId: number; approvalNote: string }) => {
      const spec = buildRejectRequestSpec({
        caseId: vars.caseId,
        approvalNote: vars.approvalNote,
      });
      return await apiFetchJson(spec.url, {
        method: spec.method,
        body: spec.body,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["dashboard"] }),
        qc.invalidateQueries({ queryKey: ["cases"] }),
        qc.invalidateQueries({ queryKey: getListCasesQueryKey() }),
        qc.invalidateQueries({ queryKey: ["cases", "filter-options"] }),
        qc.invalidateQueries({ queryKey: ["case-files"] }),
      ]);
      await Promise.all([
        qc.refetchQueries({ queryKey: ["dashboard"], type: "active" }),
        qc.refetchQueries({ queryKey: ["cases"], type: "active" }),
        qc.refetchQueries({ queryKey: ["case-files"], type: "active" }),
        qc.refetchQueries({ queryKey: ["case-notifications", "unread-counts"], type: "active" }),
      ]);
      toast({ title: "Returned for amendment" });
      setReviewOpen(false);
    },
    onError: (err) => toastError(toast, err, "Return for amendment failed"),
  });

  if (!canApproveCases) {
    return (
      <Card>
        <CardHeader><CardTitle>File Listing</CardTitle></CardHeader>
        <CardContent>
          <div className="text-slate-600">No permission.</div>
        </CardContent>
      </Card>
    );
  }

  const rows = status === "approved" ? (approvedFilesQuery.data?.data ?? []) : (listQuery.data?.data ?? []);
  const total = status === "approved" ? (approvedFilesQuery.data?.total ?? 0) : (listQuery.data?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const isLoading = status === "approved" ? approvedFilesQuery.isLoading : listQuery.isLoading;
  const isError = status === "approved" ? approvedFilesQuery.isError : listQuery.isError;
  const error = status === "approved" ? approvedFilesQuery.error : listQuery.error;
  const refetch = status === "approved" ? approvedFilesQuery.refetch : listQuery.refetch;
  const isFetching = status === "approved" ? approvedFilesQuery.isFetching : listQuery.isFetching;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">File Listing</h1>
        <p className="text-slate-500 mt-1">Open file approvals and amendments</p>
      </div>

      <Tabs value={status} onValueChange={(v) => setStatus(v as ApprovalStatus)}>
        <TabsList>
          <TabsTrigger value="pending_approval">
            <span className="flex items-center gap-2">
              Open File Pending Approval
              {(notifCounts?.pendingApprovalUnreadCount ?? 0) > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                  {notifCounts?.pendingApprovalUnreadCount ?? 0}
                </span>
              ) : null}
            </span>
          </TabsTrigger>
          <TabsTrigger value="rejected">
            <span className="flex items-center gap-2">
              Case Details to Amend
              {(notifCounts?.amendUnreadCount ?? 0) > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                  {notifCounts?.amendUnreadCount ?? 0}
                </span>
              ) : null}
            </span>
          </TabsTrigger>
          <TabsTrigger value="approved">
            <span className="flex items-center gap-2">
              Approved Files
              {(notifCounts?.approvedUnreadCount ?? 0) > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                  {notifCounts?.approvedUnreadCount ?? 0}
                </span>
              ) : null}
            </span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-3">
            <span>{status === "approved" ? "Approved Files" : status === "rejected" ? "Case Details to Amend" : "Open File Pending Approval"}</span>
            <div className="w-full max-w-md">
              <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isError ? (
            <QueryFallback title="Listing unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} />
          ) : isLoading ? (
            <div className="text-slate-500 py-10 text-center">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-14 text-slate-500">No records found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                {status === "approved" ? (
                  <>
                    <thead>
                      <tr className="text-left text-slate-500 border-b">
                        <th className="py-3 pr-4 min-w-[160px]">File Reference</th>
                        <th className="py-3 pr-4 min-w-[140px]">Case Type</th>
                        <th className="py-3 pr-4 min-w-[220px]">Client / Purchaser</th>
                        <th className="py-3 pr-4 min-w-[260px]">Property / Project</th>
                        <th className="py-3 pr-4 min-w-[140px]">Open Date</th>
                        <th className="py-3 pr-4 min-w-[160px]">Status</th>
                        <th className="py-3 pr-4 min-w-[120px]">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r: any) => (
                        <tr key={r.id} className="border-b last:border-b-0 hover:bg-slate-50">
                          <td className="py-3 pr-4 font-medium">{showCell(r.referenceNo)}</td>
                          <td className="py-3 pr-4">{caseTypeLabel(r.caseType)}</td>
                          <td className="py-3 pr-4">{formatClientParties(r.clientParties)}</td>
                          <td className="py-3 pr-4 text-slate-700">{showCell(r.propertyInfo)}</td>
                          <td className="py-3 pr-4 text-xs">{fmtIsoToYmd(r.openFileDate)}</td>
                          <td className="py-3 pr-4 text-xs text-slate-700">{showCell(r.status)}</td>
                          <td className="py-3 pr-4">
                            <Button size="sm" variant="outline" onClick={() => { setCaseInfoCaseId(r.id); setCaseInfoOpen(true); }}>
                              View
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </>
                ) : (
                  <>
                    <thead>
                      <tr className="text-left text-slate-500 border-b">
                        <th className="py-3 pr-4 min-w-[130px]">Submitted Date</th>
                        <th className="py-3 pr-4 min-w-[140px]">Submitted By</th>
                        {status === "rejected" ? <th className="py-3 pr-4 min-w-[130px]">Returned Date</th> : null}
                        <th className="py-3 pr-4 min-w-[140px]">Case Type</th>
                        <th className="py-3 pr-4 min-w-[260px]">Case Summary</th>
                        {status === "rejected" ? <th className="py-3 pr-4 min-w-[240px]">Amendment Notes</th> : null}
                        <th className="py-3 pr-4 min-w-[120px]">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c: any) => (
                        <tr key={c.id} className="border-b last:border-b-0 hover:bg-slate-50 align-top">
                          <td className="py-3 pr-4 text-xs">{fmtIsoToYmd((c as any).submittedAt)}</td>
                          <td className="py-3 pr-4">{(c as any).submittedByName ?? (c as any).submittedBy ?? "—"}</td>
                          {status === "rejected" ? <td className="py-3 pr-4 text-xs">{fmtIsoToYmd((c as any).approvedAt)}</td> : null}
                          <td className="py-3 pr-4">{caseTypeLabel((c as any).caseType)}</td>
                          <td className="py-3 pr-4 text-slate-700">{buildCaseSummary(c)}</td>
                          {status === "rejected" ? <td className="py-3 pr-4 text-xs text-slate-700">{String((c as any).approvalNote ?? "—")}</td> : null}
                          <td className="py-3 pr-4">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setReviewCaseId(c.id);
                                const proposed = String((c as any).proposedReferenceNo ?? "");
                                setReviewProposedReferenceNo(proposed);
                                setReviewReferenceNo(proposed);
                                setReviewNote(String((c as any).approvalNote ?? ""));
                                setReviewChangeReason("");
                                setReviewSubmittedAt((c as any).submittedAt ?? null);
                                setReviewSubmittedByName((c as any).submittedByName ?? (c as any).submittedBy ?? null);
                                void reviewSummaryQuery.refetch().catch(() => undefined);
                                setReviewOpen(true);
                              }}
                            >
                              Review
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </>
                )}
              </table>
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t mt-4">
            <div className="text-xs text-slate-500">Page {page} / {pageCount}</div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
              <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={reviewOpen} onOpenChange={(o) => {
        setReviewOpen(o);
        if (!o) {
          setReviewCaseId(null);
          setReviewProposedReferenceNo("");
          setReviewReferenceNo("");
          setReviewNote("");
          setReviewChangeReason("");
          setReviewSubmittedAt(null);
          setReviewSubmittedByName(null);
        }
      }}>
        <DialogContent
          className="max-w-[900px] w-[95vw]"
          onInteractOutside={(e) => e.preventDefault()}
          aria-modal="true"
        >
          <DialogHeader>
            <DialogTitle>Open File Review</DialogTitle>
            <DialogDescription>Review the case submission and approve or return for amendment.</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="rounded-lg border border-slate-200 bg-slate-50/60">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-900">Case Summary</div>
                <div className="text-xs text-slate-500">Read-only</div>
              </div>
              <div className="p-4">
                {reviewSummaryQuery.isError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Case summary unavailable</AlertTitle>
                    <AlertDescription className="flex flex-col sm:flex-row sm:items-center gap-3">
                      <span>We could not load the case summary. You may continue approving using the fields below.</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { void reviewSummaryQuery.refetch().catch(() => undefined); }}
                        disabled={reviewSummaryQuery.isFetching}
                      >
                        {reviewSummaryQuery.isFetching ? "Retrying…" : "Retry"}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : reviewSummaryQuery.isLoading || !reviewSummaryQuery.data ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-28" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-28" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5 md:col-span-2">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-28" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-28" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-5 w-full" />
                    </div>
                  </div>
                ) : (
                  (() => {
                    const payload = (reviewSummaryQuery.data ?? {}) as any;
                    const c = payload.case ?? {};
                    const parties = payload.parties ?? {};
                    const purchasers = Array.isArray(parties.purchasers) ? parties.purchasers : [];
                    const borrowers = Array.isArray(parties.borrowers) ? parties.borrowers : [];
                    const purchasePriceRaw = c.spaPrice;
                    const hasPurchasePrice = purchasePriceRaw != null && String(purchasePriceRaw).trim() !== "";
                    const loanAmountRaw = c.loanAmountNum;
                    const hasLoanAmount = loanAmountRaw != null && String(loanAmountRaw).trim() !== "";
                    return (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Proposed Reference</div>
                          <div className="font-medium text-slate-900 break-words">{showCell(reviewProposedReferenceNo)}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Case Type</div>
                          <div className="font-medium text-slate-900">{caseTypeLabel(c.caseType)}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Client / Purchaser</div>
                          <div className="text-slate-900">{purchasers.length > 0 ? purchasers.join(", ") : "—"}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Borrower</div>
                          <div className="text-slate-900">{borrowers.length > 0 ? borrowers.join(", ") : "—"}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3 md:col-span-2">
                          <div className="text-xs text-slate-500 mb-1">Property</div>
                          <div className="text-slate-900 break-words">{showCell(c.parcelNo)}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Project</div>
                          <div className="text-slate-900">{showCell(c.projectName)}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Developer</div>
                          <div className="text-slate-900">{showCell(c.developerName)}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Purchase Price</div>
                          <div className="font-medium text-slate-900">{hasPurchasePrice ? formatRMAmount(purchasePriceRaw) : "—"}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Loan Amount</div>
                          <div className="font-medium text-slate-900">{hasLoanAmount ? formatRMAmount(loanAmountRaw) : "—"}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Responsible Lawyer</div>
                          <div className="text-slate-900">{showCell(c.responsibleLawyer)}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Assigned Clerk</div>
                          <div className="text-slate-900">{showCell(c.assignedClerk)}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Submission Date</div>
                          <div className="text-slate-900">{fmtIsoToYmd(reviewSubmittedAt)}</div>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <div className="text-xs text-slate-500 mb-1">Submitted By</div>
                          <div className="text-slate-900">{showCell(reviewSubmittedByName)}</div>
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-12 space-y-1.5">
                <Label>Proposed Reference No.</Label>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 break-words">
                  {reviewProposedReferenceNo.trim() || "—"}
                </div>
                <div className="text-xs text-slate-500">This is a proposed reference number. Final reference number will be confirmed upon approval.</div>
              </div>
              <div className="md:col-span-12 space-y-1.5">
                <Label>Final Approved Reference No. *</Label>
                <Input
                  value={reviewReferenceNo}
                  onChange={(e) => setReviewReferenceNo(e.target.value)}
                  disabled={!isPendingTab || approveMutation.isPending || rejectMutation.isPending}
                  placeholder="Enter Reference Number"
                  list="case-reference-suggestions"
                />
                <datalist id="case-reference-suggestions">
                  {suggestedReference ? <option value={suggestedReference} /> : null}
                  {previousReferenceSuggestions.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
                {isPendingTab ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs text-slate-500">
                      {referenceSuggestionsQuery.isLoading ? "Loading suggestions…" : suggestedReference ? `Suggested: ${suggestedReference}` : "Suggested: —"}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!suggestedReference || !isPendingTab || approveMutation.isPending || rejectMutation.isPending || reviewReferenceNo.trim() === suggestedReference}
                      onClick={() => setReviewReferenceNo(suggestedReference)}
                    >
                      Use Suggested Reference
                    </Button>
                  </div>
                ) : null}
                {isPendingTab && duplicateWarning?.isDuplicate ? (
                  <div className="text-xs text-amber-700">
                    Warning: This Reference Number already exists in this firm. Please change it before approving.
                  </div>
                ) : null}
                {isPendingTab && sequenceWarning ? (
                  <div className="text-xs text-amber-700">
                    {sequenceWarning}
                  </div>
                ) : null}
                {!isPendingTab ? <div className="text-xs text-slate-500">Reference Number can only be set while Open File Pending Approval.</div> : null}
              </div>
              {isPendingTab && reviewProposedReferenceNo.trim() && reviewReferenceNo.trim() && reviewReferenceNo.trim() !== reviewProposedReferenceNo.trim() ? (
                <div className="md:col-span-12 space-y-1.5">
                  <Label>Change Reason (optional)</Label>
                  <Input
                    value={reviewChangeReason}
                    onChange={(e) => setReviewChangeReason(e.target.value)}
                    disabled={!isPendingTab || approveMutation.isPending || rejectMutation.isPending}
                    placeholder="Optional reason for changing reference number"
                  />
                </div>
              ) : null}
              <div className="md:col-span-12 space-y-1.5">
                <Label>Amendment Notes</Label>
                <Textarea
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  disabled={!isPendingTab || approveMutation.isPending || rejectMutation.isPending}
                  placeholder="Optional notes (required to return for amendment)"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => setReviewOpen(false)}>Close</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!reviewCaseId) return;
                if (!isPendingTab) return;
                if (!reviewNote.trim()) {
                  toast({ title: "Amendment Notes is required", variant: "destructive" });
                  return;
                }
                rejectMutation.mutate({ caseId: reviewCaseId, approvalNote: reviewNote.trim() });
              }}
              disabled={!isPendingTab || !reviewCaseId || rejectMutation.isPending}
            >
              Return for Amendment
            </Button>
            <Button
              onClick={() => {
                if (!reviewCaseId) return;
                if (!isPendingTab) return;
                if (!reviewReferenceNo.trim()) {
                  toast({ title: "Reference Number is required", variant: "destructive" });
                  return;
                }
                if (duplicateWarning?.isDuplicate) {
                  toast({ title: "Duplicate Reference Number", description: "Please change the Reference Number before approving.", variant: "destructive" });
                  return;
                }
                approveMutation.mutate({ caseId: reviewCaseId, referenceNo: reviewReferenceNo.trim(), approvalNote: reviewNote, changeReason: reviewChangeReason });
              }}
              disabled={!isPendingTab || !reviewCaseId || approveMutation.isPending}
            >
              Approve Open File
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={caseInfoOpen} onOpenChange={(o) => {
        setCaseInfoOpen(o);
        if (!o) setCaseInfoCaseId(null);
      }}>
        <DialogContent className="max-w-[900px] w-[95vw]">
          <DialogHeader>
            <DialogTitle>Case Information</DialogTitle>
            <DialogDescription>Read-only case summary for accounting.</DialogDescription>
          </DialogHeader>
          {caseInfoQuery.isError ? (
            <QueryFallback title="Case summary unavailable" error={caseInfoQuery.error} onRetry={() => caseInfoQuery.refetch()} isRetrying={caseInfoQuery.isFetching} />
          ) : caseInfoQuery.isLoading ? (
            <div className="text-sm text-slate-500">Loading…</div>
          ) : (
            (() => {
              const payload = (caseInfoQuery.data ?? {}) as any;
              const c = payload.case ?? {};
              const parties = payload.parties ?? {};
              const acc = payload.accounting ?? {};
              const purchasers = Array.isArray(parties.purchasers) ? parties.purchasers : [];
              const borrowers = Array.isArray(parties.borrowers) ? parties.borrowers : [];
              const openDate = c.openDate ? fmtIsoToYmd(String(c.openDate)) : "—";
              return (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">File Reference</div>
                      <div className="font-medium text-slate-900">{showCell(c.referenceNo)}</div>
                    </div>
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Case Type</div>
                      <div className="font-medium text-slate-900">{caseTypeLabel(c.caseType)}</div>
                    </div>
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Open Date</div>
                      <div className="font-medium text-slate-900">{openDate}</div>
                    </div>
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Current Status</div>
                      <div className="font-medium text-slate-900">{showCell(c.status)}</div>
                    </div>
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Responsible Lawyer</div>
                      <div className="font-medium text-slate-900">{showCell(c.responsibleLawyer)}</div>
                    </div>
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Assigned Clerk</div>
                      <div className="font-medium text-slate-900">{showCell(c.assignedClerk)}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Client / Purchaser</div>
                      <div className="text-sm text-slate-900">{purchasers.length > 0 ? purchasers.join(", ") : "—"}</div>
                    </div>
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Borrower</div>
                      <div className="text-sm text-slate-900">{borrowers.length > 0 ? borrowers.join(", ") : "—"}</div>
                    </div>
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Project</div>
                      <div className="text-sm text-slate-900">{showCell(c.projectName)}</div>
                    </div>
                    <div className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs text-slate-500">Developer</div>
                      <div className="text-sm text-slate-900">{showCell(c.developerName)}</div>
                    </div>
                  </div>

                  <div className="rounded-md border border-slate-200 p-3">
                    <div className="text-xs text-slate-500">Accounting Summary</div>
                    <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                      <div>Outstanding: <span className="font-medium">{showCell(c.outstandingBalance)}</span></div>
                      <div>Payment Vouchers: <span className="font-medium">{showCell(acc.paymentVoucherCount)}</span></div>
                      <div>Latest Invoice Due: <span className="font-medium">{showCell(acc.latestInvoiceAmountDue)}</span></div>
                    </div>
                  </div>
                </div>
              );
            })()
          )}
          <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button variant="outline" onClick={() => setCaseInfoOpen(false)}>Close</Button>
            <div className="flex flex-wrap gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  const payload = (caseInfoQuery.data ?? {}) as any;
                  const caseId = payload?.case?.id;
                  if (caseId) setLocation(`/app/quotations/new?caseId=${encodeURIComponent(String(caseId))}`);
                }}
                disabled={!canAccountingCreate}
              >
                Create Quotation
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const payload = (caseInfoQuery.data ?? {}) as any;
                  const qid = payload?.accounting?.latestQuotationId;
                  const sp = new URLSearchParams();
                  sp.set("tab", "invoices");
                  sp.set("openCreate", "1");
                  if (qid) sp.set("quotationId", String(qid));
                  setLocation(`/app/accounting?${sp.toString()}`);
                }}
                disabled={!canAccountingCreate}
              >
                Create Invoice
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const payload = (caseInfoQuery.data ?? {}) as any;
                  const invoiceId = payload?.accounting?.latestInvoiceId;
                  const suffix = invoiceId ? `?tab=receipts&openCreate=1&invoiceId=${encodeURIComponent(String(invoiceId))}` : "?tab=receipts&openCreate=1";
                  setLocation(`/app/accounting${suffix}`);
                }}
                disabled={!canAccountingCreate}
              >
                Create Receipt
              </Button>
              <Button
                onClick={() => {
                  const payload = (caseInfoQuery.data ?? {}) as any;
                  const caseId = payload?.case?.id;
                  const referenceNo = payload?.case?.referenceNo;
                  const suffix = caseId
                    ? `?tab=payment-vouchers&openCreate=1&caseId=${encodeURIComponent(String(caseId))}&caseTitle=${encodeURIComponent(String(referenceNo ?? ""))}`
                    : "?tab=payment-vouchers&openCreate=1";
                  setLocation(`/app/accounting${suffix}`);
                }}
                className="bg-amber-500 hover:bg-amber-600 text-white"
                disabled={!canAccountingCreate}
              >
                Create Payment Voucher
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
