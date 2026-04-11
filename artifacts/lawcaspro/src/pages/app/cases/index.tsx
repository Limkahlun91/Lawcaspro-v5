import { CaseMilestoneKey, MilestonePresence, useListCases, useListDevelopers, useListProjects } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemo, useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { getStoredAuthToken } from "@/lib/auth-token";
import { Badge } from "@/components/ui/badge";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

async function apiFetch(path: string) {
  const token = getStoredAuthToken();
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    credentials: "include",
    timeoutMs: 15000,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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
    setIf("purchaseMode", purchaseMode);
    setIf("spaStatus", spaStatus);
    setIf("loanStatus", loanStatus);
    setIf("milestone", milestone === "all" ? undefined : milestone);
    if (milestone !== "all") nextSp.set("milestonePresence", milestonePresence);
    setIf("assignedLawyerId", lawyerId);
    setIf("assignedClerkId", clerkId);
    setIf("projectId", projectId);
    setIf("developerId", developerId);
    setIf("titleType", titleType);
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
    projectId,
    developerId,
    titleType,
    page,
    limit,
    sortBy,
    sortDir,
    sp,
    setLocation,
  ]);

  const { data: response, isLoading } = useListCases({ 
    page,
    limit,
    search: search || undefined,
    purchaseMode: purchaseMode !== "all" ? purchaseMode : undefined,
    projectId: projectId !== "all" ? Number(projectId) : undefined,
    developerId: developerId !== "all" ? Number(developerId) : undefined,
    titleType: titleType !== "all" ? titleType : undefined,
    assignedLawyerId: lawyerId !== "all" ? parseInt(lawyerId) : undefined,
    assignedClerkId: clerkId !== "all" ? parseInt(clerkId) : undefined,
    spaStatus: spaStatus !== "all" ? spaStatus : undefined,
    loanStatus: loanStatus !== "all" ? loanStatus : undefined,
    milestone: milestone !== "all" ? milestone : undefined,
    milestonePresence: milestone !== "all" ? milestonePresence : undefined,
    sortBy,
    sortDir,
  });

  const { data: filterOptions } = useQuery({
    queryKey: ["cases", "filter-options"],
    queryFn: () => apiFetch("/cases/filter-options"),
    retry: false,
  });
  const spaStatuses: string[] = Array.isArray(filterOptions?.spaStatuses) ? filterOptions.spaStatuses : ["Pending"];
  const loanStatuses: string[] = Array.isArray(filterOptions?.loanStatuses) ? filterOptions.loanStatuses : ["Pending"];
  const lawyers: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.lawyers) ? filterOptions.assignees.lawyers : [];
  const clerks: Array<{ id: number; name: string }> = Array.isArray(filterOptions?.assignees?.clerks) ? filterOptions.assignees.clerks : [];
  const milestoneOptions: Array<{ key: CaseMilestoneKey; label: string }> = Array.isArray(filterOptions?.milestones) ? filterOptions.milestones : [];

  const { data: projectsRes } = useListProjects({ page: 1, limit: 200 });
  const { data: devsRes } = useListDevelopers({ page: 1, limit: 200 });
  const projects = projectsRes?.data ?? [];
  const developers = devsRes?.data ?? [];
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
    if (projectId !== "all") chips.push({ key: "projectId", label: `Project: ${projectNameById.get(projectId) ?? projectId}`, onClear: () => { setProjectId("all"); setPage(1); } });
    if (developerId !== "all") chips.push({ key: "developerId", label: `Developer: ${developerNameById.get(developerId) ?? developerId}`, onClear: () => { setDeveloperId("all"); setPage(1); } });
    if (titleType !== "all") chips.push({ key: "titleType", label: `Title: ${titleType}`, onClear: () => { setTitleType("all"); setPage(1); } });
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
    projectId,
    developerId,
    titleType,
    milestoneLabelByKey,
    lawyerNameById,
    clerkNameById,
    projectNameById,
    developerNameById,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Cases</h1>
          <p className="text-slate-500 mt-1">Manage conveyancing cases</p>
          <p className="text-xs text-slate-400 mt-1">Total: {total}</p>
        </div>
        <Link href="/app/cases/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Case
          </Button>
        </Link>
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
              setProjectId("all");
              setDeveloperId("all");
              setTitleType("all");
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
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
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
                  {response?.data.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/50">
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
                  {response?.data.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-8 text-center text-slate-500">
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
    </div>
  );
}
