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
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { useAuth } from "@/lib/auth-context";
import { DateOnlyInput } from "@/components/date-only-input";

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
  const { user } = useAuth();
  const myUserId = typeof (user as any)?.id === "number" ? (user as any).id : Number((user as any)?.id);
  const roleName = String((user as any)?.roleName ?? "");
  const isPartnerOrManager = roleName.toLowerCase().includes("partner") || roleName.toLowerCase().includes("manager");

  const initialPageRaw = sp.get("page");
  const initialLimitRaw = sp.get("limit");
  const initialPage = initialPageRaw ? Number(initialPageRaw) : 1;
  const initialLimit = initialLimitRaw ? Number(initialLimitRaw) : 50;

  const [search, setSearch] = useState(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("search") ?? "") : (sp.get("search") ?? "")));
  const [spaStatus, setSpaStatus] = useState<string>(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("spaStatus") ?? "all") : (sp.get("spaStatus") ?? "all")));
  const [loanStatus, setLoanStatus] = useState<string>(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("loanStatus") ?? "all") : (sp.get("loanStatus") ?? "all")));
  const [lawyerId, setLawyerId] = useState<string>(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("assignedLawyerId") ?? "all") : (sp.get("assignedLawyerId") ?? "all")));
  const [clerkId, setClerkId] = useState<string>(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("assignedClerkId") ?? "all") : (sp.get("assignedClerkId") ?? "all")));
  const [projectId, setProjectId] = useState<string>(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("projectId") ?? "all") : (sp.get("projectId") ?? "all")));
  const [purchaseMode, setPurchaseMode] = useState<string>(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("purchaseMode") ?? "all") : (sp.get("purchaseMode") ?? "all")));
  const [titleType, setTitleType] = useState<string>(() => (typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("titleType") ?? "all") : (sp.get("titleType") ?? "all")));
  const [milestone, setMilestone] = useState<CaseMilestoneKey | "all">(() => {
    const raw = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("milestone") : sp.get("milestone");
    return raw && Object.values(CaseMilestoneKey).includes(raw as any) ? (raw as CaseMilestoneKey) : "all";
  });
  const [milestonePresence, setMilestonePresence] = useState<MilestonePresence>(() => {
    const raw = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("milestonePresence") : sp.get("milestonePresence");
    return raw && Object.values(MilestonePresence).includes(raw as any) ? (raw as MilestonePresence) : "filled";
  });
  const [page, setPage] = useState<number>(() => Number.isInteger(initialPage) && initialPage > 0 ? initialPage : 1);
  const [limit, setLimit] = useState<number>(() => Number.isInteger(initialLimit) && initialLimit > 0 ? initialLimit : 50);

  useEffect(() => {
    isHydratingFromUrl.current = true;

    const nextPageRaw = sp.get("page");
    const nextLimitRaw = sp.get("limit");
    const nextPage = nextPageRaw ? Number(nextPageRaw) : 1;
    const nextLimit = nextLimitRaw ? Number(nextLimitRaw) : 50;

    const nextSearch = sp.get("search") ?? "";
    const nextSpaStatus = sp.get("spaStatus") ?? "all";
    const nextLoanStatus = sp.get("loanStatus") ?? "all";
    const nextLawyerId = sp.get("assignedLawyerId") ?? "all";
    const nextClerkId = sp.get("assignedClerkId") ?? "all";
    const nextProjectId = sp.get("projectId") ?? "all";
    const nextPurchaseMode = sp.get("purchaseMode") ?? "all";
    const nextTitleType = sp.get("titleType") ?? "all";
    const nextMilestoneRaw = sp.get("milestone");
    const nextMilestone: CaseMilestoneKey | "all" =
      nextMilestoneRaw && Object.values(CaseMilestoneKey).includes(nextMilestoneRaw as any)
        ? (nextMilestoneRaw as CaseMilestoneKey)
        : "all";
    const nextPresenceRaw = sp.get("milestonePresence");
    const nextPresence: MilestonePresence =
      nextPresenceRaw && Object.values(MilestonePresence).includes(nextPresenceRaw as any)
        ? (nextPresenceRaw as MilestonePresence)
        : "filled";

    setSearch((prev) => prev === nextSearch ? prev : nextSearch);
    setSpaStatus((prev) => prev === nextSpaStatus ? prev : nextSpaStatus);
    setLoanStatus((prev) => prev === nextLoanStatus ? prev : nextLoanStatus);
    setLawyerId((prev) => prev === nextLawyerId ? prev : nextLawyerId);
    setClerkId((prev) => prev === nextClerkId ? prev : nextClerkId);
    setProjectId((prev) => prev === nextProjectId ? prev : nextProjectId);
    setPurchaseMode((prev) => prev === nextPurchaseMode ? prev : nextPurchaseMode);
    setTitleType((prev) => prev === nextTitleType ? prev : nextTitleType);
    setMilestone((prev) => prev === nextMilestone ? prev : nextMilestone);
    setMilestonePresence((prev) => prev === nextPresence ? prev : nextPresence);
    setPage((prev) => prev === (Number.isInteger(nextPage) && nextPage > 0 ? nextPage : 1) ? prev : (Number.isInteger(nextPage) && nextPage > 0 ? nextPage : 1));
    setLimit((prev) => prev === (Number.isInteger(nextLimit) && nextLimit > 0 ? nextLimit : 50) ? prev : (Number.isInteger(nextLimit) && nextLimit > 0 ? nextLimit : 50));

    queueMicrotask(() => { isHydratingFromUrl.current = false; });
  }, [sp]);

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
    setIf("projectId", projectId);
    setIf("purchaseMode", purchaseMode);
    setIf("titleType", titleType);
    setIf("milestone", milestone === "all" ? undefined : milestone);
    if (milestone !== "all") nextSp.set("milestonePresence", milestonePresence);
    nextSp.set("page", String(page));
    nextSp.set("limit", String(limit));

    const nextQs = nextSp.toString();
    const currentQs = sp.toString();
    if (nextQs !== currentQs) setLocation(`/app/cases?${nextQs}`);
  }, [
    search,
    spaStatus,
    loanStatus,
    lawyerId,
    clerkId,
    projectId,
    purchaseMode,
    titleType,
    milestone,
    milestonePresence,
    page,
    limit,
    sp,
    setLocation,
  ]);

  const { data: response, isLoading, isError, error, refetch, isFetching } = useListCases({ 
    page,
    limit,
    search: search || undefined,
    projectId: projectId !== "all" ? Number(projectId) : undefined,
    assignedLawyerId: lawyerId !== "all" ? parseInt(lawyerId) : undefined,
    assignedClerkId: clerkId !== "all" ? parseInt(clerkId) : undefined,
    spaStatus: spaStatus !== "all" ? spaStatus : undefined,
    loanStatus: loanStatus !== "all" ? loanStatus : undefined,
    purchaseMode: purchaseMode !== "all" ? purchaseMode : undefined,
    titleType: titleType !== "all" ? titleType : undefined,
    milestone: milestone !== "all" ? milestone : undefined,
    milestonePresence: milestone !== "all" ? milestonePresence : undefined,
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
  const projects = projectsRes?.data ?? [];
  const cases = response?.data ?? [];
  const total = response?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pageCount);
  const caseById = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases]);

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
    if (spaStatus !== "all") chips.push({ key: "spaStatus", label: `SPA: ${spaStatus}`, onClear: () => { setSpaStatus("all"); setPage(1); } });
    if (loanStatus !== "all") chips.push({ key: "loanStatus", label: `Loan: ${loanStatus}`, onClear: () => { setLoanStatus("all"); setPage(1); } });
    if (milestone !== "all") {
      const label = milestoneLabelByKey.get(milestone) ?? milestone;
      const presenceLabel =
        milestonePresence === "missing" ? "Missing"
          : milestonePresence === "filled" ? "Filled"
            : milestonePresence === "completed" ? "Done"
              : "Pending";
      chips.push({
        key: "milestone",
        label: `${label}: ${presenceLabel}`,
        onClear: () => { setMilestone("all"); setMilestonePresence("filled"); setPage(1); },
      });
    }
    if (lawyerId !== "all") chips.push({ key: "assignedLawyerId", label: `Lawyer: ${lawyerNameById.get(lawyerId) ?? lawyerId}`, onClear: () => { setLawyerId("all"); setPage(1); } });
    if (clerkId !== "all") chips.push({ key: "assignedClerkId", label: `Clerk: ${clerkNameById.get(clerkId) ?? clerkId}`, onClear: () => { setClerkId("all"); setPage(1); } });
    if (projectId !== "all") chips.push({ key: "projectId", label: `Project: ${projectNameById.get(projectId) ?? projectId}`, onClear: () => { setProjectId("all"); setPage(1); } });
    return chips;
  }, [
    search,
    spaStatus,
    loanStatus,
    milestone,
    milestonePresence,
    lawyerId,
    clerkId,
    projectId,
    lawyerNameById,
    clerkNameById,
    projectNameById,
    milestoneLabelByKey,
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
              setMilestone("all");
              setMilestonePresence("filled");
              setLawyerId("all");
              setClerkId("all");
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

      {selectedCaseIds.size > 0 && (
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
    </div>
  );
}

function BatchGenerateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCaseIds: Set<number>;
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
    selectedTemplateIds,
    setSelectedTemplateIds,
    bulkZipDownloading,
    setBulkZipDownloading,
    bulkGenerateDownloading,
    setBulkGenerateDownloading,
    onSuccess,
    toast,
  } = props;

  type TemplateRow = { id: number; name?: string | null; document_type?: string | null; kind?: string | null };

  const templatesQuery = useQuery<TemplateRow[]>({
    queryKey: ["document-templates", "templateCapable"],
    queryFn: () => apiFetchJson<TemplateRow[]>("/document-templates?templateCapable=1"),
    enabled: open,
    retry: false,
    staleTime: 60_000,
  });

  const templates = Array.isArray(templatesQuery.data) ? templatesQuery.data : [];

  const selectedTemplateCount = selectedTemplateIds.size;
  const selectedCaseCount = selectedCaseIds.size;

  const toggleTemplate = (id: number) => {
    setSelectedTemplateIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const generateAndDownloadZip = async () => {
    const ids = Array.from(selectedCaseIds);
    const templateIds = Array.from(selectedTemplateIds);
    if (ids.length === 0 || templateIds.length === 0) return;
    setBulkGenerateDownloading(true);
    try {
      const res = await apiRequest("/cases/bulk/generate-documents-zip", {
        method: "POST",
        body: JSON.stringify({ caseIds: ids, templateIds }),
        timeoutMs: 180000,
      });
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?/i.exec(cd);
      const fileNameRaw = m?.[1] ?? m?.[2] ?? "batch-documents.zip";
      const fileName = decodeURIComponent(String(fileNameRaw).trim());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName || "batch-documents.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Download started", description: `${ids.length} case(s), ${templateIds.length} template(s)` });
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toastError(toast, err, "Batch generate failed");
    } finally {
      setBulkGenerateDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Batch Generate Documents</DialogTitle>
          <DialogDescription>Select templates to generate, then download as ZIP.</DialogDescription>
        </DialogHeader>

        {templatesQuery.isError ? (
          <QueryFallback title="Templates unavailable" error={templatesQuery.error} onRetry={() => templatesQuery.refetch()} isRetrying={templatesQuery.isFetching} />
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              {selectedCaseCount} case(s) selected · {selectedTemplateCount} template(s) selected
            </div>
            <div className="max-h-[320px] overflow-auto rounded-md border border-slate-200">
              {templates.length === 0 ? (
                <div className="p-4 text-sm text-slate-500">No templates found.</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {templates.map((t) => (
                    <label key={t.id} className="flex items-center gap-3 px-4 py-3 text-sm cursor-pointer hover:bg-slate-50">
                      <Checkbox checked={selectedTemplateIds.has(t.id)} onCheckedChange={() => toggleTemplate(t.id)} />
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 truncate">{String(t.name ?? `Template ${t.id}`)}</div>
                        <div className="text-xs text-slate-500 truncate">{String(t.document_type ?? "")}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
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
            Generate &amp; Download ZIP
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
