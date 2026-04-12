import { CaseMilestoneKey, MilestonePresence, getListCasesQueryKey, useListCases, useListDevelopers, useListProjects, useListUsers } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Plus, Save, Search, Trash2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemo, useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";

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

export default function CasesList() {
  const [location, setLocation] = useLocation();
  const sp = useMemo(() => new URLSearchParams(location.split("?")[1] ?? ""), [location]);
  const isHydratingFromUrl = useRef(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [purchaseMode, setPurchaseMode] = useState<string>("all");
  const [spaStatus, setSpaStatus] = useState<string>("all");
  const [loanStatus, setLoanStatus] = useState<string>("all");
  const [milestone, setMilestone] = useState<CaseMilestoneKey | "all">("all");
  const [milestonePresence, setMilestonePresence] = useState<MilestonePresence>("filled");
  const [lawyerId, setLawyerId] = useState<string>("all");
  const [clerkId, setClerkId] = useState<string>("all");
  const [projectId, setProjectId] = useState<string>("all");
  const [developerId, setDeveloperId] = useState<string>("all");
  const [titleType, setTitleType] = useState<string>("all");
  const [page, setPage] = useState<number>(1);
  const [limit, setLimit] = useState<number>(50);
  const [sortBy, setSortBy] = useState<"updatedAt" | "createdAt" | "referenceNo" | "spaDate">("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [assignedToUserId, setAssignedToUserId] = useState<string>("all");
  const [overdueDays, setOverdueDays] = useState<string>("all");

  useEffect(() => {
    isHydratingFromUrl.current = true;

    const nextMilestoneRaw = sp.get("milestone");
    const nextMilestone: CaseMilestoneKey | "all" =
      nextMilestoneRaw && Object.values(CaseMilestoneKey).includes(nextMilestoneRaw as CaseMilestoneKey)
        ? (nextMilestoneRaw as CaseMilestoneKey)
        : "all";
    const nextPresenceRaw = sp.get("milestonePresence");
    const nextPresence: MilestonePresence =
      nextPresenceRaw && Object.values(MilestonePresence).includes(nextPresenceRaw as MilestonePresence)
        ? (nextPresenceRaw as MilestonePresence)
        : "filled";
    const nextPageRaw = sp.get("page");
    const nextLimitRaw = sp.get("limit");
    const nextSortByRaw = sp.get("sortBy");
    const nextSortDirRaw = sp.get("sortDir");
    const nextPage = nextPageRaw ? Number(nextPageRaw) : 1;
    const nextLimit = nextLimitRaw ? Number(nextLimitRaw) : 50;
    const nextSortBy = (nextSortByRaw === "createdAt" || nextSortByRaw === "referenceNo" || nextSortByRaw === "spaDate") ? nextSortByRaw : "updatedAt";
    const nextSortDir = (nextSortDirRaw === "asc" || nextSortDirRaw === "desc") ? nextSortDirRaw : "desc";
    const nextAssignedToUserId = sp.get("assignedToUserId") ?? "all";
    const nextOverdueDaysRaw = sp.get("overdueDays");
    const nextOverdueDays = nextOverdueDaysRaw === "7" || nextOverdueDaysRaw === "14" || nextOverdueDaysRaw === "30" ? nextOverdueDaysRaw : "all";

    setSearch(sp.get("search") ?? "");
    setPurchaseMode(sp.get("purchaseMode") ?? "all");
    setSpaStatus(sp.get("spaStatus") ?? "all");
    setLoanStatus(sp.get("loanStatus") ?? "all");
    setMilestone(nextMilestone);
    setMilestonePresence(nextPresence);
    setLawyerId(sp.get("assignedLawyerId") ?? "all");
    setClerkId(sp.get("assignedClerkId") ?? "all");
    setProjectId(sp.get("projectId") ?? "all");
    setDeveloperId(sp.get("developerId") ?? "all");
    setTitleType(sp.get("titleType") ?? "all");
    setPage(Number.isInteger(nextPage) && nextPage > 0 ? nextPage : 1);
    setLimit(Number.isInteger(nextLimit) && nextLimit > 0 ? nextLimit : 50);
    setSortBy(nextSortBy);
    setSortDir(nextSortDir);
    setAssignedToUserId(nextAssignedToUserId);
    setOverdueDays(nextOverdueDays);

    queueMicrotask(() => { isHydratingFromUrl.current = false; });
  }, [sp]);

  const currentViewFilters = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of sp.entries()) {
      if (k === "page" || k === "returnTo") continue;
      out[k] = v;
    }
    return out;
  }, [sp]);

  const stableParamsKey = (p: Record<string, string>) => {
    const keys = Object.keys(p).sort();
    return keys.map((k) => `${k}=${String(p[k] ?? "")}`).join("&");
  };

  const buildQueryString = (p: Record<string, string>, pageOverride?: number) => {
    const nextSp = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) nextSp.set(k, v);
    nextSp.set("page", String(pageOverride ?? 1));
    return nextSp.toString();
  };

  const { data: savedViews, refetch: refetchSavedViews } = useQuery({
    queryKey: ["cases", "saved-views"],
    queryFn: () => apiFetchJson("/case-list-views"),
    retry: false,
  });

  const savedViewsList: Array<{ id: number; name: string; routeKey: string; filtersJson: Record<string, string> }> =
    Array.isArray(savedViews) ? savedViews : [];

  const activeSavedView = useMemo(() => {
    const currentKey = stableParamsKey(currentViewFilters);
    return savedViewsList.find((v) => stableParamsKey(v.filtersJson ?? {}) === currentKey) ?? null;
  }, [savedViewsList, currentViewFilters]);

  useEffect(() => {
    if (isHydratingFromUrl.current) return;

    const nextSp = new URLSearchParams();
    const setIf = (k: string, v: string | undefined) => {
      if (!v || v === "all") return;
      nextSp.set(k, v);
    };
    setIf("search", search.trim() ? search.trim() : undefined);
    setIf("purchaseMode", purchaseMode);
    setIf("spaStatus", spaStatus);
    setIf("loanStatus", loanStatus);
    setIf("milestone", milestone === "all" ? undefined : milestone);
    if (milestone !== "all") nextSp.set("milestonePresence", milestonePresence);
    setIf("assignedLawyerId", lawyerId);
    setIf("assignedClerkId", clerkId);
    setIf("assignedToUserId", assignedToUserId);
    setIf("projectId", projectId);
    setIf("developerId", developerId);
    setIf("titleType", titleType);
    setIf("overdueDays", overdueDays);
    nextSp.set("page", String(page));
    nextSp.set("limit", String(limit));
    nextSp.set("sortBy", sortBy);
    nextSp.set("sortDir", sortDir);

    const nextQs = nextSp.toString();
    const currentQs = sp.toString();
    if (nextQs !== currentQs) setLocation(`/app/cases?${nextQs}`);
  }, [
    search,
    purchaseMode,
    spaStatus,
    loanStatus,
    milestone,
    milestonePresence,
    lawyerId,
    clerkId,
    assignedToUserId,
    projectId,
    developerId,
    titleType,
    overdueDays,
    page,
    limit,
    sortBy,
    sortDir,
    sp,
    setLocation,
  ]);

  const { data: response, isLoading, isError, error, refetch, isFetching } = useListCases({ 
    page,
    limit,
    search: search || undefined,
    purchaseMode: purchaseMode !== "all" ? purchaseMode : undefined,
    projectId: projectId !== "all" ? Number(projectId) : undefined,
    developerId: developerId !== "all" ? Number(developerId) : undefined,
    titleType: titleType !== "all" ? titleType : undefined,
    assignedLawyerId: lawyerId !== "all" ? parseInt(lawyerId) : undefined,
    assignedClerkId: clerkId !== "all" ? parseInt(clerkId) : undefined,
    assignedToUserId: assignedToUserId !== "all" ? parseInt(assignedToUserId) : undefined,
    spaStatus: spaStatus !== "all" ? spaStatus : undefined,
    loanStatus: loanStatus !== "all" ? loanStatus : undefined,
    milestone: milestone !== "all" ? milestone : undefined,
    milestonePresence: milestone !== "all" ? milestonePresence : undefined,
    sortBy,
    sortDir,
    overdueDays: overdueDays !== "all" ? (Number(overdueDays) as 7 | 14 | 30) : undefined,
  });

  const { data: filterOptions } = useQuery({
    queryKey: ["cases", "filter-options"],
    queryFn: () => apiFetchJson("/cases/filter-options"),
    retry: false,
  });
  const spaStatuses: string[] = Array.isArray(filterOptions?.spaStatuses) ? filterOptions.spaStatuses : ["Pending"];
  const loanStatuses: string[] = Array.isArray(filterOptions?.loanStatuses) ? filterOptions.loanStatuses : ["Pending"];
  const lawyers: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.lawyers) ? filterOptions.assignees.lawyers : [];
  const clerks: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.clerks) ? filterOptions.assignees.clerks : [];
  const milestoneOptions: Array<{ key: CaseMilestoneKey; label: string }> = Array.isArray(filterOptions?.milestones) ? filterOptions.milestones : [];

  const { data: projectsRes } = useListProjects({ page: 1, limit: 200 });
  const { data: devsRes } = useListDevelopers({ page: 1, limit: 200 });
  const { data: usersRes } = useListUsers({ page: 1, limit: 200 });
  const allUsers = usersRes?.data ?? [];
  const userNameById = useMemo(() => new Map(allUsers.map(u => [String(u.id), u.name])), [allUsers]);
  const lawyerCandidates = allUsers.filter(u => (u.roleName ?? "").toLowerCase().includes("lawyer") || (u.roleName ?? "").toLowerCase().includes("partner"));
  const clerkCandidates = allUsers.filter(u => (u.roleName ?? "").toLowerCase().includes("clerk"));
  const projects = projectsRes?.data ?? [];
  const developers = devsRes?.data ?? [];
  const cases = response?.data ?? [];
  const total = response?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pageCount);

  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page]);

  const milestoneLabelByKey = useMemo(() => new Map(milestoneOptions.map(m => [m.key, m.label])), [milestoneOptions]);
  const lawyerNameById = useMemo(() => new Map(lawyers.map(u => [String(u.id), u.name])), [lawyers]);
  const clerkNameById = useMemo(() => new Map(clerks.map(u => [String(u.id), u.name])), [clerks]);
  const projectNameById = useMemo(() => new Map(projects.map(p => [String(p.id), p.name])), [projects]);
  const developerNameById = useMemo(() => new Map(developers.map(d => [String(d.id), d.name])), [developers]);

  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; onClear: () => void }> = [];
    if (search.trim()) chips.push({ key: "search", label: `Search: ${search.trim()}`, onClear: () => { setSearch(""); setPage(1); } });
    if (purchaseMode !== "all") chips.push({ key: "purchaseMode", label: `Mode: ${purchaseMode}`, onClear: () => { setPurchaseMode("all"); setPage(1); } });
    if (spaStatus !== "all") chips.push({ key: "spaStatus", label: `SPA: ${spaStatus}`, onClear: () => { setSpaStatus("all"); setPage(1); } });
    if (loanStatus !== "all") chips.push({ key: "loanStatus", label: `Loan: ${loanStatus}`, onClear: () => { setLoanStatus("all"); setPage(1); } });
    if (milestone !== "all") {
      const label = milestoneLabelByKey.get(milestone) ?? milestone;
      chips.push({
        key: "milestone",
        label: `${label}: ${milestonePresence === "missing" ? "Missing" : "Filled"}`,
        onClear: () => { setMilestone("all"); setMilestonePresence("filled"); setPage(1); },
      });
    }
    if (lawyerId !== "all") chips.push({ key: "assignedLawyerId", label: `Lawyer: ${lawyerNameById.get(lawyerId) ?? lawyerId}`, onClear: () => { setLawyerId("all"); setPage(1); } });
    if (clerkId !== "all") chips.push({ key: "assignedClerkId", label: `Clerk: ${clerkNameById.get(clerkId) ?? clerkId}`, onClear: () => { setClerkId("all"); setPage(1); } });
    if (assignedToUserId !== "all") chips.push({ key: "assignedToUserId", label: `Assigned to: ${userNameById.get(assignedToUserId) ?? assignedToUserId}`, onClear: () => { setAssignedToUserId("all"); setPage(1); } });
    if (projectId !== "all") chips.push({ key: "projectId", label: `Project: ${projectNameById.get(projectId) ?? projectId}`, onClear: () => { setProjectId("all"); setPage(1); } });
    if (developerId !== "all") chips.push({ key: "developerId", label: `Developer: ${developerNameById.get(developerId) ?? developerId}`, onClear: () => { setDeveloperId("all"); setPage(1); } });
    if (titleType !== "all") chips.push({ key: "titleType", label: `Title: ${titleType}`, onClear: () => { setTitleType("all"); setPage(1); } });
    if (overdueDays !== "all") chips.push({ key: "overdueDays", label: `Overdue: >${overdueDays}d`, onClear: () => { setOverdueDays("all"); setPage(1); } });
    return chips;
  }, [
    search,
    purchaseMode,
    spaStatus,
    loanStatus,
    milestone,
    milestonePresence,
    lawyerId,
    clerkId,
    assignedToUserId,
    projectId,
    developerId,
    titleType,
    overdueDays,
    milestoneLabelByKey,
    lawyerNameById,
    clerkNameById,
    projectNameById,
    developerNameById,
    userNameById,
  ]);

  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<number>>(new Set());
  const [bulkLawyerId, setBulkLawyerId] = useState<string>("all");
  const [bulkClerkId, setBulkClerkId] = useState<string>("all");

  useEffect(() => {
    setSelectedCaseIds(new Set());
    setBulkLawyerId("all");
    setBulkClerkId("all");
  }, [sp.toString()]);

  const currentPageIds = (response?.data ?? []).map((c) => c.id);
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

  const bulkAssignMutation = useMutation({
    mutationFn: async (vars: { roleInCase: "lawyer" | "clerk"; userId: number; caseIds: number[] }) => {
      const res = await apiFetchJson("/cases/bulk/assign", { method: "POST", body: JSON.stringify(vars) });
      return res as { requested: number; succeeded: number; failed: number; failures: Array<{ caseId: number; error: string }> };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
      setSelectedCaseIds(new Set());
      setBulkLawyerId("all");
      setBulkClerkId("all");
      toast({ title: "Bulk update completed", description: `${data.succeeded} succeeded, ${data.failed} failed` });
    },
    onError: (err) => toastError(toast, err, "Bulk update failed"),
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

  type SavedView = { id: number; name: string; routeKey: string; filtersJson: Record<string, string> };
  const [isSaveViewOpen, setIsSaveViewOpen] = useState(false);
  const [isRenameViewOpen, setIsRenameViewOpen] = useState(false);
  const [viewNameInput, setViewNameInput] = useState("");

  const createViewMutation = useMutation({
    mutationFn: async (vars: { name: string; routeKey: "cases"; filtersJson: Record<string, string> }) => {
      const res = await apiFetchJson("/case-list-views", { method: "POST", body: JSON.stringify(vars) });
      return res as SavedView;
    },
    onSuccess: async () => {
      setIsSaveViewOpen(false);
      setViewNameInput("");
      await refetchSavedViews();
      toast({ title: "View saved" });
    },
    onError: (err) => toastError(toast, err, "Save view failed"),
  });

  const renameViewMutation = useMutation({
    mutationFn: async (vars: { id: number; name: string }) => {
      const res = await apiFetchJson(`/case-list-views/${vars.id}`, { method: "PATCH", body: JSON.stringify({ name: vars.name }) });
      return res as SavedView;
    },
    onSuccess: async () => {
      setIsRenameViewOpen(false);
      setViewNameInput("");
      await refetchSavedViews();
      toast({ title: "View renamed" });
    },
    onError: (err) => toastError(toast, err, "Rename failed"),
  });

  const deleteViewMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiFetchJson(`/case-list-views/${id}`, { method: "DELETE" });
      return id;
    },
    onSuccess: async () => {
      await refetchSavedViews();
      toast({ title: "View deleted" });
    },
    onError: (err) => toastError(toast, err, "Delete failed"),
  });

  return (
    <div className="space-y-6">
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
          <Button
            variant="outline"
            onClick={() => {
              setViewNameInput(activeSavedView?.name ? `${activeSavedView.name} (copy)` : "");
              setIsSaveViewOpen(true);
            }}
          >
            <Save className="w-4 h-4 mr-2" />
            Save View
          </Button>
          <Link href="/app/cases/new">
            <Button className="bg-amber-500 hover:bg-amber-600 text-white">
              <Plus className="w-4 h-4 mr-2" />
              New Case
            </Button>
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Select
          value={activeSavedView ? String(activeSavedView.id) : "custom"}
          onValueChange={(v) => {
            if (v === "custom") return;
            const view = savedViewsList.find((x) => String(x.id) === v);
            if (!view) return;
            const qs = buildQueryString(view.filtersJson as Record<string, string>, 1);
            setLocation(`/app/cases?${qs}`);
          }}
        >
          <SelectTrigger className="w-[260px]">
            <SelectValue placeholder="Saved Views" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="custom">Custom (current)</SelectItem>
            {savedViewsList.map((v) => (
              <SelectItem key={v.id} value={String(v.id)}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={!activeSavedView}
          onClick={() => {
            if (!activeSavedView) return;
            setViewNameInput(activeSavedView.name);
            setIsRenameViewOpen(true);
          }}
        >
          Rename
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!activeSavedView}
          onClick={() => {
            if (!activeSavedView) return;
            deleteViewMutation.mutate(activeSavedView.id);
          }}
        >
          <Trash2 className="w-4 h-4 mr-2" />
          Delete
        </Button>
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
              setPurchaseMode("all");
              setSpaStatus("all");
              setLoanStatus("all");
              setMilestone("all");
              setMilestonePresence("filled");
              setLawyerId("all");
              setClerkId("all");
              setAssignedToUserId("all");
              setProjectId("all");
              setDeveloperId("all");
              setTitleType("all");
              setOverdueDays("all");
              setPage(1);
            }}
          >
            Clear all filters
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search reference, client, project, property..." 
            className="pl-9"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>

        <Select value={purchaseMode} onValueChange={(v) => { setPurchaseMode(v); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Purchase Mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Modes</SelectItem>
            <SelectItem value="cash">Cash</SelectItem>
            <SelectItem value="loan">Loan</SelectItem>
          </SelectContent>
        </Select>

        <Select value={spaStatus} onValueChange={(v) => { setSpaStatus(v); setPage(1); }}>
          <SelectTrigger>
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
          <SelectTrigger>
            <SelectValue placeholder="Loan Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Loan Status</SelectItem>
            {loanStatuses.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={milestone} onValueChange={(v: CaseMilestoneKey | "all") => {
          setMilestone(v);
          if (v === "all") setMilestonePresence("filled");
          setPage(1);
        }}>
          <SelectTrigger>
            <SelectValue placeholder="Milestone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">No Milestone Filter</SelectItem>
            {milestoneOptions.map((m) => (
              <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={milestonePresence} onValueChange={(v) => { setMilestonePresence(v); setPage(1); }} disabled={milestone === "all"}>
          <SelectTrigger>
            <SelectValue placeholder="Filled / Missing" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="filled">Filled</SelectItem>
            <SelectItem value="missing">Missing</SelectItem>
          </SelectContent>
        </Select>

        <Select value={lawyerId} onValueChange={(v) => { setLawyerId(v); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Assigned Lawyer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Lawyers</SelectItem>
            {lawyers.map(l => <SelectItem key={l.id} value={l.id.toString()}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={clerkId} onValueChange={(v) => { setClerkId(v); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Assigned Clerk" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Clerks</SelectItem>
            {clerks.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={projectId} onValueChange={(v) => { setProjectId(v); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={developerId} onValueChange={(v) => { setDeveloperId(v); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Developer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Developers</SelectItem>
            {developers.map((d) => (
              <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={titleType} onValueChange={(v) => { setTitleType(v); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Title Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Title Types</SelectItem>
            <SelectItem value="master">Master</SelectItem>
            <SelectItem value="individual">Individual</SelectItem>
            <SelectItem value="strata">Strata</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sortBy} onValueChange={(v: "updatedAt" | "createdAt" | "referenceNo" | "spaDate") => { setSortBy(v); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Sort By" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updatedAt">Updated At</SelectItem>
            <SelectItem value="createdAt">Created At</SelectItem>
            <SelectItem value="referenceNo">Our Reference</SelectItem>
            <SelectItem value="spaDate">SPA Date</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sortDir} onValueChange={(v: "asc" | "desc") => { setSortDir(v); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Sort Dir" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desc">Desc</SelectItem>
            <SelectItem value="asc">Asc</SelectItem>
          </SelectContent>
        </Select>

        <Select value={String(limit)} onValueChange={(v) => { setLimit(Number(v)); setPage(1); }}>
          <SelectTrigger>
            <SelectValue placeholder="Per Page" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="20">20 / page</SelectItem>
            <SelectItem value="50">50 / page</SelectItem>
            <SelectItem value="100">100 / page</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">
          Page {safePage} / {pageCount}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
          <Button variant="outline" size="sm" disabled={safePage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading cases...</div>
          ) : isError ? (
            <div className="p-6">
              <QueryFallback title="Cases unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
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
                  {cases.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/50">
                      <td className="px-4 py-4">
                        <Checkbox
                          checked={selectedCaseIds.has(c.id)}
                          onCheckedChange={() => toggleSelectOne(c.id)}
                        />
                      </td>
                      <td className="px-6 py-4">
                        <Link href={`/app/cases/${c.id}?returnTo=${encodeURIComponent(location)}`}>
                          <span className="font-medium text-slate-900 hover:text-amber-600 cursor-pointer transition-colors">
                            {c.referenceNo}
                          </span>
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-slate-700">
                        {c.clientName ?? "—"}
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-800">{c.projectName}</div>
                        <div className="text-slate-500 text-xs mt-0.5">
                          {c.property ? c.property : c.developerName}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-slate-800">{c.assignedLawyerName ?? "—"}</div>
                        <div className="text-slate-500 text-xs mt-0.5">{c.assignedClerkName ?? "—"}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700">
                          {c.spaStatus}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700">
                          {c.loanStatus ?? "N/A"}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-xs text-slate-700">
                          <span className="font-semibold">SPA</span>: {fmtYmd(c.milestones.spa_date)}
                          <span className="text-slate-400"> · </span>
                          <span className="font-semibold">Stamped</span>: {fmtYmd(c.milestones.spa_stamped_date)}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          <span className="font-semibold">LOF</span>: {fmtYmd(c.milestones.letter_of_offer_date)}
                          <span className="text-slate-400"> · </span>
                          <span className="font-semibold">Loan</span>: {fmtYmd(c.milestones.loan_docs_signed_date)}
                          <span className="text-slate-400"> · </span>
                          <span className="font-semibold">Comp</span>: {fmtYmd(c.milestones.completion_date)}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-slate-600 text-xs">
                        {fmtYmd(c.updatedAt.slice(0, 10))}
                      </td>
                    </tr>
                  ))}
                  {cases.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-6 py-8 text-center text-slate-500">
                        No cases found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedCaseIds.size > 0 && (
        <Card>
          <CardContent className="py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="text-sm text-slate-700">
              {selectedCaseIds.size} case(s) selected
            </div>
            <div className="flex flex-col md:flex-row gap-2 md:items-center">
              <Select value={bulkLawyerId} onValueChange={setBulkLawyerId}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Assign Lawyer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Select lawyer…</SelectItem>
                  {lawyerCandidates.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={bulkLawyerId === "all" || bulkAssignMutation.isPending}
                onClick={() => {
                  const ids = Array.from(selectedCaseIds);
                  bulkAssignMutation.mutate({ roleInCase: "lawyer", userId: Number(bulkLawyerId), caseIds: ids });
                }}
              >
                Apply
              </Button>

              <Select value={bulkClerkId} onValueChange={setBulkClerkId}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Assign Clerk" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Select clerk…</SelectItem>
                  {clerkCandidates.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={bulkClerkId === "all" || bulkAssignMutation.isPending}
                onClick={() => {
                  const ids = Array.from(selectedCaseIds);
                  bulkAssignMutation.mutate({ roleInCase: "clerk", userId: Number(bulkClerkId), caseIds: ids });
                }}
              >
                Apply
              </Button>

              <Button variant="ghost" onClick={() => setSelectedCaseIds(new Set())}>
                Clear selection
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={isSaveViewOpen} onOpenChange={setIsSaveViewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current view</DialogTitle>
            <DialogDescription>Save the current filters/sort/limit as a named view.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="text-sm font-medium">Name</div>
              <Input value={viewNameInput} onChange={(e) => setViewNameInput(e.target.value)} placeholder="e.g. My urgent loan cases" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSaveViewOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                const name = viewNameInput.trim();
                if (!name) return;
                createViewMutation.mutate({ name, routeKey: "cases", filtersJson: currentViewFilters });
              }}
              disabled={createViewMutation.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isRenameViewOpen} onOpenChange={setIsRenameViewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename view</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <div className="text-sm font-medium">Name</div>
            <Input value={viewNameInput} onChange={(e) => setViewNameInput(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRenameViewOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                const name = viewNameInput.trim();
                if (!name || !activeSavedView) return;
                renameViewMutation.mutate({ id: activeSavedView.id, name });
              }}
              disabled={!activeSavedView || renameViewMutation.isPending}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
