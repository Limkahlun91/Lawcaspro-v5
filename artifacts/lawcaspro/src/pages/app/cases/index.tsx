import { CaseMilestoneKey, MilestonePresence, getListCasesQueryKey, useListCases, useListProjects, getListProjectsQueryKey, useListUsers, getListUsersQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Plus, Search, Printer, Pencil as BatchUpdateIcon, FileSpreadsheet } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FeatureGuard } from "@/lib/feature-guards";
import { PermissionGuard } from "@/components/permission-guard";

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
      await queryClient.invalidateQueries({ queryKey: ["case-notifications", "unread-counts"] });
    },
  });

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

  const listCasesParams = {
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
  };
  const approvedQuery = useListCases(listCasesParams, {
    query: {
      retry: false,
      staleTime: 10_000,
      placeholderData: (prev) => prev,
      queryKey: getListCasesQueryKey(listCasesParams),
    },
  });

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

  useEffect(() => {
    const counts = notifCounts;
    if (!counts) return;
    const types =
      approvalStatus === "pending_approval"
        ? ["OPEN_FILE_PENDING_APPROVAL"]
        : approvalStatus === "rejected"
          ? ["CASE_DETAILS_TO_AMEND"]
          : ["CASE_APPROVED", "REFERENCE_NO_CHANGED"];
    const count =
      approvalStatus === "pending_approval"
        ? counts.pendingApprovalUnreadCount
        : approvalStatus === "rejected"
          ? counts.amendUnreadCount
          : counts.approvedUnreadCount;
    if (count <= 0) return;
    const ready = approvalStatus === "approved" ? approvedQuery.isSuccess : approvalListQuery.isSuccess;
    if (!ready) return;
    if (markReadMutation.isPending) return;
    markReadMutation.mutate({ types });
  }, [approvalListQuery.isSuccess, approvalStatus, approvedQuery.isSuccess, markReadMutation, notifCounts]);

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

  const listProjectsParamsCases = { page: 1 as const, limit: 200 as const };
  const { data: projectsRes } = useListProjects(listProjectsParamsCases, {
    query: { staleTime: 5 * 60 * 1000, queryKey: getListProjectsQueryKey(listProjectsParamsCases) },
  });
  const projects = Array.isArray((projectsRes as any)?.data) ? ((projectsRes as any).data as any[]) : [];

  const listUsersParams = { page: 1 as const, limit: 500 as const };
  const { data: usersResData } = useListUsers(listUsersParams, {
    query: { staleTime: 5 * 60 * 1000, queryKey: getListUsersQueryKey(listUsersParams), retry: false, enabled: Boolean(user) },
  });
  const firmUsers: Array<{ id: number; name: string; roleName?: string | null }> = Array.isArray((usersResData as any)?.data?.users)
    ? (usersResData as any).data.users
    : Array.isArray((usersResData as any)?.users) ? (usersResData as any).users : [];

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

  const [isBatchUpdateOpen, setIsBatchUpdateOpen] = useState(false);
  const [isBatchPrintOpen, setIsBatchPrintOpen] = useState(false);
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
          <FeatureGuard feature="cases.legacy_import" hideDisabled={true}>
            <PermissionGuard module="cases" action="create" mode="silent">
              <Link href="/app/cases/import">
                <Button variant="outline">
                  <FileSpreadsheet className="w-4 h-4 mr-2" />
                  Import Old Cases
                </Button>
              </Link>
            </PermissionGuard>
          </FeatureGuard>
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
          <TabsTrigger value="pending_approval">
            <span className="flex items-center gap-2">
              Pending Approval
              {(notifCounts?.pendingApprovalUnreadCount ?? 0) > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                  {notifCounts?.pendingApprovalUnreadCount ?? 0}
                </span>
              ) : null}
            </span>
          </TabsTrigger>
          <TabsTrigger value="approved">
            <span className="flex items-center gap-2">
              Approved Cases
              {(notifCounts?.approvedUnreadCount ?? 0) > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-500 rounded-full">
                  {notifCounts?.approvedUnreadCount ?? 0}
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
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <span>{selectedCaseIds.size} case(s) selected</span>
                  {!isPartnerOrManager && (
                    <span className="text-amber-600/90 text-xs px-2 py-1 bg-amber-500/10 rounded border border-amber-200/40">
                      Batch is limited to My Work assigned cases only
                    </span>
                  )}
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

                  <Button
                    variant="secondary"
                    disabled={bulkStatusMutation.isPending || bulkKeyDatesMutation.isPending || bulkGenerateDownloading}
                    onClick={() => setIsBatchUpdateOpen(true)}
                  >
                    <BatchUpdateIcon className="w-4 h-4 mr-2" />
                    Batch Update
                  </Button>

                  <Button
                    disabled={bulkStatusMutation.isPending || bulkKeyDatesMutation.isPending || bulkGenerateDownloading}
                    onClick={() => setIsBatchPrintOpen(true)}
                  >
                    <Printer className="w-4 h-4 mr-2" />
                    Batch Print
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

          <Dialog open={isBatchUpdateOpen} onOpenChange={setIsBatchUpdateOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Batch Update</DialogTitle>
                <DialogDescription>Update multiple case fields in a single batch operation.</DialogDescription>
              </DialogHeader>
              <BatchUpdateModalBody
                selectedCaseIds={selectedCaseIds}
                caseById={caseById}
                firmUsers={firmUsers}
                spaStatuses={spaStatuses}
                loanStatuses={loanStatuses}
                onClose={() => setIsBatchUpdateOpen(false)}
                onSuccess={() => {
                  setSelectedCaseIds(new Set());
                  setIsBatchUpdateOpen(false);
                }}
                toast={toast}
                isPartnerOrManager={isPartnerOrManager}
                isStaffMode={!isPartnerOrManager}
              />
            </DialogContent>
          </Dialog>

          <Dialog open={isBatchPrintOpen} onOpenChange={setIsBatchPrintOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Batch Print</DialogTitle>
                <DialogDescription>Print or download documents for multiple cases.</DialogDescription>
              </DialogHeader>
              <BatchPrintModalBody
                selectedCaseIds={selectedCaseIds}
                caseById={caseById}
                onClose={() => setIsBatchPrintOpen(false)}
                onSuccess={() => {
                  setSelectedCaseIds(new Set());
                  setIsBatchPrintOpen(false);
                }}
                toast={toast}
                isStaffMode={!isPartnerOrManager}
              />
            </DialogContent>
          </Dialog>
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

function BatchUpdateModalBody(props: {
  selectedCaseIds: Set<number>;
  caseById: Map<number, any>;
  firmUsers: Array<{ id: number; name: string; roleName?: string | null }>;
  spaStatuses: string[];
  loanStatuses: string[];
  onClose: () => void;
  onSuccess: () => void;
  toast: ReturnType<typeof useToast>["toast"];
  isPartnerOrManager: boolean;
  isStaffMode: boolean;
}) {
  const { selectedCaseIds, caseById, firmUsers, spaStatuses, loanStatuses, onClose, onSuccess, toast, isPartnerOrManager, isStaffMode } = props;
  const queryClient = useQueryClient();

  const caseIdsArr = Array.from(selectedCaseIds).sort();
  const casesSelected = caseIdsArr.map((id) => caseById.get(id)).filter(Boolean);

  const [enabledFields, setEnabledFields] = useState<Set<string>>(new Set());
  const [statusModule, setStatusModule] = useState<"spa" | "loan">("loan");
  const [statusValue, setStatusValue] = useState<string>("");
  const [statusDateYmd, setStatusDateYmd] = useState<string>("");
  const [remarksText, setRemarksText] = useState<string>("");
  const [assignedLawyerId, setAssignedLawyerId] = useState<string>("");
  const [assignedClerkId, setAssignedClerkId] = useState<string>("");
  const [responsibleLawyerId, setResponsibleLawyerId] = useState<string>("");
  const [nextAction, setNextAction] = useState<string>("");
  const [nextActionDateYmd, setNextActionDateYmd] = useState<string>("");
  const [lawyerStatus, setLawyerStatus] = useState<string>("");
  const [confirmStep, setConfirmStep] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [result, setResult] = useState<null | {
    succeeded: number;
    skipped: number;
    failed: number;
    results: any[];
    transitionWarnings: string[];
  }>(null);

  const caseUpdatedAtById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of casesSelected) {
      const id = String(c.id);
      const ua = c.updatedAt ?? c.updated_at;
      if (ua) m.set(id, ua);
    }
    return m;
  }, [casesSelected]);

  const getCurrentStatus = (c: any, module: "spa" | "loan"): string => {
    return module === "spa" ? (c.spaStatus ?? c.spa_status ?? "") : (c.loanStatus ?? c.loan_status ?? "");
  };

  const toggleField = (key: string) => {
    setEnabledFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const lawyerUsers = firmUsers.filter((u) => {
    const r = String(u.roleName ?? "").toLowerCase();
    return r.includes("lawyer") || isPartnerOrManager;
  });

  const mutation = useMutation({
    mutationFn: async () => {
      setSubmitting(true);
      const body = {
        caseIds: caseIdsArr,
        updates: {
          status: enabledFields.has("status") ? { module: statusModule, value: statusValue } : undefined,
          statusDate: enabledFields.has("statusDate") ? statusDateYmd : undefined,
          remarks: enabledFields.has("remarks") ? remarksText : undefined,
          assignedLawyerId: enabledFields.has("assignedLawyerId") && assignedLawyerId ? Number(assignedLawyerId) : undefined,
          assignedClerkId: enabledFields.has("assignedClerkId") && assignedClerkId ? Number(assignedClerkId) : undefined,
          responsibleLawyerId: enabledFields.has("responsibleLawyerId") && responsibleLawyerId ? Number(responsibleLawyerId) : undefined,
          nextAction: enabledFields.has("nextAction") ? nextAction : undefined,
          nextActionDate: enabledFields.has("nextActionDate") ? nextActionDateYmd : undefined,
          lawyerStatus: enabledFields.has("lawyerStatus") ? lawyerStatus : undefined,
        },
        enabledFields: Array.from(enabledFields),
        caseUpdatedAtById: Object.fromEntries(Array.from(caseUpdatedAtById.entries()).filter(([, v]) => v != null)),
        confirmSummary: true,
      };
      const res = await apiFetchJson("/cases/batch/update", { method: "POST", body: JSON.stringify(body) });
      return res as any;
    },
    onSuccess: (data) => {
      setResult({
        succeeded: data.succeeded ?? 0,
        skipped: data.skipped ?? 0,
        failed: data.failed ?? 0,
        results: data.results ?? [],
        transitionWarnings: data.transitionWarnings ?? [],
      });
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      toast({ title: "Batch update completed", description: `${data.succeeded ?? 0} succeeded, ${data.skipped ?? 0} skipped, ${data.failed ?? 0} failed` });
    },
    onError: (err) => {
      toastError(toast, err, "Batch update failed");
    },
    onSettled: () => {
      setSubmitting(false);
    },
  });

  const renderFieldToggle = (key: string, label: string, controls: React.ReactNode) => (
    <div className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        <Checkbox checked={enabledFields.has(key)} onCheckedChange={() => toggleField(key)} id={`toggle-${key}`} />
        <Label htmlFor={`toggle-${key}`} className="text-sm font-medium">{label}</Label>
      </div>
      {enabledFields.has(key) && <div className="pl-6 space-y-2">{controls}</div>}
    </div>
  );

  const getFieldNewValue = (key: string): string => {
    switch (key) {
      case "status": return `Status (${statusModule}) → ${statusValue || "—"}`;
      case "statusDate": return `Status Date → ${statusDateYmd || "—"}`;
      case "remarks": return `Append Remark → "${remarksText.slice(0, 60)}${remarksText.length > 60 ? "…" : ""}"`;
      case "assignedLawyerId": {
        const u = firmUsers.find((x) => String(x.id) === assignedLawyerId);
        return `Assigned Lawyer → ${u ? u.name : "Clear"}`;
      }
      case "assignedClerkId": {
        const u = firmUsers.find((x) => String(x.id) === assignedClerkId);
        return `Assigned Clerk → ${u ? u.name : "Clear"}`;
      }
      case "responsibleLawyerId": {
        const u = firmUsers.find((x) => String(x.id) === responsibleLawyerId);
        return `Responsible Lawyer → ${u ? u.name : "Clear"}`;
      }
      case "nextAction": return `Next Action → "${nextAction || "—"}"`;
      case "nextActionDate": return `Next Action Date → ${nextActionDateYmd || "—"}`;
      case "lawyerStatus": return `Lawyer Status → "${lawyerStatus || "—"}"`;
      default: return key;
    }
  };

  const getFieldCurrentValues = (key: string): string[] => {
    return casesSelected.map((c) => {
      switch (key) {
        case "status": return getCurrentStatus(c, statusModule);
        case "statusDate": return fmtIsoToYmd(c.statusDate ?? c.status_date);
        case "remarks": return c.caseNotes ?? c.case_notes ?? "—";
        case "assignedLawyerId": return c.assignedLawyerName ?? c.assigned_lawyer_name ?? "—";
        case "assignedClerkId": return c.assignedClerkName ?? c.assigned_clerk_name ?? "—";
        case "responsibleLawyerId": return c.responsibleLawyerName ?? c.responsible_lawyer_name ?? "—";
        case "nextAction": return c.nextAction ?? c.next_action ?? "—";
        case "nextActionDate": return fmtIsoToYmd(c.nextActionDate ?? c.next_action_date);
        case "lawyerStatus": return c.lawyerStatus ?? c.lawyer_status ?? "—";
        default: return "—";
      }
    });
  };

  const hasTransitionWarning = (() => {
    if (!enabledFields.has("status")) return false;
    const currentVals = Array.from(new Set(casesSelected.map((c) => getCurrentStatus(c, statusModule)).filter(Boolean)));
    if (currentVals.length <= 1) return false;
    const backward = ["Pending", "In Progress", "Completed"];
    const targetIdx = backward.indexOf(statusValue);
    return currentVals.some((v) => {
      const curIdx = backward.indexOf(v);
      return targetIdx >= 0 && curIdx > targetIdx;
    });
  })();

  if (result) {
    return (
      <div className="space-y-4">
        {isStaffMode && (
          <div className="text-amber-600/90 text-xs p-3 bg-amber-500/10 rounded border border-amber-200/40 mb-3">
            Batch actions restricted: server will only apply to cases assigned to you (My Work scope). Unassigned cases will be skipped.
          </div>
        )}
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2">
          <div className="font-medium text-green-800">Batch update finished</div>
          <div className="text-sm text-green-700">
            Succeeded: {result.succeeded} · Skipped: {result.skipped} · Failed: {result.failed}
          </div>
        </div>
        {result.transitionWarnings.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {result.transitionWarnings.map((w, i) => (
              <div key={i}>• {w}</div>
            ))}
          </div>
        )}
        {result.results && result.results.some((r: any) => !r.ok) && (
          <ScrollArea className="h-48 rounded-md border border-slate-200">
            <div className="space-y-1 p-2 text-sm">
              {result.results
                .filter((r: any) => !r.ok)
                .map((r: any, i: number) => (
                  <div key={i} className="rounded bg-red-50 px-2 py-1 text-red-800">
                    Case #{r.caseId}: {r.reason || r.error || "Failed"}
                  </div>
                ))}
            </div>
          </ScrollArea>
        )}
        <DialogFooter>
          <Button
            onClick={() => {
              onSuccess();
              onClose();
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (!confirmStep) {
    return (
      <div className="space-y-4">
        {isStaffMode && (
          <div className="text-amber-600/90 text-xs p-3 bg-amber-500/10 rounded border border-amber-200/40 mb-3">
            Batch actions restricted: server will only apply to cases assigned to you (My Work scope). Unassigned cases will be skipped.
          </div>
        )}
        <div className="text-sm text-slate-600">
          {casesSelected.length} case(s) selected · {enabledFields.size} field(s) to update
        </div>
        <ScrollArea className="max-h-[50vh]">
          <div className="space-y-2 pr-2">
            {renderFieldToggle(
              "status",
              "Case Status",
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select value={statusModule} onValueChange={(v) => setStatusModule(v === "spa" ? "spa" : "loan")}>
                  <SelectTrigger className="w-full sm:w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="loan">Loan</SelectItem>
                    <SelectItem value="spa">SPA</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={statusValue} onValueChange={setStatusValue}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select status..." />
                  </SelectTrigger>
                  <SelectContent>
                    {(statusModule === "spa" ? spaStatuses : loanStatuses).map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {renderFieldToggle(
              "statusDate",
              "Status Date",
              <DateOnlyInput valueYmd={statusDateYmd} onChangeYmd={setStatusDateYmd} />
            )}
            {renderFieldToggle(
              "remarks",
              "Remarks",
              <>
                <Label className="text-xs text-slate-500">Append remark note to each case</Label>
                <Input value={remarksText} onChange={(e) => setRemarksText(e.target.value)} placeholder="Enter remark..." />
              </>
            )}
            {renderFieldToggle(
              "assignedLawyerId",
              "Assigned Lawyer",
              <Select value={assignedLawyerId} onValueChange={setAssignedLawyerId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No change / clear" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No change / clear</SelectItem>
                  {lawyerUsers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name} (#{u.id})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {renderFieldToggle(
              "assignedClerkId",
              "Assigned Clerk",
              <Select value={assignedClerkId} onValueChange={setAssignedClerkId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No change / clear" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No change / clear</SelectItem>
                  {firmUsers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name} (#{u.id})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {renderFieldToggle(
              "responsibleLawyerId",
              "Responsible Lawyer",
              <Select value={responsibleLawyerId} onValueChange={setResponsibleLawyerId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No change / clear" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No change / clear</SelectItem>
                  {lawyerUsers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name} (#{u.id})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {renderFieldToggle(
              "nextAction",
              "Next Action",
              <Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Next action..." />
            )}
            {renderFieldToggle(
              "nextActionDate",
              "Next Action Date",
              <DateOnlyInput valueYmd={nextActionDateYmd} onChangeYmd={setNextActionDateYmd} />
            )}
            {renderFieldToggle(
              "lawyerStatus",
              "Lawyer Status",
              <Input value={lawyerStatus} onChange={(e) => setLawyerStatus(e.target.value)} placeholder="Lawyer status..." />
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={enabledFields.size === 0 || submitting} onClick={() => setConfirmStep(true)}>Next</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isStaffMode && (
        <div className="text-amber-600/90 text-xs p-3 bg-amber-500/10 rounded border border-amber-200/40 mb-3">
          Batch actions restricted: server will only apply to cases assigned to you (My Work scope). Unassigned cases will be skipped.
        </div>
      )}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="font-medium">Confirm Batch Update · {casesSelected.length} Cases Selected</div>
          {hasTransitionWarning && (
            <div className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-800">
              ⚠ Updating cases with different statuses may cause invalid workflow transitions. Some cases may be skipped.
            </div>
          )}
          <div className="space-y-2">
            {Array.from(enabledFields).map((key) => {
              const currVals = getFieldCurrentValues(key);
              const uniq = Array.from(new Set(currVals.filter((v) => v && v !== "—")));
              return (
                <div key={key} className="rounded-md border border-slate-200 p-2 text-sm">
                  <div className="font-medium">{getFieldNewValue(key)}</div>
                  <div className="mt-1 text-slate-600">
                    {uniq.length === 0 ? (
                      <span>Current: —</span>
                    ) : uniq.length === 1 ? (
                      <span>Current: {uniq[0]}</span>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Varies</Badge>
                        <span>Current: Values vary → New Value applied</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <DialogFooter>
        <Button variant="outline" disabled={submitting || mutation.isPending} onClick={() => setConfirmStep(false)}>Back</Button>
        <Button disabled={submitting || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending || submitting ? "Submitting..." : "Submit"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function BatchPrintModalBody(props: {
  selectedCaseIds: Set<number>;
  caseById: Map<number, any>;
  onClose: () => void;
  onSuccess: () => void;
  toast: ReturnType<typeof useToast>["toast"];
  isStaffMode: boolean;
}) {
  const { selectedCaseIds, caseById, onClose, onSuccess, toast, isStaffMode } = props;

  const caseIdsArr = Array.from(selectedCaseIds).sort();
  const casesSelected = caseIdsArr.map((id) => caseById.get(id)).filter(Boolean);

  const [selectionMode, setSelectionMode] = useState<"same_for_all" | "per_case">("same_for_all");
  const [outputMode, setOutputMode] = useState<"combined_pdf" | "separate_files">("combined_pdf");
  const [sharedSelection, setSharedSelection] = useState<Set<string>>(new Set());
  const [perCaseSelections, setPerCaseSelections] = useState<Record<string, Set<string>>>({});
  const [prepareResult, setPrepareResult] = useState<any>(null);
  const [prepareLoading, setPrepareLoading] = useState(false);
  const [opStatus, setOpStatus] = useState<string | null>(null);
  const [allPrimaryJobsDone, setAllPrimaryJobsDone] = useState(false);
  const [readyToDownload, setReadyToDownload] = useState(false);
  const [jobCounts, setJobCounts] = useState<any>(null);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [downloadResult, setDownloadResult] = useState<any>(null);
  const [batchOpId, setBatchOpId] = useState<string | null>(null);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const CATEGORIES = [
    { key: "primary_status", label: "Primary Status Document" },
    { key: "stamped_spa", label: "Stamped SPA" },
    { key: "letter_of_offer", label: "Letter of Offer" },
    { key: "spa", label: "SPA" },
    { key: "facility_agreement", label: "Facility Agreement" },
    { key: "deed_of_assignment", label: "Deed of Assignment" },
    { key: "power_of_attorney", label: "Power of Attorney" },
    { key: "memorandum_of_transfer", label: "MOT" },
    { key: "charge_document", label: "Charge Document" },
    { key: "land_search", label: "Land Search" },
    { key: "bankruptcy_search", label: "Bankruptcy Search" },
    { key: "identity_document", label: "Identity Document" },
  ] as const;

  const parseKindRef = (s: string): { kind: string; ref: string } => {
    const idx = s.indexOf(":");
    if (idx < 0) return { kind: s, ref: "" };
    return { kind: s.slice(0, idx), ref: s.slice(idx + 1) };
  };

  const toggleShared = (key: string) => {
    setSharedSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const togglePerCase = (caseIdStr: string, key: string) => {
    setPerCaseSelections((prev) => {
      const existing = prev[caseIdStr] ?? new Set<string>();
      const next = new Set(existing);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [caseIdStr]: next };
    });
  };

  const hasAnySelection = () => {
    if (selectionMode === "same_for_all") return sharedSelection.size > 0;
    return Object.values(perCaseSelections).some((s) => s.size > 0);
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const prepareAndPoll = async () => {
    if (casesSelected.length === 0 || !hasAnySelection()) return;
    setPrepareLoading(true);
    setPrepareResult(null);
    setOpStatus(null);
    setReadyToDownload(false);
    setBatchOpId(null);
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    try {
      const body: any = {
        caseIds: caseIdsArr,
        selectionMode,
        outputMode,
        sharedSelection: [],
        perCaseSelections: {},
      };
      if (selectionMode === "same_for_all") {
        body.sharedSelection = Array.from(sharedSelection).map((s) => {
          const { kind, ref } = parseKindRef(s);
          return { kind, ref };
        });
      } else {
        body.perCaseSelections = Object.fromEntries(
          Object.entries(perCaseSelections).map(([cid, set]) => [
            cid,
            Array.from(set).map((s) => {
              const { kind, ref } = parseKindRef(s);
              return { kind, ref };
            }),
          ])
        );
      }

      const res = await apiFetchJson("/cases/batch/print/prepare", { method: "POST", body: JSON.stringify(body) });
      setPrepareResult(res);
      const opId = (res as any).batchOperationId ?? (res as any).batchOpId ?? null;
      if (opId) {
        setBatchOpId(opId);
        pollIntervalRef.current = setInterval(async () => {
          try {
            const st = await apiFetchJson(`/cases/batch/print/${opId}/status`);
            setOpStatus((st as any).opStatus ?? (st as any).status ?? null);
            setJobCounts((st as any).jobCounts ?? null);
            setAllPrimaryJobsDone(Boolean((st as any).allPrimaryJobsDone ?? false));
            if ((st as any).readyToDownload || (st as any).status === "ready") {
              setReadyToDownload(true);
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
            } else if ((st as any).opStatus === "failed" || (st as any).status === "failed") {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              toastError(toast, new Error((st as any).errorMessage || "Batch print failed"), "Batch print failed");
            }
          } catch (e) {
            // ignore poll error, will retry next interval
          }
        }, 2000);
      }
      const sc = (res as any).summaryCounts;
      if (sc && sc.tooLarge) {
        toast({ title: "Warning", description: "Batch print limit: maximum 50 cases per batch print operation." });
      }
    } catch (err) {
      toastError(toast, err, "Batch print prepare failed");
    } finally {
      setPrepareLoading(false);
    }
  };

  const doDownload = async () => {
    if (!batchOpId) return;
    setDownloadLoading(true);
    try {
      if (outputMode === "combined_pdf") {
        const blob = await apiFetchBlob(`/cases/batch/print/${batchOpId}/download?mode=combined_pdf`);
        const filename = `Batch-Print-${Date.now()}-combined.pdf`;
        triggerDownload(blob, filename);
        setDownloadResult({ mode: "combined_pdf", filename });
        toast({ title: "Download started", description: filename });
        onSuccess();
      } else {
        const res = await apiFetchJson(`/cases/batch/print/${batchOpId}/download?mode=separate_files`);
        const files = (res as any).files ?? [];
        for (const f of files) {
          try {
            const resp = await fetch(f.signedUrl);
            const blob = await resp.blob();
            triggerDownload(blob, f.filename || `document-${Date.now()}.pdf`);
            await new Promise((r) => setTimeout(r, 200));
          } catch {
            // skip individual file error
          }
        }
        setDownloadResult({ mode: "separate_files", count: files.length });
        toast({ title: "Download started", description: `${files.length} file(s)` });
        onSuccess();
      }
    } catch (err) {
      toastError(toast, err, "Download failed");
    } finally {
      setDownloadLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  const disabled = prepareLoading || downloadLoading || (pollIntervalRef.current != null && !readyToDownload);

  const summary = prepareResult?.summaryCounts;
  const authFailures = prepareResult?.authFailures ?? prepareResult?.authorizationFailures ?? [];
  const caseSummaries = prepareResult?.caseSummaries ?? prepareResult?.perCase ?? [];

  return (
    <div className="space-y-4">
      {isStaffMode && (
        <div className="text-amber-600/90 text-xs p-3 bg-amber-500/10 rounded border border-amber-200/40 mb-3">
          Batch actions restricted: server will only process documents for cases assigned to you (My Work scope). Unassigned cases will be skipped.
        </div>
      )}
      <Tabs value={selectionMode} onValueChange={(v) => {
        if (v === "same_for_all" || v === "per_case") setSelectionMode(v);
      }}>
        <TabsList>
          <TabsTrigger value="same_for_all">Same for All Cases</TabsTrigger>
          <TabsTrigger value="per_case">Customize Per Case</TabsTrigger>
        </TabsList>
      </Tabs>

      <div>
        <Label className="text-xs text-slate-500">Output mode</Label>
        <div className="mt-1">
          <Select value={outputMode} onValueChange={(v) => setOutputMode(v === "separate_files" ? "separate_files" : "combined_pdf")} disabled={disabled}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="combined_pdf">Combined PDF</SelectItem>
              <SelectItem value="separate_files">Separate Files</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {selectionMode === "same_for_all" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Mode 1: Same Selection for All Cases</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => (
              <Button
                key={cat.key}
                type="button"
                variant={sharedSelection.has(cat.key) ? "default" : "outline"}
                size="sm"
                disabled={disabled}
                onClick={() => toggleShared(cat.key)}
              >
                {cat.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {selectionMode === "per_case" && (
        <ScrollArea className="max-h-[40vh]">
          <div className="space-y-2 pr-2">
            {casesSelected.map((c) => {
              const cid = String(c.id);
              const sel = perCaseSelections[cid] ?? new Set<string>();
              return (
                <details key={cid} className="rounded-md border border-slate-200 p-2" open={false}>
                  <summary className="flex items-center justify-between cursor-pointer list-none">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{c.caseReference ?? c.case_reference ?? `Case #${c.id}`}</span>
                      <Badge variant="outline">{sel.size} selected</Badge>
                      {sel.size > 0 && (
                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Missing docs</Badge>
                      )}
                    </div>
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {CATEGORIES.map((cat) => (
                      <Button
                        key={cat.key}
                        type="button"
                        variant={sel.has(cat.key) ? "default" : "outline"}
                        size="sm"
                        disabled={disabled}
                        onClick={() => togglePerCase(cid, cat.key)}
                      >
                        {cat.label}
                      </Button>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {summary && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <div className="font-medium">Summary</div>
          <div className="text-slate-600">
            Total: {summary.total ?? 0} · Ready: {summary.ready ?? 0} · Missing docs: {summary.missing ?? 0} · Failed/Unauthorized: {summary.failed ?? 0}
          </div>
          {summary.tooLarge && (
            <div className="mt-2 rounded-md border border-yellow-200 bg-yellow-50 px-2 py-1 text-yellow-800">
              ⚠ Batch limit exceeded. Maximum 50 cases allowed per batch print operation.
            </div>
          )}
        </div>
      )}

      {authFailures.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          ⚠ Some cases were not authorized (injection attempt detected and blocked) — see audit log.
        </div>
      )}

      {caseSummaries.length > 0 && (
        <ScrollArea className="max-h-[30vh] rounded-md border border-slate-200">
          <div className="space-y-1 p-2 text-sm">
            {caseSummaries.map((cs: any, i: number) => (
              <div key={i} className="rounded border border-slate-100 p-2">
                <div className="font-medium">{cs.caseReference ?? `Case #${cs.caseId}`}</div>
                <div className="text-slate-600">
                  Selected: {cs.selectedCount ?? 0} · {cs.missing && cs.missing.length > 0 ? <>Missing: {cs.missing.join(", ")}</> : null}
                  {cs.error ? <span className="text-red-600"> · Error: {cs.error}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      {(opStatus || jobCounts) && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <div>Status: {opStatus || "processing..."} {allPrimaryJobsDone ? "· Jobs ready" : ""}</div>
          {jobCounts && (
            <div className="text-xs text-blue-700">
              Pending: {jobCounts.pending ?? 0} · Running: {jobCounts.running ?? 0} · Done: {jobCounts.done ?? 0} · Failed: {jobCounts.failed ?? 0}
            </div>
          )}
        </div>
      )}

      <DialogFooter className="gap-2">
        <Button
          variant="outline"
          onClick={onClose}
          disabled={disabled}
        >
          Close
        </Button>
        {!prepareResult || !readyToDownload ? (
          <Button
            onClick={prepareAndPoll}
            disabled={disabled || casesSelected.length === 0 || !hasAnySelection()}
          >
            {prepareLoading ? "Preparing..." : "Prepare Preview"}
          </Button>
        ) : (
          <Button
            onClick={doDownload}
            disabled={downloadLoading}
          >
            {downloadLoading ? "Downloading..." : outputMode === "combined_pdf" ? "Download Combined PDF" : "Download Separate Files"}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
