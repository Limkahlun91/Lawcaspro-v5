import { CaseMilestoneKey, MilestonePresence, getListCasesQueryKey, useListCases, useListProjects } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Plus, Search } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemo, useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetchBlob, apiFetchJson, apiRequest } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { useAuth } from "@/lib/auth-context";
import { DateOnlyInput } from "@/components/date-only-input";
import { TemplateFolderPicker, type TemplateFolderPickerFolder, type TemplateFolderPickerTemplate } from "@/components/documents/TemplateFolderPicker";
import {
  createGenerationJob,
  downloadGenerationJob,
  finalizeGenerationJob,
  getGenerationJobStatus,
  runNextGenerationJob,
  type NormalizedGenerationJob,
} from "@/lib/document-generation-client";
import { normalizeAssignedToUserIdParam } from "./case-filter-utils";

async function apiFetchCsv(path: string): Promise<Blob> {
  return await apiFetchBlob(path, { timeoutMs: 60000, headers: { accept: "text/csv" } });
}

function fmtYmd(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

function fmtIsoToYmd(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = String(iso);
  if (s.length < 10) return s;
  return fmtYmd(s.slice(0, 10));
}

function normalizeMilestonePresence(raw: string | null): MilestonePresence {
  if (!raw) return "filled";
  if (raw === "done") return "completed";
  return Object.values(MilestonePresence).includes(raw as any) ? (raw as MilestonePresence) : "filled";
}

function normalizeMilestoneKey(raw: string | null): CaseMilestoneKey | "all" {
  if (!raw) return "all";
  if (raw === "loan_executed") return "loan_bank_executed";
  return Object.values(CaseMilestoneKey).includes(raw as any) ? (raw as CaseMilestoneKey) : "all";
}

function parseLegacyMilestoneParams(sp: URLSearchParams): { milestone: CaseMilestoneKey; presence: MilestonePresence } | null {
  for (const key of Object.values(CaseMilestoneKey)) {
    const v = sp.get(key);
    if (!v) continue;
    const vv = v.trim().toLowerCase();
    if (vv === "done") return { milestone: key as CaseMilestoneKey, presence: "completed" };
    if (vv === "pending") return { milestone: key as CaseMilestoneKey, presence: "pending" };
  }
  return null;
}

function isAbortError(e: unknown): boolean {
  const n = typeof (e as any)?.name === "string" ? String((e as any).name) : "";
  return n === "AbortError";
}

export default function CasesList() {
  const [location, setLocation] = useLocation();
  const searchString = typeof window !== "undefined" ? window.location.search : (location.includes("?") ? location.slice(location.indexOf("?")) : "");
  const sp = useMemo(() => new URLSearchParams(searchString.startsWith("?") ? searchString.slice(1) : searchString), [searchString]);
  const currentQs = sp.toString();
  const isHydratingFromUrl = useRef(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const myUserId = typeof (user as any)?.id === "number" ? (user as any).id : Number((user as any)?.id);
  const roleName = String((user as any)?.roleName ?? "");
  const isPartnerOrManager = roleName.toLowerCase().includes("partner") || roleName.toLowerCase().includes("manager");
  const canApproveCases = (() => {
    const n = roleName.trim().toLowerCase();
    if (!n) return false;
    if (n.includes("partner")) return true;
    if (n === "account admin" || n === "account manager") return true;
    if (n.includes("account") && n.includes("admin")) return true;
    if (n.includes("account") && n.includes("manager")) return true;
    return false;
  })();

  const me = Number.isFinite(myUserId) && myUserId > 0 ? myUserId : null;
  const normalizeAssignedToUserId = (raw: string | null): string =>
    normalizeAssignedToUserIdParam(raw, { myUserId: me, isPartnerOrManager });

  const mode = sp.get("mode");
  const intake = sp.get("intake") ?? "";
  useEffect(() => {
    if (mode !== "create") return;
    const next = intake ? `/app/cases/new?intake=${encodeURIComponent(intake)}` : "/app/cases/new";
    setLocation(next);
  }, [mode, intake, setLocation]);

  const initialPageRaw = sp.get("page");
  const initialLimitRaw = sp.get("limit");
  const initialPage = initialPageRaw ? Number(initialPageRaw) : 1;
  const initialLimit = initialLimitRaw ? Number(initialLimitRaw) : 50;

  const [search, setSearch] = useState(() => (sp.get("search") ?? ""));
  const [spaStatus, setSpaStatus] = useState<string>(() => (sp.get("spaStatus") ?? "all"));
  const [loanStatus, setLoanStatus] = useState<string>(() => (sp.get("loanStatus") ?? "all"));
  const [lawyerId, setLawyerId] = useState<string>(() => (sp.get("assignedLawyerId") ?? "all"));
  const [clerkId, setClerkId] = useState<string>(() => (sp.get("assignedClerkId") ?? "all"));
  const [assignedToUserId, setAssignedToUserId] = useState<string>(() => normalizeAssignedToUserId(sp.get("assignedToUserId")));
  const [projectId, setProjectId] = useState<string>(() => (sp.get("projectId") ?? "all"));
  const [purchaseMode, setPurchaseMode] = useState<string>(() => (sp.get("purchaseMode") ?? "all"));
  const [titleType, setTitleType] = useState<string>(() => (sp.get("titleType") ?? "all"));
  const legacyInitial = parseLegacyMilestoneParams(sp);
  const initialMilestone = legacyInitial ? legacyInitial.milestone : normalizeMilestoneKey(sp.get("milestone"));
  const initialPresence = (() => {
    if (legacyInitial) return legacyInitial.presence;
    const raw = sp.get("milestoneStatus") ?? sp.get("milestonePresence") ?? sp.get("status");
    return normalizeMilestonePresence(raw);
  })();
  const [milestoneFilter, setMilestoneFilter] = useState<CaseMilestoneKey | "all">(() => initialMilestone);
  const [milestonePresence, setMilestonePresence] = useState<MilestonePresence>(() => initialPresence);
  const [page, setPage] = useState<number>(() => Number.isInteger(initialPage) && initialPage > 0 ? initialPage : 1);
  const [limit, setLimit] = useState<number>(() => Number.isInteger(initialLimit) && initialLimit > 0 ? initialLimit : 50);
  const normalizeApprovalStatus = (
    raw: string | null,
  ): "pending_approval" | "approved" | "rejected" => {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "pending_approval") return "pending_approval";
    if (s === "rejected") return "rejected";
    return "approved";
  };
  const [approvalStatus, setApprovalStatus] = useState<
    "pending_approval" | "approved" | "rejected"
  >(() => normalizeApprovalStatus(sp.get("approvalStatus")));
  const [pendingViewCaseId, setPendingViewCaseId] = useState<number | null>(null);


  useEffect(() => {
    isHydratingFromUrl.current = true;

    const q = new URLSearchParams(currentQs);
    const nextPageRaw = q.get("page");
    const nextLimitRaw = q.get("limit");
    const nextPage = nextPageRaw ? Number(nextPageRaw) : 1;
    const nextLimit = nextLimitRaw ? Number(nextLimitRaw) : 50;

    const nextSearch = q.get("search") ?? "";
    const nextSpaStatus = q.get("spaStatus") ?? "all";
    const nextLoanStatus = q.get("loanStatus") ?? "all";
    const nextLawyerId = q.get("assignedLawyerId") ?? "all";
    const nextClerkId = q.get("assignedClerkId") ?? "all";
    const nextAssignedToUserId = normalizeAssignedToUserId(q.get("assignedToUserId"));
    const nextProjectId = q.get("projectId") ?? "all";
    const nextPurchaseMode = q.get("purchaseMode") ?? "all";
    const nextTitleType = q.get("titleType") ?? "all";
    const nextApprovalStatus = normalizeApprovalStatus(q.get("approvalStatus"));
    const legacy = parseLegacyMilestoneParams(q);
    const nextMilestone = legacy ? legacy.milestone : normalizeMilestoneKey(q.get("milestone"));
    const nextPresence = legacy ? legacy.presence : normalizeMilestonePresence(q.get("milestoneStatus") ?? q.get("milestonePresence") ?? q.get("status"));

    setSearch((prev) => prev === nextSearch ? prev : nextSearch);
    setSpaStatus((prev) => prev === nextSpaStatus ? prev : nextSpaStatus);
    setLoanStatus((prev) => prev === nextLoanStatus ? prev : nextLoanStatus);
    setLawyerId((prev) => prev === nextLawyerId ? prev : nextLawyerId);
    setClerkId((prev) => prev === nextClerkId ? prev : nextClerkId);
    setAssignedToUserId((prev) => prev === nextAssignedToUserId ? prev : nextAssignedToUserId);
    setProjectId((prev) => prev === nextProjectId ? prev : nextProjectId);
    setPurchaseMode((prev) => prev === nextPurchaseMode ? prev : nextPurchaseMode);
    setTitleType((prev) => prev === nextTitleType ? prev : nextTitleType);
    setApprovalStatus((prev) => prev === nextApprovalStatus ? prev : nextApprovalStatus);
    setMilestoneFilter((prev) => prev === nextMilestone ? prev : nextMilestone);
    setMilestonePresence((prev) => prev === nextPresence ? prev : nextPresence);
    setPage((prev) => prev === (Number.isInteger(nextPage) && nextPage > 0 ? nextPage : 1) ? prev : (Number.isInteger(nextPage) && nextPage > 0 ? nextPage : 1));
    setLimit((prev) => prev === (Number.isInteger(nextLimit) && nextLimit > 0 ? nextLimit : 50) ? prev : (Number.isInteger(nextLimit) && nextLimit > 0 ? nextLimit : 50));

    queueMicrotask(() => { isHydratingFromUrl.current = false; });
  }, [currentQs]);

  useEffect(() => {
    if (isHydratingFromUrl.current) return;

    const nextSp = new URLSearchParams();
    const setIf = (k: string, v: string | undefined) => {
      if (!v || v === "all") return;
      nextSp.set(k, v);
    };
    setIf("search", search.trim() ? search.trim() : undefined);
    setIf("spaStatus", spaStatus);
    setIf("loanStatus", loanStatus);
    setIf("assignedLawyerId", lawyerId);
    setIf("assignedClerkId", clerkId);
    setIf("assignedToUserId", assignedToUserId);
    setIf("projectId", projectId);
    setIf("purchaseMode", purchaseMode);
    setIf("titleType", titleType);
    if (approvalStatus !== "approved") nextSp.set("approvalStatus", approvalStatus);
    setIf("milestone", milestoneFilter === "all" ? undefined : milestoneFilter);
    if (milestoneFilter !== "all") {
      const status = milestonePresence === "completed" ? "done" : milestonePresence;
      nextSp.set("status", status);
      nextSp.set("milestonePresence", milestonePresence);
    }
    nextSp.set("page", String(page));
    nextSp.set("limit", String(limit));

    const nextQs = nextSp.toString();
    if (nextQs !== currentQs) setLocation(`/app/cases?${nextQs}`);
  }, [
    search,
    spaStatus,
    loanStatus,
    lawyerId,
    clerkId,
    assignedToUserId,
    projectId,
    purchaseMode,
    titleType,
    milestoneFilter,
    milestonePresence,
    page,
    limit,
    approvalStatus,
    currentQs,
    setLocation,
  ]);

  const approvedQuery = useListCases(
    {
      page,
      limit,
      search: search || undefined,
      projectId: projectId !== "all" ? Number(projectId) : undefined,
      assignedLawyerId: lawyerId !== "all" ? parseInt(lawyerId) : undefined,
      assignedClerkId: clerkId !== "all" ? parseInt(clerkId) : undefined,
      assignedToUserId: assignedToUserId !== "all" ? parseInt(assignedToUserId) : undefined,
      spaStatus: spaStatus !== "all" ? spaStatus : undefined,
      loanStatus: loanStatus !== "all" ? loanStatus : undefined,
      purchaseMode: purchaseMode !== "all" ? purchaseMode : undefined,
      titleType: titleType !== "all" ? titleType : undefined,
      milestone: milestoneFilter !== "all" ? milestoneFilter : undefined,
      milestonePresence: milestoneFilter !== "all" ? milestonePresence : undefined,
    },
    {
      query: {
        retry: false,
        staleTime: 10_000,
        placeholderData: (prev) => prev,
      },
    },
  );

  const approvalListQuery = useQuery<{
    data: any[];
    total: number;
    page: number;
    limit: number;
  }>({
    queryKey: ["cases", "approval-list", approvalStatus, page, limit, search],
    enabled: approvalStatus !== "approved",
    queryFn: ({ signal }) =>
      apiFetchJson(
        `/cases?approvalStatus=${encodeURIComponent(approvalStatus)}&page=${page}&limit=${limit}&search=${encodeURIComponent(search.trim())}`,
        { signal },
      ),
    retry: false,
    placeholderData: (prev) => prev,
  });

  type CaseFilterOptionsResponse = {
    spaStatuses?: string[];
    loanStatuses?: string[];
    assignees?: {
      lawyers?: Array<{ id: number; name: string }>;
      clerks?: Array<{ id: number; name: string }>;
    };
    milestones?: Array<{ key: CaseMilestoneKey; label: string }>;
  };

  const { data: filterOptions } = useQuery<CaseFilterOptionsResponse>({
    queryKey: ["cases", "filter-options"],
    queryFn: () => apiFetchJson<CaseFilterOptionsResponse>("/cases/filter-options"),
    retry: false,
  });
  const spaStatusesFromApi: string[] | null = Array.isArray(filterOptions?.spaStatuses) ? filterOptions.spaStatuses : null;
  const loanStatusesFromApi: string[] | null = Array.isArray(filterOptions?.loanStatuses) ? filterOptions.loanStatuses : null;
  const spaStatuses: string[] = Array.from(new Set([
    ...(spaStatusesFromApi ?? []),
    ...(spaStatusesFromApi ? [] : (spaStatus !== "all" ? [spaStatus] : [])),
    "Pending",
  ]));
  const loanStatuses: string[] = Array.from(new Set([
    ...(loanStatusesFromApi ?? []),
    ...(loanStatusesFromApi ? [] : (loanStatus !== "all" ? [loanStatus] : [])),
    "Pending",
  ]));
  const lawyers: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.lawyers) ? filterOptions.assignees.lawyers : [];
  const clerks: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.clerks) ? filterOptions.assignees.clerks : [];
  const milestoneOptions: Array<{ key: CaseMilestoneKey; label: string }> = Array.isArray(filterOptions?.milestones) ? filterOptions.milestones : [];

  const { data: projectsRes } = useListProjects({ page: 1, limit: 200 }, { query: { staleTime: 5 * 60 * 1000 } });
  const projects = Array.isArray((projectsRes as any)?.data) ? ((projectsRes as any).data as any[]) : [];

  const lastApprovedRef = useRef<{ data: any[]; total: number; page: number; limit: number } | null>(null);
  const lastApprovalListRef = useRef<{ data: any[]; total: number; page: number; limit: number } | null>(null);

  const approvedData = approvedQuery.data;
  useEffect(() => {
    if (!approvedData || !Array.isArray((approvedData as any).data)) return;
    const data = (approvedData as any).data;
    lastApprovedRef.current = {
      data,
      total: typeof (approvedData as any).total === "number" ? (approvedData as any).total : data.length,
      page: typeof (approvedData as any).page === "number" ? (approvedData as any).page : page,
      limit: typeof (approvedData as any).limit === "number" ? (approvedData as any).limit : limit,
    };
  }, [approvedData, page, limit]);

  useEffect(() => {
    const cur = approvalListQuery.data;
    if (!cur || !Array.isArray((cur as any).data)) return;
    const data = (cur as any).data;
    lastApprovalListRef.current = {
      data,
      total: typeof (cur as any).total === "number" ? (cur as any).total : data.length,
      page: typeof (cur as any).page === "number" ? (cur as any).page : page,
      limit: typeof (cur as any).limit === "number" ? (cur as any).limit : limit,
    };
  }, [approvalListQuery.data, page, limit]);

  const cases = Array.isArray((approvedData as any)?.data)
    ? ((approvedData as any).data as any[])
    : (lastApprovedRef.current?.data ?? []);
  const approvalCases = approvalStatus === "approved"
    ? cases
    : (Array.isArray((approvalListQuery.data as any)?.data)
      ? ((approvalListQuery.data as any).data as any[])
      : (lastApprovalListRef.current?.data ?? []));

  const listIsLoading = approvalStatus === "approved" ? approvedQuery.isLoading : approvalListQuery.isLoading;
  const listIsError = approvalStatus === "approved" ? approvedQuery.isError : approvalListQuery.isError;
  const listError = approvalStatus === "approved" ? approvedQuery.error : approvalListQuery.error;
  const listRefetch = approvalStatus === "approved" ? approvedQuery.refetch : approvalListQuery.refetch;
  const listIsFetching = approvalStatus === "approved" ? approvedQuery.isFetching : approvalListQuery.isFetching;
  const total =
    approvalStatus === "approved"
      ? (typeof (approvedData as any)?.total === "number" ? (approvedData as any).total : (lastApprovedRef.current?.total ?? 0))
      : (typeof (approvalListQuery.data as any)?.total === "number" ? (approvalListQuery.data as any).total : (lastApprovalListRef.current?.total ?? 0));
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pageCount);
  const caseById = useMemo(() => new Map(approvalCases.map((c) => [c.id, c])), [approvalCases]);
  const pendingViewCase = pendingViewCaseId ? (caseById.get(pendingViewCaseId) ?? null) : null;
  const listRows = approvalStatus === "approved" ? cases : approvalCases;
  const hasListRows = listRows.length > 0;
  const isListAbortError = isAbortError(listError);
  const showListLoading = listIsLoading && !hasListRows;
  const showListBlockingError = listIsError && !isListAbortError && !hasListRows;
  const showListInlineError = listIsError && !isListAbortError && hasListRows;

  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page]);

  const lawyerNameById = useMemo(() => new Map(lawyers.map(u => [String(u.id), u.name])), [lawyers]);
  const clerkNameById = useMemo(() => new Map(clerks.map(u => [String(u.id), u.name])), [clerks]);
  const projectNameById = useMemo(() => new Map(projects.map(p => [String(p.id), p.name])), [projects]);
  const milestoneLabelByKey = useMemo(() => new Map(milestoneOptions.map(m => [m.key, m.label])), [milestoneOptions]);

  useEffect(() => {
    if (spaStatusesFromApi && spaStatus !== "all" && spaStatusesFromApi.length > 0 && !spaStatusesFromApi.includes(spaStatus)) {
      setSpaStatus("all");
      setPage(1);
    }
    if (loanStatusesFromApi && loanStatus !== "all" && loanStatusesFromApi.length > 0 && !loanStatusesFromApi.includes(loanStatus)) {
      setLoanStatus("all");
      setPage(1);
    }
  }, [spaStatus, loanStatus, spaStatusesFromApi, loanStatusesFromApi]);

  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; onClear: () => void }> = [];
    if (search.trim()) chips.push({ key: "search", label: `Search: ${search.trim()}`, onClear: () => { setSearch(""); setPage(1); } });
    if (approvalStatus === "approved") {
      if (spaStatus !== "all") chips.push({ key: "spaStatus", label: `SPA: ${spaStatus}`, onClear: () => { setSpaStatus("all"); setPage(1); } });
      if (loanStatus !== "all") chips.push({ key: "loanStatus", label: `Loan: ${loanStatus}`, onClear: () => { setLoanStatus("all"); setPage(1); } });
      if (milestoneFilter !== "all") {
        const label = milestoneLabelByKey.get(milestoneFilter) ?? milestoneFilter;
        const presenceLabel =
          milestonePresence === "missing" ? "Missing"
            : milestonePresence === "filled" ? "Filled"
              : milestonePresence === "completed" ? "Done"
                : "Pending";
        chips.push({
          key: "milestone",
          label: `${label}: ${presenceLabel}`,
          onClear: () => { setMilestoneFilter("all"); setMilestonePresence("filled"); setPage(1); },
        });
      }
      if (assignedToUserId !== "all") {
        const me = Number.isFinite(myUserId) && myUserId > 0 ? myUserId : null;
        const label = me && String(me) === assignedToUserId ? "Assigned: Me" : `Assigned: ${assignedToUserId}`;
        chips.push({ key: "assignedToUserId", label, onClear: () => { setAssignedToUserId("all"); setPage(1); } });
      }
      if (lawyerId !== "all") chips.push({ key: "assignedLawyerId", label: `Lawyer: ${lawyerNameById.get(lawyerId) ?? lawyerId}`, onClear: () => { setLawyerId("all"); setPage(1); } });
      if (clerkId !== "all") chips.push({ key: "assignedClerkId", label: `Clerk: ${clerkNameById.get(clerkId) ?? clerkId}`, onClear: () => { setClerkId("all"); setPage(1); } });
      if (projectId !== "all") chips.push({ key: "projectId", label: `Project: ${projectNameById.get(projectId) ?? projectId}`, onClear: () => { setProjectId("all"); setPage(1); } });
    }
    return chips;
  }, [
    search,
    spaStatus,
    loanStatus,
    milestoneFilter,
    milestonePresence,
    lawyerId,
    clerkId,
    assignedToUserId,
    projectId,
    lawyerNameById,
    clerkNameById,
    projectNameById,
    milestoneLabelByKey,
    myUserId,
    approvalStatus,
  ]);

  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<number>>(new Set());
  const [isBatchStatusOpen, setIsBatchStatusOpen] = useState(false);
  const [batchStatusModule, setBatchStatusModule] = useState<"spa" | "loan">("loan");
  const [batchStatusValue, setBatchStatusValue] = useState<string>("");
  const [bulkZipDownloading, setBulkZipDownloading] = useState(false);
  const [isBatchDateOpen, setIsBatchDateOpen] = useState(false);
  const [batchDateField, setBatchDateField] = useState<string>("");
  const [batchDateValue, setBatchDateValue] = useState<string>("");
  const [isBatchGenerateOpen, setIsBatchGenerateOpen] = useState(false);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<number>>(new Set());
  const [bulkGenerateDownloading, setBulkGenerateDownloading] = useState(false);
  const resubmitMutation = useMutation({
    mutationFn: async (caseId: number) => {
      return await apiFetchJson(`/cases/${caseId}/resubmit`, { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["case-files"] });
      queryClient.invalidateQueries({ queryKey: ["cases", "filter-options"] });
      queryClient.invalidateQueries({ queryKey: ["cases", "approval-list"] });
      queryClient.invalidateQueries({ queryKey: ["cases"] });
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      toast({ title: "Resubmitted for approval" });
    },
    onError: (err) => toastError(toast, err, "Resubmit failed"),
  });

  useEffect(() => {
    setSelectedCaseIds(new Set());
    setIsBatchStatusOpen(false);
    setBatchStatusModule("loan");
    setBatchStatusValue("");
    setIsBatchDateOpen(false);
    setBatchDateField("");
    setBatchDateValue("");
    setIsBatchGenerateOpen(false);
    setSelectedTemplateIds(new Set());
  }, [sp.toString()]);

  const currentPageIds = approvalStatus === "approved" ? cases.map((c) => c.id) : [];
  const allOnPageSelected = currentPageIds.length > 0 && currentPageIds.every((id) => selectedCaseIds.has(id));
  const someOnPageSelected = currentPageIds.some((id) => selectedCaseIds.has(id));

  const toggleSelectAllPage = () => {
    setSelectedCaseIds((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const id of currentPageIds) next.delete(id);
      } else {
        for (const id of currentPageIds) next.add(id);
      }
      return next;
    });
  };

  const toggleSelectOne = (id: number) => {
    setSelectedCaseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkStatusMutation = useMutation({
    mutationFn: async (vars: { module: "spa" | "loan"; status: string; caseIds: number[] }) => {
      const res = await apiFetchJson("/cases/bulk/status", { method: "POST", body: JSON.stringify(vars) });
      return res as { requested: number; succeeded: number; failed: number; failures: Array<{ caseId: number; error: string }> };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      setSelectedCaseIds(new Set());
      setIsBatchStatusOpen(false);
      setBatchStatusValue("");
      toast({ title: "Batch update completed", description: `${data.succeeded} succeeded, ${data.failed} failed` });
    },
    onError: (err) => toastError(toast, err, "Batch update failed"),
  });

  const bulkKeyDatesMutation = useMutation({
    mutationFn: async (vars: { field: string; date: string; caseIds: number[] }) => {
      const res = await apiFetchJson("/cases/bulk/key-dates", { method: "PATCH", body: JSON.stringify(vars) });
      return res as { requested: number; succeeded: number; failed: number; failures: Array<{ caseId: number; error: string }> };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      setSelectedCaseIds(new Set());
      setIsBatchDateOpen(false);
      setBatchDateField("");
      setBatchDateValue("");
      toast({ title: "Batch date update completed", description: `${data.succeeded} succeeded, ${data.failed} failed` });
    },
    onError: (err) => toastError(toast, err, "Batch date update failed"),
  });

  const downloadCsv = async () => {
    const qs = sp.toString();
    const blob = await apiFetchCsv(`/cases/export.csv?${qs}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cases_export.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const caseTypeLabel = (v: string | null | undefined): string => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s === "subsale") return "Subsale";
    if (s === "perfection") return "Perfection";
    return "Developer Sales";
  };

  const buildCaseSummary = (c: any): string => {
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
  };

  if (mode === "create") return null;

  return (
    <div className="space-y-4 pb-24">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Cases</h1>
          <p className="text-slate-500 mt-1">Manage conveyancing cases</p>
          <p className="text-xs text-slate-400 mt-1">Total: {total}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              downloadCsv().catch((err) => toastError(toast, err, "Export failed"));
            }}
          >
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
          <Link href="/app/cases/new">
            <Button className="bg-amber-500 hover:bg-amber-600 text-white">
              <Plus className="w-4 h-4 mr-2" />
              New Case
            </Button>
          </Link>
        </div>
      </div>

      {activeChips.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {activeChips.map((c) => (
              <Badge key={c.key} variant="secondary" className="px-2 py-1">
                <span className="mr-2">{c.label}</span>
                <button className="text-slate-500 hover:text-slate-900" onClick={c.onClear} type="button">×</button>
              </Badge>
            ))}
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              setSearch("");
              setSpaStatus("all");
              setLoanStatus("all");
              setMilestoneFilter("all");
              setMilestonePresence("filled");
              setLawyerId("all");
              setClerkId("all");
              setAssignedToUserId("all");
              setProjectId("all");
              setPage(1);
            }}
          >
            Clear
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
        <div className="relative md:col-span-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search reference, client, project, property..." 
            className="pl-9"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        {approvalStatus === "approved" ? (
          <>
            <Select value={projectId} onValueChange={(v) => { setProjectId(v); setPage(1); }}>
              <SelectTrigger className="md:col-span-3">
                <SelectValue placeholder="Project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={spaStatus} onValueChange={(v) => { setSpaStatus(v); setPage(1); }}>
              <SelectTrigger className="md:col-span-3">
                <SelectValue placeholder="SPA Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All SPA Status</SelectItem>
                {spaStatuses.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={loanStatus} onValueChange={(v) => { setLoanStatus(v); setPage(1); }}>
              <SelectTrigger className="md:col-span-3">
                <SelectValue placeholder="Loan Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Loan Status</SelectItem>
                {loanStatuses.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={lawyerId} onValueChange={(v) => { setLawyerId(v); setPage(1); }}>
              <SelectTrigger className="md:col-span-3">
                <SelectValue placeholder="Assigned Lawyer" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Lawyers</SelectItem>
                {lawyers.map(l => <SelectItem key={l.id} value={l.id.toString()}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={clerkId} onValueChange={(v) => { setClerkId(v); setPage(1); }}>
              <SelectTrigger className="md:col-span-3">
                <SelectValue placeholder="Assigned Clerk" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Clerks</SelectItem>
                {clerks.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        ) : null}
      </div>

      <Tabs value={approvalStatus} onValueChange={(v) => { setApprovalStatus(normalizeApprovalStatus(v)); setPage(1); }}>
        <TabsList>
          <TabsTrigger value="pending_approval">Pending Approval</TabsTrigger>
          <TabsTrigger value="approved">Approved Cases</TabsTrigger>
          <TabsTrigger value="rejected">Case Details to Amend</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-0">
          {showListLoading ? (
            <div className="p-8 text-center text-slate-500">Loading cases...</div>
          ) : showListBlockingError ? (
            <div className="p-6">
              <QueryFallback title="Cases unavailable" error={listError} onRetry={() => listRefetch()} isRetrying={listIsFetching} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              {showListInlineError ? (
                <div className="px-4 py-3 border-b border-slate-200 bg-amber-50 flex items-center justify-between gap-3">
                  <div className="text-sm text-amber-900">
                    Failed to refresh cases. Showing cached results.
                  </div>
                  <Button size="sm" variant="outline" onClick={() => listRefetch()} disabled={listIsFetching}>
                    Retry
                  </Button>
                </div>
              ) : null}
              <table className="w-full text-sm text-left">
                {approvalStatus === "approved" ? (
                  <>
                    <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-4 py-3 font-semibold">
                          <Checkbox
                            checked={allOnPageSelected ? true : (someOnPageSelected ? "indeterminate" : false)}
                            onCheckedChange={toggleSelectAllPage}
                          />
                        </th>
                        <th className="px-6 py-3 font-semibold">Our Reference</th>
                        <th className="px-6 py-3 font-semibold">Client / Purchaser</th>
                        <th className="px-6 py-3 font-semibold">Project / Property</th>
                        <th className="px-6 py-3 font-semibold">Assigned</th>
                        <th className="px-6 py-3 font-semibold">SPA Status</th>
                        <th className="px-6 py-3 font-semibold">Loan Status</th>
                        <th className="px-6 py-3 font-semibold">Milestones</th>
                        <th className="px-6 py-3 font-semibold">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {cases.map((c) => {
                        const ms = (c as any)?.milestones && typeof (c as any).milestones === "object" ? (c as any).milestones : {};
                        return (
                        <tr key={c.id} className="hover:bg-slate-50/50">
                          <td className="px-4 py-4">
                            <Checkbox
                              checked={selectedCaseIds.has(c.id)}
                              onCheckedChange={() => toggleSelectOne(c.id)}
                            />
                          </td>
                          <td className="px-6 py-4">
                            <Link
                              href={`/app/cases/${c.id}?returnTo=${encodeURIComponent(location)}`}
                              onClick={(e) => {
                                if (isPartnerOrManager) return;
                                if (!Number.isFinite(myUserId)) return;
                                const assignedLawyerId = typeof (c as any).assignedLawyerId === "number" ? (c as any).assignedLawyerId : Number((c as any).assignedLawyerId);
                                const assignedClerkId = typeof (c as any).assignedClerkId === "number" ? (c as any).assignedClerkId : Number((c as any).assignedClerkId);
                                const ok = myUserId === assignedLawyerId || myUserId === assignedClerkId;
                                if (!ok) {
                                  e.preventDefault();
                                  toast({
                                    title: "Access Denied",
                                    description: "Access Denied: You are not assigned to this case. You can only view its basic info here.",
                                    variant: "destructive",
                                  });
                                }
                              }}
                            >
                              <span className="font-medium text-slate-900 hover:text-amber-600 cursor-pointer transition-colors">
                                {String((c as any).referenceNo ?? "—") || "—"}
                              </span>
                            </Link>
                          </td>
                          <td className="px-6 py-4 text-slate-700">
                            {String((c as any).clientName ?? "—") || "—"}
                          </td>
                          <td className="px-6 py-4">
                            <div className="font-medium text-slate-800">{String((c as any).projectName ?? "—") || "—"}</div>
                            <div className="text-slate-500 text-xs mt-0.5">
                              {String((c as any).property ?? "") || String((c as any).developerName ?? "—") || "—"}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-slate-800">{String((c as any).assignedLawyerName ?? "—") || "—"}</div>
                            <div className="text-slate-500 text-xs mt-0.5">{String((c as any).assignedClerkName ?? "—") || "—"}</div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700">
                              {String((c as any).spaStatus ?? "—") || "—"}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700">
                              {String((c as any).loanStatus ?? "N/A") || "N/A"}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-xs text-slate-700">
                              <span className="font-semibold">SPA</span>: {fmtYmd((ms as any).spa_date)}
                              <span className="text-slate-400"> · </span>
                              <span className="font-semibold">Stamped</span>: {fmtYmd((ms as any).spa_stamped_date)}
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">
                              <span className="font-semibold">LOF</span>: {fmtYmd((ms as any).letter_of_offer_date)}
                              <span className="text-slate-400"> · </span>
                              <span className="font-semibold">Loan</span>: {fmtYmd((ms as any).loan_docs_signed_date)}
                              <span className="text-slate-400"> · </span>
                              <span className="font-semibold">Comp</span>: {fmtYmd((ms as any).completion_date)}
                            </div>
                            {(c as any).completionSla?.status ? (
                              <div className="mt-1">
                                <span
                                  className={[
                                    "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold",
                                    (c as any).completionSla.status === "overdue"
                                      ? "bg-red-100 text-red-700"
                                      : (c as any).completionSla.status === "soon"
                                        ? "bg-amber-100 text-amber-800"
                                        : "bg-emerald-100 text-emerald-800",
                                  ].join(" ")}
                                >
                                  Advice SLA: {(c as any).completionSla.status === "overdue" ? "Overdue" : (c as any).completionSla.status === "soon" ? "Soon" : "Due"}
                                </span>
                              </div>
                            ) : null}
                          </td>
                          <td className="px-6 py-4 text-slate-600 text-xs">
                            {fmtIsoToYmd((c as any).updatedAt)}
                          </td>
                        </tr>
                        );
                      })}
                      {cases.length === 0 && (
                        <tr>
                          <td colSpan={9} className="px-6 py-8 text-center text-slate-500">
                            No cases found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </>
                ) : approvalStatus === "pending_approval" ? (
                  <>
                    <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 font-semibold">Submitted Date</th>
                        <th className="px-6 py-3 font-semibold">Submitted By</th>
                        <th className="px-6 py-3 font-semibold">Our Reference</th>
                        <th className="px-6 py-3 font-semibold">Client / Purchaser</th>
                        <th className="px-6 py-3 font-semibold">Project / Property</th>
                        <th className="px-6 py-3 font-semibold">Case Type</th>
                        <th className="px-6 py-3 font-semibold">Purchase Mode</th>
                        <th className="px-6 py-3 font-semibold">Title Category</th>
                        <th className="px-6 py-3 font-semibold">Assigned Lawyer</th>
                        <th className="px-6 py-3 font-semibold">Assigned Clerk</th>
                        <th className="px-6 py-3 font-semibold">Approval Status</th>
                        <th className="px-6 py-3 font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {approvalCases.map((c: any) => {
                        const statusRaw = String((c as any).approvalStatus ?? "");
                        const statusLabel =
                          statusRaw === "pending_approval"
                            ? "Pending Approval"
                            : statusRaw
                              ? statusRaw
                              : "—";
                        return (
                          <tr key={c.id} className="hover:bg-slate-50/50">
                            <td className="px-6 py-4 text-slate-600 text-xs">
                              {fmtIsoToYmd((c as any).submittedAt)}
                            </td>
                            <td className="px-6 py-4 text-slate-700 text-xs">
                              {String((c as any).submittedByName ?? "—") || "—"}
                            </td>
                            <td className="px-6 py-4 text-slate-700">
                              {String((c as any).referenceNo ?? "—") || "—"}
                            </td>
                            <td className="px-6 py-4 text-slate-700">
                              {String((c as any).clientName ?? "—") || "—"}
                            </td>
                            <td className="px-6 py-4">
                              <div className="font-medium text-slate-800">
                                {String((c as any).projectName ?? "—") || "—"}
                              </div>
                              <div className="text-slate-500 text-xs mt-0.5">
                                {String((c as any).property ?? "") || String((c as any).developerName ?? "—") || "—"}
                              </div>
                            </td>
                            <td className="px-6 py-4 text-slate-700">
                              {caseTypeLabel((c as any).caseType)}
                            </td>
                            <td className="px-6 py-4 text-slate-700">
                              {String((c as any).purchaseMode ?? "—") || "—"}
                            </td>
                            <td className="px-6 py-4 text-slate-700">
                              {String((c as any).titleType ?? "—") || "—"}
                            </td>
                            <td className="px-6 py-4 text-slate-700">
                              {String((c as any).assignedLawyerName ?? "—") || "—"}
                            </td>
                            <td className="px-6 py-4 text-slate-700">
                              {String((c as any).assignedClerkName ?? "—") || "—"}
                            </td>
                            <td className="px-6 py-4 text-slate-700">
                              {statusLabel}
                            </td>
                            <td className="px-6 py-4">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPendingViewCaseId(c.id)}
                              >
                                View
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                      {approvalCases.length === 0 && (
                        <tr>
                          <td colSpan={12} className="px-6 py-8 text-center text-slate-500">
                            No cases found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </>
                ) : (
                  <>
                    <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-3 font-semibold">Submitted Date</th>
                        <th className="px-6 py-3 font-semibold">Returned Date</th>
                        <th className="px-6 py-3 font-semibold">Case Type</th>
                        <th className="px-6 py-3 font-semibold">Case Summary</th>
                        <th className="px-6 py-3 font-semibold">Amendment Notes</th>
                        <th className="px-6 py-3 font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {approvalCases.map((c: any) => (
                        <tr key={c.id} className="hover:bg-slate-50/50">
                          <td className="px-6 py-4 text-slate-600 text-xs">{fmtIsoToYmd((c as any).submittedAt)}</td>
                          <td className="px-6 py-4 text-slate-600 text-xs">{fmtIsoToYmd((c as any).approvedAt)}</td>
                          <td className="px-6 py-4 text-slate-700">{caseTypeLabel((c as any).caseType)}</td>
                          <td className="px-6 py-4 text-slate-700">{buildCaseSummary(c)}</td>
                          <td className="px-6 py-4 text-slate-700 text-xs">{String((c as any).approvalNote ?? "—")}</td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <Link href={`/app/cases/${c.id}`}>
                                <Button size="sm" variant="outline">Edit Details</Button>
                              </Link>
                              <Button size="sm" onClick={() => resubmitMutation.mutate(c.id)} disabled={resubmitMutation.isPending}>
                                Resubmit for Approval
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {approvalCases.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-6 py-8 text-center text-slate-500">
                            No cases found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={approvalStatus === "pending_approval" && pendingViewCaseId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingViewCaseId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pending Approval (View Only)</DialogTitle>
            <DialogDescription>Read-only summary for submitted open file approval.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs text-slate-500">Submitted Date</div>
              <div className="mt-1 text-slate-800">
                {fmtIsoToYmd((pendingViewCase as any)?.submittedAt)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Submitted By</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.submittedByName ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Our Reference</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.referenceNo ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Client / Purchaser</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.clientName ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Project</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.projectName ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Property</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.property ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Developer</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.developerName ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Case Type</div>
              <div className="mt-1 text-slate-800">
                {caseTypeLabel((pendingViewCase as any)?.caseType)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Purchase Mode</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.purchaseMode ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Title Category</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.titleType ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Assigned Lawyer</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.assignedLawyerName ?? "—") || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Assigned Clerk</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.assignedClerkName ?? "—") || "—"}
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs text-slate-500">Approval Status</div>
              <div className="mt-1 text-slate-800">
                {String((pendingViewCase as any)?.approvalStatus ?? "—") || "—"}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingViewCaseId(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-slate-500">
          Page {safePage} / {pageCount}
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(limit)} onValueChange={(v) => { setLimit(Number(v)); setPage(1); }}>
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue placeholder="Per page" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="20">20 / page</SelectItem>
              <SelectItem value="50">50 / page</SelectItem>
              <SelectItem value="100">100 / page</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
          <Button variant="outline" size="sm" disabled={safePage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next</Button>
        </div>
      </div>

      {approvalStatus === "approved" && selectedCaseIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40">
          <div className="mx-auto w-full max-w-6xl px-4 pb-4">
            <Card className="shadow-lg border-slate-200">
              <CardContent className="py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div className="text-sm text-slate-700">
                  {selectedCaseIds.size} case(s) selected
                </div>
                <div className="flex flex-col lg:flex-row gap-2 lg:items-center">
                  <Button
                    disabled={bulkStatusMutation.isPending || bulkKeyDatesMutation.isPending || bulkGenerateDownloading}
                    onClick={() => {
                      setBatchStatusValue("");
                      setIsBatchStatusOpen(true);
                    }}
                  >
                    Batch Update Status
                  </Button>

                  <Button
                    disabled={bulkStatusMutation.isPending || bulkKeyDatesMutation.isPending || bulkGenerateDownloading}
                    onClick={() => {
                      setBatchDateField("");
                      setBatchDateValue("");
                      setIsBatchDateOpen(true);
                    }}
                  >
                    Batch Update Date
                  </Button>

                  <Button
                    variant="secondary"
                    disabled={bulkStatusMutation.isPending || bulkKeyDatesMutation.isPending || bulkGenerateDownloading}
                    onClick={() => setIsBatchGenerateOpen(true)}
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Batch Generate Documents
                  </Button>

                  <Button variant="ghost" onClick={() => setSelectedCaseIds(new Set())}>
                    Clear selection
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {approvalStatus === "approved" ? (
        <>
          <Dialog open={isBatchStatusOpen} onOpenChange={setIsBatchStatusOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Batch Update Status</DialogTitle>
                <DialogDescription>Update workflow status for multiple cases at once.</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-1">
                  <div className="text-sm font-medium">Module</div>
                  <Select
                    value={batchStatusModule}
                    onValueChange={(v: "spa" | "loan") => {
                      setBatchStatusModule(v);
                      setBatchStatusValue("");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select module" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="spa">SPA Status</SelectItem>
                      <SelectItem value="loan">Loan Status</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <div className="text-sm font-medium">New Status</div>
                  <Select value={batchStatusValue} onValueChange={setBatchStatusValue}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      {(batchStatusModule === "spa" ? spaStatuses : loanStatuses)
                        .filter((s) => s !== "Pending")
                        .map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsBatchStatusOpen(false)}>Cancel</Button>
                <Button
                  disabled={!batchStatusValue || bulkStatusMutation.isPending}
                  onClick={() => {
                    const ids = Array.from(selectedCaseIds);
                    const filtered = batchStatusModule === "loan"
                      ? ids.filter((id) => String((caseById.get(id) as any)?.purchaseMode ?? "").trim().toLowerCase() === "loan")
                      : ids;
                    if (filtered.length === 0) {
                      toast({ title: "No eligible cases selected", description: "Select at least one matching case for this module.", variant: "destructive" });
                      return;
                    }
                    bulkStatusMutation.mutate({ module: batchStatusModule, status: batchStatusValue, caseIds: filtered });
                  }}
                >
                  Update
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={isBatchDateOpen} onOpenChange={setIsBatchDateOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Batch Update Date</DialogTitle>
                <DialogDescription>Update a key date for multiple cases at once.</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-1">
                  <div className="text-sm font-medium">Field</div>
                  <Select value={batchDateField} onValueChange={setBatchDateField}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select field" />
                    </SelectTrigger>
                    <SelectContent>
                      {milestoneOptions.map((m) => (
                        <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <div className="text-sm font-medium">Date</div>
                  <DateOnlyInput valueYmd={batchDateValue} onChangeYmd={setBatchDateValue} />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsBatchDateOpen(false)}>Cancel</Button>
                <Button
                  disabled={!batchDateField || !batchDateValue || bulkKeyDatesMutation.isPending}
                  onClick={() => {
                    const ids = Array.from(selectedCaseIds);
                    const loanOnly = new Set([
                      "letter_of_offer_date",
                      "letter_of_offer_stamped_date",
                      "loan_docs_pending_date",
                      "loan_docs_signed_date",
                      "acting_letter_issued_date",
                      "loan_sent_bank_execution_date",
                      "loan_bank_executed_date",
                      "bank_lu_received_date",
                      "advice_to_bank_date",
                      "bank_lu_forward_to_developer_on",
                      "developer_lu_received_on",
                      "developer_lu_dated",
                      "register_poa_on",
                      "letter_disclaimer_dated",
                      "loan_agreement_stamped_date",
                      "bank_1st_release_on",
                      "discharge_date",
                      "caveat_lodged_date",
                      "first_advice_date",
                      "dev_informed_redemption_date",
                      "request_discharge_date",
                      "charge_date",
                      "presentation_date",
                      "second_advice_date",
                      "mot_received_date",
                      "mot_signed_date",
                      "mot_stamped_date",
                      "mot_registered_date",
                      "noa_served_on",
                    ]);
                    const filtered = loanOnly.has(batchDateField)
                      ? ids.filter((id) => String((caseById.get(id) as any)?.purchaseMode ?? "").trim().toLowerCase() === "loan")
                      : ids;
                    if (filtered.length === 0) {
                      toast({ title: "No eligible cases selected", description: "Select at least one matching case for this field.", variant: "destructive" });
                      return;
                    }
                    bulkKeyDatesMutation.mutate({ field: batchDateField, date: batchDateValue, caseIds: filtered });
                  }}
                >
                  Update
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <BatchGenerateDialog
            open={isBatchGenerateOpen}
            onOpenChange={(v) => {
              setIsBatchGenerateOpen(v);
              if (!v) setSelectedTemplateIds(new Set());
            }}
            selectedCaseIds={selectedCaseIds}
            caseById={caseById}
            selectedTemplateIds={selectedTemplateIds}
            setSelectedTemplateIds={setSelectedTemplateIds}
            bulkZipDownloading={bulkZipDownloading}
            setBulkZipDownloading={setBulkZipDownloading}
            bulkGenerateDownloading={bulkGenerateDownloading}
            setBulkGenerateDownloading={setBulkGenerateDownloading}
            onSuccess={() => {
              setSelectedCaseIds(new Set());
            }}
            toast={toast}
          />
        </>
      ) : null}
    </div>
  );
}

function BatchGenerateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCaseIds: Set<number>;
  caseById: Map<number, any>;
  selectedTemplateIds: Set<number>;
  setSelectedTemplateIds: (next: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
  bulkZipDownloading: boolean;
  setBulkZipDownloading: (v: boolean) => void;
  bulkGenerateDownloading: boolean;
  setBulkGenerateDownloading: (v: boolean) => void;
  onSuccess: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const {
    open,
    onOpenChange,
    selectedCaseIds,
    caseById,
    selectedTemplateIds,
    setSelectedTemplateIds,
    bulkZipDownloading,
    setBulkZipDownloading,
    bulkGenerateDownloading,
    setBulkGenerateDownloading,
    onSuccess,
    toast,
  } = props;

  const [mode, setMode] = useState<"download" | "print">("download");
  const [copies, setCopies] = useState("1");
  const [job, setJob] = useState<NormalizedGenerationJob | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState<string | null>(null);
  const [failureLines, setFailureLines] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const runKeyRef = useRef<string>("");

  useEffect(() => {
    if (open) return;
    abortRef.current?.abort();
    abortRef.current = null;
    runKeyRef.current = "";
    setJob(null);
    setProgressText(null);
    setCurrentText(null);
    setFailureLines([]);
  }, [open]);

  const foldersQuery = useQuery<TemplateFolderPickerFolder[]>({
    queryKey: ["document-automation", "folders"],
    queryFn: () => apiFetchJson<TemplateFolderPickerFolder[]>("/firm-document-folders"),
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });

  const templatesQuery = useQuery<TemplateFolderPickerTemplate[]>({
    queryKey: ["document-automation", "templates"],
    queryFn: () => apiFetchJson<TemplateFolderPickerTemplate[]>("/document-templates?templateCapable=true&kind=template"),
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });

  const folders = Array.isArray(foldersQuery.data) ? foldersQuery.data : [];
  const templates = Array.isArray(templatesQuery.data) ? templatesQuery.data : [];

  const selectedTemplateCount = selectedTemplateIds.size;
  const selectedCaseCount = selectedCaseIds.size;

  const safeText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const parseFilenameFromDisposition = (v: string | null): string | null => {
    if (!v) return null;
    const m = /filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?/i.exec(v);
    const raw = m?.[1] ?? m?.[2] ?? "";
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  const getApiErrorCode = (err: unknown): string => {
    const r = err && typeof err === "object" && !Array.isArray(err) ? (err as any) : {};
    const direct = safeText(r.code);
    if (direct) return direct;
    const data = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : null;
    const errObj = data && typeof (data as any).error === "object" ? (data as any).error : null;
    return errObj ? safeText(errObj.code) : "";
  };

  const caseLabel = (caseId: number): string => {
    const c = caseById.get(caseId);
    const ref =
      safeText((c as any)?.referenceNo) ||
      safeText((c as any)?.reference_no) ||
      safeText((c as any)?.reference) ||
      "";
    return ref ? ref : `Case ${caseId}`;
  };

  const computeCurrentText = (snapshot: NormalizedGenerationJob): string | null => {
    const items = snapshot.items ?? [];
    const running =
      items.find((it) => String(it.status ?? "") === "running") ??
      items.find((it) => String(it.status ?? "") === "processing") ??
      null;
    const pending = items.find((it) => String(it.status ?? "") === "pending") ?? null;
    const pick = running ?? pending;
    if (!pick) return null;
    const cid = typeof pick.caseId === "number" ? pick.caseId : 0;
    const tpl = safeText(pick.templateName) || "Template";
    return `${caseLabel(cid)} - ${tpl}`;
  };

  const updateProgressUi = (snapshot: NormalizedGenerationJob) => {
    const total = snapshot.progress?.total ?? snapshot.totalCount ?? 0;
    const done =
      (snapshot.progress?.success ?? snapshot.successCount ?? 0) +
      (snapshot.progress?.failed ?? snapshot.failedCount ?? 0);
    setProgressText(total > 0 ? `${done} / ${total} completed` : null);
    setCurrentText(computeCurrentText(snapshot));
    const failed = (snapshot.items ?? []).filter((it) => String(it.status ?? "") === "failed");
    const lines = failed.slice(0, 5).map((it) => {
      const cid = typeof it.caseId === "number" ? it.caseId : 0;
      const tpl = safeText(it.templateName) || "Template";
      const code = safeText(it.errorCode);
      const msg = safeText(it.errorMessage);
      const diag = it.diagnostic && typeof it.diagnostic === "object" ? (it.diagnostic as any) : null;
      const sqlState = diag ? safeText(diag.sqlstate ?? diag.sqlState) : "";
      const parts = [
        `${caseLabel(cid)} - ${tpl}`,
        code ? `(${code})` : "",
        sqlState ? `SQLSTATE=${sqlState}` : "",
        msg ? `- ${msg}` : "",
      ].filter(Boolean);
      return parts.join(" ");
    });
    setFailureLines(lines);
  };

  const generateAndDownloadZip = async () => {
    const ids = Array.from(selectedCaseIds);
    const templateIds = Array.from(selectedTemplateIds);
    if (ids.length === 0 || templateIds.length === 0) return;
    setBulkGenerateDownloading(true);
    try {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const runKey = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      runKeyRef.current = runKey;

      const templates = templateIds.map((id) => ({ source: "firm" as const, id }));
      const created = await createGenerationJob({
        caseIds: ids,
        templates,
        config: {
          action: mode,
          outputFormat: "pdf",
          ...(mode === "print" ? { copies: copies || "1" } : {}),
        },
      });
      const jobId = created.jobId;
      if (!jobId) throw new Error("Missing jobId");

      try {
        const st = await getGenerationJobStatus(jobId, { signal: ctrl.signal });
        if (runKeyRef.current === runKey) {
          setJob(st);
          updateProgressUi(st);
        }
      } catch {}

      for (;;) {
        if (runKeyRef.current !== runKey) return;
        let next: NormalizedGenerationJob;
        try {
          next = await runNextGenerationJob(jobId, { signal: ctrl.signal });
        } catch (err) {
          const code = getApiErrorCode(err);
          if (code === "RUN_NEXT_IN_FLIGHT") {
            await new Promise<void>((r) => setTimeout(r, 600));
            continue;
          }
          const status =
            err && typeof err === "object" && "status" in (err as any) && typeof (err as any).status === "number"
              ? Number((err as any).status)
              : null;
          if (code === "JOB_NOT_FOUND" || status === 404) {
            throw new Error("Job not found (JOB_NOT_FOUND). Please start a new job.");
          }
          next = await getGenerationJobStatus(jobId, { signal: ctrl.signal });
        }

        if (runKeyRef.current !== runKey) return;
        setJob(next);
        updateProgressUi(next);

        const st = String(next.status ?? "");
        const action =
          next.nextAction ??
          (() => {
            if ((next.progress?.pending ?? next.pendingCount) > 0) return "run_next";
            if ((next.progress?.running ?? next.runningCount ?? 0) > 0) return "run_next";
            if (st === "finalizing") return "finalize";
            if (st === "completed" || st === "completed_with_errors") return "download";
            if (st === "failed") return "stop";
            return "run_next";
          })();

        if (action === "finalize") {
          const fin = await finalizeGenerationJob(jobId, { signal: ctrl.signal });
          if (runKeyRef.current !== runKey) return;
          setJob(fin);
          updateProgressUi(fin);
          continue;
        }

        if (action === "download") {
          let resp: Response | null = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            resp = await downloadGenerationJob(jobId, { signal: ctrl.signal });
            if (resp.status !== 409) break;
            const ct = resp.headers.get("Content-Type") ?? "";
            if (!ct.includes("application/json") && !ct.includes("text/")) break;
            const body = (await resp.json().catch(() => null)) as any;
            const code = body?.error?.code ? String(body.error.code) : "";
            if (code !== "JOB_NOT_FINALIZED" && code !== "JOB_NOT_COMPLETED") break;
            await new Promise<void>((r) => setTimeout(r, 500 * attempt));
            try {
              const fin = await finalizeGenerationJob(jobId, { signal: ctrl.signal });
              if (runKeyRef.current !== runKey) return;
              setJob(fin);
              updateProgressUi(fin);
            } catch {}
          }
          if (!resp) throw new Error("Download failed");
          const contentType = resp.headers.get("Content-Type") ?? "";
          if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(text || "Download failed");
          }
          if (
            contentType.includes("application/json") ||
            contentType.includes("text/")
          ) {
            const text = await resp.text().catch(() => "");
            throw new Error(text || "Download failed");
          }
          const blob = await resp.blob();
          const fileName =
            parseFilenameFromDisposition(resp.headers.get("content-disposition")) ||
            (mode === "print" ? "system-print.pdf" : "batch-documents.zip");
          if (mode === "print") {
            const url = URL.createObjectURL(blob);
            const iframe = document.createElement("iframe");
            iframe.style.position = "fixed";
            iframe.style.right = "0";
            iframe.style.bottom = "0";
            iframe.style.width = "0";
            iframe.style.height = "0";
            iframe.src = url;
            iframe.onload = () => {
              try {
                iframe.contentWindow?.focus();
                iframe.contentWindow?.print();
              } catch {}
              setTimeout(() => {
                URL.revokeObjectURL(url);
                iframe.remove();
              }, 60_000);
            };
            document.body.appendChild(iframe);
            toast({
              title: "Printable PDF ready",
              description: `${ids.length} case(s), ${templateIds.length} template(s)`,
            });
          } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName || "batch-documents.zip";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            toast({
              title: "Download started",
              description: `${ids.length} case(s), ${templateIds.length} template(s)`,
            });
          }
          onOpenChange(false);
          onSuccess();
          return;
        }

        if (action === "stop" || st === "failed") {
          const summary = next.errorSummary || "Generation failed";
          throw new Error(summary);
        }

        await new Promise<void>((r) => setTimeout(r, 250));
      }
    } catch (err) {
      toastError(toast, err, mode === "print" ? "Batch print failed" : "Batch generate failed");
    } finally {
      setBulkGenerateDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Batch Generate Documents</DialogTitle>
          <DialogDescription>Select template folders/files, then download or print.</DialogDescription>
        </DialogHeader>

        {templatesQuery.isError || foldersQuery.isError ? (
          <QueryFallback title="Templates unavailable" error={templatesQuery.error || foldersQuery.error} onRetry={() => { foldersQuery.refetch(); templatesQuery.refetch(); }} isRetrying={foldersQuery.isFetching || templatesQuery.isFetching} />
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              {selectedCaseCount} case(s) selected · {selectedTemplateCount} template(s) selected
            </div>
            {bulkGenerateDownloading ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <div className="font-medium">Generating documents...</div>
                {progressText ? <div className="text-slate-600">{progressText}</div> : null}
                {currentText ? <div className="text-slate-600">Current: {currentText}</div> : null}
                {failureLines.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    <div className="text-slate-600">Failures:</div>
                    <ul className="list-disc pl-5 text-slate-600">
                      {failureLines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
            <TemplateFolderPicker
              folders={folders}
              templates={templates}
              selectedTemplateIds={selectedTemplateIds}
              onChange={(next) => setSelectedTemplateIds(next)}
            />
            <div className="flex items-center gap-2">
              <Select value={mode} onValueChange={(v) => setMode(v === "print" ? "print" : "download")}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="download">Download ZIP</SelectItem>
                  <SelectItem value="print">System Print</SelectItem>
                </SelectContent>
              </Select>
              {mode === "print" ? (
                <Input value={copies} onChange={(e) => setCopies(e.target.value)} inputMode="numeric" className="w-[120px]" placeholder="Copies" />
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={bulkZipDownloading || bulkGenerateDownloading || selectedCaseCount === 0 || selectedTemplateCount === 0}
            onClick={() => {
              setBulkZipDownloading(true);
              generateAndDownloadZip().finally(() => setBulkZipDownloading(false));
            }}
          >
            {mode === "print" ? "Generate & Print" : "Generate & Download ZIP"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
