import { CaseMilestoneKey, MilestonePresence, useListCases } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { getStoredAuthToken } from "@/lib/auth-token";

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

  const [search, setSearch] = useState("");
  const [purchaseMode, setPurchaseMode] = useState<string>("all");
  const [spaStatus, setSpaStatus] = useState<string>("all");
  const [loanStatus, setLoanStatus] = useState<string>("all");
  const [milestone, setMilestone] = useState<CaseMilestoneKey | "all">("all");
  const [milestonePresence, setMilestonePresence] = useState<MilestonePresence>("filled");
  const [lawyerId, setLawyerId] = useState<string>("all");
  const [clerkId, setClerkId] = useState<string>("all");

  useEffect(() => {
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

    setSearch(sp.get("search") ?? "");
    setPurchaseMode(sp.get("purchaseMode") ?? "all");
    setSpaStatus(sp.get("spaStatus") ?? "all");
    setLoanStatus(sp.get("loanStatus") ?? "all");
    setMilestone(nextMilestone);
    setMilestonePresence(nextPresence);
    setLawyerId(sp.get("assignedLawyerId") ?? "all");
    setClerkId(sp.get("assignedClerkId") ?? "all");
  }, [sp]);

  const applyUrl = (next: {
    search?: string;
    purchaseMode?: string;
    spaStatus?: string;
    loanStatus?: string;
    milestone?: string;
    milestonePresence?: string;
    assignedLawyerId?: string;
    assignedClerkId?: string;
  }) => {
    const nextSp = new URLSearchParams();
    const setIf = (k: string, v: string | undefined) => {
      if (!v || v === "all") return;
      nextSp.set(k, v);
    };
    setIf("search", next.search?.trim() ? next.search.trim() : undefined);
    setIf("purchaseMode", next.purchaseMode);
    setIf("spaStatus", next.spaStatus);
    setIf("loanStatus", next.loanStatus);
    setIf("milestone", next.milestone);
    setIf("milestonePresence", next.milestone ? (next.milestonePresence ?? "filled") : undefined);
    setIf("assignedLawyerId", next.assignedLawyerId);
    setIf("assignedClerkId", next.assignedClerkId);
    const qs = nextSp.toString();
    setLocation(qs ? `/app/cases?${qs}` : "/app/cases");
  };

  const { data: response, isLoading } = useListCases({ 
    page: 1, 
    limit: 50,
    search: search || undefined,
    purchaseMode: purchaseMode !== "all" ? purchaseMode : undefined,
    assignedLawyerId: lawyerId !== "all" ? parseInt(lawyerId) : undefined,
    assignedClerkId: clerkId !== "all" ? parseInt(clerkId) : undefined,
    spaStatus: spaStatus !== "all" ? spaStatus : undefined,
    loanStatus: loanStatus !== "all" ? loanStatus : undefined,
    milestone: milestone !== "all" ? milestone : undefined,
    milestonePresence: milestone !== "all" ? milestonePresence : undefined,
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Cases</h1>
          <p className="text-slate-500 mt-1">Manage conveyancing cases</p>
          <p className="text-xs text-slate-400 mt-1">Total: {response?.total ?? 0}</p>
        </div>
        <Link href="/app/cases/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Case
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search reference, client, project, property..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyUrl({ search, purchaseMode, spaStatus, loanStatus, milestone, milestonePresence, assignedLawyerId: lawyerId, assignedClerkId: clerkId });
            }}
          />
        </div>

        <Select value={purchaseMode} onValueChange={setPurchaseMode}>
          <SelectTrigger>
            <SelectValue placeholder="Purchase Mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Modes</SelectItem>
            <SelectItem value="cash">Cash</SelectItem>
            <SelectItem value="loan">Loan</SelectItem>
          </SelectContent>
        </Select>

        <Select value={spaStatus} onValueChange={setSpaStatus}>
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

        <Select value={loanStatus} onValueChange={setLoanStatus}>
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

        <Select value={milestonePresence} onValueChange={setMilestonePresence} disabled={milestone === "all"}>
          <SelectTrigger>
            <SelectValue placeholder="Filled / Missing" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="filled">Filled</SelectItem>
            <SelectItem value="missing">Missing</SelectItem>
          </SelectContent>
        </Select>

        <Select value={lawyerId} onValueChange={setLawyerId}>
          <SelectTrigger>
            <SelectValue placeholder="Assigned Lawyer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Lawyers</SelectItem>
            {lawyers.map(l => <SelectItem key={l.id} value={l.id.toString()}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={clerkId} onValueChange={setClerkId}>
          <SelectTrigger>
            <SelectValue placeholder="Assigned Clerk" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Clerks</SelectItem>
            {clerks.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => applyUrl({ search, purchaseMode, spaStatus, loanStatus, milestone, milestonePresence, assignedLawyerId: lawyerId, assignedClerkId: clerkId })}
        >
          Apply Filters
        </Button>
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
            setLocation("/app/cases");
          }}
        >
          Reset
        </Button>
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
                        <Link href={`/app/cases/${c.id}`}>
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
